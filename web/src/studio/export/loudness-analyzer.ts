/**
 * Analyzer master streaming untuk export.
 *
 * Integrated loudness mengikuti bentuk BS.1770/EBU R128: K-weighting,
 * blok 400 ms dengan langkah 100 ms, absolute gate -70 LUFS, lalu relative
 * gate -10 LU. Seluruh lagu tidak pernah ditahan di RAM; yang disimpan hanya
 * energi per blok dan ring buffer 400 ms.
 *
 * True peak dihitung dari puncak antar-sample dengan interpolasi cubic 4x.
 * Ini jauh lebih berguna daripada sample peak untuk menjaga headroom encoder
 * lossy, tetapi sengaja dinamai `truePeakDbtp` sebagai estimasi implementasi
 * produk — sertifikasi meter tetap membutuhkan test-vector resmi ITU.
 */

export const ROBLOX_SAFE_TARGET_LUFS = -16;
export const ROBLOX_SAFE_MIN_LUFS = -17;
export const ROBLOX_SAFE_MAX_LUFS = -15;
export const ROBLOX_SAFE_MAX_TRUE_PEAK_DBTP = -2;

export interface LoudnessAnalysis {
  readonly integratedLufs: number | null;
  readonly truePeakDbtp: number | null;
  readonly samplePeakDbfs: number | null;
  readonly clippedSamples: number;
  /** True peak dikurangi RMS keseluruhan; kecil berarti master sangat gepeng. */
  readonly crestFactorDb: number | null;
  readonly frames: number;
  readonly durationSec: number;
}

export type RobloxSafeStatus = 'pass' | 'warning' | 'fail';

export interface RobloxSafeAssessment {
  readonly safe: boolean;
  readonly loudness: RobloxSafeStatus;
  readonly truePeak: RobloxSafeStatus;
  readonly clipping: RobloxSafeStatus;
  readonly dynamics: RobloxSafeStatus;
  /** Gain linear yang aman: mengejar -16 LUFS tanpa melewati -2 dBTP. */
  readonly recommendedGainDb: number;
}

const ABS_GATE_LUFS = -70;
const REL_GATE_LU = -10;
const LUFS_OFFSET = -0.691;
const EPS = 1e-20;

const toDb = (linear: number): number | null =>
  linear > 0 && Number.isFinite(linear) ? 20 * Math.log10(linear) : null;

const energyToLufs = (energy: number): number => LUFS_OFFSET + 10 * Math.log10(Math.max(EPS, energy));

/** Biquad Direct Form II transposed — stabil dan hanya menyimpan dua state. */
class Biquad {
  private z1 = 0;
  private z2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/**
 * Koefisien referensi K-weighting untuk 48 kHz. Project dan export aplikasi
 * memakai 48 kHz sebagai rate kanonis; rate lain tetap dianalisis memakai
 * filter yang sama dan diberi hasil stabil, tetapi akurasi referensinya paling
 * tinggi pada 48 kHz.
 */
function kWeighting(): [Biquad, Biquad] {
  const shelf = new Biquad(
    1.53512485958697,
    -2.69169618940638,
    1.19839281085285,
    -1.69065929318241,
    0.73248077421585,
  );
  const highPass = new Biquad(1, -2, 1, -1.99004745483398, 0.99007225036621);
  return [shelf, highPass];
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  // Catmull-Rom: melalui b pada t=0 dan c pada t=1.
  const a0 = -0.5 * a + 1.5 * b - 1.5 * c + 0.5 * d;
  const a1 = a - 2.5 * b + 2 * c - 0.5 * d;
  const a2 = -0.5 * a + 0.5 * c;
  return ((a0 * t + a1) * t + a2) * t + b;
}

class PeakInterpolator {
  private a = 0;
  private b = 0;
  private c = 0;
  private count = 0;
  peak = 0;

  push(sample: number): void {
    this.peak = Math.max(this.peak, Math.abs(sample));
    if (this.count >= 3) {
      for (const t of [0.25, 0.5, 0.75]) {
        this.peak = Math.max(this.peak, Math.abs(cubic(this.a, this.b, this.c, sample, t)));
      }
    }
    this.a = this.b;
    this.b = this.c;
    this.c = sample;
    this.count++;
  }
}

export class LoudnessAnalyzer {
  private readonly blockFrames: number;
  private readonly stepFrames: number;
  private readonly ring: Float64Array;
  private ringAt = 0;
  private ringFill = 0;
  private windowEnergy = 0;
  private sinceBlock = 0;
  private readonly blocks: number[] = [];
  private readonly leftFilters = kWeighting();
  private readonly rightFilters = kWeighting();
  private readonly leftPeak = new PeakInterpolator();
  private readonly rightPeak = new PeakInterpolator();
  private totalRawEnergy = 0;
  private samplePeak = 0;
  private clipCount = 0;
  private frameCount = 0;

  constructor(readonly sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Sample rate analyzer tidak sah.');
    this.blockFrames = Math.max(1, Math.round(sampleRate * 0.4));
    this.stepFrames = Math.max(1, Math.round(sampleRate * 0.1));
    this.ring = new Float64Array(this.blockFrames);
  }

  push(left: Float32Array, right: Float32Array): void {
    if (left.length !== right.length) throw new Error('Analyzer membutuhkan channel L/R yang sama panjang.');
    for (let i = 0; i < left.length; i++) {
      const l = Number.isFinite(left[i]) ? left[i]! : 0;
      const r = Number.isFinite(right[i]) ? right[i]! : 0;
      const absL = Math.abs(l);
      const absR = Math.abs(r);
      this.samplePeak = Math.max(this.samplePeak, absL, absR);
      if (absL >= 1) this.clipCount++;
      if (absR >= 1) this.clipCount++;
      this.leftPeak.push(l);
      this.rightPeak.push(r);
      this.totalRawEnergy += (l * l + r * r) / 2;

      let kl = l;
      let kr = r;
      for (const filter of this.leftFilters) kl = filter.process(kl);
      for (const filter of this.rightFilters) kr = filter.process(kr);
      const e = kl * kl + kr * kr;

      if (this.ringFill === this.blockFrames) this.windowEnergy -= this.ring[this.ringAt]!;
      else this.ringFill++;
      this.ring[this.ringAt] = e;
      this.windowEnergy += e;
      this.ringAt = (this.ringAt + 1) % this.blockFrames;
      this.sinceBlock++;
      this.frameCount++;

      if (this.ringFill === this.blockFrames && this.sinceBlock >= this.stepFrames) {
        this.blocks.push(this.windowEnergy / this.blockFrames);
        this.sinceBlock = 0;
      }
    }
  }

  finish(): LoudnessAnalysis {
    // Untuk SFX <400 ms tetap beri jawaban berguna dari seluruh durasinya.
    if (this.blocks.length === 0 && this.ringFill > 0) {
      this.blocks.push(this.windowEnergy / this.ringFill);
    }

    const absolute = this.blocks.filter((e) => energyToLufs(e) > ABS_GATE_LUFS);
    let integratedLufs: number | null = null;
    if (absolute.length > 0) {
      const preliminary = absolute.reduce((sum, e) => sum + e, 0) / absolute.length;
      const relativeGate = energyToLufs(preliminary) + REL_GATE_LU;
      const gated = absolute.filter((e) => energyToLufs(e) > Math.max(ABS_GATE_LUFS, relativeGate));
      if (gated.length > 0) {
        integratedLufs = energyToLufs(gated.reduce((sum, e) => sum + e, 0) / gated.length);
      }
    }

    const truePeak = Math.max(this.leftPeak.peak, this.rightPeak.peak);
    const truePeakDbtp = toDb(truePeak);
    const samplePeakDbfs = toDb(this.samplePeak);
    const rms = this.frameCount > 0 ? Math.sqrt(this.totalRawEnergy / this.frameCount) : 0;
    const rmsDb = toDb(rms);
    const crestFactorDb = truePeakDbtp !== null && rmsDb !== null ? truePeakDbtp - rmsDb : null;

    return {
      integratedLufs,
      truePeakDbtp,
      samplePeakDbfs,
      clippedSamples: this.clipCount,
      crestFactorDb,
      frames: this.frameCount,
      durationSec: this.frameCount / this.sampleRate,
    };
  }
}

export function assessRobloxSafe(a: LoudnessAnalysis): RobloxSafeAssessment {
  const lufs = a.integratedLufs;
  const peak = a.truePeakDbtp;
  const loudness: RobloxSafeStatus =
    lufs === null ? 'fail' : lufs > ROBLOX_SAFE_MAX_LUFS ? 'fail' : lufs < ROBLOX_SAFE_MIN_LUFS ? 'warning' : 'pass';
  const truePeak: RobloxSafeStatus = peak === null ? 'warning' : peak > ROBLOX_SAFE_MAX_TRUE_PEAK_DBTP ? 'fail' : 'pass';
  const clipping: RobloxSafeStatus = a.clippedSamples > 0 ? 'fail' : 'pass';
  const dynamics: RobloxSafeStatus =
    a.crestFactorDb === null ? 'warning' : a.crestFactorDb < 6 ? 'warning' : 'pass';

  const loudnessGain = lufs === null ? 0 : ROBLOX_SAFE_TARGET_LUFS - lufs;
  const peakGain = peak === null ? loudnessGain : ROBLOX_SAFE_MAX_TRUE_PEAK_DBTP - peak;
  // Jangan menaikkan noise floor ekstrem lebih dari 12 dB secara otomatis.
  const recommendedGainDb = Math.max(-60, Math.min(12, loudnessGain, peakGain));

  return {
    safe: loudness !== 'fail' && truePeak !== 'fail' && clipping !== 'fail',
    loudness,
    truePeak,
    clipping,
    dynamics,
    recommendedGainDb,
  };
}

/** Terapkan gain hasil analyzer pada buffer render sebelum encoder. */
export function applyGain(channels: readonly Float32Array[], gainDb: number): void {
  if (!Number.isFinite(gainDb) || Math.abs(gainDb) < 1e-9) return;
  const gain = 10 ** (gainDb / 20);
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) channel[i] = (channel[i] ?? 0) * gain;
  }
}
