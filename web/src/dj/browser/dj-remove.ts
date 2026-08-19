/**
 * Hapus lagu dari kepustakaan.
 *
 * ## Kenapa ini tidak boleh sekadar `delete assets[id]`
 *
 * Registry asset **dipakai bersama** halaman `/studio`. Sebuah lagu yang
 * dihapus di sini bisa saja sedang dipakai oleh clip di timeline — dan clip
 * yang menunjuk asset hantu tidak melempar apa pun: ia hanya menggambar
 * placeholder dan diam saat diputar. Penyebabnya terjadi di halaman lain,
 * beberapa menit sebelumnya, jadi praktis tidak bisa dilacak dari layar.
 *
 * Karena itu penghapusan **menolak** kalau ada clip yang memakainya, dan
 * mengatakan berapa banyak serta di lane mana. Menghapusnya diam-diam lalu
 * "membersihkan" clip-nya adalah keputusan yang tidak berhak diambil halaman
 * ini: yang dihapus user adalah satu baris di Collection, bukan bagian dari
 * karyanya di Studio.
 *
 * ## Urutannya mengikat
 *
 * Deck dikosongkan LEBIH DULU. Kalau tidak, `apply()` berikutnya akan mencari
 * buffer yang sudah dilepas dan deck-nya diam tanpa satu pun tanda bahwa
 * lagunya memang sudah tidak ada.
 */

import { deleteAsset } from '../../studio/persist/db';
import { unregisterBuffer } from '../../studio/preview/audio-preview';
import { assetUsage, studioActions, studioStore } from '../../studio/store';
import { DECK_IDS, type DeckId } from '../model';
import { djActions, djStore } from '../store';

export interface RemovalReport {
  /** Clip di timeline Studio yang memakai lagu ini. */
  readonly clips: number;
  readonly lanes: readonly string[];
  /** Deck yang sedang memegangnya. */
  readonly decks: readonly DeckId[];
  /** Ada cue tersimpan yang akan ikut hilang. */
  readonly hasCues: boolean;
}

/** Apa yang akan terjadi kalau lagu ini dihapus. Murni; tidak mengubah apa pun. */
export function inspectRemoval(assetId: number): RemovalReport {
  const usage = assetUsage(studioStore.getState(), assetId);
  const dj = djStore.getState();
  return {
    clips: usage.clips,
    lanes: usage.lanes,
    decks: DECK_IDS.filter((id) => dj.decks[id].assetId === assetId),
    hasCues: dj.cues[assetId] !== undefined,
  };
}

export interface RemoveResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export async function removeAssetFromLibrary(assetId: number): Promise<RemoveResult> {
  const asset = studioStore.getState().assets[assetId];
  if (asset === undefined) return { ok: false, reason: 'lagu itu sudah tidak ada' };

  const report = inspectRemoval(assetId);
  if (report.clips > 0) {
    const where = report.lanes.length > 0 ? ` (${report.lanes.join(', ')})` : '';
    return {
      ok: false,
      reason: `"${asset.name}" dipakai ${report.clips} clip di Studio${where} — hapus clip-nya dulu di sana`,
    };
  }

  // Deck lebih dulu: `apply()` berikutnya tidak boleh mencari buffer yang sudah
  // dilepas.
  for (const id of report.decks) djActions.ejectDeck(id);
  djActions.forgetCues(assetId);
  if (djStore.getState().browse.selectedAssetId === assetId) {
    djActions.selectBrowseAsset(null);
  }

  studioActions.removeAsset(assetId);
  unregisterBuffer(assetId);
  await deleteAsset(assetId);

  return { ok: true };
}
