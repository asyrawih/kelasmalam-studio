/**
 * Dialog Clip Detail: cara membukanya (double-click di clip), cara
 * membentangkannya, dan cara menutupnya.
 *
 * Yang paling mudah rusak di sini ada dua, dan keduanya tidak terlihat dari
 * membaca kode:
 *
 *   1. DOUBLE-CLICK-nya tidak boleh berasal dari `dblclick`. Jalur pointerdown
 *      di `ClipArea` memanggil `preventDefault()`, dan itu menekan seluruh
 *      compatibility mouse event. Tes ini mengirim POINTER EVENT saja — persis
 *      seperti browser sungguhan — jadi kalau suatu saat deteksinya dipindah ke
 *      `onDoubleClick`, tes ini merah.
 *
 *   2. Dialog dipasang lewat PORTAL, dan React tetap mengalirkan event-nya
 *      menyusuri pohon React. Kalau ia dipasang di dalam scroller timeline,
 *      setiap tekanan pointer di dalam dialog akan memulai kotak seleksi di
 *      belakangnya. Tes terakhir mengunci itu.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';
import { studioActions, studioStore } from '../store';
import { BeatProvider } from './beat-context';
import { TimelinePanel } from './TimelinePanel';

const SR = 48_000;
const TRACK_W = 1000;

Element.prototype.getBoundingClientRect = function (this: Element) {
  return { x: 0, y: 0, top: 0, left: 0, right: TRACK_W, bottom: 400, width: TRACK_W, height: 400, toJSON: () => ({}) } as DOMRect;
};
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get: () => TRACK_W,
});

/**
 * Jam yang dikendalikan tes.
 *
 * `timeStamp` sebuah Event tidak bisa diisi lewat init-nya (ia readonly, diisi
 * saat konstruksi), padahal justru itu yang dipakai untuk memutuskan "dua
 * ketukan ini cukup berdekatan". Tanpa kendali atas nilainya, kasus "dua klik
 * yang berjauhan" hanya bisa diuji dengan benar-benar menunggu — dan tes yang
 * menunggu 400 ms akan segera dihapus orang.
 */
let clock = 0;
Object.defineProperty(Event.prototype, 'timeStamp', { configurable: true, get: () => clock });

/**
 * Jamnya TIDAK PERNAH dimulai dari nol.
 *
 * React menormalkan stempel waktu event sebagai `event.timeStamp || Date.now()`
 * — jadi nilai 0 diam-diam berubah menjadi waktu epoch, dan ketukan berikutnya
 * (yang bernilai kecil) tampak terjadi RIBUAN TAHUN sebelumnya. Tes yang mulai
 * dari nol karena itu menguji sesuatu yang tidak pernah terjadi di browser.
 */
const T0 = 1_000;

function clip(id: string, startSec: number, lenSec = 4): StudioClip {
  return {
    id,
    assetId: 1,
    chain: [],
    start: startSec * SR,
    len: lenSec * SR,
    sourceStart: 0,
    sourceLen: lenSec * SR,
    label: id,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
  };
}

function Harness(): JSX.Element {
  return (
    <BeatProvider>
      <TimelinePanel />
    </BeatProvider>
  );
}

function clipEl(id: string): HTMLElement {
  const el = document.querySelector(`[data-clip="${id}"]`);
  if (el === null) throw new Error(`clip ${id} tidak ada`);
  return el as HTMLElement;
}

function scroller(): HTMLElement {
  const el = document.querySelector('[data-tl-scroll]');
  if (el === null) throw new Error('scroller tidak ada');
  return el as HTMLElement;
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-clip-detail-dialog]');
}

/** Satu ketukan lengkap pada clip: turun di clip, lepas di scroller. */
function tap(id: string, x = 10, y = 10): void {
  fireEvent.pointerDown(clipEl(id), { pointerId: 1, button: 0, clientX: x, clientY: y });
  fireEvent.pointerUp(scroller(), { pointerId: 1, clientX: x, clientY: y });
}

beforeEach(() => {
  clock = T0;
  studioActions.__resetForTest('empty');
  const laneId = studioStore.getState().lanes[0]!.id;
  studioActions.addClip(laneId, clip('a', 0));
  studioActions.addClip(laneId, clip('b', 20));
  studioActions.clearClipSelection();
});

afterEach(cleanup);

describe('membuka Clip Detail dengan double-click', () => {
  it('dua ketukan cepat pada clip yang sama membuka dialog', () => {
    render(<Harness />);
    tap('a');
    clock = T0 + 120;
    tap('a');
    expect(dialog()).not.toBeNull();
  });

  it('clip yang dibuka menjadi clip yang terpilih', () => {
    render(<Harness />);
    tap('b');
    clock = T0 + 120;
    tap('b');
    expect(studioStore.getState().selectedClipId).toBe('b');
  });

  it('satu ketukan saja tidak membuka apa pun', () => {
    render(<Harness />);
    tap('a');
    expect(dialog()).toBeNull();
  });

  it('dua ketukan yang berjauhan waktunya bukan double-click', () => {
    render(<Harness />);
    tap('a');
    clock = T0 + 900;
    tap('a');
    expect(dialog()).toBeNull();
  });

  it('ketukan pada dua clip berbeda bukan double-click', () => {
    render(<Harness />);
    tap('a');
    clock = T0 + 100;
    tap('b');
    expect(dialog()).toBeNull();
  });

  it('double-click tidak menggeser clip', () => {
    render(<Harness />);
    const before = studioStore.getState().lanes[0]!.clips.find((c) => c.id === 'a')!.start;
    tap('a');
    clock = T0 + 120;
    // Ketukan kedua meleset beberapa piksel — tangan bergetar, dan itu tidak
    // boleh berubah menjadi perpindahan materi.
    fireEvent.pointerDown(clipEl('a'), { pointerId: 1, button: 0, clientX: 13, clientY: 12 });
    fireEvent.pointerMove(scroller(), { pointerId: 1, clientX: 60, clientY: 12 });
    fireEvent.pointerUp(scroller(), { pointerId: 1, clientX: 60, clientY: 12 });
    expect(studioStore.getState().lanes[0]!.clips.find((c) => c.id === 'a')!.start).toBe(before);
  });
});

describe('bentang & tutup', () => {
  function open(): HTMLElement {
    render(<Harness />);
    tap('a');
    clock = T0 + 120;
    tap('a');
    const d = dialog();
    if (d === null) throw new Error('dialog tidak terbuka');
    return d;
  }

  it('tombol fullscreen membentangkan dialog, dan bisa dikembalikan', () => {
    const d = open();
    expect(d.getAttribute('data-fullscreen')).toBe('false');
    fireEvent.click(document.querySelector('[title="bentangkan ke seluruh layar"]')!);
    expect(dialog()!.getAttribute('data-fullscreen')).toBe('true');
    fireEvent.click(document.querySelector('[title="kembali ke ukuran jendela (Esc)"]')!);
    expect(dialog()!.getAttribute('data-fullscreen')).toBe('false');
  });

  it('Esc saat dibentangkan MENGECILKAN, bukan menutup', () => {
    const d = open();
    fireEvent.click(document.querySelector('[title="bentangkan ke seluruh layar"]')!);
    fireEvent.keyDown(dialog()!, { key: 'Escape' });
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('data-fullscreen')).toBe('false');
    void d;
  });

  it('Esc saat seukuran jendela menutup dialog', () => {
    const d = open();
    fireEvent.keyDown(d, { key: 'Escape' });
    expect(dialog()).toBeNull();
  });

  it('klik di luar dialog menutupnya', () => {
    open();
    fireEvent.mouseDown(document.querySelector('[data-clip-detail-backdrop]')!);
    expect(dialog()).toBeNull();
  });

  it('menekan pointer DI DALAM dialog tidak memulai kotak seleksi di timeline', () => {
    const d = open();
    const before = studioStore.getState().selectedClipIds;
    fireEvent.pointerDown(d, { pointerId: 2, button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(d, { pointerId: 2, clientX: 200, clientY: 120 });
    expect(document.querySelector('[data-marquee]')).toBeNull();
    expect(studioStore.getState().selectedClipIds).toEqual(before);
  });
});
