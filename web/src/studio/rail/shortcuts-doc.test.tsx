import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __clearCommandsForTest } from '../../app-shell/command';
import { useCommands } from '../../app-shell/useCommands';
import { useKeyDispatch } from '../../app-shell/useKeyDispatch';
import { studioCommands } from '../commands';
import { studioActions } from '../store';
import { SHORTCUTS } from './ShortcutsCard';

/** Persis yang dipasang `/studio`: command Studio di registry + dispatcher shell. */
function Harness(): JSX.Element {
  useCommands(studioCommands());
  useKeyDispatch();
  return <div />;
}

/** Kirim keydown; `defaultPrevented` menandakan dispatcher benar-benar menanganinya. */
function handled(code: string, init: KeyboardEventInit = {}): boolean {
  const ev = new KeyboardEvent('keydown', {
    code,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/** Label tombol di kartu → `KeyboardEvent.code` (posisi fisik, yang dibaca keymap). */
const KEY_MAP: Record<string, string | null> = {
  Space: 'Space',
  Backspace: 'Backspace',
  Home: 'Home',
  End: 'End',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  A: 'KeyA',
  B: 'KeyB',
  C: 'KeyC',
  E: 'KeyE',
  S: 'KeyS',
  V: 'KeyV',
  X: 'KeyX',
  Z: 'KeyZ',
  'Cmd/Ctrl': null,
  Shift: null, // modifier, bukan tombol yang berdiri sendiri
};

describe('kartu Shortcut tidak boleh basi', () => {
  beforeEach(() => studioActions.__resetForTest());
  afterEach(() => {
    cleanup();
    __clearCommandsForTest();
  });

  it('setiap shortcut yang didokumentasikan benar-benar ditangani', () => {
    render(<Harness />);
    const notHandled: string[] = [];

    for (const doc of SHORTCUTS) {
      // Gerakan pointer tidak punya `KeyboardEvent` untuk diperiksa.
      if (doc.group === 'pointer') continue;
      // Tiap baris mulai dari state segar: X menghapus clip terpilih, dan C/V
      // sesudahnya butuh seleksi. Undo DAN redo butuh riwayat di dua arah —
      // dua edit lalu satu undo memberi keduanya.
      studioActions.__resetForTest();
      studioActions.setMasterGain(-3);
      studioActions.setMasterGain(-6);
      studioActions.undo();
      for (const label of doc.keys) {
        const code = KEY_MAP[label];
        if (code === undefined) {
          notHandled.push(`${label} (tidak ada di KEY_MAP)`);
          continue;
        }
        if (code === null) continue;
        const shift = doc.keys.includes('Shift');
        const mod = doc.keys.includes('Cmd/Ctrl');
        // `mod` = Cmd di macOS, Ctrl di tempat lain; keduanya dinyalakan supaya
        // tes tidak bergantung pada platform yang dilaporkan jsdom.
        if (!handled(code, { shiftKey: shift, ctrlKey: mod, metaKey: mod })) {
          notHandled.push(`${label} → ${doc.label}`);
        }
      }
    }

    expect(notHandled).toEqual([]);
  });

  it('tombol yang TIDAK didokumentasikan memang tidak dibajak', () => {
    render(<Harness />);
    // Huruf biasa harus lolos ke browser/komponen — kalau tidak, mengetik
    // di mana pun akan terasa aneh.
    for (const code of ['KeyA', 'KeyQ', 'KeyZ', 'F5']) {
      expect(handled(code), code).toBe(false);
    }
  });

  it('mendokumentasikan gesture timeline yang aktif', () => {
    expect(SHORTCUTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keys: ['Cmd/Ctrl', 'Klik'], label: 'Tambah/buang dari seleksi' }),
        expect.objectContaining({ keys: ['Shift', 'Drag'], label: 'Pan tampilan timeline' }),
        expect.objectContaining({ keys: ['Shift', 'Scroll'], label: 'Gulir timeline horizontal' }),
        expect.objectContaining({ keys: ['Scroll'], label: 'Zoom timeline' }),
      ]),
    );
  });
});
