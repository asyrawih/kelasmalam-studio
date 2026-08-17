/**
 * Tempel URL audio dari clipboard → langsung jadi clip.
 *
 * TABRAKAN DENGAN SHORTCUT V: `useTransportShortcuts` sudah memakai V untuk
 * paste CLIP (metadata clip yang disalin dengan C). Keduanya sama-sama terpicu
 * oleh Cmd/Ctrl+V, jadi urutannya harus tegas:
 *
 *   1. Kalau ada clip di clipboard internal → V memaste clip. Selesai.
 *   2. Kalau tidak ada → isi clipboard SISTEM dibaca; kalau berupa URL, diimpor.
 *
 * Prioritas ini dipilih supaya alur copy/paste clip di dalam project tidak
 * pernah terganggu oleh apa pun yang kebetulan ada di clipboard sistem.
 *
 * Dipasang sebagai listener `paste` (bukan keydown) karena hanya event itu
 * yang membawa `clipboardData` tanpa perlu izin apa pun. Membaca lewat
 * `navigator.clipboard.readText()` akan memunculkan prompt izin di sebagian
 * browser — tidak sepadan untuk fitur ini.
 */

import { useEffect } from 'react';

import { studioActions, studioStore } from '../store';
import { importUrlToLane } from '../timeline/url-to-lane';
import { classifyUrl } from '../timeline/url-import';

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useClipboardImport(onError: (message: string) => void): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      // Saat mengetik di field, tempel adalah tempel teks biasa.
      if (isTextEntry(e.target)) return;
      // Clip internal menang — lihat catatan urutan di kepala file.
      if (studioStore.getState().clipboard !== null) return;

      const text = e.clipboardData?.getData('text/plain') ?? '';
      const cls = classifyUrl(text);
      if (cls.kind === 'not-a-url') return; // bukan urusan kita, biarkan lewat

      e.preventDefault();

      const s = studioStore.getState();
      const laneId = s.selectedLaneId ?? s.lanes[0]?.id;
      if (laneId === undefined) {
        onError('tidak ada lane untuk menaruh audio');
        return;
      }

      // Ditaruh di PLAYHEAD: itu posisi yang sedang diperhatikan user, dan
      // konsisten dengan paste clip (V) yang juga jatuh di playhead.
      void importUrlToLane(text, laneId, s.playhead, s.sampleRate).then((r) => {
        if (!r.ok) onError(r.reason ?? 'gagal mengimpor URL');
        else studioActions.selectLane(laneId);
      });
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onError]);
}
