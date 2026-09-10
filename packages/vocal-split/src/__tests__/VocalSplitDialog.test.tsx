/**
 * Dialog SPLIT (docs/26 §3b) di atas store studio nyata; `runVocalSplit`
 * dipalsukan (`vi.mock('../split-job')`) supaya yang diuji adalah apa yang
 * dialog kirimkan, dan klien worker dipalsukan (`vi.mock('../split-client')`)
 * untuk baris status model + tombol UNDUH.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioClip } from '@kelasmalam/studio/studio/model';
import { studioActions, studioStore } from '@kelasmalam/studio/studio/store';

import type { VocalModelInfo } from '../mdx-model';
import type { SplitClient, SplitResult, SplitSeparateOptions } from '../split-client';
import { __resetVocalSplitSessionForTest, markVocalSplitJob } from '../split-session';
import { formatModelSize, VocalSplitDialog } from '../VocalSplitDialog';

const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => ({ laneIds: ['a', 'b'] })),
  cancel: vi.fn(() => true),
  client: null as unknown,
}));

vi.mock('../split-job', () => ({
  runVocalSplit: mocks.run,
  cancelVocalSplit: mocks.cancel,
}));

vi.mock('../split-client', () => ({
  createSplitClient: () => mocks.client,
}));

const READY: VocalModelInfo = {
  loadMs: 1, inputs: ['input'], outputs: ['output'], threads: 4,
  modelId: 'kim-vocal-2', modelBytes: 66_759_214, cacheHit: false, executionProvider: 'wasm',
};

/** `init` menunggu perintah tes: `progress()` lalu `ready()` / `fail()`. */
class FakeClient implements SplitClient {
  initCalls = 0;
  onProgress: ((p: { loaded: number; total: number; cacheHit: boolean }) => void) | undefined;
  private resolve: ((info: VocalModelInfo) => void) | null = null;
  private reject: ((reason: unknown) => void) | null = null;

  init(_modelId: 'kim-vocal-2', onProgress?: (p: { loaded: number; total: number; cacheHit: boolean }) => void) {
    this.initCalls += 1;
    this.onProgress = onProgress;
    return new Promise<VocalModelInfo>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  separate(_l: Float32Array, _r: Float32Array, _o: SplitSeparateOptions): Promise<SplitResult> {
    return Promise.reject(new Error('tidak dipakai di tes dialog'));
  }

  dispose(): void {}

  progress(loaded: number, total: number): void {
    this.onProgress?.({ loaded, total, cacheHit: false });
  }

  ready(): void {
    this.resolve?.(READY);
  }

  fail(message: string): void {
    this.reject?.(new Error(message));
  }
}

function withClip(): StudioClip {
  studioActions.__resetForTest('empty');
  const laneId = studioStore.getState().lanes[0]!.id;
  const clip: StudioClip = {
    id: studioActions.newClipId(),
    assetId: 1,
    chain: [],
    start: 0,
    len: 1000,
    sourceStart: 0,
    sourceLen: 1000,
    label: 'LAGU',
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
  };
  studioActions.addClip(laneId, clip);
  studioActions.selectClip(clip.id, laneId);
  return clip;
}

const pisahkan = (): HTMLButtonElement => screen.getByRole('button', { name: 'Pisahkan' }) as HTMLButtonElement;
const blocker = (): HTMLElement => document.querySelector('[data-split-blocker]') as HTMLElement;
const modelStatus = (): HTMLElement => document.querySelector('[data-split-model-status]') as HTMLElement;

let client: FakeClient;

beforeEach(() => {
  client = new FakeClient();
  mocks.client = client;
  mocks.run.mockClear();
  mocks.cancel.mockClear();
  // 8 core → thread bawaan `min(4, 8 − 2)` = 4, batas atas 8.
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
  __resetVocalSplitSessionForTest();
});

afterEach(() => {
  cleanup();
  __resetVocalSplitSessionForTest();
});

describe('VocalSplitDialog · sumber', () => {
  it('tanpa clip terpilih → PISAHKAN mati dengan alasan tertulis', () => {
    studioActions.__resetForTest('empty');
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(pisahkan().disabled).toBe(true);
    expect(blocker().textContent).toBe('pilih satu clip dulu');
    expect(document.querySelector('[data-split-source]')!.textContent).toBe('pilih satu clip dulu');
  });

  it('dengan clip terpilih → nama clip + lane tampil, PISAHKAN hidup', () => {
    withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(document.querySelector('[data-split-source]')!.textContent).toBe('LAGU — FIRST');
    expect(pisahkan().disabled).toBe(false);
    expect(blocker().textContent).toBe('');
  });

  it('export sedang berjalan → mati, "menunggu export"', () => {
    withClip();
    studioActions.setExportProgress(0.3);
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(pisahkan().disabled).toBe(true);
    expect(blocker().textContent).toMatch(/menunggu export/);
  });

  it('job split sedang jalan → mati, dan HENTIKAN memanggil cancelVocalSplit', () => {
    withClip();
    markVocalSplitJob({ id: 'import-9', clipId: 'x', laneId: 'first' });
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(pisahkan().disabled).toBe(true);
    expect(blocker().textContent).toMatch(/sedang berjalan/);
    fireEvent.click(screen.getByRole('button', { name: 'Hentikan' }));
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('VocalSplitDialog · PISAHKAN', () => {
  it('menutup dialog dan memanggil runVocalSplit dengan opsi bawaan', () => {
    const clip = withClip();
    const onClose = vi.fn();
    render(<VocalSplitDialog onClose={onClose} />);
    fireEvent.click(pisahkan());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith({
      clipId: clip.id,
      modelId: 'kim-vocal-2',
      overlap: 0.25,
      denoise: false,
      muteSource: true,
      maxThreads: 4,
    });
  });

  it('opsi yang dipilih ikut: overlap 0,5, denoise, tanpa mute, thread 2', () => {
    const clip = withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '0,5' }));
    fireEvent.click(screen.getByLabelText(/DENOISE/));
    fireEvent.click(screen.getByLabelText(/MUTE LANE SUMBER/));
    fireEvent.change(screen.getByLabelText('thread'), { target: { value: '2' } });
    fireEvent.click(pisahkan());
    expect(mocks.run).toHaveBeenCalledWith({
      clipId: clip.id,
      modelId: 'kim-vocal-2',
      overlap: 0.5,
      denoise: true,
      muteSource: false,
      maxThreads: 2,
    });
  });

  it('thread dijepit ke [1, core]', () => {
    const clip = withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('thread'), { target: { value: '99' } });
    fireEvent.click(pisahkan());
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ clipId: clip.id, maxThreads: 8 }));
  });

  it('galat job dilaporkan lewat alert', async () => {
    withClip();
    mocks.run.mockRejectedValueOnce(new Error('worker mati'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<VocalSplitDialog onClose={() => {}} />);
    fireEvent.click(pisahkan());
    await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Vocal split gagal: worker mati'));
    alertSpy.mockRestore();
  });
});

describe('VocalSplitDialog · model', () => {
  it('belum diunduh (66,8 MB) → mengunduh 40% → siap; UNDUH terpisah dari PISAHKAN', async () => {
    withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(formatModelSize(66_759_214)).toBe('66,8 MB');
    expect(modelStatus().textContent).toBe('belum diunduh (66,8 MB)');
    // PISAHKAN hidup meski model belum dimuat — job yang memuatnya.
    expect(pisahkan().disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'UNDUH' }));
    expect(client.initCalls).toBe(1);
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('mengunduh …'));
    act(() => client.progress(40, 100));
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('mengunduh 40%'));
    expect((screen.getByRole('button', { name: 'MENGUNDUH…' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => client.ready());
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('siap'));
    expect((screen.getByRole('button', { name: 'SIAP' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('unduhan gagal → alasannya tampil, UNDUH bisa ditekan lagi', async () => {
    withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'UNDUH' }));
    await act(async () => client.fail('HTTP 500'));
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('gagal: HTTP 500'));
    expect((screen.getByRole('button', { name: 'UNDUH' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('atribusi model tampil', () => {
    withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(screen.getByText(/Kim_Vocal_2 oleh KimberleyJSN/)).toBeTruthy();
  });
});

describe('VocalSplitDialog · dialog', () => {
  it('Escape dan BATAL menutup', () => {
    withClip();
    const onClose = vi.fn();
    render(<VocalSplitDialog onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Batal' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('fokus masuk ke dialog saat dibuka', () => {
    withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});
