/**
 * Menyimpan & memulihkan sesi halaman DJ.
 *
 * ## Apa yang disimpan, dan kenapa hanya itu
 *
 * Aturannya sama dengan `studio/persist/persistence.ts`: yang disimpan hanya
 * hal yang **merupakan karya**, bukan keadaan sesaat.
 *
 *  - **Cue per asset** (hot cue, cue point, memory cue) — ini yang paling
 *    berharga dan paling mahal dibuat ulang. Ia milik LAGU, jadi ia bertahan
 *    walau decknya ganti.
 *  - **Lagu yang terpasang di deck**, tempo fader, rentang tempo, pad mode,
 *    quantize, dan seluruh posisi mixer — keadaan alat yang disiapkan tangan.
 *
 * Yang **TIDAK** disimpan, dan alasannya persis sama dengan yang ditulis di
 * kepala `persistence.ts`: `playing` dan `playhead`. Memulihkan "sedang
 * berbunyi" membuat audio menyala setelah refresh tanpa user menekan apa pun —
 * di alat DJ itu bukan kejutan kecil, itu suara keras yang tidak diminta.
 *
 * ## Kenapa autosave sendiri, bukan menumpang milik Studio
 *
 * `startAutosave` hanya hidup selama `App` ter-mount, dan yang ia tulis adalah
 * project Studio. Menumpanginya berarti halaman ini menulis ulang project yang
 * bahkan tidak sedang ia tampilkan.
 */

import { loadDjSession, saveDjSession } from '../../studio/persist/db';
import { registerAssetRoot } from '../../studio/persist/asset-roots';
import {
  DECK_IDS,
  EMPTY_TRACK_CUES,
  HOT_CUE_SLOTS,
  defaultMixer,
  normalizeChannel,
  type DeckId,
  type DjState,
  type HotCueBank,
  type TrackCues,
} from '../model';
import { djActions, djStore } from '../store';

/** Naikkan kalau bentuknya berubah dan yang lama tidak bisa dibaca lagi. */
const SCHEMA_VERSION = 1;

interface PersistedDeck {
  readonly assetId: number | null;
  readonly faderTravel: number;
  readonly rangePct: number;
  readonly padMode: string;
  readonly quantize: boolean;
}

interface PersistedSession {
  readonly version: number;
  readonly decks: Readonly<Record<DeckId, PersistedDeck>>;
  readonly cues: Readonly<Record<number, TrackCues>>;
  readonly mixer: DjState['mixer'];
  readonly quantizeDiv: DjState['quantizeDiv'];
  readonly masterDeck: DeckId | null;
  readonly fx: DjState['fx'];
}

function serialize(s: DjState): string {
  const decks = {} as Record<DeckId, PersistedDeck>;
  for (const id of DECK_IDS) {
    const d = s.decks[id];
    decks[id] = {
      assetId: d.assetId,
      faderTravel: d.tempo.fader,
      rangePct: d.tempo.rangePct,
      padMode: d.padMode,
      quantize: d.quantize,
    };
  }
  const data: PersistedSession = {
    version: SCHEMA_VERSION,
    decks,
    cues: s.cues,
    mixer: s.mixer,
    quantizeDiv: s.quantizeDiv,
    masterDeck: s.masterDeck,
    fx: s.fx,
  };
  return JSON.stringify(data);
}

/**
 * Bank hot cue yang dipulihkan harus tetap punya DELAPAN slot.
 *
 * Data lama, data yang disunting tangan, atau data dari versi berikutnya bisa
 * kekurangan slot — dan satu slot yang hilang membuat `cues.hotCues.F` jadi
 * `undefined`, yang lolos tipe (dibaca lewat index) lalu meledak saat digambar.
 */
function normalizeBank(raw: unknown): HotCueBank {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...EMPTY_TRACK_CUES.hotCues } as Record<string, unknown>;
  for (const slot of HOT_CUE_SLOTS) {
    const cue = src[slot];
    if (
      cue !== null &&
      typeof cue === 'object' &&
      typeof (cue as { at?: unknown }).at === 'number'
    ) {
      out[slot] = cue;
    }
  }
  return out as HotCueBank;
}

/**
 * Lengkapi mixer dari sesi tersimpan.
 *
 * Sesi yang ditulis sebelum `eqKill` ada tidak punya field itu, dan membacanya
 * langsung menghasilkan `undefined` yang lolos tipe lalu meledak saat dipakai
 * menghitung gain. Dibaca dengan default alih-alih menaikkan `SCHEMA_VERSION`
 * dan membuang sesi user demi satu objek berisi tiga `false` — alasan yang sama
 * ditulis di `persistence.ts` untuk `masterChain`.
 */
function normalizeMixer(raw: DjState['mixer'] | undefined): DjState['mixer'] {
  const base = defaultMixer();
  if (raw === undefined) return base;
  return {
    ...base,
    ...raw,
    channels: {
      A: normalizeChannel('A', raw.channels?.A),
      B: normalizeChannel('B', raw.channels?.B),
    },
  };
}

function deserialize(json: string): PersistedSession | null {
  try {
    const raw = JSON.parse(json) as Partial<PersistedSession>;
    if (raw.version !== SCHEMA_VERSION) return null;
    const cues: Record<number, TrackCues> = {};
    for (const [key, value] of Object.entries(raw.cues ?? {})) {
      const v = value as Partial<TrackCues>;
      cues[Number(key)] = {
        hotCues: normalizeBank(v.hotCues),
        cuePoint: typeof v.cuePoint === 'number' ? v.cuePoint : 0,
        memoryCues: Array.isArray(v.memoryCues) ? v.memoryCues.filter((n) => typeof n === 'number') : [],
      };
    }
    return { ...(raw as PersistedSession), cues, mixer: normalizeMixer(raw.mixer) };
  } catch {
    return null;
  }
}

/**
 * Id asset yang dipegang sesi TERSIMPAN.
 *
 * Didaftarkan sebagai akar retensi kedua supaya membuka `/studio` di tab baru —
 * tanpa pernah menyentuh `/dj` di tab itu — tidak memangkas lagu yang sedang
 * duduk di deck pada sesi yang tersimpan.
 */
let persistedAssetIds: readonly number[] = [];

export function persistedDeckAssetIds(): readonly number[] {
  return persistedAssetIds;
}

registerAssetRoot(persistedDeckAssetIds);

export interface RestoreDjResult {
  readonly restored: boolean;
  /** Lagu yang tercatat di deck tapi asetnya sudah tidak ada di kepustakaan. */
  readonly missing: number;
}

/**
 * Pulihkan sesi. `assetExists` disuntikkan supaya modul ini bisa dites tanpa
 * store Studio.
 */
export async function restoreDjSession(
  assetExists: (id: number) => boolean,
): Promise<RestoreDjResult> {
  const json = await loadDjSession();
  if (json === null) return { restored: false, missing: 0 };
  const data = deserialize(json);
  if (data === null) return { restored: false, missing: 0 };

  const ids = DECK_IDS.map((id) => data.decks[id]?.assetId).filter(
    (v): v is number => typeof v === 'number',
  );
  persistedAssetIds = [...ids, ...Object.keys(data.cues).map(Number)];

  const base = djStore.getState();
  let missing = 0;
  const decks = { ...base.decks };
  for (const id of DECK_IDS) {
    const d = data.decks[id];
    if (d === undefined) continue;
    decks[id] = {
      ...decks[id],
      tempo: {
        ...decks[id].tempo,
        fader: typeof d.faderTravel === 'number' ? d.faderTravel : 0,
        rangePct: (d.rangePct as 6 | 10 | 16 | 100) ?? 10,
      },
      padMode: (d.padMode as typeof decks[DeckId]['padMode']) ?? 'hotcue',
      quantize: d.quantize !== false,
    };
    if (d.assetId !== null && !assetExists(d.assetId)) missing += 1;
  }

  djActions.hydrate({
    decks,
    cues: data.cues,
    mixer: data.mixer ?? base.mixer,
    quantizeDiv: data.quantizeDiv ?? base.quantizeDiv,
    masterDeck: data.masterDeck ?? null,
    fx: data.fx ?? base.fx,
  });

  return { restored: true, missing };
}

/** Lagu apa yang harus dimuat ke deck setelah kepustakaan siap. */
export async function pendingDeckLoads(): Promise<Readonly<Record<DeckId, number | null>>> {
  const json = await loadDjSession();
  const data = json === null ? null : deserialize(json);
  const out = { A: null, B: null } as Record<DeckId, number | null>;
  if (data === null) return out;
  for (const id of DECK_IDS) out[id] = data.decks[id]?.assetId ?? null;
  return out;
}

let lastJson = '';

/**
 * Tulis sesi SEKARANG, melewati debounce.
 *
 * Terpisah dan diekspor karena ada tiga pemanggil dengan alasan berbeda:
 * penyiraman debounce, `pagehide` (perubahan terakhir tidak boleh hilang di
 * dalam jendela tunggu), dan tes — yang butuh titik tunggal untuk memaksa
 * penulisan alih-alih menunggu timer.
 *
 * Melewati penulisan kalau isinya identik: menulis ulang byte yang sama ke
 * IndexedDB hanya membuang I/O.
 */
export async function flushDjSession(): Promise<void> {
  const s = djStore.getState();
  const json = serialize(s);
  if (json === lastJson) return;
  lastJson = json;
  persistedAssetIds = [
    ...DECK_IDS.map((id) => s.decks[id].assetId).filter((v): v is number => v !== null),
    ...Object.keys(s.cues).map(Number),
  ];
  await saveDjSession(json);
}

/** Hanya untuk tes: lupakan sidik jari tulisan terakhir. */
export function __resetDjSessionForTest(): void {
  lastJson = '';
  persistedAssetIds = [];
}

/**
 * Nyalakan autosave. Mengembalikan fungsi untuk berhenti.
 *
 * Di-debounce dengan alasan yang sama seperti autosave Studio: satu tarikan
 * crossfader menghasilkan puluhan perubahan per detik, dan menulis ke IndexedDB
 * di tengahnya hanya membuang I/O untuk keadaan yang langsung usang.
 */
export function startDjAutosave(delayMs = 600): () => void {
  let timer: number | undefined;

  const schedule = (): void => {
    if (typeof window === 'undefined') return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void flushDjSession();
    }, delayMs);
  };

  const unsub = djStore.subscribe(schedule);
  const onHide = (): void => {
    void flushDjSession();
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);

  return () => {
    unsub();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onHide);
      if (timer !== undefined) window.clearTimeout(timer);
    }
  };
}
