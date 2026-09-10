/**
 * Pembangkit sinyal dan pengukur SNR untuk tes vocal-split. Bukan berkas tes
 * (tidak berakhiran `.test.ts`), hanya dibagi antar tes.
 */

/** PRNG deterministik (mulberry32) supaya angka SNR di laporan bisa diulang. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SNR dalam dB: `10·log10(Σref² / Σ(ref − got)²)`; `Infinity` bila identik. */
export function snrDb(ref: ArrayLike<number>, got: ArrayLike<number>): number {
  if (ref.length !== got.length) throw new Error(`Panjang berbeda: ${ref.length} vs ${got.length}`);
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const r = ref[i]!;
    const d = r - got[i]!;
    signal += r * r;
    noise += d * d;
  }
  if (noise === 0) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10(signal / noise);
}

/** Derau putih stereo + sinus 440 Hz / 1 kHz, amplitudo aman dari clipping. */
export function noisePlusSine(length: number, seed = 1, sampleRate = 44_100): { left: Float32Array; right: Float32Array } {
  const rand = mulberry32(seed);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let n = 0; n < length; n += 1) {
    left[n] = 0.3 * (rand() * 2 - 1) + 0.4 * Math.sin((2 * Math.PI * 440 * n) / sampleRate);
    right[n] = 0.3 * (rand() * 2 - 1) + 0.4 * Math.cos((2 * Math.PI * 1000 * n) / sampleRate);
  }
  return { left, right };
}

/**
 * Sinyal band-limited: jumlah `tones` sinus fase acak antara `lowHz` dan
 * `highHz`, dengan AM lambat dan fade in/out raised-cosine `fadeSeconds` di
 * kedua ujung. Energinya di bawah 17,6 kHz (bin 3072) dan di atas ~17 Hz
 * (bin 3), sehingga crop dimF dan nol-kan 3 bin MDX tidak mengubahnya —
 * cocok untuk null-test pipa segmen dengan model identitas.
 */
export function bandLimitedStereo(
  length: number,
  options: { seed?: number; tones?: number; lowHz?: number; highHz?: number; fadeSeconds?: number; sampleRate?: number } = {},
): { left: Float32Array; right: Float32Array } {
  const { seed = 7, tones = 24, lowHz = 300, highHz = 12_000, fadeSeconds = 0.25, sampleRate = 44_100 } = options;
  const rand = mulberry32(seed);
  const freqs: number[] = [];
  const phasesL: number[] = [];
  const phasesR: number[] = [];
  const amps: number[] = [];
  for (let i = 0; i < tones; i += 1) {
    // Sebaran logaritmik supaya bass dan treble sama-sama terwakili.
    freqs.push(lowHz * (highHz / lowHz) ** rand());
    phasesL.push(2 * Math.PI * rand());
    phasesR.push(2 * Math.PI * rand());
    amps.push((0.5 + 0.5 * rand()) / tones);
  }
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const fade = Math.min(Math.floor(fadeSeconds * sampleRate), Math.floor(length / 2));
  for (let n = 0; n < length; n += 1) {
    let l = 0;
    let r = 0;
    for (let i = 0; i < tones; i += 1) {
      const w = (2 * Math.PI * freqs[i]! * n) / sampleRate;
      l += amps[i]! * Math.sin(w + phasesL[i]!);
      r += amps[i]! * Math.sin(w + phasesR[i]!);
    }
    // AM lambat (0,3 Hz) supaya sinyal tidak stasioner sempurna.
    const am = 0.75 + 0.25 * Math.sin((2 * Math.PI * 0.3 * n) / sampleRate);
    let env = am;
    if (n < fade) env *= 0.5 - 0.5 * Math.cos((Math.PI * n) / fade);
    const fromEnd = length - 1 - n;
    if (fromEnd < fade) env *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fade);
    left[n] = l * env;
    right[n] = r * env;
  }
  return { left, right };
}
