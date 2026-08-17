/**
 * Shortcut transport global — berlaku di mana pun fokus berada.
 *
 * Dipasang di `window` dengan fase CAPTURE supaya tetap kena walaupun fokus
 * ada di tombol/panel yang punya handler sendiri.
 *
 * PENGECUALIAN YANG WAJIB: saat user sedang mengetik. Lane bisa di-rename lewat
 * `<input data-lane-name>`, dan kalau Backspace di sana dibajak jadi "kembali ke
 * awal", nama lane tidak bisa dihapus sama sekali. Jadi "berlaku di mana saja"
 * artinya di mana saja KECUALI field teks — itu bukan pengecualian yang
 * mengurangi, itu yang membuat fiturnya tidak merusak fitur lain.
 */

import { useEffect } from 'react';

import { studioActions, studioStore } from '../store';

/** True kalau target event adalah tempat mengetik. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useTransportShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTextEntry(e.target)) return;
      // Biarkan shortcut browser/OS (Cmd-R, Ctrl-S, dsb) lewat.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case ' ': {
          // Space juga meng-'klik' tombol yang sedang fokus — cegah itu,
          // supaya menekan Space setelah klik PLAY tidak men-toggle dua kali.
          e.preventDefault();
          studioActions.togglePlay();
          break;
        }
        case 'Backspace':
        case 'Enter': {
          // Kembali ke awal. Di browser, Backspace pernah berarti "halaman
          // sebelumnya" — preventDefault menutup kemungkinan itu.
          e.preventDefault();
          studioActions.setPlayhead(0);
          break;
        }
        case 'Home': {
          e.preventDefault();
          studioActions.setPlayhead(0);
          break;
        }
        case 'End': {
          e.preventDefault();
          studioActions.setPlayhead(studioStore.getState().duration);
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          studioActions.nudgePlayhead(e.shiftKey ? -1 : -5);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          studioActions.nudgePlayhead(e.shiftKey ? 1 : 5);
          break;
        }
        // ── Editing clip ────────────────────────────────────────────────
        case 'x':
        case 'X':
        case 'Delete': {
          e.preventDefault();
          studioActions.deleteSelectedClip();
          break;
        }
        case 'b':
        case 'B': {
          // Split di playhead. Tidak melakukan apa-apa kalau playhead berada
          // di luar clip terpilih — `splitClipAtPlayhead` yang menjaganya,
          // supaya aturan "potongan nol-panjang tidak boleh dibuat" hanya
          // hidup di satu tempat.
          e.preventDefault();
          const { selectedClipId } = studioStore.getState();
          if (selectedClipId !== null) studioActions.splitClipAtPlayhead(selectedClipId);
          break;
        }
        case 'c':
        case 'C': {
          e.preventDefault();
          studioActions.copySelectedClip();
          break;
        }
        case 'v':
        case 'V': {
          // Paste jatuh di PLAYHEAD, pada lane terpilih — bukan di posisi asal.
          // Itu yang membuat copy/paste berguna: pindahkan playhead, tekan V.
          e.preventDefault();
          studioActions.pasteClipboard();
          break;
        }
        default:
          break;
      }
    };

    // capture: true — handler ini menang lebih dulu dari handler komponen.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
