/**
 * Render Speed — pemetaan slider, clamp, preset, dan akibat yang ditampilkan.
 *
 * Yang dijaga di sini bukan cuma "tidak melempar": kecepatan render adalah satu
 * dari sedikit angka yang benar-benar mengubah file yang dikirim user, jadi
 * pemetaan travel↔kecepatan harus reversibel dan angka durasi yang ditampilkan
 * harus sama dengan yang dipakai export.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NEUTRAL_FRACTION,
  RENDER_SPEED_PRESETS,
  RenderSpeedCard,
  fractionToSpeed,
  nudgeSpeed,
  outputSeconds,
  quantizeSpeed,
  semitoneShift,
  speedFromDrag,
  speedToFraction,
} from './RenderSpeedCard';
import { studioActions, studioStore } from './store-adapter';
import { MAX_RENDER_SPEED, MIN_RENDER_SPEED, formatTime } from '../model';

// jsdom melaporkan semua elemen berukuran 0; beri lebar realistis supaya jalur
// perhitungan fraksi drag benar-benar dieksekusi (pointer capture sudah di-stub
// global di `src/__tests__/setup.ts`).
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 24,
  width: 200,
  height: 24,
  toJSON: () => ({}),
};
Element.prototype.getBoundingClientRect = () => RECT as DOMRect;

afterEach(() => {
  cleanup();
  studioActions.__resetForTest();
});

const slider = (): HTMLElement => screen.getByRole('slider');
const speed = (): number => studioStore.getState().renderSpeed;

describe('pemetaan travel ↔ kecepatan', () => {
  it('bolak-balik: fraction → speed → fraction', () => {
    for (const f of [0, 0.13, 0.25, 0.5, 0.61, 0.87, 1]) {
      expect(speedToFraction(fractionToSpeed(f))).toBeCloseTo(f, 10);
    }
  });

  it('bolak-balik: speed → fraction → speed', () => {
    for (const v of [0.25, 0.4, 0.75, 1, 1.5, 2, 3.3, 4]) {
      expect(fractionToSpeed(speedToFraction(v))).toBeCloseTo(v, 10);
    }
  });

  it('monoton naik', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = fractionToSpeed(i / 100);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('logaritmik: jarak 0.5×→1× sama dengan 1×→2×', () => {
    const a = speedToFraction(1) - speedToFraction(0.5);
    const b = speedToFraction(2) - speedToFraction(1);
    expect(a).toBeCloseTo(b, 12);
    // …dan bukan linear, yang akan memberi b = 2a.
    expect(b / a).toBeCloseTo(1, 6);
  });

  it('1× tepat di tengah travel — detent tidak perlu dicari', () => {
    expect(NEUTRAL_FRACTION).toBeCloseTo(0.5, 12);
    expect(fractionToSpeed(NEUTRAL_FRACTION)).toBeCloseTo(1, 12);
  });

  it('ujung travel = batas rentang', () => {
    expect(fractionToSpeed(0)).toBeCloseTo(MIN_RENDER_SPEED, 12);
    expect(fractionToSpeed(1)).toBeCloseTo(MAX_RENDER_SPEED, 12);
  });

  it('clamp di kedua ujung, termasuk untuk nilai tak masuk akal', () => {
    expect(fractionToSpeed(-3)).toBeCloseTo(MIN_RENDER_SPEED, 12);
    expect(fractionToSpeed(9)).toBeCloseTo(MAX_RENDER_SPEED, 12);
    expect(quantizeSpeed(0.001)).toBe(MIN_RENDER_SPEED);
    expect(quantizeSpeed(99)).toBe(MAX_RENDER_SPEED);
    expect(speedToFraction(0.001)).toBe(0);
    expect(speedToFraction(99)).toBe(1);
    expect(speedToFraction(Number.NaN)).toBeCloseTo(NEUTRAL_FRACTION, 12);
  });

  it('detent drag menghasilkan 1 PERSIS, bukan 0.999…', () => {
    expect(speedFromDrag(0.5)).toBe(1);
    expect(speedFromDrag(0.505)).toBe(1);
    expect(speedFromDrag(0.495)).toBe(1);
    // Di luar magnet, nilainya kembali mengikuti pemetaan.
    expect(speedFromDrag(0.6)).toBeGreaterThan(1);
    expect(speedFromDrag(0.4)).toBeLessThan(1);
  });
});

describe('akibat yang dihitung', () => {
  it('durasi hasil = materi ÷ renderSpeed', () => {
    expect(outputSeconds(48_000 * 120, 48_000, 1)).toBeCloseTo(120, 9);
    expect(outputSeconds(48_000 * 120, 48_000, 2)).toBeCloseTo(60, 9);
    expect(outputSeconds(48_000 * 120, 48_000, 0.5)).toBeCloseTo(240, 9);
  });

  it('tanpa materi tidak ada pembagian dengan nol', () => {
    expect(outputSeconds(0, 48_000, 2)).toBe(0);
    expect(outputSeconds(48_000, 0, 2)).toBe(0);
    expect(outputSeconds(48_000, 48_000, 0)).toBe(1);
  });

  it('varispeed: 2× = naik satu oktaf, 0.5× = turun satu oktaf', () => {
    expect(semitoneShift(2)).toBeCloseTo(12, 9);
    expect(semitoneShift(0.5)).toBeCloseTo(-12, 9);
    expect(semitoneShift(1)).toBe(0);
  });
});

describe('RenderSpeedCard', () => {
  it('menampilkan readout dua desimal dan aria-valuetext yang sama', () => {
    studioActions.setRenderSpeed(1.5);
    render(<RenderSpeedCard />);
    expect(screen.getByText('1.50×')).toBeTruthy();
    expect(slider().getAttribute('aria-valuetext')).toBe('1.50×');
    expect(Number(slider().getAttribute('aria-valuenow'))).toBe(1.5);
  });

  it('preset mendarat di nilai persis (1× = 1, bukan 0.999…)', () => {
    studioActions.setRenderSpeed(1.37);
    render(<RenderSpeedCard />);
    for (const v of RENDER_SPEED_PRESETS) {
      fireEvent.click(screen.getByText(`${v}×`));
      expect(speed()).toBe(v);
    }
    fireEvent.click(screen.getByText('1×'));
    expect(speed()).toBe(1);
    expect(speed() === 1).toBe(true);
  });

  it('klik di tengah slider = 1× persis; ujung-ujungnya ter-clamp', () => {
    render(<RenderSpeedCard />);
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 1, clientX: 100 });
    expect(speed()).toBe(1);

    fireEvent.pointerMove(slider(), { pointerId: 1, clientX: 400 });
    expect(speed()).toBe(MAX_RENDER_SPEED);

    fireEvent.pointerMove(slider(), { pointerId: 1, clientX: -400 });
    expect(speed()).toBe(MIN_RENDER_SPEED);
    fireEvent.pointerUp(slider(), { pointerId: 1, clientX: -400 });
  });

  it('drag ke kanan mempercepat, ke kiri memperlambat', () => {
    render(<RenderSpeedCard />);
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 1, clientX: 150 });
    const fast = speed();
    expect(fast).toBeGreaterThan(1);
    fireEvent.pointerMove(slider(), { pointerId: 1, clientX: 50 });
    expect(speed()).toBeLessThan(1);
    expect(speed()).toBeLessThan(fast);
    fireEvent.pointerUp(slider(), { pointerId: 1, clientX: 50 });
  });

  it('panah = langkah halus dan TIDAK tersangkut di detent 1×', () => {
    render(<RenderSpeedCard />);
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    const up = speed();
    expect(up).toBeGreaterThan(1);
    expect(up).toBeLessThan(1.1); // halus, bukan lompat ke preset berikutnya

    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
    expect(speed()).toBeCloseTo(1, 2);
    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
    expect(speed()).toBeLessThan(1);
  });

  it('Shift+panah melangkah lebih besar dari panah biasa', () => {
    expect(nudgeSpeed(1, 0.05) - 1).toBeGreaterThan(nudgeSpeed(1, 0.01) - 1);
  });

  it('Home/End melompat ke batas', () => {
    render(<RenderSpeedCard />);
    fireEvent.keyDown(slider(), { key: 'End' });
    expect(speed()).toBe(MAX_RENDER_SPEED);
    fireEvent.keyDown(slider(), { key: 'Home' });
    expect(speed()).toBe(MIN_RENDER_SPEED);
  });

  it('klik dua kali kembali ke 1×', () => {
    studioActions.setRenderSpeed(2.75);
    render(<RenderSpeedCard />);
    fireEvent.doubleClick(slider());
    expect(speed()).toBe(1);
  });

  it('durasi hasil yang tampil = contentEnd / sampleRate / renderSpeed', () => {
    const { contentEnd, sampleRate } = studioStore.getState();
    expect(contentEnd).toBeGreaterThan(0); // seed demo memang punya clip

    studioActions.setRenderSpeed(2);
    const { container } = render(<RenderSpeedCard />);
    const out = container.querySelector('[aria-label="Panjang file hasil"]');
    const src = container.querySelector('[aria-label="Panjang materi"]');
    expect(src?.textContent).toBe(formatTime(contentEnd / sampleRate));
    expect(out?.textContent).toBe(formatTime(contentEnd / sampleRate / 2));
  });

  it('durasi hasil ikut berubah saat preset ditekan', () => {
    const { contentEnd, sampleRate } = studioStore.getState();
    const { container } = render(<RenderSpeedCard />);
    fireEvent.click(screen.getByText('0.5×'));
    expect(container.querySelector('[aria-label="Panjang file hasil"]')?.textContent).toBe(
      formatTime(contentEnd / sampleRate / 0.5),
    );
  });

  it('project kosong: durasi diganti keterangan, bukan 00:00 yang menyesatkan', () => {
    studioActions.__resetForTest('empty');
    render(<RenderSpeedCard />);
    expect(screen.getByText('BELUM ADA MATERI')).toBeTruthy();
  });

  it('jujur soal pitch: varispeed, bukan pitch lock', () => {
    render(<RenderSpeedCard />);
    // Dua tempat: label kepala dan baris akibat di bawah.
    expect(screen.getAllByText(/VARISPEED/)).toHaveLength(2);
    expect(screen.queryByText(/PITCH LOCKED/)).toBeNull();
    expect(screen.queryByText(/PITCH DIPERTAHANKAN/)).toBeNull();
  });

  it('pergeseran pitch ditulis dalam semitone saat kecepatan bukan 1×', () => {
    studioActions.setRenderSpeed(2);
    render(<RenderSpeedCard />);
    expect(screen.getByText(/\+12\.0 st/)).toBeTruthy();
  });

  it('kecepatan TRANSPORT tidak menyentuh kecepatan render', () => {
    render(<RenderSpeedCard />);
    studioActions.setSpeed(2);
    expect(speed()).toBe(1);
    expect(screen.getByText('1.00×')).toBeTruthy();
  });
});
