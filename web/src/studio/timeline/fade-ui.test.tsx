/**
 * Interaksi handle fade di Clip Detail. Yang diuji adalah JALUR NYATA-nya:
 * pointerdown → pointermove pada handle harus mengubah store, bukan sekadar
 * "komponen render tanpa melempar".
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findClip, type StudioClip } from '../model';
import { studioActions, studioStore } from '../store';
import { ClipEditPanel, ClipWavePanel } from './ClipPanels';
import { BeatProvider } from './beat-context';

const SR = 48_000;
/** jsdom melaporkan semua elemen 0×0; beri lebar supaya fraksi drag terhitung. */
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 400,
  bottom: 150,
  width: 400,
  height: 150,
  toJSON: () => ({}),
};
Element.prototype.getBoundingClientRect = () => RECT as DOMRect;

function selectedClip(): StudioClip {
  const s = studioStore.getState();
  const hit = findClip(s.lanes, s.selectedClipId);
  if (hit === null) throw new Error('tidak ada clip terpilih');
  return hit.clip;
}

/**
 * Handle fade hidup di `ClipWavePanel`, field & preset di `ClipEditPanel`.
 * Keduanya mengambil clip yang dipajang dari `BeatProvider`.
 */
function Studio(): JSX.Element {
  return (
    <BeatProvider>
      <ClipWavePanel />
      <ClipEditPanel />
    </BeatProvider>
  );
}

beforeEach(() => {
  studioActions.__resetForTest();
  const s = studioStore.getState();
  const lane = s.lanes[0]!;
  const clip = lane.clips[0]!;
  // Clip 10 detik tepat — supaya 1 px = 25 ms dan angkanya mudah dibaca.
  studioActions.updateClip(clip.id, { start: 0, len: 10 * SR, fadeInMs: 0, fadeOutMs: 0 });
  studioActions.selectClip(clip.id, lane.id);
});

afterEach(cleanup);

function handle(side: 'in' | 'out'): HTMLElement {
  const el = document.querySelector(`[data-fade-handle="${side}"]`);
  if (el === null) throw new Error(`handle ${side} tidak ada`);
  return el as HTMLElement;
}

function drag(el: HTMLElement, clientX: number): void {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0 });
  fireEvent.pointerMove(el, { pointerId: 1, clientX });
  fireEvent.pointerUp(el, { pointerId: 1, clientX });
}

describe('handle fade di waveform', () => {
  it('menarik handle kiri ke dalam memperpanjang fade-in', () => {
    render(<Studio />);
    drag(handle('in'), 100); // 25% dari 400px → 25% dari 10 s
    expect(selectedClip().fadeInMs).toBe(2500);
  });

  it('menarik handle kanan ke dalam memperpanjang fade-out', () => {
    render(<Studio />);
    drag(handle('out'), 300); // 25% diukur dari kanan
    expect(selectedClip().fadeOutMs).toBe(2500);
  });

  it('fade tidak bisa menembus fade sisi seberang', () => {
    studioActions.updateClip(selectedClip().id, { fadeOutMs: 7000 });
    render(<Studio />);
    drag(handle('in'), 320); // minta 8 s, headroom cuma 3 s
    expect(selectedClip().fadeInMs).toBe(3000);
    expect(selectedClip().fadeOutMs).toBe(7000); // sisi lain TIDAK ikut berubah
  });

  it('drag keluar batas kiri tidak menghasilkan nilai negatif', () => {
    render(<Studio />);
    drag(handle('in'), -200);
    expect(selectedClip().fadeInMs).toBe(0);
  });

  it('dobel-klik mengembalikan fade ke nol', () => {
    studioActions.updateClip(selectedClip().id, { fadeInMs: 4000 });
    render(<Studio />);
    fireEvent.doubleClick(handle('in'));
    expect(selectedClip().fadeInMs).toBe(0);
  });

  it('panah menggeser 0.1 s, dengan Shift 0.01 s', () => {
    render(<Studio />);
    fireEvent.keyDown(handle('in'), { key: 'ArrowRight' });
    expect(selectedClip().fadeInMs).toBe(100);
    fireEvent.keyDown(handle('in'), { key: 'ArrowRight', shiftKey: true });
    expect(selectedClip().fadeInMs).toBe(110);
    // Di sisi kanan, ← yang berarti "ke dalam" = lebih panjang.
    fireEvent.keyDown(handle('out'), { key: 'ArrowLeft' });
    expect(selectedClip().fadeOutMs).toBe(100);
  });

  it('pembacaan tampil dalam detik dua desimal, bukan milidetik', () => {
    studioActions.updateClip(selectedClip().id, { fadeInMs: 4250 });
    render(<Studio />);
    expect(document.querySelector('[data-fade-readout]')?.textContent).toContain('4.25 s');
  });
});

describe('kontrol pendukung', () => {
  it('preset per sisi hanya mengubah sisinya sendiri', () => {
    render(<Studio />);
    const blocks = screen.getAllByTitle(/fade in 8 detik/i);
    fireEvent.click(blocks[0]!);
    expect(selectedClip().fadeInMs).toBe(8000);
    expect(selectedClip().fadeOutMs).toBe(0);
  });

  it('preset yang tidak muat dinonaktifkan, bukan diam-diam dipotong', () => {
    studioActions.updateClip(selectedClip().id, { fadeOutMs: 9000 });
    render(<Studio />);
    // Sisa ruang cuma 1 s: preset 1s masih boleh, 8s tidak.
    const btns = screen.getAllByRole('button') as HTMLButtonElement[];
    const at = (text: string, nth: number): HTMLButtonElement =>
      btns.filter((b) => b.textContent === text)[nth]!;
    expect(at('1s', 0).disabled).toBe(false);
    expect(at('8s', 0).disabled).toBe(true);
  });

  it('field detik menerima nilai pecahan', () => {
    render(<Studio />);
    const field = screen.getByLabelText('FADE IN (detik)');
    fireEvent.change(field, { target: { value: '6.5' } });
    fireEvent.blur(field);
    expect(selectedClip().fadeInMs).toBe(6500);
  });

  it('toggle kurva menulis ke clip', () => {
    render(<Studio />);
    fireEvent.click(screen.getByText('LINEAR'));
    expect(selectedClip().fadeCurve).toBe('linear');
    fireEvent.click(screen.getByText('EQUAL-POWER'));
    expect(selectedClip().fadeCurve).toBe('equalPower');
  });
});
