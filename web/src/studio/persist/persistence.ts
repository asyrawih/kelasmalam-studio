/**
 * Simpan otomatis + pulihkan project saat boot.
 *
 * Bentuk yang disimpan sengaja hanya berisi hal yang MERUPAKAN PROJECT.
 * State transien (sedang play, sedang drag, clipboard, progress export, status
 * engine) tidak ikut: memulihkan "sedang playing" setelah refresh akan membuat
 * audio berbunyi tanpa user menekan apa pun, dan memulihkan "sedang drag"
 * membuat UI macet menunggu pointer yang tidak pernah dilepas.
 */

import type { StudioLane, StudioState } from '../model';
import {
  DEFAULT_PANEL_ORDER,
  DEFAULT_RAIL_ORDER,
  studioActions,
  studioStore,
  type StudioAppState,
} from '../store';
import { normalizeClipFade } from '../timeline/fade';
import { loadAllAssets, loadProjectJson, pruneAssets, saveProjectJson } from './db';

/** Naikkan kalau bentuk data berubah dan yang lama tidak bisa dibaca lagi. */
const SCHEMA_VERSION = 1;

interface PersistedProject {
  readonly version: number;
  readonly projectName: string;
  readonly sampleRate: number;
  readonly lanes: StudioLane[];
  readonly playhead: number;
  readonly speed: number;
  readonly loop: boolean;
  readonly minDurationSec: number;
  readonly maxDurationSec: number | null;
  readonly eqMode: StudioAppState['eqMode'];
  readonly panelOrder: StudioAppState['panelOrder'];
  readonly railOrder: StudioAppState['railOrder'];
  readonly selectedLaneId: string | null;
  readonly selectedClipId: string | null;
}

export function serialize(s: StudioAppState): string {
  const data: PersistedProject = {
    version: SCHEMA_VERSION,
    projectName: s.projectName,
    sampleRate: s.sampleRate,
    lanes: s.lanes,
    playhead: s.playhead,
    speed: s.speed,
    loop: s.loop,
    minDurationSec: s.minDurationSec,
    maxDurationSec: s.maxDurationSec,
    eqMode: s.eqMode,
    panelOrder: s.panelOrder,
    railOrder: s.railOrder,
    selectedLaneId: s.selectedLaneId,
    selectedClipId: s.selectedClipId,
  };
  return JSON.stringify(data);
}

/** null kalau tidak ada / tidak bisa dibaca — bukan alasan untuk gagal boot. */
export function deserialize(json: string): PersistedProject | null {
  try {
    const d = JSON.parse(json) as Partial<PersistedProject>;
    if (d.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(d.lanes) || d.lanes.length === 0) return null;
    if (typeof d.sampleRate !== 'number' || d.sampleRate <= 0) return null;
    return d as PersistedProject;
  } catch {
    return null;
  }
}

/**
 * Isi field clip yang belum ada di project versi lama.
 *
 * Beda dengan `panelOrder`/`railOrder` yang cukup diberi default sekali di
 * pemanggilan `hydrate`: clip ada di dalam ARRAY di dalam lane, jadi
 * `data.clipField ?? default` tidak punya tempat untuk ditulis. Normalisasi
 * harus turun sampai ke tiap clip, sekali, di pintu masuk.
 */
export function normalizeLanes(lanes: StudioLane[]): StudioLane[] {
  return lanes.map((l) => ({ ...l, clips: (l.clips ?? []).map(normalizeClipFade) }));
}

export interface RestoreResult {
  readonly restored: boolean;
  /** Asset yang gagal di-decode ulang — clip-nya ada tapi bisu. */
  readonly missingAssets: number;
}

/**
 * Pulihkan project + decode ulang audionya.
 *
 * `decodeAsset` disuntikkan (bukan diimpor langsung) supaya modul ini bisa
 * dites tanpa Web Audio.
 */
export async function restoreProject(
  decodeAsset: (id: number, name: string, bytes: ArrayBuffer) => Promise<boolean>,
): Promise<RestoreResult> {
  const json = await loadProjectJson();
  if (json === null) return { restored: false, missingAssets: 0 };
  const data = deserialize(json);
  if (data === null) return { restored: false, missingAssets: 0 };

  // Audio dipulihkan LEBIH DULU, baru state. Kalau urutannya dibalik, UI
  // sempat menggambar clip yang asetnya belum ada dan waveform-nya berkedip
  // dari mock ke bentuk asli.
  const stored = await loadAllAssets();
  let missing = 0;
  for (const a of stored) {
    const ok = await decodeAsset(a.id, a.name, a.bytes);
    if (!ok) missing += 1;
  }

  studioActions.hydrate({
    projectName: data.projectName,
    sampleRate: data.sampleRate,
    lanes: normalizeLanes(data.lanes),
    playhead: data.playhead,
    speed: data.speed as StudioState['speed'],
    loop: data.loop,
    minDurationSec: data.minDurationSec,
    maxDurationSec: data.maxDurationSec,
    eqMode: data.eqMode,
    // Data lama (sebelum panel bisa diurutkan) tidak punya field ini —
    // WAJIB memberi default, bukan `undefined`: menulis key dengan undefined
    // tetap menimpa nilai yang sudah ada di store.
    panelOrder: data.panelOrder ?? DEFAULT_PANEL_ORDER,
    railOrder: data.railOrder ?? DEFAULT_RAIL_ORDER,
    selectedLaneId: data.selectedLaneId,
    selectedClipId: data.selectedClipId,
  });

  return { restored: true, missingAssets: missing };
}

/**
 * Mulai menyimpan otomatis. Mengembalikan fungsi untuk berhenti.
 *
 * Di-debounce, DAN dilewati selama drag/scrub: satu drag clip menghasilkan
 * puluhan perubahan state per detik, dan menulis ke IndexedDB di tengah itu
 * hanya membuang I/O untuk keadaan setengah jadi yang langsung usang.
 */
export function startAutosave(delayMs = 600): () => void {
  let timer: number | undefined;
  let lastJson = '';

  const flush = (): void => {
    const s = studioStore.getState();
    if (s.draggingClip || s.scrubbing) return;
    const json = serialize(s);
    if (json === lastJson) return;
    lastJson = json;
    void saveProjectJson(json);
    // Asset yang clip-nya sudah dihapus tidak perlu ikut memenuhi kuota.
    const used = new Set(s.lanes.flatMap((l) => l.clips.map((c) => c.assetId)));
    void pruneAssets(used);
  };

  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(flush, delayMs);
  };

  const unsub = studioStore.subscribe(schedule);
  // Tulis sekali saat halaman ditutup, supaya perubahan terakhir tidak hilang
  // di dalam jendela debounce.
  const onHide = (): void => flush();
  window.addEventListener('pagehide', onHide);

  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    unsub();
    window.removeEventListener('pagehide', onHide);
  };
}
