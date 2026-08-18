import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { useTransportShortcuts } from './useTransportShortcuts';

function Harness(): JSX.Element {
  useTransportShortcuts();
  return <input data-lane-name defaultValue="LANE 1" />;
}

function press(key: string, target?: EventTarget, init: KeyboardEventInit = {}): void {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(ev);
}

function release(key: string, target?: EventTarget, init: KeyboardEventInit = {}): void {
  const ev = new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(ev);
}

describe('useTransportShortcuts', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });

  it('Space men-toggle play dari mana saja — saat DILEPAS', () => {
    render(<Harness />);
    const before = studioStore.getState().playing;
    // Selama ditahan, spasi adalah alat tangan untuk pan timeline; transport
    // tidak boleh berubah sampai jelas bahwa ia cuma diketuk.
    press(' ');
    expect(studioStore.getState().playing).toBe(before);
    release(' ');
    expect(studioStore.getState().playing).toBe(!before);
  });

  it('Space yang dipakai untuk pan TIDAK ikut men-toggle play', async () => {
    const { markSpacePan } = await import('./space-pan');
    render(<Harness />);
    const before = studioStore.getState().playing;
    press(' ');
    markSpacePan(); // ClipArea memanggilnya saat pan benar-benar dimulai
    release(' ');
    expect(studioStore.getState().playing).toBe(before);
  });

  it('auto-repeat saat ditahan tidak menumpuk toggle', () => {
    render(<Harness />);
    const before = studioStore.getState().playing;
    press(' ');
    press(' ');
    press(' ');
    release(' ');
    expect(studioStore.getState().playing).toBe(!before);
  });

  it('kehilangan fokus jendela membatalkan keadaan tahan', async () => {
    const { isSpaceHeld } = await import('./space-pan');
    render(<Harness />);
    press(' ');
    expect(isSpaceHeld()).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(isSpaceHeld()).toBe(false);
    // Dan keyup yang datang belakangan tidak lagi menyalakan transport.
    const before = studioStore.getState().playing;
    release(' ');
    expect(studioStore.getState().playing).toBe(before);
  });

  it('Backspace mengembalikan playhead ke awal', () => {
    render(<Harness />);
    studioActions.setPlayhead(48_000 * 30);
    expect(studioStore.getState().playhead).toBeGreaterThan(0);
    press('Backspace');
    expect(studioStore.getState().playhead).toBe(0);
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

  it('mengabaikan kombinasi dengan modifier (shortcut browser tetap jalan)', () => {
    render(<Harness />);
    const before = studioStore.getState().playing;
    press(' ', undefined, { metaKey: true });
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
});

describe('shortcut editing clip', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });

  it('X menghapus clip terpilih', () => {
    render(<Harness />);
    const id = studioStore.getState().selectedClipId;
    expect(id).not.toBeNull();
    press('x');
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

    press('c');
    studioActions.setPlayhead(src.sampleRate * 90);
    press('v');

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
    press('v');
    expect(studioStore.getState().lanes.flatMap((l) => l.clips).length).toBe(before);
  });
});

describe('shortcut B — split di playhead', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });

  it('memecah clip terpilih jadi dua di posisi playhead', () => {
    render(<Harness />);
    const s = studioStore.getState();
    const clip = s.lanes.flatMap((l) => l.clips).find((c) => c.id === s.selectedClipId)!;
    const before = s.lanes.flatMap((l) => l.clips).length;

    studioActions.setPlayhead(clip.start + Math.round(clip.len / 2));
    press('b');

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
    press('b');

    expect(studioStore.getState().lanes.flatMap((l) => l.clips).length).toBe(before);
  });

  it('tidak membajak B saat mengetik nama lane', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input')!;
    const s = studioStore.getState();
    const clip = s.lanes.flatMap((l) => l.clips).find((c) => c.id === s.selectedClipId)!;
    studioActions.setPlayhead(clip.start + Math.round(clip.len / 2));
    const before = s.lanes.flatMap((l) => l.clips).length;

    press('b', input);

    expect(studioStore.getState().lanes.flatMap((l) => l.clips).length).toBe(before);
  });
});
