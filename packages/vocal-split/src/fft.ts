/**
 * FFT kompleks mixed-radix untuk MDX-Net (docs/26 §1).
 *
 * `nFft` Kim_Vocal_2 = 7680 = 2^9 · 15 — BUKAN pangkat dua, jadi radix-2
 * murni tidak cukup, dan DFT naif O(N²) dilarang (docs/14: 97 detik per
 * STFT).
 *
 * Keputusan algoritma: Cooley-Tukey SATU tingkat, `N = m · p` dengan `m`
 * faktor ganjil (15) dan `p` pangkat dua terbesar yang membagi N (512).
 * Faktor ganjil dikerjakan dengan DFT langsung berukuran `m` (biaya m² per
 * blok, p blok → m·N operasi kompleks = 15·N; terbatas dan jauh dari O(N²)),
 * faktor pangkat dua dengan radix-2 iteratif biasa. Alternatif yang
 * ditolak: Bluestein (chirp-z) butuh tiga FFT 16384 per transform, ≈ 6×
 * lebih mahal; radix-3/radix-5 khusus menambah dua kernel butterfly lagi
 * untuk dijaga. Yang dipilih hanya butuh satu kernel radix-2 + satu loop DFT
 * kecil, dan kebenarannya dibuktikan lawan DFT naif di `__tests__/fft.test.ts`
 * (N = 15, 30, 7680). Untuk N pangkat dua (m = 1) jalurnya jatuh ke radix-2
 * murni; untuk N ganjil (p = 1) ke DFT langsung — keduanya kasus khusus dari
 * rumus yang sama.
 *
 * Presisi: Float64 di dalam. Tensor model memang Float32, tetapi akumulasi
 * galat FFT Float32 pada N = 7680 sudah mendekati −110 dB dan mengancam ambang
 * null-test 100 dB (docs/26 P0). Konversi ke Float32 terjadi sekali di tepi
 * (`mdx-stft.ts`), bukan di tiap butterfly.
 *
 * Semua buffer kerja dialokasikan sekali di `createFft`; `fftForward` dan
 * `fftInverse` bekerja di tempat (in-place) tanpa alokasi.
 */

export interface FftPlan {
  readonly n: number;
  /** Faktor ganjil; `n = m · p`. */
  readonly m: number;
  /** Pangkat dua terbesar yang membagi `n`. */
  readonly p: number;
  /** `W_N^j = exp(−2πi·j/N)` untuk j ∈ [0, n): bagian real dan imajiner. */
  readonly cosN: Float64Array;
  readonly sinN: Float64Array;
  /** `W_m^{(n1·k1) mod m}`, tabel m×m, supaya loop DFT kecil tanpa modulo. */
  readonly cosM: Float64Array;
  readonly sinM: Float64Array;
  /** Permutasi bit-reversal ukuran `p`. */
  readonly bitrev: Uint32Array;
  /** Buffer transposisi ukuran `n` (dipakai hanya bila m > 1). */
  readonly tmpRe: Float64Array;
  readonly tmpIm: Float64Array;
}

export function createFft(n: number): FftPlan {
  if (!Number.isInteger(n) || n < 1 || n > 0x4000_0000) {
    throw new Error(`Ukuran FFT tidak valid: ${n}`);
  }
  // Bit terendah yang menyala = pangkat dua terbesar yang membagi n.
  const p = n & -n;
  const m = n / p;

  const cosN = new Float64Array(n);
  const sinN = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    const angle = (-2 * Math.PI * j) / n;
    cosN[j] = Math.cos(angle);
    sinN[j] = Math.sin(angle);
  }

  const cosM = new Float64Array(m * m);
  const sinM = new Float64Array(m * m);
  for (let n1 = 0; n1 < m; n1 += 1) {
    for (let k1 = 0; k1 < m; k1 += 1) {
      // W_m^x = W_N^{x·p}
      const j = ((n1 * k1) % m) * p;
      cosM[n1 * m + k1] = cosN[j]!;
      sinM[n1 * m + k1] = sinN[j]!;
    }
  }

  const bitrev = new Uint32Array(p);
  const bits = Math.log2(p);
  for (let i = 0; i < p; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) r |= ((i >>> b) & 1) << (bits - 1 - b);
    bitrev[i] = r;
  }

  return {
    n, m, p, cosN, sinN, cosM, sinM, bitrev,
    tmpRe: new Float64Array(m > 1 ? n : 0),
    tmpIm: new Float64Array(m > 1 ? n : 0),
  };
}

/**
 * Radix-2 iteratif di tempat pada `re/im[off .. off + p)`. Twiddle
 * `W_len^j = W_N^{j · (N/len)}` diambil dari tabel N dengan langkah
 * `(p/len) · stride`, `stride = m`, supaya tidak ada tabel twiddle kedua.
 */
function radix2(plan: FftPlan, re: Float64Array, im: Float64Array, off: number, stride: number): void {
  const { p, bitrev, cosN, sinN } = plan;
  for (let i = 0; i < p; i += 1) {
    const j = bitrev[i]!;
    if (j > i) {
      const a = off + i;
      const b = off + j;
      const tr = re[a]!; re[a] = re[b]!; re[b] = tr;
      const ti = im[a]!; im[a] = im[b]!; im[b] = ti;
    }
  }
  for (let len = 2; len <= p; len <<= 1) {
    const half = len >>> 1;
    const tstep = (p / len) * stride;
    for (let start = off; start < off + p; start += len) {
      for (let j = 0; j < half; j += 1) {
        const c = cosN[j * tstep]!;
        const s = sinN[j * tstep]!;
        const a = start + j;
        const b = a + half;
        const br = re[b]!;
        const bi = im[b]!;
        const tr = br * c - bi * s;
        const ti = br * s + bi * c;
        const ar = re[a]!;
        const ai = im[a]!;
        re[b] = ar - tr; im[b] = ai - ti;
        re[a] = ar + tr; im[a] = ai + ti;
      }
    }
  }
}

/** DFT maju, tak dinormalisasi (`X[k] = Σ x[n]·W_N^{nk}`), di tempat. */
export function fftForward(plan: FftPlan, re: Float64Array, im: Float64Array): void {
  const { n, m, p } = plan;
  if (re.length < n || im.length < n) throw new Error(`Buffer FFT lebih pendek dari ${n}`);
  if (m === 1) {
    radix2(plan, re, im, 0, 1);
    return;
  }
  const { cosN, sinN, cosM, sinM, tmpRe, tmpIm } = plan;

  // Tahap 1 — indeks n = p·n1 + n2, k = k1 + m·k2.
  // Untuk tiap n2: DFT langsung panjang m atas x[p·n1 + n2] → Y[k1], kalikan
  // twiddle W_N^{n2·k1}, simpan pada T[k1·p + n2] supaya tahap 2 kontigu.
  for (let n2 = 0; n2 < p; n2 += 1) {
    for (let k1 = 0; k1 < m; k1 += 1) {
      let sr = 0;
      let si = 0;
      for (let n1 = 0; n1 < m; n1 += 1) {
        const x = re[p * n1 + n2]!;
        const y = im[p * n1 + n2]!;
        const c = cosM[n1 * m + k1]!;
        const s = sinM[n1 * m + k1]!;
        sr += x * c - y * s;
        si += x * s + y * c;
      }
      const j = n2 * k1; // < p·m = n, tanpa modulo
      const c = cosN[j]!;
      const s = sinN[j]!;
      tmpRe[k1 * p + n2] = sr * c - si * s;
      tmpIm[k1 * p + n2] = sr * s + si * c;
    }
  }

  // Tahap 2 — radix-2 panjang p untuk tiap k1.
  for (let k1 = 0; k1 < m; k1 += 1) radix2(plan, tmpRe, tmpIm, k1 * p, m);

  // Tahap 3 — X[k1 + m·k2] = T[k1·p + k2].
  for (let k1 = 0; k1 < m; k1 += 1) {
    for (let k2 = 0; k2 < p; k2 += 1) {
      re[k1 + m * k2] = tmpRe[k1 * p + k2]!;
      im[k1 + m * k2] = tmpIm[k1 * p + k2]!;
    }
  }
}

/** DFT balik ternormalisasi 1/N (`x[n] = (1/N) Σ X[k]·W_N^{−nk}`), di tempat. */
export function fftInverse(plan: FftPlan, re: Float64Array, im: Float64Array): void {
  const n = plan.n;
  for (let i = 0; i < n; i += 1) im[i] = -im[i]!;
  fftForward(plan, re, im);
  const scale = 1 / n;
  for (let i = 0; i < n; i += 1) {
    re[i] = re[i]! * scale;
    im[i] = -im[i]! * scale;
  }
}
