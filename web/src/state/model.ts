/**
 * Mirror read-only dari project model yang hidup di Rust (`crates/timeline-core/src/model.rs`).
 *
 * PENTING: tipe di file ini BUKAN sumber kebenaran. Ia adalah salinan turunan
 * yang dikirim engine ke UI. Kalau nilai di sini berbeda dengan Rust, Rust yang
 * benar. Jangan pernah memutasi objek ini langsung dari komponen — semua
 * perubahan lewat `useEngineCommands()`.
 *
 * Lihat docs/08-ui-mapping.md untuk mapping field → command.
 */

/** Posisi dalam sample di ruang TIMELINE. Sengaja di-brand supaya tidak
 *  tertukar dengan SourceSample (sumber bug off-by-one klasik, Bagian 8d). */
export type TimelineSample = number & { readonly __brand: 'TimelineSample' };

/** Posisi dalam sample di ruang SOURCE (offset di dalam asset PCM). */
export type SourceSample = number & { readonly __brand: 'SourceSample' };

export const timelineSample = (n: number): TimelineSample => n as TimelineSample;
export const sourceSample = (n: number): SourceSample => n as SourceSample;

export type AssetId = number;
export type ClipId = number;
export type TrackId = number;
export type FxId = number;

export type FadeCurve = 'linear' | 'equalPower';

export interface FadeSpec {
  /** Durasi fade dalam sample (ruang timeline). */
  readonly lengthSamples: number;
  readonly curve: FadeCurve;
}

/** Cerminan `struct Clip` dari prompt.md BAGIAN 6a. */
export interface Clip {
  readonly id: ClipId;
  /** Label yang tampil di pojok clip (design: `VERSE A`, `BREAKBEAT LOOP`). */
  readonly name: string;
  readonly assetId: AssetId;
  /** Offset trim-in di dalam source. */
  readonly sourceStart: SourceSample;
  /** Panjang region source yang dipakai. */
  readonly sourceLen: number;
  readonly timelinePos: TimelineSample;
  /** Clip gain, LINEAR (bukan dB). Konversi dB dilakukan di lapisan presentasi. */
  readonly gain: number;
  readonly fadeIn: FadeSpec;
  readonly fadeOut: FadeSpec;
  /** Bagian 8: varispeed. 1.0 = normal. */
  readonly speedRatio: number;
  /** Bagian 6e: belum punya UI di MVP, lihat docs/08 §8e nomor 4. */
  readonly insertChain: readonly FxId[];
}

export interface FxSlot {
  readonly id: FxId;
  readonly kind: string;
  readonly bypassed: boolean;
  /** Ringkasan parameter utama untuk FX Rack (design: `RATIO 4:1`). */
  readonly valueLabel: string;
  /** Nilai 0..1 untuk 4 knob pertama — sumber Plugin Knobs. */
  readonly params: readonly number[];
  /** Index awal param slot di BLOCK 2 SAB untuk efek ini. */
  readonly paramBase: number;
}

/** design menampilkan ini di bawah nama track (AUDIO / MIDI / GROUP).
 *  MIDI belum punya model — lihat docs/08 §Piano Roll & Step Sequencer. */
export type TrackKind = 'AUDIO' | 'MIDI' | 'GROUP';

export interface Track {
  readonly id: TrackId;
  readonly name: string;
  readonly kind: TrackKind;
  readonly color: string;
  /** Ringkasan insert chain untuk baris kecil di channel strip
   *  (design: `COMP · SAT`). Diturunkan dari `insertChain`. */
  readonly fxSummary: string;
  /** Fader gain, LINEAR. Taper adalah urusan UI (docs/08 §Mixer). */
  readonly gain: number;
  /** -1 = kiri penuh, 0 = tengah, +1 = kanan penuh. */
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly armed: boolean;
  readonly clips: readonly Clip[];
  readonly insertChain: readonly FxSlot[];
  readonly sends: readonly number[];
}

export interface AudioAsset {
  readonly id: AssetId;
  readonly name: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly lengthSamples: number;
  /** Pointer ke peak pyramid di WASM linear memory. HARUS dipakai bersama
   *  `memGeneration` — lihat docs/05 §WASM memory growth. */
  readonly peakPtr: number;
  readonly memGeneration: number;
}

export interface TempoMapPoint {
  readonly atTick: number;
  readonly bpm: number;
}

export interface Project {
  readonly name: string;
  readonly sampleRate: number;
  readonly tempoMap: readonly TempoMapPoint[];
  readonly tracks: readonly Track[];
  readonly assets: readonly AudioAsset[];
  readonly masterGain: number;
  readonly masterSpeedRatio: number;
  readonly loopStart: TimelineSample;
  readonly loopEnd: TimelineSample;
  readonly loopEnabled: boolean;
}

export const emptyProject = (sampleRate: number): Project => ({
  name: 'Untitled',
  sampleRate,
  tempoMap: [{ atTick: 0, bpm: 120 }],
  tracks: [],
  assets: [],
  masterGain: 1,
  masterSpeedRatio: 1,
  loopStart: timelineSample(0),
  loopEnd: timelineSample(0),
  loopEnabled: false,
});
