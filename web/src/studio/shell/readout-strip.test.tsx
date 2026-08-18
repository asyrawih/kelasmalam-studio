/**
 * Readout strip — sel COMPILE OUT.
 *
 * Yang dijaga di sini satu hal: angka di sel itu adalah panjang FILE, bukan
 * panjang kanvas timeline. Keduanya nyaris tidak pernah sama (kanvas punya ekor
 * 30 detik dan lantai 2 menit), dan kalau tertukar, user membaca janji durasi
 * yang tidak pernah ditepati file hasil export.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadoutStrip, playbackFactor } from './ReadoutStrip';
import { formatTime } from '../model';
import { studioActions, studioStore } from '../store';

// State modul apa adanya belum melewati `withDerived`, jadi `contentEnd` masih
// 0 sampai reset pertama — seed demo baru punya materi sesudahnya.
beforeEach(() => studioActions.__resetForTest());

afterEach(() => {
  cleanup();
  studioActions.__resetForTest();
});

/** Sel dicari lewat label-nya — struktur DOM-nya boleh berubah. */
const cell = (label: string): HTMLElement => screen.getByText(label).parentElement as HTMLElement;
const compile = (): HTMLElement => cell('Compile out');
/** Baris nilai besar (label, nilai, lalu baris mikro opsional). */
const valueOf = (el: HTMLElement): string => (el.children[1]?.textContent ?? '').trim();
/**
 * Baris mikro di bawah nilai. Node-nya SEKARANG SELALU ADA: ia mengunci tinggi
 * sel supaya strip tidak berubah tinggi saat notanya muncul-hilang — itulah
 * yang dulu membuat timeline di bawahnya melompat saat playhead di-scrub
 * (lihat `NoteLine` di `BpmCell`). Jadi yang berarti di sini ada-tidaknya
 * TEKS, bukan ada-tidaknya elemen; baris kosong dilaporkan `null`.
 */
const noteOf = (el: HTMLElement): string | null => {
  const text = el.children[2]?.textContent ?? '';
  return text === '' ? null : text;
};

describe('COMPILE OUT = panjang file, bukan panjang timeline', () => {
  it('durasi yang tampil = contentEnd / sampleRate / renderSpeed', () => {
    const { contentEnd, sampleRate } = studioStore.getState();
    expect(contentEnd).toBeGreaterThan(0); // seed demo memang punya clip

    for (const speed of [0.25, 0.5, 1, 1.5, 2, 4]) {
      studioActions.setRenderSpeed(speed);
      render(<ReadoutStrip />);
      expect(valueOf(compile()), `${speed}×`).toBe(
        `${formatTime(contentEnd / sampleRate / speed)}wav`,
      );
      cleanup();
    }
  });

  it('bukan `duration`: ekor kosong dan lantai 2 menit tidak ikut terhitung', () => {
    const { contentEnd, duration, sampleRate } = studioStore.getState();
    expect(duration).toBeGreaterThan(contentEnd); // ekor 30 detik selalu ada
    render(<ReadoutStrip />);
    expect(valueOf(compile())).not.toBe(`${formatTime(duration / sampleRate)}wav`);
    expect(valueOf(cell('Timeline'))).toBe(formatTime(duration / sampleRate));
  });

  it('project kosong: bukan 00:00 yang menyiratkan file kosong yang sah', () => {
    studioActions.__resetForTest('empty');
    render(<ReadoutStrip />);
    expect(valueOf(compile())).toBe('—');
    expect(noteOf(compile())).toBe('BELUM ADA MATERI');
    // Timeline tetap 02:00 (lantai kanvas) — itu justru angka yang dulu bocor
    // ke sel ini.
    expect(valueOf(cell('Timeline'))).toBe('02:00');
  });
});

describe('varispeed: pada kecepatan berapa file terdengar normal', () => {
  it('faktor putar = 1 / renderSpeed', () => {
    expect(playbackFactor(2)).toBe(0.5);
    expect(playbackFactor(0.5)).toBe(2);
    expect(playbackFactor(1)).toBe(1);
    // Kecepatan tak masuk akal tidak boleh jadi Infinity di layar.
    expect(playbackFactor(0)).toBe(1);
  });

  it('faktor putar dan semitone tampil, bukan sekadar di tooltip', () => {
    studioActions.setRenderSpeed(2);
    render(<ReadoutStrip />);
    // 2× → satu oktaf naik, terdengar seperti aslinya di 0.5×.
    expect(noteOf(compile())).toBe('PUTAR 0.50× · +12.0 st');
  });

  it('semitone = 12·log2(speed), termasuk arah turun', () => {
    for (const speed of [0.5, 0.75, 1.5, 2]) {
      studioActions.setRenderSpeed(speed);
      render(<ReadoutStrip />);
      const st = 12 * Math.log2(speed);
      const sign = st > 0 ? '+' : '−';
      expect(noteOf(compile()), `${speed}×`).toBe(
        `PUTAR ${(1 / speed).toFixed(2)}× · ${sign}${Math.abs(st).toFixed(1)} st`,
      );
      cleanup();
    }
  });

  it('1×: tidak ada keterangan tambahan sama sekali', () => {
    studioActions.setRenderSpeed(1);
    render(<ReadoutStrip />);
    expect(noteOf(compile())).toBeNull();
    expect(compile().getAttribute('title')).toBeNull();
  });

  it('tooltip menyebut varispeed dan kecepatan putarnya', () => {
    studioActions.setRenderSpeed(2);
    render(<ReadoutStrip />);
    const title = compile().getAttribute('title') ?? '';
    expect(title).toMatch(/Varispeed/);
    expect(title).toMatch(/0\.50×/);
    expect(title).toMatch(/\+12\.0 st/);
  });
});
