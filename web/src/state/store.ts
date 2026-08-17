/**
 * Store UI minimal berbasis `useSyncExternalStore` (React 18).
 *
 * KENAPA BUKAN ZUSTAND: menambah dependensi berarti menyentuh `package.json`,
 * yang dimiliki agent lain. `useSyncExternalStore` sudah memberi hal yang
 * membuat zustand berguna di sini — langganan berbasis selector, sehingga
 * komponen hanya render ulang saat irisan datanya berubah.
 *
 * KENAPA BUKAN Context + useReducer: Context menyiarkan ke SELURUH consumer
 * setiap kali nilainya berubah. Dengan 32 channel strip yang masing-masing
 * mengamati satu track, satu perubahan gain akan me-render 32 strip.
 *
 * Store ini HANYA menyimpan:
 *   - mirror read-only project (kebenaran ada di Rust; ini salinan UI)
 *   - state presentasi murni (viewport, seleksi, panel, library, export)
 * Tidak ada logika edit di komponen. Semua mutasi lewat `useEngineCommands()`,
 * yang memanggil engine DAN memperbarui mirror ini.
 *
 * Data 60 Hz (meter, playhead, analyzer) TIDAK PERNAH masuk ke sini
 * (docs/08 §Ringkasan arus state) — itu jalur `useMeterFrame` → canvas.
 */

import { useSyncExternalStore } from 'react';
import { emptyProject, type ClipId, type Project, type Track, type TrackId } from './model';

export type GridDivision = 'off' | 'bar' | '1/4' | '1/8' | '1/16' | '1/32';

/** Murni presentasi — tidak pernah di-serialize, tidak pernah menyentuh audio. */
export interface ViewportState {
  /** Sample paling kiri yang terlihat. */
  readonly startSample: number;
  /** Zoom. Satu-satunya sumber kebenaran untuk konversi sample↔pixel. */
  readonly pxPerSample: number;
  readonly widthPx: number;
  readonly scrollTopPx: number;
  readonly trackHeightPx: number;
}

/** Seleksi waktu di Waveform Display (design: region terang 34%..56%). */
export interface TimeSelection {
  readonly startSample: number;
  readonly endSample: number;
}

/** Metadata transport yang tidak dipegang engine (docs/08 §Transport Bar:
 *  signature & key adalah metadata murni). */
export interface TransportMeta {
  readonly bpm: number;
  readonly timeSignature: readonly [number, number];
  readonly key: string;
  readonly metronome: boolean;
  readonly recordArmed: boolean;
  readonly loopEnabled: boolean;
  readonly playing: boolean;
}

export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
  readonly tag: string;
}

export type ExportStage = 'idle' | 'render' | 'encode' | 'done' | 'cancelled' | 'error';

export interface ExportJobState {
  readonly stage: ExportStage;
  readonly rendered: number;
  readonly total: number;
  readonly etaMs: number;
  readonly format: 'wav' | 'mp3' | 'ogg';
  readonly bitDepth: 16 | 24 | 32;
  readonly range: 'project' | 'selection' | 'loop';
  readonly message?: string;
}

export interface UiState {
  readonly project: Project;
  readonly viewport: ViewportState;
  readonly selectedClipIds: readonly ClipId[];
  readonly selectedTrackId: TrackId | null;
  readonly timeSelection: TimeSelection | null;
  readonly grid: GridDivision;
  /** Dimatikan sementara saat modifier ditekan — override snap. */
  readonly snapEnabled: boolean;
  readonly audioUnlocked: boolean;
  readonly transport: TransportMeta;
  readonly library: readonly LibraryEntry[];
  /** Track yang FX Rack / EQ / knob-nya sedang ditampilkan. */
  readonly focusedTrackId: TrackId | null;
  readonly exportJob: ExportJobState;
  /** Latensi output Web Audio (baseLatency + outputLatency) dalam ms. */
  readonly latencyMs: number;
  readonly engineFault: string | null;
}

const initialState = (sampleRate: number): UiState => ({
  project: emptyProject(sampleRate),
  viewport: {
    startSample: 0,
    pxPerSample: 1 / 512,
    widthPx: 0,
    scrollTopPx: 0,
    trackHeightPx: 52, // tinggi lane di design
  },
  selectedClipIds: [],
  selectedTrackId: null,
  timeSelection: null,
  grid: '1/16',
  snapEnabled: true,
  audioUnlocked: false,
  transport: {
    bpm: 128,
    timeSignature: [4, 4],
    key: 'F min',
    metronome: true,
    recordArmed: false,
    loopEnabled: true,
    playing: false,
  },
  library: [],
  focusedTrackId: null,
  exportJob: {
    stage: 'idle',
    rendered: 0,
    total: 0,
    etaMs: 0,
    format: 'wav',
    bitDepth: 24,
    range: 'project',
  },
  latencyMs: 0,
  engineFault: null,
});

type Listener = () => void;

let state: UiState = initialState(48000);
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<UiState> | ((prev: UiState) => Partial<UiState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  let changed = false;
  for (const key of Object.keys(next) as (keyof UiState)[]) {
    if (!Object.is(state[key], next[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...next };
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getState = (): UiState => state;

/**
 * Baca satu irisan state. Komponen hanya render ulang saat hasil `selector`
 * berubah menurut `Object.is`.
 *
 * Selector harus mengembalikan nilai stabil — jangan membuat objek/array baru
 * di dalamnya (`s => ({ a: s.a })` akan render ulang selamanya). Ambil field
 * satu per satu, atau `useUiStore(s => s.project.tracks[i])`.
 */
export function useUiStore<T>(selector: (s: UiState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/** Ganti satu track di mirror tanpa menyentuh track lain — identitas objek
 *  track lain tetap sama, jadi strip mixer lain TIDAK render ulang. */
function replaceTrack(project: Project, id: TrackId, fn: (t: Track) => Track): Project {
  const index = project.tracks.findIndex((t) => t.id === id);
  if (index < 0) return project;
  const tracks = project.tracks.slice();
  tracks[index] = fn(tracks[index]!);
  return { ...project, tracks };
}

/** Aksi presentasi + pemeliharaan mirror. Perhatikan: TIDAK ADA di sini yang
 *  berbicara ke audio — itu tugas `useEngineCommands()`. */
export const uiActions = {
  setProject(project: Project): void {
    setState({ project });
  },
  /** Dipakai `useEngineCommands` untuk menjaga mirror sinkron dengan command
   *  yang baru saja dikirim (engine tidak mengirim balik project). */
  patchTrack(id: TrackId, fn: (t: Track) => Track): void {
    setState((prev) => ({ project: replaceTrack(prev.project, id, fn) }));
  },
  patchProject(fn: (p: Project) => Project): void {
    setState((prev) => ({ project: fn(prev.project) }));
  },
  setViewport(patch: Partial<ViewportState>): void {
    setState((prev) => ({ viewport: { ...prev.viewport, ...patch } }));
  },
  selectClips(ids: readonly ClipId[]): void {
    setState({ selectedClipIds: ids });
  },
  selectTrack(id: TrackId | null): void {
    setState({ selectedTrackId: id, focusedTrackId: id });
  },
  setTimeSelection(sel: TimeSelection | null): void {
    setState({ timeSelection: sel });
  },
  setGrid(grid: GridDivision): void {
    setState({ grid });
  },
  setSnapEnabled(snapEnabled: boolean): void {
    setState({ snapEnabled });
  },
  setAudioUnlocked(audioUnlocked: boolean): void {
    setState({ audioUnlocked });
  },
  patchTransport(patch: Partial<TransportMeta>): void {
    setState((prev) => ({ transport: { ...prev.transport, ...patch } }));
  },
  setLibrary(library: readonly LibraryEntry[]): void {
    setState({ library });
  },
  patchExportJob(patch: Partial<ExportJobState>): void {
    setState((prev) => ({ exportJob: { ...prev.exportJob, ...patch } }));
  },
  setLatencyMs(latencyMs: number): void {
    setState({ latencyMs });
  },
  setEngineFault(engineFault: string | null): void {
    setState({ engineFault });
  },
  /** Dipanggil sekali saat AudioContext siap — sample rate baru diketahui saat
   *  runtime (docs/05 §Safari: jangan paksa sample rate). */
  resetForSampleRate(sampleRate: number): void {
    state = { ...initialState(sampleRate), library: state.library };
    emit();
  },
};

export const uiStore = { getState, subscribe };
