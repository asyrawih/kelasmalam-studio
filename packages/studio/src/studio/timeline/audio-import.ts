/**
 * Import file audio yang di-drop ke sebuah LANE.
 *
 * Bagian yang tidak tahu lane — sniff, gunzip, decode, peak pyramid, dedup
 * hash, `registerAsset` — hidup di `@kelasmalam/studio-core/timeline/audio-import`
 * (docs/25 P4). Yang tersisa di sini hanya "aset yang sudah terdaftar → satu
 * clip di lane", supaya halaman `/dj` bisa memakai jalur decode yang sama
 * tanpa menarik store lane.
 */

import {
  importBytesToAsset,
  readFileBytes,
  type ImportProgressFn,
} from '@kelasmalam/studio-core/timeline/audio-import';
import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';
import { studioActions, studioStore } from '../store';

export interface DropResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Decode `file` lalu buat clip di `laneId` mulai `startSamples`.
 * Mengembalikan alasan kegagalan alih-alih melempar, supaya UI bisa
 * menampilkannya tanpa merusak render.
 */
export async function importFileToLane(
  file: File,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  let bytes: ArrayBuffer;
  try {
    bytes = await readFileBytes(file, opts.onProgress);
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : 'gagal membaca file' };
  }
  return importBytesToLane(bytes, file.name, laneId, startSamples, projectSampleRate, opts);
}

/** Ujung materi terjauh di sebuah lane, dalam sample. 0 kalau lane kosong. */
export function laneContentEnd(laneId: string): number {
  const lane = studioStore.getState().lanes.find((l) => l.id === laneId);
  if (lane === undefined) return 0;
  let end = 0;
  for (const c of lane.clips) end = Math.max(end, c.start + c.len);
  return end;
}

export interface LaneImportOptions {
  readonly onProgress?: ImportProgressFn;
  /**
   * Taruh clip di belakang materi yang sudah ada di lane, bukan persis di
   * `startSamples`.
   *
   * Untuk SATU perbuatan yang membawa beberapa file (pilih 3 lagu dari file
   * manager, drop 3 file sekaligus). Tanpa ini ketiganya mendarat di titik yang
   * sama dan saling menumpuk — di layar hanya terlihat satu clip, dua sisanya
   * seperti hilang.
   *
   * Perhitungannya WAJIB terjadi di sini, tepat sebelum clip dibuat, bukan saat
   * import dimulai: ketiga import berjalan bersamaan, jadi saat dimulai lane-nya
   * masih kosong untuk ketiga-tiganya dan ketiganya akan menghitung posisi yang
   * sama persis. Yang membedakan mereka hanya keadaan lane pada saat masing-masing
   * SELESAI.
   */
  readonly avoidOverlap?: boolean;
}

/**
 * Jalur import ke LANE — sekarang tipis: decode lewat `importBytesToAsset`,
 * lalu satu clip. Dipakai drop file MAUPUN import dari URL, jadi keduanya tetap
 * berperilaku persis sama.
 */
export async function importBytesToLane(
  input: ArrayBuffer,
  name: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  const got = await importBytesToAsset(input, name, projectSampleRate, opts.onProgress);
  if (!got.ok) return { ok: false, reason: got.reason };

  placeAssetOnLane(got.assetId, name, got.frames, laneId, startSamples, opts);
  return { ok: true };
}

/**
 * Taruh asset yang SUDAH terdaftar sebagai satu clip di lane.
 *
 * Dipisah dari `importBytesToLane` supaya bentuk clip — `len`, `sourceLen`,
 * `seed`, fade bawaan — hidup di SATU tempat. Pemakainya sekarang dua: import
 * berkas, dan lagu yang diseret dari kepustakaan (yang asetnya mungkin sudah
 * ada di sesi ini, jadi tidak ada yang perlu di-decode lagi). Kalau keduanya
 * menyusun clip sendiri-sendiri, salah satunya akan salah diam-diam begitu
 * bentuknya berubah.
 */
export function placeAssetOnLane(
  assetId: number,
  name: string,
  frames: number,
  laneId: string,
  startSamples: number,
  opts: LaneImportOptions = {},
): void {
  const start = opts.avoidOverlap
    ? Math.max(startSamples, laneContentEnd(laneId))
    : startSamples;
  const clip: StudioClip = {
    id: studioActions.newClipId(),
    assetId,
    chain: [],
    start: Math.max(0, Math.round(start)),
    len: frames,
    sourceStart: 0,
    sourceLen: frames,
    label: name.toUpperCase(),
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: assetId % 97,
  };
  studioActions.addClip(laneId, clip);
}
