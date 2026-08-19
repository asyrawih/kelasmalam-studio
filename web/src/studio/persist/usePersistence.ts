/**
 * Pasang pemulihan saat boot + simpan otomatis.
 *
 * Decode asset dilakukan lewat jalur yang sama dengan import biasa
 * (`ensureContext` + `decodeAudioData` + peak), supaya audio hasil pemulihan
 * tidak pernah berbeda dari audio hasil drag pertama kali.
 */

import { useEffect, useState } from 'react';

import { decodeStoredAsset } from './decode-asset';
import { restoreProject, startAutosave } from './persistence';

export type PersistenceStatus =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly restored: boolean; readonly missingAssets: number }
  | { readonly phase: 'unavailable' };

export function usePersistence(sampleRate: number): PersistenceStatus {
  const [status, setStatus] = useState<PersistenceStatus>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let stopAutosave: (() => void) | undefined;

    // Jalur decode-nya hidup di `decode-asset.ts` karena halaman `/dj` juga
    // memakainya — dan envelope hasil pemulihan wajib identik dari halaman mana
    // pun, jadi ia tidak boleh punya dua salinan.
    const decodeAsset = (id: number, name: string, bytes: ArrayBuffer): Promise<boolean> =>
      decodeStoredAsset(id, name, bytes, sampleRate);

    void restoreProject(decodeAsset).then((r) => {
      if (cancelled) return;
      setStatus({ phase: 'ready', restored: r.restored, missingAssets: r.missingAssets });
      // Autosave baru dinyalakan SETELAH pemulihan selesai. Kalau dinyalakan
      // lebih dulu, state awal yang masih kosong akan menimpa project tersimpan
      // sebelum sempat dibaca.
      stopAutosave = startAutosave();
    });

    return () => {
      cancelled = true;
      stopAutosave?.();
    };
  }, [sampleRate]);

  return status;
}
