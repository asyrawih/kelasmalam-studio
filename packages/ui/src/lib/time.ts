/**
 * Konversi waktu untuk lapisan tampilan.
 *
 * CATATAN PENTING (docs/08 §Transport Bar): konversi sample → bar.beat.tick
 * yang MENGIKAT adalah `sample_to_tick()` di `daw-timeline` (Rust), bukan
 * aritmetika float di JS. Fungsi di sini dipakai untuk label dan grid saja,
 * dan hanya valid untuk tempo map konstan. Begitu tempo map ber-segmen
 * dipakai, label harus datang dari Rust — bukan dari sini.
 */

const TICKS_PER_BEAT = 960;

export interface TempoView {
  readonly bpm: number;
  readonly sampleRate: number;
  readonly beatsPerBar: number;
}

export const samplesPerBeat = (t: TempoView): number => (60 * t.sampleRate) / t.bpm;
export const samplesPerBar = (t: TempoView): number => samplesPerBeat(t) * t.beatsPerBar;

/** Format `000.4.03` seperti di design (`fmtTime`). */
export function formatBarBeatTick(sample: number, t: TempoView): string {
  const spb = samplesPerBeat(t);
  const beats = sample / spb;
  const bar = Math.floor(beats / t.beatsPerBar) + 1;
  const beat = Math.floor(beats % t.beatsPerBar) + 1;
  const tick = Math.floor((beats % 1) * TICKS_PER_BEAT * 0.03125); // 0..29
  return `${String(bar).padStart(3, '0')}.${beat}.${String(tick).padStart(2, '0')}`;
}

/** `0:12`, `1:04` — label ruler Waveform Display di design. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** `00:08.412` — label seleksi di design. */
export function formatClockMs(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

export type GridDivision = 'off' | 'bar' | '1/4' | '1/8' | '1/16' | '1/32';

export function gridSamples(grid: GridDivision, t: TempoView): number {
  switch (grid) {
    case 'off':
      return 0;
    case 'bar':
      return samplesPerBar(t);
    case '1/4':
      return samplesPerBeat(t);
    case '1/8':
      return samplesPerBeat(t) / 2;
    case '1/16':
      return samplesPerBeat(t) / 4;
    case '1/32':
      return samplesPerBeat(t) / 8;
  }
}

/**
 * Snap satu posisi. `override` (Alt ditekan) mematikan snap untuk satu gerakan
 * tanpa mengubah setting — perilaku yang sama dengan DAW desktop.
 */
export function snapSample(
  sample: number,
  grid: GridDivision,
  t: TempoView,
  enabled: boolean,
  override: boolean,
): number {
  if (!enabled || override || grid === 'off') return Math.round(sample);
  const step = gridSamples(grid, t);
  if (step <= 0) return Math.round(sample);
  return Math.round(Math.round(sample / step) * step);
}

export interface Viewport {
  readonly startSample: number;
  readonly pxPerSample: number;
}

export const sampleToPx = (sample: number, v: Viewport): number =>
  (sample - v.startSample) * v.pxPerSample;

export const pxToSample = (px: number, v: Viewport): number => v.startSample + px / v.pxPerSample;

export const visibleSamples = (widthPx: number, v: Viewport): number => widthPx / v.pxPerSample;
