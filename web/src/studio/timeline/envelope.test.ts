/**
 * Tes envelope: matematika bucket terhadap sinyal sintetis yang jawabannya
 * bisa dihitung tangan, pemilihan level dari zoom, striding oleh speedRatio,
 * dan jaminan "sunyi menghasilkan nol, bukan NaN".
 */

import { describe, expect, it } from 'vitest';

import {
  allocColumns,
  buildEnvelope,
  BUCKET_SIZES,
  envelopeBytes,
  levelFor,
  envelopePeak,
  readEnvelope,
  type PcmSource,
} from './envelope';
import { assetFromBuffer } from './audio-import';

/** `AudioBuffer` palsu — bentuknya sama dengan yang dipakai kode produksi. */
function pcm(channels: Float32Array[]): PcmSource & AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    length,
    duration: length / 48000,
    sampleRate: 48000,
    getChannelData: (ch: number) => channels[ch]!,
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined,
  } as unknown as PcmSource & AudioBuffer;
}

describe('buildEnvelope', () => {
  it('min/max/rms sesuai hitungan tangan pada sinyal DC per-bucket', () => {
    // Empat bucket level-0 (64 sample) dengan nilai konstan berbeda.
    const values = [0.5, -0.25, 1, 0];
    const data = new Float32Array(64 * values.length);
    values.forEach((v, b) => data.fill(v, b * 64, (b + 1) * 64));
    const env = buildEnvelope(pcm([data]));
    const l0 = env.levels[0]!;
    expect(l0.bucket).toBe(64);
    expect(l0.min.length).toBe(4);
    expect(Array.from(l0.max)).toEqual([0.5, 0, 1, 0]);
    expect(Array.from(l0.min)).toEqual([0, -0.25, 0, 0]);
    // RMS sinyal DC = |nilai|.
    expect(Array.from(l0.rms)).toEqual([0.5, 0.25, 1, 0]);
  });

  it('gelombang kotak ±a: rms = a, min = -a, max = +a', () => {
    const n = 64 * 8;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i += 1) data[i] = i % 2 === 0 ? 0.8 : -0.8;
    const l0 = buildEnvelope(pcm([data])).levels[0]!;
    expect(l0.max.every((v) => Math.abs(v - 0.8) < 1e-6)).toBe(true);
    expect(l0.min.every((v) => Math.abs(v + 0.8) < 1e-6)).toBe(true);
    expect(l0.rms.every((v) => Math.abs(v - 0.8) < 1e-6)).toBe(true);
  });

  it('level atas identik dengan brute force atas level 0 (agregasi min/max eksak)', () => {
    const n = 4096 * 3;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i += 1) data[i] = Math.sin(i * 0.01) * (0.2 + 0.8 * ((i / n) % 1));
    const env = buildEnvelope(pcm([data]));
    for (let li = 1; li < BUCKET_SIZES.length; li += 1) {
      const level = env.levels[li]!;
      for (let b = 0; b < level.min.length; b += 1) {
        const lo = b * level.bucket;
        const hi = Math.min(n, lo + level.bucket);
        let mn = 0;
        let mx = 0;
        for (let i = lo; i < hi; i += 1) {
          mn = Math.min(mn, data[i]!);
          mx = Math.max(mx, data[i]!);
        }
        expect(level.min[b]).toBeCloseTo(mn, 6);
        expect(level.max[b]).toBeCloseTo(mx, 6);
      }
    }
  });

  it('stereo digabung: min terendah & max tertinggi lintas channel', () => {
    const left = new Float32Array(64).fill(0.3);
    const right = new Float32Array(64).fill(-0.9);
    const l0 = buildEnvelope(pcm([left, right])).levels[0]!;
    expect(l0.max[0]).toBeCloseTo(0.3, 6);
    expect(l0.min[0]).toBeCloseTo(-0.9, 6);
    // mean-square dua channel: sqrt((0.09 + 0.81)/2)
    expect(l0.rms[0]).toBeCloseTo(Math.sqrt(0.45), 6);
  });

  it('region sunyi menghasilkan nol, bukan NaN', () => {
    const env = buildEnvelope(pcm([new Float32Array(64 * 10)]));
    for (const level of env.levels) {
      expect(level.min.every((v) => v === 0)).toBe(true);
      expect(level.max.every((v) => v === 0)).toBe(true);
      expect(level.rms.every((v) => v === 0)).toBe(true);
    }
    const out = allocColumns(16);
    readEnvelope(env, 0, 640, 16, out);
    expect(Array.from(out.rms).every(Number.isFinite)).toBe(true);
    expect(Array.from(out.min).every((v) => v === 0)).toBe(true);
  });

  it('asset nol frame / rentang nol tidak menghasilkan NaN', () => {
    const env = buildEnvelope(pcm([new Float32Array(0)]));
    const out = allocColumns(8);
    readEnvelope(env, 0, 0, 8, out);
    expect(Array.from(out.max).every((v) => v === 0)).toBe(true);
    expect(envelopePeak(env, 0, 0)).toBe(0);
  });
});

describe('levelFor', () => {
  it('memilih level terkasar yang masih ≥ 1 bucket per pixel', () => {
    expect(levelFor(1)).toBe(0);
    expect(levelFor(63)).toBe(0);
    expect(levelFor(64)).toBe(0);
    expect(levelFor(511)).toBe(0);
    expect(levelFor(512)).toBe(1);
    expect(levelFor(4095)).toBe(1);
    expect(levelFor(4096)).toBe(2);
    expect(levelFor(1e6)).toBe(2);
  });

  it('input tidak masuk akal jatuh ke level paling halus', () => {
    expect(levelFor(0)).toBe(0);
    expect(levelFor(Number.NaN)).toBe(0);
    expect(levelFor(-5)).toBe(0);
  });
});

describe('readEnvelope', () => {
  const n = 4096 * 16;
  const data = new Float32Array(n);
  // Dua bagian: keras di paruh pertama, sangat pelan di paruh kedua. Justru
  // kontras inilah yang hilang di versi 2048-bucket beresolusi tunggal.
  for (let i = 0; i < n; i += 1) {
    data[i] = Math.sin(i * 0.05) * (i < n / 2 ? 1 : 0.02);
  }
  const env = buildEnvelope(pcm([data]));

  it('membedakan bagian keras dari bagian pelan', () => {
    const out = allocColumns(64);
    readEnvelope(env, 0, n, 64, out);
    expect(out.max[0]!).toBeGreaterThan(0.9);
    expect(out.max[63]!).toBeLessThan(0.1);
    expect(out.rms[0]!).toBeGreaterThan(out.rms[63]! * 10);
  });

  it('kolom membawa ketiga pita, dan pita mengikuti isi sinyalnya', () => {
    // `data` di atas adalah sinus 0,05 rad/sample = ~382 Hz pada 48 kHz —
    // pita TENGAH. Kolom yang keras harus oranye, kolom yang pelan harus ikut
    // pelan di ketiga pita (bukan cuma di outline).
    const out = allocColumns(64);
    readEnvelope(env, 0, n, 64, out);
    expect(out.mid[0]!).toBeGreaterThan(out.low[0]! * 2);
    expect(out.mid[0]!).toBeGreaterThan(out.high[0]! * 2);
    expect(out.mid[63]!).toBeLessThan(out.mid[0]! * 0.1);
  });

  it('agregasi pita antar lebar pixel juga eksak', () => {
    const wide = allocColumns(64);
    const narrow = allocColumns(32);
    readEnvelope(env, 0, n, 64, wide);
    readEnvelope(env, 0, n, 32, narrow);
    for (let i = 0; i < 32; i += 1) {
      expect(narrow.mid[i]!).toBeCloseTo(Math.max(wide.mid[2 * i]!, wide.mid[2 * i + 1]!), 5);
    }
  });

  it('striding oleh speedRatio: rentang source sama, lebar pixel terbagi ratio', () => {
    // Lane speedRatio 2 → clip.len = sourceLen / 2, jadi lebar layarnya separuh
    // untuk rentang source YANG SAMA. Tidak ada pyramid baru yang dibangun.
    const wide = allocColumns(64);
    const narrow = allocColumns(32);
    readEnvelope(env, 0, n, 64, wide);
    readEnvelope(env, 0, n, 32, narrow);

    // Kolom ke-i dari yang sempit harus mencakup kolom 2i dan 2i+1 dari yang
    // lebar — agregasi min/max eksak, jadi ini kesamaan, bukan pendekatan.
    for (let i = 0; i < 32; i += 1) {
      expect(narrow.max[i]!).toBeCloseTo(Math.max(wide.max[2 * i]!, wide.max[2 * i + 1]!), 5);
      expect(narrow.min[i]!).toBeCloseTo(Math.min(wide.min[2 * i]!, wide.min[2 * i + 1]!), 5);
    }
  });

  it('menghormati region source clip (sourceStart..+sourceLen)', () => {
    const out = allocColumns(8);
    // Hanya paruh kedua yang pelan.
    readEnvelope(env, n / 2, n / 2, 8, out);
    expect(Array.from(out.max).every((v) => v < 0.1)).toBe(true);
    readEnvelope(env, 0, n / 2, 8, out);
    expect(Array.from(out.max).every((v) => v > 0.9)).toBe(true);
  });

  it('lebar nol / negatif tidak menggambar dan tidak melempar', () => {
    const out = allocColumns(4);
    expect(() => readEnvelope(env, 0, n, 0, out)).not.toThrow();
    expect(() => readEnvelope(env, 0, n, -3, out)).not.toThrow();
    expect(Array.from(out.max)).toEqual([0, 0, 0, 0]);
  });
});

describe('asset dari import vs pemulihan', () => {
  it('assetFromBuffer menghasilkan envelope identik untuk PCM yang sama', () => {
    const make = (): Float32Array => {
      const d = new Float32Array(64 * 200);
      for (let i = 0; i < d.length; i += 1) d[i] = Math.sin(i * 0.013) * 0.7;
      return d;
    };
    // Jalur import dan jalur restore memanggil fungsi yang SAMA; tes ini
    // menjaga agar tidak ada yang menduplikasinya lagi.
    const imported = assetFromBuffer(1, 'a.wav', pcm([make()]));
    const restored = assetFromBuffer(1, 'a.wav', pcm([make()]));
    expect(imported.frames).toBe(restored.frames);
    expect(imported.envelope.levels.length).toBe(restored.envelope.levels.length);
    for (let li = 0; li < imported.envelope.levels.length; li += 1) {
      const a = imported.envelope.levels[li]!;
      const b = restored.envelope.levels[li]!;
      expect(Array.from(a.min)).toEqual(Array.from(b.min));
      expect(Array.from(a.max)).toEqual(Array.from(b.max));
      expect(Array.from(a.rms)).toEqual(Array.from(b.rms));
      expect(Array.from(a.low)).toEqual(Array.from(b.low));
      expect(Array.from(a.mid)).toEqual(Array.from(b.mid));
      expect(Array.from(a.high)).toEqual(Array.from(b.high));
    }
  });

  it('pita memisahkan sinus rendah, tengah, dan tinggi', () => {
    // Satu sinus murni per pita, amplitudo sama. Yang diuji bukan angkanya —
    // filter satu kutub bertingkat memang tidak datar — melainkan bahwa pita
    // yang BENAR yang menang, karena itulah satu-satunya hal yang dibaca warna.
    const tone = (hz: number): Float32Array => {
      const n = 48000;
      const d = new Float32Array(n);
      for (let i = 0; i < n; i += 1) d[i] = Math.sin((2 * Math.PI * hz * i) / 48000);
      return d;
    };
    // Puncak diambil lintas SEPARUH BELAKANG sinyal, bukan dari satu bucket.
    // Dua sebab, keduanya bisa membalik hasil: bucket 64 sample hanya mencakup
    // 8% dari satu putaran 60 Hz (jadi puncak satu bucket adalah titik acak di
    // sinus, bukan amplitudonya), dan bucket-bucket awal masih berisi transien
    // nyala filter yang bocor ke semua pita.
    const at = (hz: number): { low: number; mid: number; high: number } => {
      const l0 = buildEnvelope(pcm([tone(hz)])).levels[0]!;
      const peak = (a: Float32Array): number => {
        let m = 0;
        for (let i = Math.floor(a.length / 2); i < a.length; i += 1) if (a[i]! > m) m = a[i]!;
        return m;
      };
      return { low: peak(l0.low), mid: peak(l0.mid), high: peak(l0.high) };
    };

    const bass = at(60);
    expect(bass.low).toBeGreaterThan(bass.mid * 3);
    expect(bass.low).toBeGreaterThan(bass.high * 3);

    const vocal = at(700);
    expect(vocal.mid).toBeGreaterThan(vocal.low * 3);
    expect(vocal.mid).toBeGreaterThan(vocal.high * 3);

    const hat = at(9000);
    expect(hat.high).toBeGreaterThan(hat.mid * 3);
    expect(hat.high).toBeGreaterThan(hat.low * 3);
  });

  it('sunyi menghasilkan nol di ketiga pita, bukan NaN', () => {
    const l0 = buildEnvelope(pcm([new Float32Array(64 * 4)])).levels[0]!;
    for (const band of [l0.low, l0.mid, l0.high]) {
      expect(Array.from(band)).toEqual([0, 0, 0, 0]);
    }
  });

  it('puncak pita di level atas persis max dari anak-anaknya', () => {
    const n = 4096 * 4;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      d[i] = Math.sin((2 * Math.PI * 60 * i) / 48000) * (0.2 + 0.8 * (i / n));
    }
    const env = buildEnvelope(pcm([d]));
    const [l0, l1] = [env.levels[0]!, env.levels[1]!];
    const ratio = l1.bucket / l0.bucket;
    for (let i = 0; i < l1.low.length; i += 1) {
      let want = 0;
      for (let k = 0; k < ratio; k += 1) {
        const j = i * ratio + k;
        if (j < l0.low.length && l0.low[j]! > want) want = l0.low[j]!;
      }
      // Eksak, bukan mendekati: agregasi max tidak boleh mendegradasi warna
      // saat user menjauhkan zoom.
      expect(l1.low[i]).toBe(want);
    }
  });

  it('jejak memori tetap ~0,43 byte per frame per channel', () => {
    const frames = 48000 * 10;
    const env = buildEnvelope(pcm([new Float32Array(frames)]));
    const bytes = envelopeBytes(env);
    // 24 B per bucket 64 sample (min/max/rms + tiga pita) = 0,375 B/frame,
    // + ~14% untuk level 1 & 2. Dua kali lipat versi monokrom — dan itu tetap
    // ~160 × lebih kecil dari PCM-nya sendiri, yang membuat harganya tidak
    // pernah jadi bahan pertimbangan.
    expect(bytes / frames).toBeGreaterThan(0.38);
    expect(bytes / frames).toBeLessThan(0.46);
  });
});
