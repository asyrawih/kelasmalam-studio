/**
 * Drop file di halaman DJ → asset → (opsional) langsung ke deck.
 *
 * Jalur decode-nya `importBytesToAsset`, yaitu jalur yang SAMA dengan drop di
 * timeline Studio. Yang berbeda hanya apa yang terjadi setelahnya: di sana
 * dibuat clip, di sini deck diisi.
 *
 * Kegagalan diteruskan APA ADANYA. `importBytesToAsset` sudah menyusun kalimat
 * yang layak dipajang ("bukan berkas audio — terbaca sebagai …", "browser ini
 * tidak bisa men-decode Ogg Vorbis"), dan menggantinya dengan "gagal" berarti
 * membuang satu-satunya petunjuk yang dimiliki user.
 */

import { importFileToAsset } from '../../studio/timeline/audio-import';
import type { DeckId } from '../model';
import { djActions } from '../store';

export interface DjImportResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** `deck` null = hanya masuk kepustakaan, tidak dimuat ke mana pun. */
export async function importFileToDeck(
  file: File,
  deck: DeckId | null,
  sampleRate: number,
): Promise<DjImportResult> {
  const got = await importFileToAsset(file, sampleRate);
  if (!got.ok) {
    djActions.setNotice(got.reason);
    return { ok: false, reason: got.reason };
  }
  if (deck !== null) {
    djActions.loadDeck(deck, {
      assetId: got.assetId,
      frames: got.frames,
      name: got.name,
      sampleRate: got.sampleRate,
    });
  }
  djActions.setNotice(null);
  return { ok: true };
}

/** Beberapa file sekaligus: yang pertama ke deck, sisanya ke kepustakaan. */
export async function importFilesToDeck(
  files: readonly File[],
  deck: DeckId | null,
  sampleRate: number,
): Promise<DjImportResult> {
  let first = true;
  let lastFail: string | undefined;
  for (const file of files) {
    const r = await importFileToDeck(file, first ? deck : null, sampleRate);
    if (r.ok) first = false;
    else lastFail = r.reason;
  }
  return lastFail === undefined ? { ok: true } : { ok: false, reason: lastFail };
}
