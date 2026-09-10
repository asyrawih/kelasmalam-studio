/**
 * Null-test STFT → iSTFT MDX (docs/26 P0) tanpa model.
 *
 * - dimF penuh (3841 bin): rekonstruksi harus sempurna, SNR > 100 dB, pada
 *   derau putih + sinus 30 detik stereo.
 * - dimF 3072 (Kim_Vocal_2): bin ≥ 3072 dibuang, jadi derau putih TIDAK
 *   kembali utuh; yang diuji: (a) spektrum bin < 3072 identik dengan versi
 *   penuh, (b) sinyal yang energinya di bawah 17,6 kHz kembali > 40 dB.
 * - bentuk tensor: 261 120 sampel → tepat 256 frame, layout [4, dimF, T].
 */
import { describe, expect, it, vi } from 'vitest';

// Tes ini mengolah puluhan detik audio dengan FFT murni JS; di runner CI
// (2 vCPU) satu kasus bisa > 5 s — bawaan vitest. Batas per berkas, bukan
// per kasus, supaya kasus baru tidak lupa memakainya.
vi.setConfig({ testTimeout: 60_000 });

import { VOCAL_MODELS, samplesPerSegment } from '../catalog';
import { createMdxStft, hannPeriodic, specIndex, zeroLowBins } from '../mdx-stft';
import { bandLimitedStereo, noisePlusSine, snrDb } from './signals';

const KIM = VOCAL_MODELS['kim-vocal-2'].mdx;
const SR = 44_100;
const SECONDS = 30;

describe('mdx-stft', () => {
  it('Hann periodik: w[0] = 0, w[N/2] = 1, w[N−1] ≠ 0 (bukan simetris)', () => {
    const w = hannPeriodic(8);
    expect(w[0]).toBe(0);
    expect(w[4]).toBeCloseTo(1, 15);
    expect(w[7]).toBeCloseTo(0.5 - 0.5 * Math.cos((2 * Math.PI * 7) / 8), 15);
    expect(w[1]).toBeCloseTo(w[7]!, 15);
  });

  it('segmen 261 120 sampel → 256 frame, tensor [4, 3072, 256]', () => {
    const stft = createMdxStft(KIM);
    const segment = samplesPerSegment(KIM);
    expect(segment).toBe(261_120);
    expect(stft.frameCount(segment)).toBe(256);
    expect(stft.specSize(256)).toBe(4 * 3072 * 256);
    expect(stft.nBins).toBe(3841);
  });

  it('layout channel [L.re, L.im, R.re, R.im]: sinus hanya di L tidak bocor ke R', () => {
    const stft = createMdxStft(KIM);
    const segment = samplesPerSegment(KIM);
    const left = new Float32Array(segment);
    const right = new Float32Array(segment);
    // 1 kHz tepat di bin 1000·7680/44100 ≈ 174,15.
    for (let n = 0; n < segment; n += 1) left[n] = Math.sin((2 * Math.PI * 1000 * n) / SR);
    const spec = stft.forward(left, right);
    const frames = 256;
    let energyL = 0;
    let energyR = 0;
    let peakBin = 0;
    let peakMag = 0;
    const t = 100;
    for (let k = 0; k < KIM.dimF; k += 1) {
      const lr = spec[specIndex(KIM.dimF, frames, 0, k, t)]!;
      const li = spec[specIndex(KIM.dimF, frames, 1, k, t)]!;
      const rr = spec[specIndex(KIM.dimF, frames, 2, k, t)]!;
      const ri = spec[specIndex(KIM.dimF, frames, 3, k, t)]!;
      const mag = lr * lr + li * li;
      energyL += mag;
      energyR += rr * rr + ri * ri;
      if (mag > peakMag) { peakMag = mag; peakBin = k; }
    }
    // Pemisahan Hermitian dari FFT terkemas menyisakan galat pembulatan ~1e-24.
    expect(energyR).toBeLessThan(1e-18);
    expect(energyL).toBeGreaterThan(0);
    expect(peakBin).toBe(174);
    // Skala torch.stft tak dinormalisasi: puncak sinus amplitudo 1 dengan Hann ≈ N/4.
    expect(Math.sqrt(peakMag)).toBeGreaterThan(0.6 * (KIM.nFft / 4));
    expect(Math.sqrt(peakMag)).toBeLessThan(1.05 * (KIM.nFft / 4));
  });

  it('padding refleksi: frame 0 kanal kiri simetris → bagian imajiner ≈ 0', () => {
    const stft = createMdxStft(KIM);
    const segment = samplesPerSegment(KIM);
    const { left, right } = noisePlusSine(segment, 3);
    const spec = stft.forward(left, right);
    // Frame 0 = padded[0 .. nFft) = [x[3840..1], x[0..3839]]: simetris terhadap
    // pusat window (indeks 3840) dan Hann periodik juga simetris di sana,
    // jadi DFT-nya (setelah dikoreksi fase pusat) real. Uji sifat setara:
    // |spektrum frame 0| == |spektrum sinyal yang dibalik|.
    const flippedL = new Float32Array(segment);
    const flippedR = new Float32Array(segment);
    for (let n = 0; n < segment; n += 1) {
      flippedL[n] = left[segment - 1 - n]!;
      flippedR[n] = right[segment - 1 - n]!;
    }
    const specFlip = stft.forward(flippedL, flippedR);
    const frames = 256;
    // Frame terakhir sinyal terbalik harus punya magnitudo sama dengan frame 0
    // sinyal asli (refleksi di tepi kanan dan kiri memakai aturan yang sama).
    let magA = 0;
    let magB = 0;
    for (let k = 0; k < KIM.dimF; k += 1) {
      const a0 = spec[specIndex(KIM.dimF, frames, 0, k, 0)]!;
      const a1 = spec[specIndex(KIM.dimF, frames, 1, k, 0)]!;
      const b0 = specFlip[specIndex(KIM.dimF, frames, 0, k, frames - 1)]!;
      const b1 = specFlip[specIndex(KIM.dimF, frames, 1, k, frames - 1)]!;
      magA += Math.hypot(a0, a1);
      magB += Math.hypot(b0, b1);
    }
    // segment = 255·hop persis, jadi frame terakhir sinyal terbalik menutupi
    // [255·hop, 255·hop + nFft) = cermin frame 0.
    expect(Math.abs(magA - magB) / magA).toBeLessThan(1e-4);
  });

  it('zeroLowBins: 3 bin terbawah nol di 4 channel, bin 3 utuh', () => {
    const dimF = 8;
    const frames = 4;
    const spec = new Float32Array(4 * dimF * frames).fill(1);
    zeroLowBins(spec, dimF, frames);
    for (let c = 0; c < 4; c += 1) {
      for (let k = 0; k < dimF; k += 1) {
        for (let t = 0; t < frames; t += 1) {
          expect(spec[specIndex(dimF, frames, c, k, t)]).toBe(k < 3 ? 0 : 1);
        }
      }
    }
  });

  it('dimF penuh (3841): roundtrip derau + sinus 30 detik, SNR > 100 dB', () => {
    const stft = createMdxStft({ ...KIM, dimF: 3841 });
    const length = SR * SECONDS;
    const { left, right } = noisePlusSine(length, 11);
    const frames = stft.frameCount(length);
    const spec = stft.forward(left, right);
    const outL = new Float32Array(length);
    const outR = new Float32Array(length);
    stft.inverse(spec, frames, outL, outR, length);
    const snrL = snrDb(left, outL);
    const snrR = snrDb(right, outR);
    console.info(`[stft-roundtrip] dimF 3841, 30 s: SNR L ${snrL.toFixed(1)} dB, R ${snrR.toFixed(1)} dB`);
    expect(snrL).toBeGreaterThan(100);
    expect(snrR).toBeGreaterThan(100);
  });

  it('dimF 3072: bin < 3072 identik dengan versi penuh; selisih hanya di bin yang dibuang', () => {
    const full = createMdxStft({ ...KIM, dimF: 3841 });
    const crop = createMdxStft(KIM);
    const segment = samplesPerSegment(KIM);
    const { left, right } = noisePlusSine(segment, 5);
    const specFull = full.forward(left, right);
    const specCrop = crop.forward(left, right);
    const frames = 256;
    let maxDiff = 0;
    for (let c = 0; c < 4; c += 1) {
      for (let k = 0; k < KIM.dimF; k += 1) {
        for (let t = 0; t < frames; t += 1) {
          const a = specFull[specIndex(3841, frames, c, k, t)]!;
          const b = specCrop[specIndex(3072, frames, c, k, t)]!;
          maxDiff = Math.max(maxDiff, Math.abs(a - b));
        }
      }
    }
    expect(maxDiff).toBe(0);

    // Rekonstruksi dari crop == rekonstruksi dari versi penuh yang bin ≥ 3072-nya dinolkan.
    const zeroed = Float32Array.from(specFull);
    for (let c = 0; c < 4; c += 1) {
      for (let k = KIM.dimF; k < 3841; k += 1) {
        const start = specIndex(3841, frames, c, k, 0);
        zeroed.fill(0, start, start + frames);
      }
    }
    const a = { l: new Float32Array(segment), r: new Float32Array(segment) };
    const b = { l: new Float32Array(segment), r: new Float32Array(segment) };
    full.inverse(zeroed, frames, a.l, a.r);
    crop.inverse(specCrop, frames, b.l, b.r);
    expect(snrDb(a.l, b.l)).toBeGreaterThan(120);
    expect(snrDb(a.r, b.r)).toBeGreaterThan(120);
  });

  it('dimF 3072: sinyal band-limited < 12 kHz kembali > 40 dB (target > 100 dB)', () => {
    const stft = createMdxStft(KIM);
    const segment = samplesPerSegment(KIM);
    const { left, right } = bandLimitedStereo(segment, { seed: 9 });
    const spec = stft.forward(left, right);
    const outL = new Float32Array(segment);
    const outR = new Float32Array(segment);
    stft.inverse(spec, 256, outL, outR);
    const snrL = snrDb(left, outL);
    const snrR = snrDb(right, outR);
    console.info(`[stft-roundtrip] dimF 3072, band-limited 1 segmen: SNR L ${snrL.toFixed(1)} dB, R ${snrR.toFixed(1)} dB`);
    expect(snrL).toBeGreaterThan(40);
    expect(snrR).toBeGreaterThan(40);
  });
});
