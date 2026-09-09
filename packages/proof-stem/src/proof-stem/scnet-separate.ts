import { runScnet } from './scnet-model';

export type ScnetStem = 'drums' | 'bass' | 'other' | 'vocals';
export interface StereoPcm { readonly left: Float32Array; readonly right: Float32Array }
export type ScnetResult = Record<ScnetStem, StereoPcm>;
export interface ScnetChunk {
  readonly start: number;
  readonly frames: number;
  readonly stems: ScnetResult;
}

const SR = 44_100;
const N_FFT = 4096;
const HOP = 1024;
const CHUNK = 485_100;
const TARGET_PADDED = (476 - 1) * HOP + N_FFT;
const STEMS: readonly ScnetStem[] = ['drums', 'bass', 'other', 'vocals'];

export async function separateScnet(
  source: AudioBuffer,
  onProgress: (done: number, total: number, inferenceMs: number) => void,
): Promise<ScnetResult> {
  if (source.sampleRate !== SR) throw new Error(`SCNet butuh 44.1 kHz, menerima ${source.sampleRate} Hz`);
  const left = source.getChannelData(0);
  const right = source.numberOfChannels > 1 ? source.getChannelData(1) : left;
  const result = Object.fromEntries(STEMS.map((name) => [name, {
    left: new Float32Array(left.length), right: new Float32Array(left.length),
  }])) as ScnetResult;
  const chunks = Math.ceil(left.length / CHUNK);

  for (let index = 0; index < chunks; index += 1) {
    const start = index * CHUNK;
    const valid = Math.min(CHUNK, left.length - start);
    const leftPad = new Float32Array(TARGET_PADDED);
    const rightPad = new Float32Array(TARGET_PADDED);
    leftPad.set(left.subarray(start, start + valid));
    rightPad.set(right.subarray(start, start + valid));

    const leftSpec = stft(leftPad);
    const rightSpec = stft(rightPad);
    const input = spectrogramInput(leftSpec, rightSpec);
    const before = performance.now();
    const output = await runScnet(input, [1, 4, leftSpec.freqs, leftSpec.frames]);
    const inferenceMs = performance.now() - before;

    for (let stemIndex = 0; stemIndex < STEMS.length; stemIndex += 1) {
      const pcm = extractStem(output, stemIndex, leftSpec.freqs, leftSpec.frames);
      result[STEMS[stemIndex]!].left.set(pcm.left.subarray(0, valid), start);
      result[STEMS[stemIndex]!].right.set(pcm.right.subarray(0, valid), start);
    }
    onProgress(index + 1, chunks, inferenceMs);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return result;
}

/** Jalur progressive untuk Web Worker: publish setiap chunk, bukan menunggu lagu selesai. */
export async function separateScnetPcm(
  left: Float32Array,
  right: Float32Array,
  onChunk: (chunk: ScnetChunk, done: number, total: number, inferenceMs: number) => void,
  onPhase: (phase: 'stft' | 'model' | 'istft', chunk: number, total: number) => void = () => {},
): Promise<void> {
  const chunks = Math.ceil(left.length / CHUNK);
  for (let index = 0; index < chunks; index += 1) {
    const start = index * CHUNK;
    const valid = Math.min(CHUNK, left.length - start);
    const leftPad = new Float32Array(TARGET_PADDED);
    const rightPad = new Float32Array(TARGET_PADDED);
    leftPad.set(left.subarray(start, start + valid));
    rightPad.set(right.subarray(start, start + valid));
    onPhase('stft', index + 1, chunks);
    const leftSpec = stft(leftPad);
    const rightSpec = stft(rightPad);
    onPhase('model', index + 1, chunks);
    const before = performance.now();
    const output = await runScnet(
      spectrogramInput(leftSpec, rightSpec),
      [1, 4, leftSpec.freqs, leftSpec.frames],
    );
    onPhase('istft', index + 1, chunks);
    const stems = {} as ScnetResult;
    for (let stemIndex = 0; stemIndex < STEMS.length; stemIndex += 1) {
      const pcm = extractStem(output, stemIndex, leftSpec.freqs, leftSpec.frames);
      stems[STEMS[stemIndex]!] = {
        left: pcm.left.slice(0, valid),
        right: pcm.right.slice(0, valid),
      };
    }
    onChunk({ start, frames: valid, stems }, index + 1, chunks, performance.now() - before);
  }
}

interface Spectrum { real: Float32Array; imag: Float32Array; freqs: number; frames: number }

function fft(real: Float32Array, imag: Float32Array, inverse = false): void {
  const size = real.length;
  let j = 0;
  for (let i = 0; i < size - 1; i += 1) {
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imag[i], imag[j]] = [imag[j]!, imag[i]!];
    }
    let bit = size >> 1;
    while (bit >= 1 && j >= bit) { j -= bit; bit >>= 1; }
    j += bit;
  }
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    const sign = inverse ? 1 : -1;
    for (let offset = 0; offset < size; offset += width) {
      for (let k = 0; k < half; k += 1) {
        const angle = sign * 2 * Math.PI * k / width;
        const wr = Math.cos(angle), wi = Math.sin(angle);
        const a = offset + k, b = a + half;
        const tr = wr * real[b]! - wi * imag[b]!;
        const ti = wr * imag[b]! + wi * real[b]!;
        real[b] = real[a]! - tr; imag[b] = imag[a]! - ti;
        real[a] = real[a]! + tr; imag[a] = imag[a]! + ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < size; i += 1) { real[i] = real[i]! / size; imag[i] = imag[i]! / size; }
}

function stft(signal: Float32Array): Spectrum {
  const freqs = N_FFT / 2 + 1;
  const frames = Math.floor((signal.length - N_FFT) / HOP) + 1;
  const realOut = new Float32Array(freqs * frames);
  const imagOut = new Float32Array(freqs * frames);
  const scale = 1 / Math.sqrt(N_FFT);
  const real = new Float32Array(N_FFT), imag = new Float32Array(N_FFT);
  for (let t = 0; t < frames; t += 1) {
    real.set(signal.subarray(t * HOP, t * HOP + N_FFT)); imag.fill(0);
    fft(real, imag);
    for (let k = 0; k < freqs; k += 1) {
      realOut[k * frames + t] = real[k]! * scale;
      imagOut[k * frames + t] = imag[k]! * scale;
    }
  }
  return { real: realOut, imag: imagOut, freqs, frames };
}

function istft(realInput: Float32Array, imagInput: Float32Array, freqs: number, frames: number): Float32Array {
  const length = (frames - 1) * HOP + N_FFT;
  const output = new Float32Array(length), count = new Float32Array(length);
  const scale = 1 / Math.sqrt(N_FFT);
  const real = new Float32Array(N_FFT), imag = new Float32Array(N_FFT);
  for (let t = 0; t < frames; t += 1) {
    real.fill(0); imag.fill(0);
    for (let k = 0; k < freqs; k += 1) {
      real[k] = realInput[k * frames + t]!; imag[k] = imagInput[k * frames + t]!;
    }
    for (let k = 1; k < freqs - 1; k += 1) {
      real[N_FFT - k] = real[k]!; imag[N_FFT - k] = -imag[k]!;
    }
    fft(real, imag, true);
    const offset = t * HOP;
    for (let n = 0; n < N_FFT; n += 1) {
      output[offset + n] = output[offset + n]! + real[n]! * scale * N_FFT;
      count[offset + n] = count[offset + n]! + 1;
    }
  }
  for (let i = 0; i < length; i += 1) if (count[i]! > 0) output[i] = output[i]! / count[i]!;
  return output;
}

function spectrogramInput(left: Spectrum, right: Spectrum): Float32Array {
  const plane = left.freqs * left.frames;
  const input = new Float32Array(4 * plane);
  input.set(left.real); input.set(left.imag, plane);
  input.set(right.real, plane * 2); input.set(right.imag, plane * 3);
  return input;
}

function extractStem(output: Float32Array, index: number, freqs: number, frames: number): StereoPcm {
  const plane = freqs * frames, base = index * 4 * plane;
  return {
    left: istft(output.subarray(base, base + plane), output.subarray(base + plane, base + 2 * plane), freqs, frames),
    right: istft(output.subarray(base + 2 * plane, base + 3 * plane), output.subarray(base + 3 * plane, base + 4 * plane), freqs, frames),
  };
}
