/**
 * Simpan & buka project lewat kepustakaan (L6 docs/16).
 *
 * ## Simpan itu PERINTAH, bukan efek samping
 *
 * Tidak ada autosave di sini, dan itu bukan kelalaian. Autosave lama membaca
 * ulang byte terenkode SELURUH asset tiap perubahan state — puluhan MB per
 * gerakan tangan pada lagu 27 menit (PR #16). Yang menggantikannya adalah
 * perbuatan yang disengaja: user menekan simpan, dan tahu persis kapan
 * pekerjaannya aman.
 *
 * ## Membuka project berarti mengunduh audionya
 *
 * Beda dari daftar lagu, yang tampil dari metadata dan mengunduh sesuai
 * permintaan (L4). Project TANPA audionya bukan project — timeline-nya penuh
 * clip bisu tanpa waveform. Jadi yang dirujuknya diunduh lebih dulu, dengan
 * kemajuan yang terlihat, dan baru sesudah itu state-nya dipasang.
 */

import { restoreProject, serialize, type StoredAssetBytes } from '../studio/persist/persistence';
import { importBytesToAsset } from '../studio/timeline/audio-import';
import { studioStore } from '../studio/store';
import type { LibraryApi } from './api';
import { libraryActions, libraryStore } from './store';

export type SaveOutcome =
  | { readonly ok: true; readonly id: string; readonly version: number }
  | { readonly ok: false; readonly message: string; readonly conflict: boolean };

/**
 * Hash yang dipakai project ini tapi belum ada di kepustakaan.
 *
 * Diperiksa DI SINI, bukan hanya di server, supaya user tahu sebelum menekan
 * simpan — dan supaya pesannya bisa menyebut nama lagunya, yang tidak diketahui
 * server. Server tetap memeriksa ulang; yang di sini bantuan, yang di sana
 * penjaga.
 */
export function unsavedAssets(): readonly string[] {
  const state = studioStore.getState();
  const library = libraryStore.getState();
  const known = new Set(library.tracks.map((t) => t.hash));

  const missing: string[] = [];
  for (const lane of state.lanes) {
    for (const clip of lane.clips) {
      const asset = state.assets[clip.assetId];
      if (asset === undefined) continue;
      const nama = asset.name;
      if (asset.contentHash === '') {
        // Hasil bake: tidak punya berkas asal, jadi tidak akan pernah ada di
        // kepustakaan sampai §8e diputuskan.
        if (!missing.includes(nama)) missing.push(nama);
        continue;
      }
      if (!known.has(asset.contentHash) && !missing.includes(nama)) missing.push(nama);
    }
  }
  return missing;
}

export async function saveProject(
  api: LibraryApi,
  opts: { readonly id: string | null; readonly name: string; readonly version: number },
): Promise<SaveOutcome> {
  const json: unknown = JSON.parse(serialize(studioStore.getState()));

  try {
    if (opts.id === null) {
      const made = await api.createProject(opts.name, json);
      return { ok: true, id: made.id, version: made.version };
    }
    const version = await api.updateProject(opts.id, opts.name, json, opts.version);
    return { ok: true, id: opts.id, version };
  } catch (err: unknown) {
    const conflict = err instanceof Error && err.name === 'VersionConflict';
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      conflict,
    };
  }
}

export type OpenOutcome =
  | { readonly ok: true; readonly missingAssets: number }
  | { readonly ok: false; readonly message: string };

/**
 * Buka satu project: unduh asset yang dirujuknya, lalu pasang state-nya.
 *
 * Asset yang sudah ada di sesi ini TIDAK diunduh lagi — peta `loaded` adalah
 * hash → assetId yang dibangun tiap sesi, dan itu persis pertanyaan yang perlu
 * dijawab di sini.
 */
export async function openProject(
  api: LibraryApi,
  id: string,
  onProgress?: (done: number, total: number) => void,
): Promise<OpenOutcome> {
  let body;
  try {
    body = await api.project(id);
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const json = JSON.stringify(body.json);
  const hashes = hashesIn(body.json);
  const wanted = hashes.filter((h) => libraryStore.getState().loaded[h] === undefined);

  const bytes: StoredAssetBytes[] = [];
  let done = 0;
  for (const hash of wanted) {
    onProgress?.(done, wanted.length);
    try {
      const raw = await api.blob(hash, (percent) => libraryActions.setProgress(hash, percent));
      const track = libraryStore.getState().tracks.find((t) => t.hash === hash);
      const name = track?.name ?? hash.slice(0, 8);

      /*
       * Lewat `importBytesToAsset`, bukan decode sendiri: jalur itu yang
       * memberi envelope, tempo, dan cache PCM yang sama persis dengan import
       * berkas lokal. Dua jalur decode berarti waveform lagu yang sama bisa
       * berbeda bentuk tergantung dari mana ia dibuka.
       */
      const got = await importBytesToAsset(raw, name, studioStore.getState().sampleRate);
      if (got.ok) {
        libraryActions.markLoaded(hash, got.assetId);
        bytes.push({ id: got.assetId, name, bytes: raw, contentHash: hash });
      }
    } catch {
      // Satu asset yang gagal tidak membatalkan pembukaan project: clip-nya
      // jadi bisu, dan `missingAssets` melaporkan berapa banyak.
      libraryActions.clearProgress(hash);
    }
    done += 1;
  }
  onProgress?.(done, wanted.length);

  /*
   * Asset yang SUDAH ada di sesi ikut diserahkan ke `restoreProject` — bukan
   * untuk di-decode ulang (`decodeAsset` di bawah menolaknya), melainkan supaya
   * peta hash → id yang dibangunnya lengkap. Tanpa itu, clip yang menunjuk lagu
   * yang sudah dimuat akan gagal disambungkan.
   */
  const already = hashes
    .map((hash) => ({ hash, id: libraryStore.getState().loaded[hash] }))
    .filter((x): x is { hash: string; id: number } => x.id !== undefined)
    .filter((x) => !bytes.some((b) => b.contentHash === x.hash))
    .map((x) => ({
      id: x.id,
      name: studioStore.getState().assets[x.id]?.name ?? '',
      bytes: new ArrayBuffer(0),
      contentHash: x.hash,
    }));

  const result = await restoreProject(json, [...bytes, ...already], async (id2) =>
    // Sudah terdaftar lewat `importBytesToAsset` di atas; yang tersisa hanya
    // menjawab "asset ini ada", supaya ia masuk peta hash → id.
    studioStore.getState().assets[id2] !== undefined,
  );

  return result.restored
    ? { ok: true, missingAssets: result.missingAssets }
    : { ok: false, message: 'bentuk project ini tidak dikenali' };
}

/** Semua `contentHash` yang disebut project, di mana pun letaknya. */
export function hashesIn(json: unknown): readonly string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'contentHash' && typeof value === 'string' && value !== '') {
        out.add(value);
      } else if (key === 'assetGridsByHash' && typeof value === 'object' && value !== null) {
        // Kunci-kunci di sini ADALAH hash-nya.
        for (const hash of Object.keys(value)) out.add(hash);
      } else {
        walk(value);
      }
    }
  };
  walk(json);
  return [...out];
}

/** Nama project sekarang — dipakai sebagai nama default saat menyimpan. */
export function currentProjectName(): string {
  return studioStore.getState().projectName;
}
