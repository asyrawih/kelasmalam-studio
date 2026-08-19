/**
 * Pad, lewat jalur pointer sungguhan.
 *
 * `web/src/__tests__/setup.ts` men-stub Pointer Capture API; tanpa stub itu
 * setiap tes yang mengirim `pointerdown` ke elemen ber-capture akan TAMPAK
 * lulus padahal jalur interaksinya tidak pernah jalan.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DjPage } from '../DjPage';
import { djActions, djStore, selectTrackCues } from '../store';
import { studioActions } from '../../studio/store';
import type { StudioAsset } from '../../studio/store';
import { buildEnvelope } from '../../studio/timeline/envelope';

const SR = 48_000;
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

/**
 * Envelope SUNGGUHAN dari PCM sintetis, bukan `{ levels: [] }`.
 *
 * `buildEnvelope` selalu menghasilkan setidaknya satu level, dan `readEnvelope`
 * bergantung pada itu. Fixture berisi nol level bukan keadaan yang bisa terjadi
 * di aplikasi — memakainya berarti menguji jalur yang tidak ada, lalu
 * "memperbaiki" kode produksi untuk melayaninya.
 */
const FRAMES = SR * 8;
const pcm = {
  numberOfChannels: 1,
  length: FRAMES,
  getChannelData: () => {
    const out = new Float32Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) out[i] = Math.sin(i / 40) * 0.5;
    return out;
  },
};

const fakeAsset = (id: number): StudioAsset =>
  ({
    id,
    name: `LAGU ${id}`,
    envelope: buildEnvelope(pcm),
    frames: SR * 120,
    sampleRate: SR,
    tempo: { bpm: 120, confidence: 0.5, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
  }) as unknown as StudioAsset;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
  studioActions.registerAsset(fakeAsset(1));
  djActions.loadDeck('A', { assetId: 1, frames: SR * 120, name: 'LAGU 1', sampleRate: SR });
});

afterEach(cleanup);

/**
 * Delapan pad deck A.
 *
 * Dipilih lewat `data-dj-pad`, bukan lewat teks: teks pad berubah setiap mode,
 * dan menyaring "tombol yang isinya satu huruf" ikut menangkap tab mode
 * `HOT CUE`. Selector berbasis teks di sini akan lulus hari ini dan diam-diam
 * salah besok.
 */
function padsOfDeckA(): HTMLElement[] {
  const deck = document.querySelector('[data-dj-deck="A"]');
  if (deck === null) throw new Error('deck A tidak ditemukan');
  return [...deck.querySelectorAll('[data-dj-pad]')] as HTMLElement[];
}

/**
 * Aksi store yang dipanggil LANGSUNG dari badan tes memberi tahu pelanggannya
 * secara sinkron, jadi React me-render di luar `act()` dan mencetak peringatan
 * lewat `console.error` — yang di smoke test halaman ini menggagalkan tes.
 * Membungkusnya di sini menjaga aturan itu tetap berarti.
 */
const run = (fn: () => void): void => {
  act(() => {
    fn();
  });
};

describe('memory cue', () => {
  const memoryButton = (): HTMLElement => {
    const deck = document.querySelector('[data-dj-deck="A"]') as HTMLElement;
    const b = [...deck.querySelectorAll('button')].find((x) =>
      /MEMORY CUE|HAPUS CUE/.test(x.textContent ?? ''),
    );
    if (b === undefined) throw new Error('tombol memory cue tidak ditemukan');
    return b as HTMLElement;
  };

  it('menekan di posisi yang sama menghapusnya lagi', () => {
    render(<DjPage />);
    fireEvent.click(memoryButton());
    expect(selectTrackCues('A')(djStore.getState()).memoryCues).toHaveLength(1);

    // Tanpa toggle, satu salah tekan tinggal permanen di lagu itu selamanya —
    // tidak ada UI lain yang bisa menghapusnya.
    fireEvent.click(memoryButton());
    expect(selectTrackCues('A')(djStore.getState()).memoryCues).toHaveLength(0);
  });

  it('labelnya mengatakan apa yang akan terjadi SEBELUM ditekan', () => {
    render(<DjPage />);
    expect(memoryButton().textContent).toBe('MEMORY CUE');
    fireEvent.click(memoryButton());
    expect(memoryButton().textContent).toBe('HAPUS CUE');
  });

  it('posisi berbeda menambah, bukan mengganti', () => {
    render(<DjPage />);
    fireEvent.click(memoryButton());
    run(() => djActions.seek('A', SR * 30));
    fireEvent.click(memoryButton());
    expect(selectTrackCues('A')(djStore.getState()).memoryCues).toHaveLength(2);
  });
});

describe('LOOP ROLL momentary', () => {
  const rollPads = (): HTMLElement[] => {
    fireEvent.click(screen.getAllByRole('button', { name: 'LOOP ROLL' })[0] as HTMLElement);
    return padsOfDeckA();
  };

  it('ditahan = loop + SLIP; dilepas = keluar dan slip kembali seperti semula', () => {
    render(<DjPage />);
    const pad = rollPads().find((b) => (b.textContent ?? '').trim() === '1ROLL') as HTMLElement;
    expect(pad).toBeTruthy();
    expect(djStore.getState().decks.A.slip).toBe(false);

    fireEvent.pointerDown(pad);
    expect(djStore.getState().decks.A.loop.active).toBe(true);
    // SLIP-lah yang membuat roll berbeda dari beat loop: posisi bayangan terus
    // berjalan, jadi lagunya tidak kehilangan tempat.
    expect(djStore.getState().decks.A.slip).toBe(true);

    fireEvent.pointerUp(pad);
    expect(djStore.getState().decks.A.loop.active).toBe(false);
    expect(djStore.getState().decks.A.slip).toBe(false);
  });

  it('SLIP yang memang sudah dinyalakan user TIDAK ikut dimatikan', () => {
    render(<DjPage />);
    const pad = rollPads().find((b) => (b.textContent ?? '').trim() === '1ROLL') as HTMLElement;
    act(() => djActions.toggleSlip('A'));
    expect(djStore.getState().decks.A.slip).toBe(true);

    fireEvent.pointerDown(pad);
    fireEvent.pointerUp(pad);
    expect(djStore.getState().decks.A.slip).toBe(true);
  });

  it('kursor yang cuma LEWAT tidak mengakhiri apa pun', () => {
    render(<DjPage />);
    const pads = rollPads();
    const a = pads[0] as HTMLElement;
    const b = pads[1] as HTMLElement;

    fireEvent.pointerDown(a);
    expect(djStore.getState().decks.A.loop.active).toBe(true);
    // Pointer melintas di atas pad tetangga tanpa pernah menekannya.
    fireEvent.pointerLeave(b);
    expect(djStore.getState().decks.A.loop.active).toBe(true);

    fireEvent.pointerLeave(a);
    expect(djStore.getState().decks.A.loop.active).toBe(false);
  });
});

describe('pad hot cue', () => {
  it('pad kosong memasang cue di posisi kini; menekannya lagi melompat ke sana', () => {
    djActions.seek('A', SR * 10);
    render(<DjPage />);

    const padA = padsOfDeckA()[0] as HTMLElement;
    fireEvent.click(padA);
    expect(selectTrackCues('A')(djStore.getState()).hotCues.A?.at).toBe(SR * 10);

    run(() => djActions.seek('A', 0));
    fireEvent.click(padA);
    expect(djStore.getState().decks.A.playhead).toBe(SR * 10);
  });

  it('SHIFT-klik menghapus cue', () => {
    djActions.setHotCue('A', 'A', SR * 5);
    render(<DjPage />);
    fireEvent.click(padsOfDeckA()[0] as HTMLElement, { shiftKey: true });
    expect(selectTrackCues('A')(djStore.getState()).hotCues.A).toBeNull();
  });

  it('klik BIASA pada pad terisi melompat, tidak menghapus', () => {
    djActions.setHotCue('A', 'A', SR * 5);
    render(<DjPage />);
    fireEvent.click(padsOfDeckA()[0] as HTMLElement);
    expect(selectTrackCues('A')(djStore.getState()).hotCues.A).not.toBeNull();
    expect(djStore.getState().decks.A.playhead).toBe(SR * 5);
  });

  it('klik kanan menghapus cue — dan pad kembali terlihat KOSONG', () => {
    djActions.setHotCue('A', 'A', SR * 5);
    render(<DjPage />);

    const padA = padsOfDeckA()[0] as HTMLElement;
    // Pad TERISI: bergaris utuh dan berwarna slot-nya.
    expect(padA.getAttribute('style')).not.toContain('dashed');

    fireEvent.contextMenu(padA);
    expect(selectTrackCues('A')(djStore.getState()).hotCues.A).toBeNull();
    // Pad KOSONG harus TERLIHAT kosong — garis putus-putus, tanpa isian.
    expect((padsOfDeckA()[0] as HTMLElement).getAttribute('style')).toContain('dashed');
  });

  it('mengganti mode pad mengganti isi delapan pad, bukan menambah baris', () => {
    render(<DjPage />);
    const deck = document.querySelector('[data-dj-deck="A"]') as HTMLElement;

    fireEvent.click(screen.getAllByRole('button', { name: 'BEAT JUMP' })[0] as HTMLElement);
    expect(djStore.getState().decks.A.padMode).toBe('beatjump');
    expect([...deck.querySelectorAll('button')].some((b) => b.textContent?.includes('+16'))).toBe(
      true,
    );
  });

  it('pad BEAT LOOP yang MENYALA bisa dimatikan dengan menekannya lagi', () => {
    render(<DjPage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'BEAT LOOP' })[0] as HTMLElement);
    const four = padsOfDeckA().find((b) => (b.textContent ?? '').trim() === '4BEAT');
    expect(four).toBeTruthy();

    fireEvent.click(four as HTMLElement);
    expect(djStore.getState().decks.A.loop.active).toBe(true);

    // Tekan lagi → keluar. Sebelum perbaikan ini pad hanya bisa dinyalakan,
    // dan pad yang menyala tapi tidak merespons dirinya sendiri terbaca sebagai
    // kerusakan.
    fireEvent.click(four as HTMLElement);
    expect(djStore.getState().decks.A.loop.active).toBe(false);

    // Batasnya TETAP tersimpan supaya RELOOP masih mungkin.
    expect(djStore.getState().decks.A.loop.inAt).not.toBeNull();
    expect(djStore.getState().decks.A.loop.outAt).not.toBeNull();
  });

  it('pad BEAT LOOP lain menggantikan loop, bukan mematikannya', () => {
    render(<DjPage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'BEAT LOOP' })[0] as HTMLElement);
    const pads = padsOfDeckA();
    const four = pads.find((b) => (b.textContent ?? '').trim() === '4BEAT') as HTMLElement;
    const eight = pads.find((b) => (b.textContent ?? '').trim() === '8BEAT') as HTMLElement;

    fireEvent.click(four);
    fireEvent.click(eight);
    expect(djStore.getState().decks.A.loop.active).toBe(true);
    expect(djStore.getState().decks.A.loop.beats).toBe(8);
  });

  it('pad BEAT LOOP memasang loop yang panjangnya dari grid', () => {
    render(<DjPage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'BEAT LOOP' })[0] as HTMLElement);

    const deck = document.querySelector('[data-dj-deck="A"]') as HTMLElement;
    const four = [...deck.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === '4BEAT',
    );
    expect(four).toBeTruthy();
    fireEvent.click(four as HTMLElement);

    // 120 BPM @48k → 24 000 sample/ketukan; empat ketukan = 96 000.
    expect(djStore.getState().decks.A.loop.outAt).toBe(96_000);
    expect(djStore.getState().decks.A.loop.active).toBe(true);
  });
});
