/**
 * Shell dari ujung ke ujung: tombol ditekan → command jalan → store berubah.
 *
 * Tes lapisan bawah membuktikan chord dan keymap-nya benar; yang ini
 * membuktikan **rantainya tersambung** — dispatcher terpasang, halaman
 * mendaftarkan command-nya, dan keduanya bertemu. Rantai yang putus di salah
 * satu sambungan tetap lolos semua tes unit.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppShell } from './AppShell';
import { djActions, djStore } from '../dj/store';
import { studioActions } from '../studio/store';

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

const press = (code: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(window, { code, ...init });
};

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  window.history.pushState(null, '', '/dj');
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
  act(() =>
    djActions.loadDeck('A', { assetId: 1, frames: SR * 120, name: 'LAGU A', sampleRate: SR }),
  );
  act(() =>
    djActions.loadDeck('B', { assetId: 2, frames: SR * 120, name: 'LAGU B', sampleRate: SR }),
  );
});

afterEach(cleanup);

describe('shortcut halaman DJ', () => {
  it('Q dan P memutar deck yang berbeda', () => {
    render(<AppShell />);
    press('KeyQ');
    expect(djStore.getState().decks.A.playing).toBe(true);
    expect(djStore.getState().decks.B.playing).toBe(false);

    press('KeyP');
    expect(djStore.getState().decks.B.playing).toBe(true);
  });

  it('menekan lagi menghentikannya — shortcut ikut aturan toggle yang sama', () => {
    render(<AppShell />);
    press('KeyQ');
    press('KeyQ');
    expect(djStore.getState().decks.A.playing).toBe(false);
  });

  it('backquote memindahkan fokus, dan Space memutar deck yang fokus', () => {
    render(<AppShell />);
    expect(djStore.getState().focusedDeck).toBe('A');

    press('Space');
    expect(djStore.getState().decks.A.playing).toBe(true);

    press('Backquote');
    expect(djStore.getState().focusedDeck).toBe('B');
    press('Space');
    expect(djStore.getState().decks.B.playing).toBe(true);
  });

  /**
   * TAB TIDAK BOLEH DIRAMPAS.
   *
   * Ia satu-satunya cara keyboard berpindah antar kontrol. Mengambilnya membuat
   * halaman berhenti bisa dipakai tanpa tetikus — dan itu tidak terlihat sama
   * sekali oleh siapa pun yang memakai tetikus, jadi ia bisa hidup lama sebelum
   * ada yang melaporkannya.
   */
  it('Tab dibiarkan untuk navigasi keyboard', () => {
    render(<AppShell />);
    const before = djStore.getState().focusedDeck;
    press('Tab');
    expect(djStore.getState().focusedDeck).toBe(before);
  });

  /**
   * Space/Enter saat fokus ada di TOMBOL adalah cara keyboard menekan tombol
   * itu. Kalau dispatcher merampasnya, tidak ada satu pun tombol di halaman
   * yang bisa ditekan tanpa tetikus.
   */
  it('Space tidak dirampas saat fokus ada di sebuah tombol', () => {
    render(<AppShell />);
    const button = screen.getAllByRole('button')[0] as HTMLElement;
    button.focus();
    fireEvent.keyDown(button, { code: 'Space' });
    expect(djStore.getState().decks.A.playing).toBe(false);
  });

  it('Enter tidak dirampas saat fokus ada di sebuah tombol', () => {
    render(<AppShell />);
    act(() => djActions.selectBrowseAsset(1));
    const button = screen.getAllByRole('button')[0] as HTMLElement;
    button.focus();
    fireEvent.keyDown(button, { code: 'Enter' });
    // Perintah "muat ke deck fokus" TIDAK jalan; tombolnya yang ditekan.
    expect(djStore.getState().decks.A.name).toBe('LAGU A');
  });

  it('panah menggerakkan crossfader', () => {
    render(<AppShell />);
    const before = djStore.getState().mixer.crossfader;
    press('ArrowRight');
    expect(djStore.getState().mixer.crossfader).toBeGreaterThan(before);
    press('ArrowLeft');
    press('ArrowLeft');
    expect(djStore.getState().mixer.crossfader).toBeLessThan(before);
  });

  it('digit yang sama ditekan dua kali = ON lalu OFF', () => {
    render(<AppShell />);
    act(() => djActions.setHotCue('A', 'A', SR * 10));

    press('Digit1');
    expect(djStore.getState().decks.A.playing).toBe(true);
    expect(djStore.getState().decks.A.playhead).toBe(SR * 10);

    press('Digit1');
    expect(djStore.getState().decks.A.playing).toBe(false);
    expect(djStore.getState().decks.A.playhead).toBe(SR * 10);
    // Dan cue-nya tetap ada — tombol on/off, bukan tombol hapus.
    expect(djStore.getState().cues[1]?.hotCues.A?.at).toBe(SR * 10);
  });

  it('digit memasang hot cue di deck yang benar', () => {
    render(<AppShell />);
    act(() => djActions.seek('A', SR * 10));
    press('Digit1');
    expect(djStore.getState().cues[1]?.hotCues.A?.at).toBe(SR * 10);
    // Deck B memakai baris digit sebelah kanan, dan cue-nya milik asset LAIN.
    act(() => djActions.seek('B', SR * 20));
    press('Digit7');
    expect(djStore.getState().cues[2]?.hotCues.A?.at).toBe(SR * 20);
  });

  it('MENGETIK menang atas shortcut', () => {
    render(<AppShell />);
    const search = screen.getByLabelText('cari judul');
    // "q" di kotak pencarian harus tetap jadi huruf, bukan memutar deck A.
    fireEvent.keyDown(search, { code: 'KeyQ' });
    expect(djStore.getState().decks.A.playing).toBe(false);
  });

  it('tombol yang DITAHAN tidak mengulang perintah', () => {
    render(<AppShell />);
    press('KeyQ');
    expect(djStore.getState().decks.A.playing).toBe(true);
    // `repeat` menyala saat sistem mengulang tombol yang ditahan. Tanpa
    // penjaga, PLAY akan di-toggle puluhan kali per detik.
    press('KeyQ', { repeat: true });
    expect(djStore.getState().decks.A.playing).toBe(true);
  });

  it('chord tanpa binding tidak melakukan apa-apa', () => {
    render(<AppShell />);
    press('KeyM');
    expect(djStore.getState().decks.A.playing).toBe(false);
  });
});

describe('command palette', () => {
  it('dibuka dengan mod+K dan menjalankan perintah yang dipilih', () => {
    render(<AppShell />);
    press('KeyK', { metaKey: true, ctrlKey: true });

    const input = screen.getByLabelText('cari perintah');
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: 'putar' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(djStore.getState().decks.A.playing).toBe(true);
  });

  /**
   * Peringkat, bukan sekadar penyaringan.
   *
   * Subsekuens murni membuat "Aplikasi Buka daftar perintah" ikut cocok dengan
   * "putar" — dan karena urutannya alfabetis, ia mendarat di ATAS "Putar /
   * jeda". Palette yang meranking omong kosong di baris pertama lebih buruk
   * daripada tidak ada palette sama sekali: Enter jadi tombol yang hasilnya
   * harus dibaca dulu.
   */
  it('kecocokan yang lebih baik naik ke atas', () => {
    render(<AppShell />);
    press('KeyK', { metaKey: true, ctrlKey: true });
    fireEvent.change(screen.getByLabelText('cari perintah'), { target: { value: 'putar' } });

    const first = document.querySelector('[role="dialog"] button');
    expect(first?.textContent).toContain('Putar / jeda');
  });

  it('menampilkan command dari halaman yang SEDANG terbuka saja', () => {
    render(<AppShell />);
    press('KeyK', { metaKey: true, ctrlKey: true });
    fireEvent.change(screen.getByLabelText('cari perintah'), { target: { value: 'deck' } });
    expect(screen.getAllByText(/Putar \/ jeda/).length).toBeGreaterThan(0);
  });
});

describe('editor pintasan', () => {
  it('dibuka dengan ? dan mendaftar shortcut yang berlaku', () => {
    render(<AppShell />);
    press('Slash', { shiftKey: true });
    expect(screen.getByRole('dialog', { name: 'pintasan keyboard' })).toBeTruthy();
    expect(screen.getAllByText('Putar / jeda').length).toBeGreaterThan(0);
  });

  /**
   * `/` POLOS juga harus membuka daftar ini.
   *
   * Keduanya sama-sama diraih orang, dan yang tidak terikat bocor ke browser:
   * `/` membuka Quick Find di Firefox. Mengikat cuma salah satunya berarti
   * separuh percobaan berakhir di kotak pencarian browser.
   */
  it('dibuka dengan / polos juga — kalau tidak, ia bocor ke Quick Find browser', () => {
    render(<AppShell />);
    press('Slash');
    expect(screen.getByRole('dialog', { name: 'pintasan keyboard' })).toBeTruthy();
  });
});

describe('halaman lain', () => {
  it('command DJ tidak terdaftar saat berada di landing', () => {
    window.history.pushState(null, '', '/');
    render(<AppShell />);
    press('KeyQ');
    expect(djStore.getState().decks.A.playing).toBe(false);
  });
});
