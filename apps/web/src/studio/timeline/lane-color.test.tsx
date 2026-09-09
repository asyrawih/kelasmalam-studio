/**
 * Pemilih warna lane.
 *
 * Yang dijaga di sini ada tiga lapis: parsing hex (satu-satunya tempat teks
 * user jadi data), perilaku modal yang paling gampang salah (Escape, backdrop,
 * fokus), dan janji "CANCEL tidak mengubah apa pun" — kalau yang terakhir bocor,
 * user kehilangan warna lane tanpa pernah menyetujuinya.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LANE_COLORS } from '../model';
import { studioActions, studioStore } from '../store';
import { LaneHeaders } from './LaneHeaders';
import {
  APP_BG,
  MIN_CONTRAST,
  contrastRatio,
  isLowContrast,
  parseHexColor,
  relativeLuminance,
} from './LaneColorModal';

afterEach(() => {
  cleanup();
  studioActions.__resetForTest();
});

describe('parseHexColor', () => {
  it('menerima #rrggbb', () => {
    expect(parseHexColor('#aabbcc')).toBe('#aabbcc');
    expect(parseHexColor('#ffd400')).toBe('#ffd400');
    expect(parseHexColor('#000000')).toBe('#000000');
  });

  it('memekarkan bentuk pendek #rgb menjadi #rrggbb', () => {
    expect(parseHexColor('#abc')).toBe('#aabbcc');
    expect(parseHexColor('#fff')).toBe('#ffffff');
    expect(parseHexColor('#000')).toBe('#000000');
    // Bentuk pendek dan panjang untuk warna yang sama harus mendarat di nilai
    // tersimpan yang sama persis — kalau tidak, dua lane "warna sama" bisa
    // berbeda string dan `setLaneColor` menganggapnya perubahan.
    expect(parseHexColor('#abc')).toBe(parseHexColor('#aabbcc'));
  });

  it('huruf besar diterima tapi dinormalkan ke huruf kecil', () => {
    expect(parseHexColor('#AABBCC')).toBe('#aabbcc');
    expect(parseHexColor('#FFD400')).toBe('#ffd400');
    expect(parseHexColor('#ABC')).toBe('#aabbcc');
    expect(parseHexColor('#AbCdEf')).toBe('#abcdef');
  });

  it('spasi di tepi diabaikan', () => {
    expect(parseHexColor('  #abc  ')).toBe('#aabbcc');
    expect(parseHexColor('\t#aabbcc\n')).toBe('#aabbcc');
  });

  it('tanpa # ditolak', () => {
    expect(parseHexColor('aabbcc')).toBeNull();
    expect(parseHexColor('abc')).toBeNull();
    expect(parseHexColor('ffd400')).toBeNull();
  });

  it('sampah ditolak', () => {
    for (const bad of [
      '',
      '#',
      '#ab',
      '#abcd',
      '#abcde',
      '#abcdefa',
      '#gggggg',
      '#xyz',
      'red',
      'rgb(1,2,3)',
      '#aa bb cc',
      '#-12345',
    ]) {
      expect(parseHexColor(bad)).toBeNull();
    }
  });
});

describe('kontras terhadap latar aplikasi', () => {
  it('luminance mengikuti terang-gelap', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(relativeLuminance('#ffd400')).toBeGreaterThan(relativeLuminance('#a07a10'));
  });

  it('rasio simetris dan berbatas 1..21', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 6);
  });

  it('ambang = 3:1, dan setiap warna palet design lolos', () => {
    expect(MIN_CONTRAST).toBe(3);
    for (const c of LANE_COLORS) {
      expect(isLowContrast(c)).toBe(false);
    }
  });

  it('#6f6a5e — warna palet TERGELAP — ada di antara 3 dan 4.5', () => {
    // Ini alasan ambangnya 3 dan bukan 4.5 (ambang teks): dengan 4.5 aplikasi
    // akan memperingatkan user atas warna yang ia sediakan sendiri.
    const r = contrastRatio('#6f6a5e', APP_BG);
    expect(r).toBeGreaterThan(3);
    expect(r).toBeLessThan(4.5);
  });

  it('warna yang nyaris melebur dengan latar ditandai', () => {
    expect(isLowContrast('#000000')).toBe(true);
    expect(isLowContrast('#101010')).toBe(true);
    expect(isLowContrast('#333333')).toBe(true);
  });

  it('penanda persis sama dengan rasio < ambang, tanpa perkiraan', () => {
    for (const c of ['#000000', '#404040', '#5a5a5a', '#6f6a5e', '#808080', '#ffd400']) {
      expect(isLowContrast(c)).toBe(contrastRatio(c, APP_BG) < MIN_CONTRAST);
    }
  });
});

// ── Integrasi UI ─────────────────────────────────────────────────────────────

function firstLaneId(): string {
  return studioStore.getState().lanes[0]!.id;
}

function laneColor(id: string): string {
  return studioStore.getState().lanes.find((l) => l.id === id)!.color;
}

function swatch(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-lane-swatch="${id}"]`);
  if (el === null) throw new Error('bar warna tidak ada');
  return el;
}

function openPicker(): { laneId: string; trigger: HTMLButtonElement } {
  render(<LaneHeaders />);
  const laneId = firstLaneId();
  const trigger = swatch(laneId);
  fireEvent.doubleClick(trigger);
  return { laneId, trigger };
}

const hexField = (): HTMLInputElement => screen.getByLabelText('kode hex') as HTMLInputElement;
const backdrop = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-lane-color-backdrop]')!;

describe('pemicu di header lane', () => {
  it('bar warna adalah tombol dengan nama aksesibel — bukan div', () => {
    render(<LaneHeaders />);
    const el = swatch(firstLaneId());
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('aria-label')).toMatch(/warna lane/);
    expect(el.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('klik dua kali membuka modal', () => {
    openPicker();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Enter dan Space membuka modal yang sama (jalur keyboard)', () => {
    for (const key of ['Enter', ' ']) {
      render(<LaneHeaders />);
      fireEvent.keyDown(swatch(firstLaneId()), { key });
      expect(screen.getByRole('dialog')).toBeTruthy();
      cleanup();
    }
  });

  it('klik tunggal tetap memilih lane dan TIDAK membuka modal', () => {
    render(<LaneHeaders />);
    const laneId = studioStore.getState().lanes[1]!.id;
    studioActions.selectLane(firstLaneId());
    fireEvent.click(swatch(laneId));
    expect(studioStore.getState().selectedLaneId).toBe(laneId);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('menerapkan warna', () => {
  it('APPLY mengirim setLaneColor dengan nilai yang sudah dinormalkan', () => {
    const { laneId } = openPicker();
    fireEvent.change(hexField(), { target: { value: '#ABC' } });
    fireEvent.click(screen.getByText('Terapkan'));
    expect(laneColor(laneId)).toBe('#aabbcc');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('APPLY dari palet memakai warna palet itu', () => {
    const { laneId } = openPicker();
    const target = LANE_COLORS[2]!;
    fireEvent.click(screen.getByLabelText(`warna ${target}`));
    fireEvent.click(screen.getByText('Terapkan'));
    expect(laneColor(laneId)).toBe(target);
  });

  it('CANCEL mengembalikan warna semula — store tidak tersentuh', () => {
    const { laneId } = openPicker();
    const before = laneColor(laneId);
    fireEvent.change(hexField(), { target: { value: '#ff0000' } });
    fireEvent.click(screen.getByText('Batal'));
    expect(laneColor(laneId)).toBe(before);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape juga tidak menulis apa pun', () => {
    const { laneId } = openPicker();
    const before = laneColor(laneId);
    fireEvent.change(hexField(), { target: { value: '#00ff00' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(laneColor(laneId)).toBe(before);
  });

  it('hex sampah ditolak tanpa menghapus ketikan user', () => {
    openPicker();
    fireEvent.change(hexField(), { target: { value: '#zz' } });
    expect(hexField().value).toBe('#zz');
    expect(hexField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/HEX TIDAK VALID/)).toBeTruthy();
    // Tidak boleh diterapkan: warna yang tersimpan akan beda dari yang tertulis.
    expect((screen.getByText('Terapkan') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ketikan setengah jadi tidak mengubah draft, ketikan sah mengubahnya', () => {
    const { laneId } = openPicker();
    fireEvent.change(hexField(), { target: { value: '#ff' } });
    fireEvent.change(hexField(), { target: { value: '#ff0000' } });
    fireEvent.click(screen.getByText('Terapkan'));
    expect(laneColor(laneId)).toBe('#ff0000');
  });
});

describe('perilaku modal', () => {
  it('Escape menutup', () => {
    openPicker();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('klik backdrop menutup; klik di dalam dialog tidak', () => {
    openPicker();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.mouseDown(backdrop());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fokus masuk ke dialog saat dibuka dan kembali ke bar warna saat ditutup', () => {
    const { trigger } = openPicker();
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('fokus terjebak: Tab dari kontrol terakhir kembali ke yang pertama', () => {
    openPicker();
    const dialog = screen.getByRole('dialog');
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('button, input'));
    expect(items.length).toBeGreaterThan(2);
    const first = items[0]!;
    const last = items[items.length - 1]!;

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('dialog dirender lewat portal ke body, di luar kartu timeline', () => {
    const { container } = render(<LaneHeaders />);
    fireEvent.doubleClick(swatch(firstLaneId()));
    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('halaman di belakang tidak ikut ter-scroll, dan dipulihkan saat ditutup', () => {
    expect(document.body.style.overflow).toBe('');
    openPicker();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });
});

describe('peringatan kontras', () => {
  it('diam untuk warna palet', () => {
    openPicker();
    fireEvent.click(screen.getByLabelText(`warna ${LANE_COLORS[3]!}`));
    expect(screen.queryByText(/NYARIS TAK TERLIHAT/)).toBeNull();
  });

  it('muncul untuk warna yang melebur dengan latar gelap', () => {
    openPicker();
    fireEvent.change(hexField(), { target: { value: '#101010' } });
    expect(screen.getByText(/NYARIS TAK TERLIHAT/)).toBeTruthy();
  });

  it('memperingatkan, BUKAN melarang — warna gelap tetap bisa diterapkan', () => {
    const { laneId } = openPicker();
    fireEvent.change(hexField(), { target: { value: '#101010' } });
    expect((screen.getByText('Terapkan') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Terapkan'));
    expect(laneColor(laneId)).toBe('#101010');
  });

  it('peringatan hilang lagi begitu warna diganti yang terang', () => {
    openPicker();
    fireEvent.change(hexField(), { target: { value: '#101010' } });
    expect(screen.getByText(/NYARIS TAK TERLIHAT/)).toBeTruthy();
    fireEvent.change(hexField(), { target: { value: '#ffd400' } });
    expect(screen.queryByText(/NYARIS TAK TERLIHAT/)).toBeNull();
  });
});
