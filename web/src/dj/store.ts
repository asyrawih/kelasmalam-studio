/**
 * Store DJ Performance Mixer — `useSyncExternalStore` dengan langganan
 * ber-selector, pola yang sama dengan `studio/store.ts` dan
 * `ui/shell/shell-store.ts`. Tidak ada pustaka, tidak ada Context.
 *
 * ## ATURAN STABILITAS REFERENSI — di sini lebih tajam daripada di Studio
 *
 * Satu gerakan crossfader menghasilkan puluhan `set` per detik, dan dua deck
 * yang masing-masing punya loop rAF waveform TIDAK BOLEH ikut me-render.
 * Karena itu:
 *
 *   1. Selector WAJIB mengembalikan nilai yang stabil secara referensi —
 *      primitif atau objek yang memang tersimpan. `useDj(s => ({a, b}))`
 *      mengarang objek baru tiap panggilan dan me-render selamanya.
 *   2. Fungsi yang MENGEMBALIKAN OBJEK (`crossfaderGains`) dipanggil DI DALAM
 *      render dari nilai primitif — bukan sebagai selector. Ia terlihat seperti
 *      "selector turunan", dan itulah yang membuatnya berbahaya.
 *   3. Semua mutasi deck lewat `patchDeck`, yang mengembalikan `null` kalau
 *      objeknya tidak berubah. `tick()` — satu-satunya aksi yang menyentuh dua
 *      deck — karena itu tetap mengembalikan objek LAMA untuk deck yang diam.
 *   4. `withDerived` mengembalikan state yang MASUK kalau tidak ada invarian
 *      yang dilanggar. Ia berjalan pada setiap `set`, dan `set` berjalan pada
 *      setiap piksel gerakan fader.
 *
 * Dijaga oleh `store-stability.test.tsx`.
 *
 * ## YANG SENGAJA TIDAK ADA DI SINI
 *
 *   - `assets`. Kepustakaan hidup di `studioStore`. Satu registry, satu jalur
 *     decode, satu IndexedDB. Deck hanya memegang `assetId`.
 *   - BPM. Diturunkan lewat `resolveBeatGrid(asset)` saat dipakai, tidak pernah
 *     disalin — `bpmOverride` bisa diubah user di Studio kapan saja.
 *   - Apa pun yang berbau Web Audio. Iterasi ini tidak menyentuhnya sama sekali.
 */

import { useSyncExternalStore } from 'react';

import type { BeatGrid } from '../studio/analysis/beat-grid';
import { samplesPerBeat } from '../studio/analysis/beat-grid';
import {
  EMPTY_TRACK_CUES,
  EQ_KILL_DB,
  EQ_MAX_DB,
  HOT_CUE_COLORS,
  MAX_LOOP_BEATS,
  MAX_MASTER_DB,
  MAX_TRIM_DB,
  MIN_LOOP_BEATS,
  MIN_LOOP_SAMPLES,
  MIN_MASTER_DB,
  MIN_TRIM_DB,
  NO_LOOP,
  TEMPO_STEP_PCT,
  createInitialDj,
  effectiveRate,
  emptyDeck,
  faderForBpm,
  loopLen,
  quantized,
  type BrowseSort,
  type ChannelState,
  type CrossfaderCurve,
  type DeckId,
  type DeckState,
  type DjState,
  type EqBandDj,
  type FxTargetDj,
  type HotCueSlot,
  type LoopState,
  type PadMode,
  type QuantizeDiv,
  type Samples,
  type SyncRole,
  type TempoRange,
  type TrackCues,
} from './model';

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isNaN(v) ? lo : v <= lo ? lo : v >= hi ? hi : v;

const BOTH: readonly DeckId[] = ['A', 'B'];

// ── Inti store ───────────────────────────────────────────────────────────────

let state: DjState = withDerived(createInitialDj());

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getState(): DjState {
  return state;
}

/**
 * `patch` boleh mengembalikan `null` untuk "tidak ada yang berubah" — itu jalur
 * yang paling sering dipakai, karena hampir setiap aksi bisa dipanggil dengan
 * nilai yang sama dengan yang sudah ada (klik pad dua kali, drag fader yang
 * tidak bergerak sepiksel pun).
 */
function set(patch: (s: DjState) => Partial<DjState> | null): void {
  const next = patch(state);
  if (next === null) return;
  const merged = withDerived({ ...state, ...next });
  if (merged === state) return;
  state = merged;
  for (const fn of [...listeners]) fn();
}

export const djStore = { getState, subscribe };

export function useDj(): DjState;
export function useDj<T>(selector: (s: DjState) => T): T;
export function useDj<T>(selector?: (s: DjState) => T): T | DjState {
  return useSyncExternalStore(
    subscribe,
    () => (selector === undefined ? state : selector(state)),
    () => (selector === undefined ? state : selector(state)),
  );
}

// ── Helper mutasi ────────────────────────────────────────────────────────────

/**
 * Ganti SATU deck. Deck yang tidak disentuh mengembalikan objek yang SAMA —
 * itulah yang membuat waveform deck B tidak digambar ulang saat deck A bergerak.
 */
function patchDeck(
  s: DjState,
  id: DeckId,
  fn: (d: DeckState) => DeckState,
): Partial<DjState> | null {
  const before = s.decks[id];
  const after = fn(before);
  if (after === before) return null;
  return { decks: { ...s.decks, [id]: after } };
}

function patchChannel(
  s: DjState,
  id: DeckId,
  fn: (c: ChannelState) => ChannelState,
): Partial<DjState> | null {
  const before = s.mixer.channels[id];
  const after = fn(before);
  if (after === before) return null;
  return { mixer: { ...s.mixer, channels: { ...s.mixer.channels, [id]: after } } };
}

/** Cue milik asset yang sedang dipegang deck, atau `null` kalau deck kosong. */
function cuesOf(s: DjState, id: DeckId): TrackCues | null {
  const assetId = s.decks[id].assetId;
  if (assetId === null) return null;
  return s.cues[assetId] ?? EMPTY_TRACK_CUES;
}

function patchCues(
  s: DjState,
  id: DeckId,
  fn: (c: TrackCues) => TrackCues,
): Partial<DjState> | null {
  const assetId = s.decks[id].assetId;
  if (assetId === null) return null;
  const before = s.cues[assetId] ?? EMPTY_TRACK_CUES;
  const after = fn(before);
  if (after === before) return null;
  return { cues: { ...s.cues, [assetId]: after } };
}

// ── Invarian ─────────────────────────────────────────────────────────────────

function sanitizeLoop(l: LoopState, frames: Samples): LoopState {
  if (l.inAt === null && l.outAt === null) return l.active ? { ...l, active: false } : l;
  const outOfRange =
    (l.inAt !== null && (l.inAt < 0 || l.inAt > frames)) ||
    (l.outAt !== null && (l.outAt < 0 || l.outAt > frames));
  if (outOfRange) return NO_LOOP;
  if (l.active && loopLen(l) === null) return { ...l, active: false };
  return l;
}

/**
 * Invarian ditegakkan DI SATU TEMPAT supaya tiap aksi tidak perlu mengingatnya:
 *
 *  1. playhead di-clamp ke `[0, frames]`;
 *  2. loop yang keluar batas materi DIBUANG, bukan di-clamp — loop yang
 *     diam-diam berpindah tempat lebih buruk daripada loop yang hilang;
 *  3. loop dengan `out <= in` tidak boleh `active`;
 *  4. `masterDeck` yang menunjuk deck kosong jadi `null`;
 *  5. hanya SATU deck boleh `sync: 'master'`;
 *  6. deck kosong tidak boleh `playing`.
 *
 * Tiap sub-objek yang tidak berubah dikembalikan APA ADANYA. Kalau tidak,
 * setiap `set` apa pun akan membangunkan seluruh halaman.
 */
function withDerived(s: DjState): DjState {
  let decks = s.decks;
  let changed = false;

  const write = (id: DeckId, next: DeckState): void => {
    if (!changed) {
      decks = { ...decks };
      changed = true;
    }
    decks = { ...decks, [id]: next };
  };

  for (const id of BOTH) {
    const d = decks[id];
    let next = d;

    const playhead = clamp(d.playhead, 0, Math.max(0, d.frames));
    if (playhead !== d.playhead) next = { ...next, playhead };

    const loop = sanitizeLoop(next.loop, d.frames);
    if (loop !== next.loop) next = { ...next, loop };

    if (d.assetId === null && next.playing) next = { ...next, playing: false };

    if (next !== d) write(id, next);
  }

  let master = s.masterDeck;
  if (master !== null && decks[master].assetId === null) master = null;

  for (const id of BOTH) {
    const d = decks[id];
    const role: SyncRole =
      d.assetId === null ? 'off' : master === id ? 'master' : d.sync === 'master' ? 'follower' : d.sync;
    if (role !== d.sync) write(id, { ...d, sync: role });
  }

  if (!changed && master === s.masterDeck) return s;
  return { ...s, decks, masterDeck: master };
}

// ── Aksi ─────────────────────────────────────────────────────────────────────

export interface LoadDeckInput {
  readonly assetId: number;
  readonly frames: Samples;
  readonly name: string;
  readonly sampleRate: number;
}

export interface SyncResult {
  readonly ok: boolean;
  readonly reason?: string;
}

function scaleLoop(id: DeckId, factor: number): void {
  set((s) =>
    patchDeck(s, id, (d) => {
      const len = loopLen(d.loop);
      if (len === null || d.loop.inAt === null) return d;
      const nextLen = Math.round(len * factor);
      if (nextLen < MIN_LOOP_SAMPLES || d.loop.inAt + nextLen > d.frames) return d;
      const beats =
        d.loop.beats === null ? null : clamp(d.loop.beats * factor, MIN_LOOP_BEATS, MAX_LOOP_BEATS);
      return { ...d, loop: { ...d.loop, outAt: d.loop.inAt + nextLen, beats } };
    }),
  );
}

export const djActions = {
  // — materi —

  loadDeck(id: DeckId, a: LoadDeckInput): void {
    set((s) =>
      patchDeck(s, id, (d) => ({
        ...emptyDeck(id),
        assetId: a.assetId,
        frames: Math.max(0, Math.round(a.frames)),
        name: a.name,
        sampleRate: a.sampleRate > 0 ? a.sampleRate : 48_000,
        // Tempo fader, pad mode, dan quantize TIDAK direset saat memuat lagu:
        // DJ menyiapkan tempo lebih dulu, lalu memuat lagunya. Mereset di sini
        // membatalkan persiapan itu tepat pada momen yang paling tidak boleh.
        tempo: d.tempo,
        padMode: d.padMode,
        quantize: d.quantize,
      })),
    );
  },

  /**
   * Kosongkan deck. Cue TIDAK ikut hilang — ia milik asset, dan asset-nya masih
   * ada di kepustakaan (lihat `TrackCues` di model.ts).
   */
  ejectDeck(id: DeckId): void {
    set((s) => patchDeck(s, id, (d) => ({ ...emptyDeck(id), tempo: d.tempo })));
  },

  // — transport —

  play(id: DeckId): void {
    set((s) =>
      patchDeck(s, id, (d) => (d.playing || d.assetId === null ? d : { ...d, playing: true })),
    );
  },

  pause(id: DeckId): void {
    set((s) => patchDeck(s, id, (d) => (d.playing ? { ...d, playing: false } : d)));
  },

  togglePlay(id: DeckId): void {
    set((s) => patchDeck(s, id, (d) => (d.assetId === null ? d : { ...d, playing: !d.playing })));
  },

  /**
   * Semantik CDJ, tiga jalur:
   *   - sedang PLAYING → lompat ke cue point dan BERHENTI;
   *   - sedang DIAM di cue point → putar-tahan (cue preview);
   *   - sedang DIAM di tempat lain → PASANG cue point di sini, lalu tetap diam.
   */
  cuePress(id: DeckId): void {
    set((s) => {
      const d = s.decks[id];
      if (d.assetId === null) return null;
      const cues = cuesOf(s, id) ?? EMPTY_TRACK_CUES;
      if (d.playing) {
        return patchDeck(s, id, (x) => ({
          ...x,
          playing: false,
          playhead: cues.cuePoint,
          seekEpoch: x.seekEpoch + 1,
        }));
      }
      if (d.playhead === cues.cuePoint) {
        return patchDeck(s, id, (x) => ({ ...x, playing: true, cueHeld: true }));
      }
      return patchCues(s, id, (c) => ({ ...c, cuePoint: d.playhead }));
    });
  },

  /** Lepas CUE: kalau tadi putar-tahan, kembali ke cue point dan berhenti. */
  cueRelease(id: DeckId): void {
    set((s) => {
      const d = s.decks[id];
      if (!d.cueHeld) return null;
      const cues = cuesOf(s, id) ?? EMPTY_TRACK_CUES;
      return patchDeck(s, id, (x) => ({
        ...x,
        cueHeld: false,
        playing: false,
        playhead: cues.cuePoint,
        seekEpoch: x.seekEpoch + 1,
      }));
    });
  },

  setCuePoint(id: DeckId, at: Samples): void {
    set((s) => patchCues(s, id, (c) => ({ ...c, cuePoint: Math.max(0, Math.round(at)) })));
  },

  /** Pindah posisi EKSPLISIT. Menaikkan `seekEpoch`. */
  seek(id: DeckId, at: Samples): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        const next = clamp(Math.round(at), 0, d.frames);
        return next === d.playhead ? d : { ...d, playhead: next, seekEpoch: d.seekEpoch + 1 };
      }),
    );
  },

  /**
   * Tulis posisi dari JAM AUDIO. TIDAK menaikkan `seekEpoch`.
   *
   * Itu bukan detail: `seekEpoch` adalah satu-satunya penanda "user melompat",
   * dan lapisan audio hanya menjadwalkan ulang source ketika ia berubah. Kalau
   * umpan jam ikut menaikkannya, setiap kiriman posisi akan memulai ulang
   * sumbernya dan yang terdengar hanya deretan klik.
   */
  syncFromClock(id: DeckId, at: Samples): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        const next = clamp(Math.round(at), 0, d.frames);
        return next === d.playhead ? d : { ...d, playhead: next };
      }),
    );
  },

  /** Geser relatif TANPA menaikkan `seekEpoch` — untuk jog halus. */
  nudge(id: DeckId, deltaSamples: number): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        const next = clamp(Math.round(d.playhead + deltaSamples), 0, d.frames);
        return next === d.playhead ? d : { ...d, playhead: next };
      }),
    );
  },

  setBend(id: DeckId, ratio: number): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        const next = clamp(ratio, 0.5, 1.5);
        return next === d.bend ? d : { ...d, bend: next };
      }),
    );
  },

  beatJump(id: DeckId, beats: number, grid: BeatGrid | null): void {
    set((s) => {
      const d = s.decks[id];
      if (grid === null || d.assetId === null) return null;
      const delta = beats * samplesPerBeat(grid, d.sampleRate);
      return patchDeck(s, id, (x) => {
        const next = clamp(Math.round(x.playhead + delta), 0, x.frames);
        return next === x.playhead ? x : { ...x, playhead: next, seekEpoch: x.seekEpoch + 1 };
      });
    });
  },

  /**
   * Majukan SEMUA deck yang playing sebesar `dtMs` waktu dinding × laju efektif.
   *
   * Jam UI, BUKAN jam audio — persis seperti `tick` di `studio/store.ts`, dan
   * sumbernya diganti di fase audio. Menghormati loop aktif dan berhenti di
   * ujung materi. Deck yang TIDAK playing mengembalikan objek yang sama, supaya
   * sisi layar yang diam benar-benar tidak me-render.
   */
  tick(dtMs: number): void {
    set((s) => {
      let decks = s.decks;
      let changed = false;
      for (const id of BOTH) {
        const d = decks[id];
        if (!d.playing || d.assetId === null) continue;
        const advance = (dtMs / 1000) * d.sampleRate * effectiveRate(d);
        if (!(advance > 0)) continue;
        let next = d.playhead + advance;
        const len = loopLen(d.loop);
        if (d.loop.active && len !== null && d.loop.inAt !== null && d.loop.outAt !== null) {
          if (next >= d.loop.outAt) {
            // Modulo, bukan lompat-ke-in: pada loop pendek satu tick bisa
            // melewati beberapa putaran, dan lompat-ke-in akan menahan playhead
            // di tempat alih-alih memutarnya.
            next = d.loop.inAt + ((next - d.loop.inAt) % len);
          }
        }
        let playing = true;
        if (next >= d.frames) {
          next = d.frames;
          playing = false;
        }
        if (!changed) changed = true;
        decks = { ...decks, [id]: { ...d, playhead: Math.round(next), playing } };
      }
      return changed ? { decks } : null;
    });
  },

  // — hot cue (milik ASSET) —

  setHotCue(id: DeckId, slot: HotCueSlot, at: Samples): void {
    set((s) =>
      patchCues(s, id, (c) => ({
        ...c,
        hotCues: {
          ...c.hotCues,
          [slot]: { at: Math.max(0, Math.round(at)), label: '', color: HOT_CUE_COLORS[slot] },
        },
      })),
    );
  },

  /** Klik pad. Terisi → lompat. Kosong → pasang di posisi kini (di-quantize). */
  triggerHotCue(id: DeckId, slot: HotCueSlot, grid: BeatGrid | null): void {
    const s0 = state;
    const d = s0.decks[id];
    if (d.assetId === null) return;
    const cue = (s0.cues[d.assetId] ?? EMPTY_TRACK_CUES).hotCues[slot];
    if (cue === null) {
      const at = quantized(d.playhead, grid, d.sampleRate, d.quantize, s0.quantizeDiv);
      djActions.setHotCue(id, slot, at);
      return;
    }
    djActions.seek(id, cue.at);
  },

  clearHotCue(id: DeckId, slot: HotCueSlot): void {
    set((s) =>
      patchCues(s, id, (c) =>
        c.hotCues[slot] === null ? c : { ...c, hotCues: { ...c.hotCues, [slot]: null } },
      ),
    );
  },

  renameHotCue(id: DeckId, slot: HotCueSlot, label: string): void {
    set((s) =>
      patchCues(s, id, (c) => {
        const cue = c.hotCues[slot];
        if (cue === null || cue.label === label) return c;
        return { ...c, hotCues: { ...c.hotCues, [slot]: { ...cue, label } } };
      }),
    );
  },

  // — memory cue —

  addMemoryCue(id: DeckId, at: Samples): void {
    set((s) =>
      patchCues(s, id, (c) => {
        const v = Math.max(0, Math.round(at));
        if (c.memoryCues.includes(v)) return c;
        return { ...c, memoryCues: [...c.memoryCues, v].sort((x, y) => x - y) };
      }),
    );
  },

  removeMemoryCue(id: DeckId, at: Samples): void {
    set((s) =>
      patchCues(s, id, (c) => {
        const next = c.memoryCues.filter((v) => v !== at);
        return next.length === c.memoryCues.length ? c : { ...c, memoryCues: next };
      }),
    );
  },

  /** CALL ◀ / ▶ — lompat ke memory cue terdekat ke arah `dir`. */
  callMemoryCue(id: DeckId, dir: -1 | 1): void {
    const s0 = state;
    const cues = cuesOf(s0, id);
    if (cues === null) return;
    const at = s0.decks[id].playhead;
    const target =
      dir === 1
        ? cues.memoryCues.find((v) => v > at + 1)
        : [...cues.memoryCues].reverse().find((v) => v < at - 1);
    if (target === undefined) return;
    djActions.seek(id, target);
  },

  // — loop —

  setLoopIn(id: DeckId, at: Samples, grid: BeatGrid | null): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        const v = quantized(Math.round(at), grid, d.sampleRate, d.quantize, s.quantizeDiv);
        return {
          ...d,
          loop: { ...d.loop, inAt: clamp(v, 0, d.frames), active: false, beats: null },
        };
      }),
    );
  },

  /** Menutup loop otomatis MENGAKTIFKANNYA — itu yang selalu dimaksud. */
  setLoopOut(id: DeckId, at: Samples, grid: BeatGrid | null): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        if (d.loop.inAt === null) return d;
        const v = quantized(Math.round(at), grid, d.sampleRate, d.quantize, s.quantizeDiv);
        const outAt = clamp(v, 0, d.frames);
        if (outAt - d.loop.inAt < MIN_LOOP_SAMPLES) return d;
        return { ...d, loop: { ...d.loop, outAt, active: true } };
      }),
    );
  },

  /** Loop N ketukan mulai dari posisi kini (di-quantize kalau menyala). */
  setBeatLoop(id: DeckId, beats: number, grid: BeatGrid | null): void {
    set((s) => {
      const d = s.decks[id];
      if (grid === null || d.assetId === null) return null;
      const b = clamp(beats, MIN_LOOP_BEATS, MAX_LOOP_BEATS);
      const inAt = quantized(d.playhead, grid, d.sampleRate, d.quantize, s.quantizeDiv);
      const len = Math.max(MIN_LOOP_SAMPLES, Math.round(b * samplesPerBeat(grid, d.sampleRate)));
      return patchDeck(s, id, (x) => ({
        ...x,
        loop: { inAt, outAt: Math.min(x.frames, inAt + len), active: true, beats: b },
      }));
    });
  },

  /**
   * ÷2 dan ×2. JANGKARNYA `inAt`, bukan playhead — menjangkarkan di playhead
   * membuat loop bergeser tiap kali dibagi, dan setelah tiga kali ia tidak lagi
   * jatuh di ketukan mana pun.
   */
  halveLoop(id: DeckId): void {
    scaleLoop(id, 0.5);
  },

  doubleLoop(id: DeckId): void {
    scaleLoop(id, 2);
  },

  exitLoop(id: DeckId): void {
    set((s) =>
      patchDeck(s, id, (d) => (d.loop.active ? { ...d, loop: { ...d.loop, active: false } } : d)),
    );
  },

  reloop(id: DeckId): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        if (loopLen(d.loop) === null || d.loop.inAt === null) return d;
        return {
          ...d,
          loop: { ...d.loop, active: true },
          playhead: d.loop.inAt,
          seekEpoch: d.seekEpoch + 1,
        };
      }),
    );
  },

  clearLoop(id: DeckId): void {
    set((s) => patchDeck(s, id, (d) => (d.loop === NO_LOOP ? d : { ...d, loop: NO_LOOP })));
  },

  // — tempo & sync —

  setTempoFader(id: DeckId, v: number): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        const next = clamp(v, -1, 1);
        return next === d.tempo.fader ? d : { ...d, tempo: { ...d.tempo, fader: next } };
      }),
    );
  },

  /** Nudge satu langkah terkecil dari rentang yang sedang dipakai. */
  nudgeTempoFader(id: DeckId, dir: -1 | 1): void {
    set((s) =>
      patchDeck(s, id, (d) => {
        const stepPct = TEMPO_STEP_PCT[d.tempo.rangePct];
        const next = clamp(d.tempo.fader + (dir * stepPct) / d.tempo.rangePct, -1, 1);
        return next === d.tempo.fader ? d : { ...d, tempo: { ...d.tempo, fader: next } };
      }),
    );
  },

  /**
   * Ganti RANGE tanpa menggerakkan fader — meniru perangkat keras. Persen yang
   * dihasilkan posisi yang sama karena itu MEMANG berubah, dan itu yang benar.
   */
  setTempoRange(id: DeckId, r: TempoRange): void {
    set((s) =>
      patchDeck(s, id, (d) =>
        d.tempo.rangePct === r ? d : { ...d, tempo: { ...d.tempo, rangePct: r } },
      ),
    );
  },

  /** Reset tempo — di rekordbox ini klik-ganda pada angka %. */
  resetTempo(id: DeckId): void {
    set((s) =>
      patchDeck(s, id, (d) =>
        d.tempo.fader === 0 ? d : { ...d, tempo: { ...d.tempo, fader: 0 } },
      ),
    );
  },

  toggleKeyLock(id: DeckId): void {
    set((s) =>
      patchDeck(s, id, (d) => ({ ...d, tempo: { ...d.tempo, keyLock: !d.tempo.keyLock } })),
    );
  },

  setMasterDeck(id: DeckId | null): void {
    set((s) => (s.masterDeck === id ? null : { masterDeck: id }));
  },

  /**
   * SYNC: hitung posisi fader yang menyamakan BPM efektif deck ini dengan deck
   * master, lalu tulis.
   *
   * Mengembalikan ALASAN kegagalan alih-alih diam. Fader yang mentok sambil
   * mengaku SYNC hanya ketahuan lewat telinga, setelah dua lagu terlanjur
   * melenceng di depan orang.
   */
  applySync(id: DeckId, selfBpm: number | null, masterBpm: number | null): SyncResult {
    const s0 = state;
    if (s0.masterDeck === null || s0.masterDeck === id) {
      return { ok: false, reason: 'belum ada deck MASTER' };
    }
    if (selfBpm === null) return { ok: false, reason: `deck ${id} belum punya beat grid` };
    if (masterBpm === null) {
      return { ok: false, reason: `deck ${s0.masterDeck} belum punya beat grid` };
    }
    const range = s0.decks[id].tempo.rangePct;
    const fader = faderForBpm(masterBpm, selfBpm, range);
    if (fader === null) {
      return {
        ok: false,
        reason: `selisih tempo di luar rentang ±${range}% — ganti rentang tempo dulu`,
      };
    }
    set((sx) =>
      patchDeck(sx, id, (d) => ({ ...d, sync: 'follower', tempo: { ...d.tempo, fader } })),
    );
    return { ok: true };
  },

  /**
   * SYNC nyala ↔ mati.
   *
   * Menyalakan menghitung ulang tempo terhadap master; mematikan **meninggalkan
   * tempo fader di tempatnya**. Itu perilaku yang benar dan bukan kemalasan:
   * DJ mematikan SYNC justru untuk mengambil alih tempo yang sudah selaras,
   * dan mengembalikan fader ke nol akan melempar lagunya keluar dari beat
   * tepat pada saat ia mengambil kendali.
   */
  toggleSync(id: DeckId, selfBpm: number | null, masterBpm: number | null): SyncResult {
    if (state.decks[id].sync === 'follower') {
      set((s) => patchDeck(s, id, (d) => ({ ...d, sync: 'off' })));
      return { ok: true };
    }
    return djActions.applySync(id, selfBpm, masterBpm);
  },

  setSyncRole(id: DeckId, role: SyncRole): void {
    set((s) => patchDeck(s, id, (d) => (d.sync === role ? d : { ...d, sync: role })));
  },

  setQuantizeDiv(div: QuantizeDiv): void {
    set((s) => (s.quantizeDiv === div ? null : { quantizeDiv: div }));
  },

  /**
   * SLIP.
   *
   * Posisi bayangannya hidup di `DeckPlayer`, bukan di store: ia bergerak
   * kontinu dari jam audio, dan menyimpannya di store berarti menulis ulang
   * state 60×/detik untuk angka yang hanya dibaca pada satu momen — saat slip
   * dilepas.
   */
  toggleSlip(id: DeckId): void {
    set((s) => patchDeck(s, id, (d) => ({ ...d, slip: !d.slip })));
  },

  toggleQuantize(id: DeckId): void {
    set((s) => patchDeck(s, id, (d) => ({ ...d, quantize: !d.quantize })));
  },

  setPadMode(id: DeckId, mode: PadMode): void {
    set((s) => patchDeck(s, id, (d) => (d.padMode === mode ? d : { ...d, padMode: mode })));
  },

  // — mixer —

  setCrossfader(v: number): void {
    set((s) => {
      const next = clamp(v, 0, 1);
      return next === s.mixer.crossfader ? null : { mixer: { ...s.mixer, crossfader: next } };
    });
  },

  setCrossfaderCurve(c: CrossfaderCurve): void {
    set((s) => (s.mixer.curve === c ? null : { mixer: { ...s.mixer, curve: c } }));
  },

  setChannelFader(id: DeckId, travel: number): void {
    set((s) =>
      patchChannel(s, id, (c) => {
        const next = clamp(travel, 0, 1);
        return next === c.fader ? c : { ...c, fader: next };
      }),
    );
  },

  setTrim(id: DeckId, db: number): void {
    set((s) =>
      patchChannel(s, id, (c) => {
        const next = clamp(db, MIN_TRIM_DB, MAX_TRIM_DB);
        return next === c.trimDb ? c : { ...c, trimDb: next };
      }),
    );
  },

  setEqBand(id: DeckId, band: EqBandDj, db: number): void {
    set((s) =>
      patchChannel(s, id, (c) => {
        const next = clamp(db, EQ_KILL_DB, EQ_MAX_DB);
        return next === c.eq[band] ? c : { ...c, eq: { ...c.eq, [band]: next } };
      }),
    );
  },

  /**
   * KILL band. Di rekordbox ini dilakukan dengan mengklik LABEL `HIGH`/`MID`/
   * `LOW` (klik-ganda pada KNOB-nya yang mengembalikan ke 0) — dua gerakan
   * berbeda pada dua sasaran yang berdempetan, dan kita meniru keduanya.
   *
   * Yang di-toggle adalah BIT, bukan nilai knob. Menimpa nilainya berarti
   * menyalakan kembali band akan mengembalikannya ke 0 dan membuang setelan
   * yang sudah dibuat tangan — kehilangan yang tidak bisa dibatalkan, dengan
   * penyebab yang tidak kelihatan. Lihat `EqKill` di model.
   */
  toggleEqKill(id: DeckId, band: EqBandDj): void {
    set((s) =>
      patchChannel(s, id, (c) => ({
        ...c,
        eqKill: { ...c.eqKill, [band]: !c.eqKill[band] },
      })),
    );
  },

  resetEqBand(id: DeckId, band: EqBandDj): void {
    set((s) =>
      patchChannel(s, id, (c) => (c.eq[band] === 0 ? c : { ...c, eq: { ...c.eq, [band]: 0 } })),
    );
  },

  setFilter(id: DeckId, v: number): void {
    set((s) =>
      patchChannel(s, id, (c) => {
        const next = clamp(v, -1, 1);
        return next === c.filter ? c : { ...c, filter: next };
      }),
    );
  },

  toggleCue(id: DeckId): void {
    set((s) => patchChannel(s, id, (c) => ({ ...c, cue: !c.cue })));
  },

  setCueMix(v: number): void {
    set((s) => {
      const next = clamp(v, 0, 1);
      return next === s.mixer.cueMix ? null : { mixer: { ...s.mixer, cueMix: next } };
    });
  },

  setCueDb(db: number): void {
    set((s) => {
      const next = clamp(db, MIN_MASTER_DB, MAX_MASTER_DB);
      return next === s.mixer.cueDb ? null : { mixer: { ...s.mixer, cueDb: next } };
    });
  },

  setMasterDb(db: number): void {
    set((s) => {
      const next = clamp(db, MIN_MASTER_DB, MAX_MASTER_DB);
      return next === s.mixer.masterDb ? null : { mixer: { ...s.mixer, masterDb: next } };
    });
  },

  // — beat fx —

  toggleFx(): void {
    set((s) => ({ fx: { ...s.fx, on: !s.fx.on } }));
  },

  setFxKind(kind: string): void {
    set((s) => (s.fx.kind === kind ? null : { fx: { ...s.fx, kind } }));
  },

  setFxTarget(t: FxTargetDj): void {
    set((s) => (s.fx.target === t ? null : { fx: { ...s.fx, target: t } }));
  },

  setFxBeats(beats: number): void {
    set((s) => (s.fx.beats === beats ? null : { fx: { ...s.fx, beats } }));
  },

  setFxLevel(v: number): void {
    set((s) => {
      const next = clamp(v, 0, 1);
      return next === s.fx.level ? null : { fx: { ...s.fx, level: next } };
    });
  },

  // — browser —

  setBrowseQuery(q: string): void {
    set((s) => (s.browse.query === q ? null : { browse: { ...s.browse, query: q } }));
  },

  /** Klik kolom yang sama membalik arah — konvensi tabel di mana pun. */
  setBrowseSort(sort: BrowseSort): void {
    set((s) =>
      s.browse.sort === sort
        ? { browse: { ...s.browse, ascending: !s.browse.ascending } }
        : { browse: { ...s.browse, sort, ascending: true } },
    );
  },

  selectBrowseAsset(assetId: number | null): void {
    set((s) =>
      s.browse.selectedAssetId === assetId
        ? null
        : { browse: { ...s.browse, selectedAssetId: assetId } },
    );
  },

  // — meta —

  setAudioStatus(ready: boolean, error: string | null): void {
    set((s) =>
      s.audioReady === ready && s.audioError === error
        ? null
        : { audioReady: ready, audioError: error },
    );
  },

  /** Satu baris pesan yang harus dibaca user. `null` menghapusnya. */
  setNotice(notice: string | null): void {
    set((s) => (s.notice === notice ? null : { notice }));
  },

  hydrate(data: Partial<DjState>): void {
    set(() => data);
  },

  __resetForTest(): void {
    state = withDerived(createInitialDj());
    for (const fn of [...listeners]) fn();
  },
};

// ── Selector siap pakai (stabil secara referensi) ────────────────────────────

export const selectDeck =
  (id: DeckId) =>
  (s: DjState): DeckState =>
    s.decks[id];

export const selectChannel =
  (id: DeckId) =>
  (s: DjState): ChannelState =>
    s.mixer.channels[id];

export const selectTrackCues =
  (id: DeckId) =>
  (s: DjState): TrackCues => {
    const assetId = s.decks[id].assetId;
    if (assetId === null) return EMPTY_TRACK_CUES;
    return s.cues[assetId] ?? EMPTY_TRACK_CUES;
  };

/**
 * Id asset yang dipegang deck ATAU yang punya cue tersimpan.
 *
 * Dipakai sebagai AKAR RETENSI oleh `studio/persist/asset-roots.ts`: tanpa ini,
 * autosave Studio berikutnya menghapus byte lagu yang sedang duduk di deck,
 * karena definisi "terpakai" di sana hanya membaca clip di lane.
 */
export function djAssetIds(): readonly number[] {
  const s = state;
  const out = new Set<number>();
  for (const id of BOTH) {
    const a = s.decks[id].assetId;
    if (a !== null) out.add(a);
  }
  for (const key of Object.keys(s.cues)) out.add(Number(key));
  return [...out];
}
