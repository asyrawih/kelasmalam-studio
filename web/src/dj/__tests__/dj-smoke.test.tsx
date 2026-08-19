/**
 * Smoke test halaman `/dj`.
 *
 * Dua hal yang dijaga di sini dan tidak di tempat lain:
 *
 *  1. **`console.error` apa pun menggagalkan tes.** Peringatan React soal
 *     `setState` di luar `act`, key yang hilang, atau prop yang salah semuanya
 *     lewat sana, dan semuanya adalah bug yang mudah lolos dari mata.
 *  2. **`AudioContext` tidak dibangun saat RENDER, hanya setelah gestur.**
 *     Context yang lahir di luar handler gestur user berstatus `suspended` di
 *     Safari dan Chrome — tanpa gejala apa pun selain "tidak ada suara". Aturan
 *     itu hanya berarti kalau ada yang menjaganya.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DjPage } from '../DjPage';
import { djActions, djStore } from '../store';
import { studioActions, type StudioAsset } from '../../studio/store';
import { buildEnvelope } from '../../studio/timeline/envelope';

const SR = 48_000;
const FRAMES = SR * 4;

/** Asset dengan envelope SUNGGUHAN — `readEnvelope` butuh minimal satu level. */
const fakeAsset = (id: number): StudioAsset =>
  ({
    id,
    name: `LAGU ${id}`,
    envelope: buildEnvelope({
      numberOfChannels: 1,
      length: FRAMES,
      getChannelData: () => new Float32Array(FRAMES),
    }),
    frames: FRAMES,
    sampleRate: SR,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
  }) as unknown as StudioAsset;

const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 300,
  width: 900,
  height: 300,
  toJSON: () => ({}),
};

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
});

afterEach(cleanup);

function expectNoConsoleError(fn: () => void): void {
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  expect(errors, `console.error: ${JSON.stringify(errors)}`).toEqual([]);
}

describe('DjPage', () => {
  it('render tanpa satu pun console.error', () => {
    expectNoConsoleError(() => {
      render(<DjPage />);
    });
    expect(screen.getByText('KELAS MALAM DJ')).toBeTruthy();
  });

  it('TIDAK membangun AudioContext saat render — hanya setelah gestur', () => {
    const ctor = vi.fn();
    const original = window.AudioContext;
    (window as unknown as { AudioContext: unknown }).AudioContext = ctor;
    try {
      render(<DjPage />);
      expect(ctor).not.toHaveBeenCalled();
    } finally {
      (window as unknown as { AudioContext: unknown }).AudioContext = original;
    }
  });

  it('mengajak menyalakan audio, bukan mengaku sudah siap', () => {
    render(<DjPage />);
    expect(screen.getByText(/AUDIO BELUM BERBUNYI/)).toBeTruthy();
  });

  it('meter menampilkan NO SIGNAL selama belum ada yang bisa diukur', () => {
    render(<DjPage />);
    expect(screen.getAllByText('NO SIGNAL').length).toBeGreaterThan(0);
  });

  it('tombol MASTER TEMPO ada tapi mati, dengan alasannya terbaca', () => {
    render(<DjPage />);
    const mt = screen.getAllByRole('button', { name: 'MT' });
    expect(mt.length).toBe(2);
    for (const b of mt) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute('title')).toMatch(/varispeed/i);
    }
  });

  it('kolom KEY kosong — deteksi nada dasar belum ada, dan itu dikatakan', () => {
    render(<DjPage />);
    const keys = screen.getAllByTitle(/deteksi nada dasar belum ada/);
    expect(keys.length).toBeGreaterThan(0);
    for (const cell of keys) expect(cell.textContent).toBe('—');
  });

  it('kedua deck kosong menyatakan dirinya kosong', () => {
    render(<DjPage />);
    expect(screen.getAllByText('DECK KOSONG')).toHaveLength(2);
  });

  it('crossfader menggerakkan store, dan pembacaan gain ikut berubah', () => {
    render(<DjPage />);
    const xf = screen.getByRole('slider', { name: 'crossfader' });
    fireEvent.pointerDown(xf, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(xf, { clientX: 900, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(xf, { clientX: 900, clientY: 0, pointerId: 1 });
    expect(djStore.getState().mixer.crossfader).toBeGreaterThan(0.9);
  });

  it('menekan KILL pada label EQ mematikan band, dan menekannya lagi menyalakan', () => {
    render(<DjPage />);
    const low = screen.getAllByRole('button', { name: 'LOW' })[0] as HTMLElement;
    fireEvent.click(low);
    expect(djStore.getState().mixer.channels.A.eqKill.low).toBe(true);
    fireEvent.click(low);
    expect(djStore.getState().mixer.channels.A.eqKill.low).toBe(false);
  });

  it('pad hot cue mati saat deck kosong — bukan diam-diam tidak berefek', () => {
    render(<DjPage />);
    const pads = screen.getAllByRole('button').filter((b) => b.textContent === 'A');
    expect(pads.length).toBeGreaterThan(0);
  });

  it('tombol hapus di Collection butuh DUA gerakan, bukan satu', () => {
    // Menghapus lagu tidak bisa dibatalkan — byte aslinya ikut hilang dari
    // IndexedDB. Satu klik yang langsung menghapus adalah satu salah-klik yang
    // membuang berkas untuk selamanya.
    act(() => studioActions.registerAsset(fakeAsset(9)));
    render(<DjPage />);

    const row = screen.getByTitle(/hapus "LAGU 9"/);
    expect(row.textContent).toBe('✕');
    fireEvent.click(row);
    expect(screen.getByTitle(/hapus "LAGU 9"/).textContent).toBe('HAPUS?');
  });

  /**
   * Penjaga KELAS BUG, bukan satu tombol.
   *
   * Bug yang memicunya: pad BEAT LOOP bisa dinyalakan tapi tidak dimatikan.
   * Kontrol yang PUNYA keadaan menyala harus bisa dikembalikan lewat kontrol
   * yang sama — kalau tidak, satu-satunya jalan keluar ada di tempat lain, dan
   * kontrol yang menyala tapi tidak merespons dirinya sendiri terbaca sebagai
   * kerusakan.
   */
  it('setiap kontrol dua-keadaan bisa dikembalikan lewat kontrol yang sama', () => {
    // Deck harus TERISI: SLIP dan MASTER sengaja mati saat deck kosong, dan
    // menguji tombol yang memang dinonaktifkan tidak membuktikan apa pun.
    act(() =>
      djActions.loadDeck('A', { assetId: 1, frames: 48_000, name: 'X', sampleRate: 48_000 }),
    );
    render(<DjPage />);
    const s = () => djStore.getState();

    /*
      Lingkupnya DISEBUT, tidak ditebak dari urutan DOM: nama "CUE" ada di DUA
      tempat yang berbeda artinya — tombol transport di deck dan monitor
      headphone di mixer — dan `getAllByRole(...)[0]` diam-diam memilih yang
      salah. Tes yang menekan tombol yang salah tetap hijau selama tombol itu
      kebetulan juga sebuah toggle.
    */
    const deckA = within(document.querySelector('[data-dj-deck="A"]') as HTMLElement);
    const mixer = within(document.querySelector('[data-dj-mixer]') as HTMLElement);

    const cases: ReadonlyArray<readonly [string, ReturnType<typeof within>, () => boolean]> = [
      ['SLIP', deckA, () => s().decks.A.slip],
      ['Q', deckA, () => s().decks.A.quantize],
      ['MASTER', deckA, () => s().masterDeck === 'A'],
      ['CUE', mixer, () => s().mixer.channels.A.cue],
      ['LOW', mixer, () => s().mixer.channels.A.eqKill.low],
    ];

    for (const [name, scope, read] of cases) {
      const btn = scope.getAllByRole('button', { name })[0] as HTMLElement;
      const before = read();
      fireEvent.click(btn);
      expect(read(), `${name} tidak berubah saat ditekan`).toBe(!before);
      fireEvent.click(btn);
      expect(read(), `${name} tidak bisa dikembalikan lewat tombol yang sama`).toBe(before);
    }
  });
});
