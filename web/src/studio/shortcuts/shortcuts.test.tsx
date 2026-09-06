/**
 * Pintasan Studio lewat registry shell.
 *
 * Harness-nya persis yang dilakukan `/studio` di aplikasi: daftarkan
 * `studioCommands()` dan pasang dispatcher shell — tanpa listener keyboard
 * milik Studio sendiri. Yang dijaga di sini adalah PERILAKU yang dulu dimiliki
 * `useTransportShortcuts` (Spasi tahan/ketuk, pre-roll cursor, Backspace di
 * input, panah, X/C/V/B) tetap sama sesudah pemetaannya pindah ke registry.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useCommands } from '../../app-shell/useCommands';
import { useKeyDispatch } from '../../app-shell/useKeyDispatch';
import { __clearCommandsForTest } from '../../app-shell/command';
import { studioCommands } from '../commands';
import { studioActions, studioStore } from '../store';
import { clearTimelineCursor, setTimelineCursor } from '../timeline/timeline-cursor';
import { isSpaceHeld, markSpacePan, resetSpace } from './space-pan';

function Harness(): JSX.Element {
  useCommands(studioCommands());
  useKeyDispatch();
  return <input data-lane-name defaultValue="LANE 1" />;
}

/** Tombol disebut lewat `code` (posisi fisik) — itu yang dibaca keymap shell. */
function press(code: string, target?: EventTarget, init: KeyboardEventInit = {}): void {
  const ev = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(ev);
}

function release(code: string, target?: EventTarget, init: KeyboardEventInit = {}): void {
  const ev = new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(ev);
}

describe('pintasan transport', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    clearTimelineCursor();
    resetSpace();
  });
  afterEach(() => {
    cleanup();
    __clearCommandsForTest();
  });

  it('Space men-toggle play dari mana saja — saat DILEPAS', () => {
    render(<Harness />);
    const before = studioStore.getState().playing;
    // Selama ditahan, spasi adalah alat tangan untuk pan timeline; transport
    // tidak boleh berubah sampai jelas bahwa ia cuma diketuk.
    press('Space');
    expect(studioStore.getState().playing).toBe(before);
    release('Space');
    expect(studioStore.getState().playing).toBe(!before);
  });

  it('Space mulai play tiga detik sebelum cursor timeline', () => {
    render(<Harness />);
    const sr = studioStore.getState().sampleRate;
    setTimelineCursor(sr * 20);
    press('Space');
    release('Space');
    expect(studioStore.getState().playing).toBe(true);
    expect(studioStore.getState().playhead).toBe(sr * 17);
  });

  it('Space untuk pause tidak memindahkan playhead ke cursor', () => {
    render(<Harness />);
    const sr = studioStore.getState().sampleRate;
    studioActions.setPlayhead(sr * 8);
    studioActions.setPlaying(true);
    setTimelineCursor(sr * 20);
    press('Space');
    release('Space');
    expect(studioStore.getState().playing).toBe(false);
    expect(studioStore.getState().playhead).toBe(sr * 8);
  });

  it('Space yang dipakai untuk pan TIDAK ikut men-toggle play', () => {
    render(<Harness />);
    const before = studioStore.getState().playing;
    press('Space');
    markSpacePan(); // ClipArea memanggilnya saat pan benar-benar dimulai
    release('Space');
    expect(studioStore.getState().playing).toBe(before);
  });

  it('auto-repeat saat ditahan tidak menumpuk toggle', () => {
    render(<Harness />);
    const before = studioStore.getState().playing;
    press('Space');
    press('Space', undefined, { repeat: true });
    press('Space', undefined, { repeat: true });
    release('Space');
    expect(studioStore.getState().playing).toBe(!before);
  });

  it('kehilangan fokus jendela membatalkan keadaan tahan', () => {
    render(<Harness />);
    press('Space');
    expect(isSpaceHeld()).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(isSpaceHeld()).toBe(false);
    // Dan keyup yang datang belakangan tidak lagi menyalakan transport.
    const before = studioStore.getState().playing;
    release('Space');
    expect(studioStore.getState().playing).toBe(before);
  });

  it('Space dicegah defaultnya saat ditekan DAN dilepas — supaya tidak menggulir halaman', () => {
    render(<Harness />);
    const down = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    window.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const up = new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true });
    window.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
  });

  it('Backspace mengembalikan playhead ke awal; Home dan Enter juga', () => {
    render(<Harness />);
    for (const code of ['Backspace', 'Home', 'Enter']) {
      studioActions.setPlayhead(48_000 * 30);
      expect(studioStore.getState().playhead).toBeGreaterThan(0);
      press(code);
      expect(studioStore.getState().playhead, code).toBe(0);
    }
  });

  it('End membawa playhead ke akhir', () => {
    render(<Harness />);
    press('End');
    expect(studioStore.getState().playhead).toBe(studioStore.getState().duration);
  });

  it('TIDAK membajak Backspace saat mengetik di input nama lane', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    studioActions.setPlayhead(48_000 * 30);
    const before = studioStore.getState().playhead;

    press('Backspace', input as EventTarget);

    // Playhead tidak boleh bergerak — Backspace milik input, untuk hapus teks.
    expect(studioStore.getState().playhead).toBe(before);
  });

  it('Space di dalam input tidak ditahan sebagai alat pan, dan keyup-nya tidak memutar', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input') as HTMLInputElement;
    const before = studioStore.getState().playing;
    press('Space', input);
    expect(isSpaceHeld()).toBe(false);
    release('Space', input);
    expect(studioStore.getState().playing).toBe(before);
  });

  it('mengabaikan kombinasi dengan modifier (shortcut browser tetap jalan)', () => {
    render(<Harness />);
    const before = studioStore.getState().playing;
    press('Space', undefined, { metaKey: true, ctrlKey: true });
    release('Space', undefined, { metaKey: true, ctrlKey: true });
    expect(studioStore.getState().playing).toBe(before);
  });

  it('panah menggeser playhead, Shift memperhalus', () => {
    render(<Harness />);
    const sr = studioStore.getState().sampleRate;
    studioActions.setPlayhead(sr * 30);
    press('ArrowRight');
    expect(studioStore.getState().playhead).toBe(sr * 35);
    press('ArrowLeft', undefined, { shiftKey: true });
    expect(studioStore.getState().playhead).toBe(sr * 34);
  });

  it('Cmd/Ctrl+Z membatalkan edit terakhir, Shift+Z mengulanginya', () => {
    render(<Harness />);
    const before = studioStore.getState().masterGainDb;
    studioActions.setMasterGain(before - 6);
    press('KeyZ', undefined, { metaKey: true, ctrlKey: true });
    expect(studioStore.getState().masterGainDb).toBe(before);
    press('KeyZ', undefined, { metaKey: true, ctrlKey: true, shiftKey: true });
    expect(studioStore.getState().masterGainDb).toBe(before - 6);
  });
});

describe('pintasan editing clip', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });
  afterEach(() => {
    cleanup();
    __clearCommandsForTest();
  });

  it('X menghapus clip terpilih', () => {
    render(<Harness />);
    const id = studioStore.getState().selectedClipId;
    expect(id).not.toBeNull();
    press('KeyX');
    const gone = studioStore
      .getState()
      .lanes.flatMap((l) => l.clips)
      .some((c) => c.id === id);
    expect(gone).toBe(false);
    expect(studioStore.getState().selectedClipId).toBeNull();
  });

  it('C lalu V menyalin clip ke playhead dan BERBAGI asset yang sama', () => {
    render(<Harness />);
    const src = studioStore.getState();
    const original = src.lanes.flatMap((l) => l.clips).find((c) => c.id === src.selectedClipId);
    expect(original).toBeDefined();

    press('KeyC');
    studioActions.setPlayhead(src.sampleRate * 90);
    press('KeyV');

    const after = studioStore.getState();
    const pasted = after.lanes.flatMap((l) => l.clips).find((c) => c.id === after.selectedClipId);
    expect(pasted).toBeDefined();
    expect(pasted!.id).not.toBe(original!.id); // clip baru
    expect(pasted!.assetId).toBe(original!.assetId); // PCM tidak diduplikasi
    expect(pasted!.start).toBe(src.sampleRate * 90); // jatuh di playhead
  });

  it('V tanpa copy sebelumnya tidak melakukan apa-apa', () => {
    render(<Harness />);
    const before = studioStore.getState().lanes.flatMap((l) => l.clips).length;
    press('KeyV');
    expect(studioStore.getState().lanes.flatMap((l) => l.clips).length).toBe(before);
  });

  it('Cmd/Ctrl+A memilih semua clip', () => {
    render(<Harness />);
    const total = studioStore.getState().lanes.flatMap((l) => l.clips).length;
    expect(total).toBeGreaterThan(1);
    press('KeyA', undefined, { metaKey: true, ctrlKey: true });
    expect(studioStore.getState().selectedClipIds.length).toBe(total);
  });
});

describe('pintasan B — split di playhead', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });
  afterEach(() => {
    cleanup();
    __clearCommandsForTest();
  });

  it('memecah clip terpilih jadi dua di posisi playhead', () => {
    render(<Harness />);
    const s = studioStore.getState();
    const clip = s.lanes.flatMap((l) => l.clips).find((c) => c.id === s.selectedClipId)!;
    const before = s.lanes.flatMap((l) => l.clips).length;

    studioActions.setPlayhead(clip.start + Math.round(clip.len / 2));
    press('KeyB');

    const clips = studioStore.getState().lanes.flatMap((l) => l.clips);
    expect(clips.length).toBe(before + 1);

    // Sambungannya harus rapat: tidak ada celah, tidak ada tumpang tindih.
    const left = clips.find((c) => c.id === clip.id)!;
    const right = clips.find((c) => c.start === left.start + left.len)!;
    expect(right).toBeDefined();
    expect(left.len + right.len).toBe(clip.len);
  });

  it('tidak melakukan apa-apa kalau playhead di luar clip terpilih', () => {
    render(<Harness />);
    const s = studioStore.getState();
    const clip = s.lanes.flatMap((l) => l.clips).find((c) => c.id === s.selectedClipId)!;
    const before = s.lanes.flatMap((l) => l.clips).length;

    studioActions.setPlayhead(clip.start + clip.len + 48_000);
    press('KeyB');

    expect(studioStore.getState().lanes.flatMap((l) => l.clips).length).toBe(before);
  });

  it('tidak membajak B saat mengetik nama lane', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input')!;
    const s = studioStore.getState();
    const clip = s.lanes.flatMap((l) => l.clips).find((c) => c.id === s.selectedClipId)!;
    studioActions.setPlayhead(clip.start + Math.round(clip.len / 2));
    const before = s.lanes.flatMap((l) => l.clips).length;

    press('KeyB', input);

    expect(studioStore.getState().lanes.flatMap((l) => l.clips).length).toBe(before);
  });
});
