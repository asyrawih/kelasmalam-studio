/**
 * Gerbang SPLIT di web (docs/26 P5): tombol aktif hanya kalau
 * `isolated && sab && wasmThreads && simd` dan bukan iOS; selain itu tetap ada
 * tapi `disabled` dengan alasan di `title`. Deteksi caps dipalsukan — yang
 * diuji adalah gerbangnya, bukan `wasm-feature-detect`.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Caps } from '@kelasmalam/engine/audio/caps';

const capsMock = vi.hoisted(() => ({
  peek: null as Caps | null,
  detect: null as Caps | null,
}));

vi.mock('@kelasmalam/engine/audio/caps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kelasmalam/engine/audio/caps')>();
  return {
    ...actual,
    peekCaps: () => capsMock.peek,
    detectCaps: () => Promise.resolve(capsMock.detect ?? capsMock.peek ?? FULL),
  };
});

import { IOS_REASON, isIosLike, vocalSplitBlockedReason, vocalSplitToolbarActions } from './register';

const FULL: Caps = {
  isolated: true,
  sab: true,
  wasmThreads: true,
  simd: true,
  fileSystemAccess: true,
  webCodecs: true,
  audioWorklet: true,
  decodeInWorker: true,
  variant: 'mt',
};

const DESKTOP_MAC = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15', maxTouchPoints: 0 };
const IPHONE = { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 };
/** iPadOS 13+ menyamar sebagai Mac; yang membedakannya hanya layar sentuh. */
const IPADOS = { platform: 'MacIntel', userAgent: DESKTOP_MAC.userAgent, maxTouchPoints: 5 };

function setNavigator(nav: { platform: string; userAgent: string; maxTouchPoints: number }): void {
  for (const [key, value] of Object.entries(nav)) {
    Object.defineProperty(navigator, key, { configurable: true, value });
  }
}

const button = (): HTMLButtonElement => screen.getByRole('button', { name: 'SPLIT' }) as HTMLButtonElement;

beforeEach(() => {
  capsMock.peek = null;
  capsMock.detect = null;
  setNavigator(DESKTOP_MAC);
});

afterEach(cleanup);

describe('isIosLike', () => {
  it('Mac desktop tanpa sentuh → bukan iOS', () => {
    expect(isIosLike(DESKTOP_MAC)).toBe(false);
  });
  it('iPhone → iOS', () => {
    expect(isIosLike(IPHONE)).toBe(true);
  });
  it('iPadOS yang mengaku MacIntel tapi punya layar sentuh → iOS', () => {
    expect(isIosLike(IPADOS)).toBe(true);
  });
});

describe('vocalSplitBlockedReason', () => {
  it('caps penuh di desktop → boleh', () => {
    expect(vocalSplitBlockedReason(FULL, DESKTOP_MAC)).toBeNull();
  });
  it('belum terdeteksi → alasan sementara', () => {
    expect(vocalSplitBlockedReason(null, DESKTOP_MAC)).toMatch(/memeriksa/);
  });
  it('tidak isolated → alasan dari degradedReasons', () => {
    expect(vocalSplitBlockedReason({ ...FULL, isolated: false, sab: false, variant: 'st' }, DESKTOP_MAC)).toMatch(/cross-origin isolated/);
  });
  it('tanpa SIMD → alasan SIMD', () => {
    expect(vocalSplitBlockedReason({ ...FULL, simd: false }, DESKTOP_MAC)).toMatch(/SIMD128/);
  });
  it('iOS mengalahkan caps penuh', () => {
    expect(vocalSplitBlockedReason(FULL, IPHONE)).toBe(IOS_REASON);
  });
});

describe('vocalSplitToolbarActions', () => {
  it('caps penuh (sudah terdeteksi) → tombol SPLIT aktif dengan title paket', () => {
    capsMock.peek = FULL;
    render(<>{vocalSplitToolbarActions()}</>);
    expect(button().disabled).toBe(false);
    expect(button().title).toBe('Pisahkan vokal & instrumen (Kim_Vocal_2)');
    expect(button().getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('caps belum terdeteksi → nonaktif dulu, lalu aktif setelah detectCaps selesai', async () => {
    capsMock.detect = FULL;
    render(<>{vocalSplitToolbarActions()}</>);
    expect(button().disabled).toBe(true);
    expect(button().title).toMatch(/memeriksa/);
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it('tidak isolated → tombol ada, disabled, alasan COOP/COEP di title', () => {
    capsMock.peek = { ...FULL, isolated: false, sab: false, variant: 'st' };
    render(<>{vocalSplitToolbarActions()}</>);
    expect(button().disabled).toBe(true);
    expect(button().title).toContain('Pisahkan vokal & instrumen');
    expect(button().title).toMatch(/cross-origin isolated/);
  });

  it('iPhone → disabled dengan alasan iOS meski caps penuh', () => {
    capsMock.peek = FULL;
    setNavigator(IPHONE);
    render(<>{vocalSplitToolbarActions()}</>);
    expect(button().disabled).toBe(true);
    expect(button().title).toContain(IOS_REASON);
  });

  it('iPadOS yang menyamar Mac → disabled dengan alasan iOS', () => {
    capsMock.peek = FULL;
    setNavigator(IPADOS);
    render(<>{vocalSplitToolbarActions()}</>);
    expect(button().disabled).toBe(true);
    expect(button().title).toContain(IOS_REASON);
  });
});
