import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions } from '../store';
import { useTransportShortcuts } from '../shortcuts/useTransportShortcuts';
import { SHORTCUTS } from './ShortcutsCard';

function Harness(): JSX.Element {
  useTransportShortcuts();
  return <div />;
}

/** Kirim keydown; `defaultPrevented` menandakan handler benar-benar menanganinya. */
function handled(key: string, init: KeyboardEventInit = {}): boolean {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/** Label tombol di kartu → nilai `KeyboardEvent.key` sebenarnya. */
const KEY_MAP: Record<string, string | null> = {
  Space: ' ',
  Backspace: 'Backspace',
  Home: 'Home',
  End: 'End',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  B: 'b',
  X: 'x',
  C: 'c',
  V: 'v',
  Shift: null, // modifier, bukan tombol yang berdiri sendiri
};

describe('kartu Shortcut tidak boleh basi', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('setiap shortcut yang didokumentasikan benar-benar ditangani', () => {
    render(<Harness />);
    const notHandled: string[] = [];

    for (const doc of SHORTCUTS) {
      // Gerakan pointer tidak punya `KeyboardEvent` untuk diperiksa.
      if (doc.group === 'pointer') continue;
      for (const label of doc.keys) {
        const key = KEY_MAP[label];
        if (key === undefined) {
          notHandled.push(`${label} (tidak ada di KEY_MAP)`);
          continue;
        }
        if (key === null) continue;
        const shift = doc.keys.includes('Shift');
        if (!handled(key, { shiftKey: shift })) {
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
    for (const k of ['a', 'q', 'z', 'F5']) {
      expect(handled(k), k).toBe(false);
    }
  });
});
