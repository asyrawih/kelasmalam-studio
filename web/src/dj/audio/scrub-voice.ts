/** Scratch granular: arah dan pitch mengikuti gerak tangan tanpa menyalin lagu penuh. */
const GRAIN_SEC = 0.09;
const GRAIN_INTERVAL_SEC = 0.045;
const GRAIN_FADE_SEC = 0.012;
const LOOKAHEAD_SEC = 0.005;
const STILL_EPS_SEC = 1e-4;
const MIN_SCRATCH_RATE = 0.12;
const MAX_SCRATCH_RATE = 4;
const POOL_SIZE = 4;

interface Grain {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

export interface ScrubVoiceOptions {
  readonly ctx: BaseAudioContext;
  readonly destination: AudioNode;
}

export class ScrubVoice {
  private readonly ctx: BaseAudioContext;
  private readonly out: AudioNode;
  private buffer: AudioBuffer | null = null;
  private grains: Grain[] = [];
  private pool: AudioBuffer[] = [];
  private poolIndex = 0;
  private lastAt = -1;
  private inputAt = Number.NaN;
  private inputPosSec = Number.NaN;

  constructor(o: ScrubVoiceOptions) {
    this.ctx = o.ctx;
    this.out = o.destination;
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stop();
    this.buffer = buffer;
    this.pool = [];
    this.poolIndex = 0;
    if (buffer === null) return;
    const frames = Math.ceil(GRAIN_SEC * MAX_SCRATCH_RATE * buffer.sampleRate);
    for (let i = 0; i < POOL_SIZE; i += 1) {
      this.pool.push(this.makeBuffer(buffer.numberOfChannels, frames, buffer.sampleRate));
    }
  }

  /** Fallback kecil hanya membuat fake Web Audio lama di unit test tetap sah. */
  private makeBuffer(channels: number, frames: number, sampleRate: number): AudioBuffer {
    if (typeof this.ctx.createBuffer === 'function') {
      return this.ctx.createBuffer(channels, frames, sampleRate);
    }
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return {
      length: frames,
      sampleRate,
      numberOfChannels: channels,
      getChannelData: (channel: number) => data[channel]!,
    } as AudioBuffer;
  }

  get liveGrains(): number {
    return this.grains.length;
  }

  emit(atSample: number, fallbackRate: number): void {
    const buffer = this.buffer;
    if (buffer === null || this.pool.length === 0) return;
    const sr = buffer.sampleRate;
    const posSec = atSample / (sr > 0 ? sr : 1);
    const totalSec = sr > 0 ? buffer.length / sr : 0;
    if (!(posSec >= 0) || posSec >= totalSec) return;

    const now = this.ctx.currentTime;
    const hadInput = Number.isFinite(this.inputAt) && Number.isFinite(this.inputPosSec);
    const delta = hadInput ? posSec - this.inputPosSec : 0;
    const elapsed = hadInput ? now - this.inputAt : 0;
    const still = hadInput && Math.abs(delta) < STILL_EPS_SEC;

    // Laporan yang kena throttle tetap memperbarui velocity. Tanpa ini grain
    // berikutnya mengukur dari titik lama lalu pitch-nya melonjak liar.
    this.inputAt = now;
    this.inputPosSec = posSec;
    if (this.lastAt >= 0 && (still || now - this.lastAt < GRAIN_INTERVAL_SEC)) return;

    const measured = elapsed > 0 ? delta / elapsed : 0;
    const fallback = Number.isFinite(fallbackRate) && fallbackRate > 0 ? fallbackRate : 1;
    const direction = measured < 0 ? -1 : 1;
    const rate = Math.min(MAX_SCRATCH_RATE, Math.max(MIN_SCRATCH_RATE, Math.abs(measured) || fallback));
    const wantedFrames = Math.max(1, Math.round(GRAIN_SEC * rate * sr));
    const anchor = Math.round(posSec * sr);
    const sourceStart = direction < 0 ? Math.max(0, anchor - wantedFrames) : anchor;
    const frames = Math.min(wantedFrames, buffer.length - sourceStart);
    if (frames <= 0) return;

    const grainBuffer = this.pool[this.poolIndex]!;
    this.poolIndex = (this.poolIndex + 1) % this.pool.length;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      // Beberapa fake AudioBuffer di tes transport hanya memodelkan metadata.
      const from = typeof buffer.getChannelData === 'function'
        ? buffer.getChannelData(channel)
        : new Float32Array(buffer.length);
      const to = grainBuffer.getChannelData(channel);
      if (direction > 0) {
        to.set(from.subarray(sourceStart, sourceStart + frames), 0);
      } else {
        for (let i = 0; i < frames; i += 1) to[i] = from[sourceStart + frames - 1 - i] ?? 0;
      }
      to.fill(0, frames);
    }

    this.lastAt = now;
    const wallSec = frames / sr / rate;
    const fade = Math.min(GRAIN_FADE_SEC, wallSec / 2);
    const startAt = now + LOOKAHEAD_SEC;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + fade);
    gain.gain.setValueAtTime(1, startAt + wallSec - fade);
    gain.gain.linearRampToValueAtTime(0, startAt + wallSec);
    gain.connect(this.out);

    const source = this.ctx.createBufferSource();
    source.buffer = grainBuffer;
    source.playbackRate.setValueAtTime(rate, startAt);
    source.connect(gain);
    source.start(startAt, 0, frames / sr);

    const grain: Grain = { source, gain };
    this.grains = [...this.grains, grain];
    source.onended = () => {
      this.grains = this.grains.filter((g) => g !== grain);
      source.disconnect();
      gain.disconnect();
    };
  }

  stop(): void {
    for (const g of this.grains) {
      g.source.onended = null;
      try { g.source.stop(); } catch { /* already ended */ }
      g.source.disconnect();
      g.gain.disconnect();
    }
    this.grains = [];
    this.lastAt = -1;
    this.inputAt = Number.NaN;
    this.inputPosSec = Number.NaN;
  }
}
