/**
 * Pasang pemulihan saat boot + simpan otomatis.
 *
 * Decode asset dilakukan lewat jalur yang sama dengan import biasa
 * (`ensureContext` + `decodeAudioData` + peak), supaya audio hasil pemulihan
 * tidak pernah berbeda dari audio hasil drag pertama kali.
 */

import { useEffect, useState } from 'react';

import { studioActions } from '../store';
import { ensureContext, registerBuffer } from '../preview/audio-preview';
import { restoreProject, startAutosave } from './persistence';
import { assetFromBuffer } from '../timeline/audio-import';

export type PersistenceStatus =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly restored: boolean; readonly missingAssets: number }
  | { readonly phase: 'unavailable' };

export function usePersistence(sampleRate: number): PersistenceStatus {
  const [status, setStatus] = useState<PersistenceStatus>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let stopAutosave: (() => void) | undefined;

    const decodeAsset = async (
      id: number,
      name: string,
      bytes: ArrayBuffer,
    ): Promise<boolean> => {
      const ctx = ensureContext(sampleRate);
      if (ctx === null) return false;
      try {
        // `decodeAudioData` MEMAKAN buffer-nya (detached) di sebagian browser,
        // jadi salin dulu — kalau tidak, percobaan berikutnya dapat buffer kosong.
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        registerBuffer(id, buffer);
        // Persis fungsi yang dipakai jalur import: envelope hasil pemulihan
        // dijamin identik dengan envelope saat file pertama kali di-drop.
        studioActions.registerAsset(assetFromBuffer(id, name, buffer));
        return true;
      } catch {
        return false;
      }
    };

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
