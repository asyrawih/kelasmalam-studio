/**
 * Dialog SPLIT (docs/26 §3b) di atas store studio nyata; `runVocalSplit`
 * dipalsukan (`vi.mock('../split-job')`) supaya yang diuji adalah apa yang
 * dialog kirimkan, dan klien worker dipalsukan (`vi.mock('../split-client')`)
 * untuk baris status model + tombol UNDUH.
 *
 * Runtime (docs/26 P3b): host bawaan tes (web) → badge `WASM`; host palsu
 * dengan `vocalSplit` → badge `NATIVE · …`, pilihan akselerasi kalau lebih
 * dari satu, baris THREAD hanya untuk CPU, dan UNDUH lewat `ensureModel` host
 * tanpa menyentuh klien worker. Dengan `navigator.gpu` palsu → badge
 * `WEBGPU`, tombol WASM/WEBGPU, `runtimeNote`, dan baris waktu job terakhir.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setPlatformHostForTests,
  type PlatformHost,
  type ScnetModelDownloadProgress,
  type VocalSplitAccel,
  type VocalSplitHost,
} from '@kelasmalam/platform';

import { DEFAULT_FADE_CURVE, type StudioClip } from '@kelasmalam/studio/studio/model';
import { studioActions, studioStore } from '@kelasmalam/studio/studio/store';

import type { VocalModelInfo } from '../mdx-model';
import type { SplitClient, SplitResult, SplitSeparateOptions } from '../split-client';
import {
  __resetVocalSplitSessionForTest,
  ensureVocalModel,
  markVocalSplitJob,
  setVocalSplitError,
  setVocalSplitOutcome,
  vocalSplitSnapshot,
} from '../split-session';
import { formatModelSize, runtimeBadgeText, splitTimingText, VocalSplitDialog } from '../VocalSplitDialog';

const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => ({ laneIds: ['a', 'b'] })),
  cancel: vi.fn(() => true),
  client: null as unknown,
  /** Pabrik klien untuk tes yang butuh lebih dari satu (ganti EP, fallback); null → `client`. */
  create: null as null | (() => unknown),
}));

vi.mock('../split-job', () => ({
  runVocalSplit: mocks.run,
  cancelVocalSplit: mocks.cancel,
}));

vi.mock('../split-client', () => ({
  createSplitClient: () => (mocks.create === null ? mocks.client : mocks.create()),
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

const webHost: PlatformHost = {
  kind: 'web',
  pickSaveTarget: async () => ({ kind: 'cancelled' }),
  openExternal: async () => {},
  authHeaders: async () => ({}),
};

/** Host native palsu: `ensureModel` menunggu perintah tes; `run` tidak dipakai (job di-mock). */
class FakeNative implements VocalSplitHost {
  ensureCalls = 0;
  onProgress: ((p: ScnetModelDownloadProgress) => void) | undefined;
  private resolve: (() => void) | null = null;

  constructor(readonly accelList: readonly VocalSplitAccel[]) {}

  accels(): Promise<readonly VocalSplitAccel[]> {
    return Promise.resolve(this.accelList);
  }

  ensureModel(_id: 'kim-vocal-2', onProgress: (p: ScnetModelDownloadProgress) => void): Promise<void> {
    this.ensureCalls += 1;
    this.onProgress = onProgress;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  run(): Promise<never> {
    return Promise.reject(new Error('tidak dipakai di tes dialog'));
  }

  ready(): void {
    this.onProgress?.({ loaded: 66_759_214, total: 66_759_214, cacheHit: true });
    this.resolve?.();
  }
}

const badge = (): HTMLElement => document.querySelector('[data-split-runtime]') as HTMLElement;

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
  mocks.create = null;
  mocks.run.mockClear();
  mocks.cancel.mockClear();
  // 8 core → thread bawaan `min(8, 8 − 2)` = 6, batas atas `8 − 1` = 7.
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
  __resetVocalSplitSessionForTest();
});

afterEach(() => {
  cleanup();
  delete (navigator as unknown as { gpu?: unknown }).gpu;
  setPlatformHostForTests(null);
  __resetVocalSplitSessionForTest();
});

/** `navigator.gpu` palsu dengan adapter — WebGPU dianggap tersedia. */
function installGpu(): void {
  Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
}

/** Tiap `createSplitClient` memberi klien baru, dicatat urut. */
function clientFactory(): FakeClient[] {
  const clients: FakeClient[] = [];
  mocks.create = () => {
    const c = new FakeClient();
    clients.push(c);
    return c;
  };
  return clients;
}

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
      maxThreads: 6,
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

  it('thread dijepit ke [1, core − 1]', () => {
    const clip = withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    const input = screen.getByLabelText('thread') as HTMLInputElement;
    expect(input.max).toBe('7');
    expect(screen.getByText('dari 7 core')).toBeTruthy();
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(pisahkan());
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ clipId: clip.id, maxThreads: 7 }));
  });

});

describe('VocalSplitDialog · galat job', () => {
  // `window.alert` di WKWebView (wry) tidak menampilkan apa pun; galat harus
  // ke konsol DAN ke sesi supaya tampil di dialog.
  it('galat job → console.error + baris galat di dialog, BUKAN alert', async () => {
    withClip();
    const err = new Error('worker mati');
    mocks.run.mockRejectedValueOnce(err);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<VocalSplitDialog onClose={() => {}} />);
    fireEvent.click(pisahkan());
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('[vocal-split]', err));
    expect(alertSpy).not.toHaveBeenCalled();
    const line = await vi.waitFor(() => {
      const el = document.querySelector('[data-split-error]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent).toContain('SPLIT GAGAL — worker mati');
    expect(vocalSplitSnapshot().lastError).toBe('worker mati');
    alertSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('kode galat host (VocalSplitCommandError.code) ikut di pesan', async () => {
    withClip();
    mocks.run.mockRejectedValueOnce(Object.assign(new Error('Kim_Vocal_2.onnx belum diunduh'), { code: 'MODEL_MISSING' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<VocalSplitDialog onClose={() => {}} />);
    fireEvent.click(pisahkan());
    await vi.waitFor(() => expect(vocalSplitSnapshot().lastError).toBe('MODEL_MISSING: Kim_Vocal_2.onnx belum diunduh'));
    expect(document.querySelector('[data-split-error]')!.textContent).toContain('MODEL_MISSING: Kim_Vocal_2.onnx belum diunduh');
    errorSpy.mockRestore();
  });

  it('galat tetap tampil saat dialog dibuka lagi; TUTUP menghapusnya', () => {
    withClip();
    setVocalSplitError('INFERENCE: shape mismatch');
    const first = render(<VocalSplitDialog onClose={() => {}} />);
    expect(document.querySelector('[data-split-error]')!.textContent).toContain('INFERENCE: shape mismatch');
    first.unmount();

    // Dialog dibuka lagi setelah galat: pesannya masih ada — hidup di sesi, bukan di komponen.
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(document.querySelector('[data-split-error]')!.textContent).toContain('INFERENCE: shape mismatch');
    fireEvent.click(screen.getByRole('button', { name: 'Tutup pesan galat' }));
    expect(document.querySelector('[data-split-error]')).toBeNull();
    expect(vocalSplitSnapshot().lastError).toBeNull();
  });

  it('job terakhir batal → baris status beralasan, bukan galat', () => {
    withClip();
    setVocalSplitOutcome({ cancelled: true, reason: 'clip-hilang' });
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(document.querySelector('[data-split-error]')).toBeNull();
    const line = document.querySelector('[data-split-outcome]')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toBe('job terakhir dibatalkan: clip sumber hilang saat job berjalan');
  });

  it('job sukses → baris waktu (total, ms/segmen, inferensi), tanpa baris galat maupun batal', () => {
    withClip();
    setVocalSplitOutcome({ laneIds: ['a', 'b'], totalMs: 56_329, inferenceMs: 50_700, segments: 13 });
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(document.querySelector('[data-split-error]')).toBeNull();
    expect(document.querySelector('[data-split-outcome]')).toBeNull();
    const line = document.querySelector('[data-split-timing]')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toBe('job terakhir selesai dalam 56,3 s · 4 333 ms/segmen (13 segmen) · inferensi 3 900 ms/segmen');
  });

  it('belum ada job → tanpa baris galat, batal, maupun waktu', () => {
    withClip();
    render(<VocalSplitDialog onClose={() => {}} />);
    expect(document.querySelector('[data-split-error]')).toBeNull();
    expect(document.querySelector('[data-split-outcome]')).toBeNull();
    expect(document.querySelector('[data-split-timing]')).toBeNull();
  });

  it('splitTimingText: native tanpa inferensi, nol segmen, batal/null', () => {
    expect(splitTimingText({ laneIds: ['a'], totalMs: 24_000, inferenceMs: null, segments: 40 }))
      .toBe('job terakhir selesai dalam 24,0 s · 600 ms/segmen (40 segmen)');
    expect(splitTimingText({ laneIds: ['a'], totalMs: 1500, inferenceMs: 1000, segments: 0 }))
      .toBe('job terakhir selesai dalam 1,5 s');
    expect(splitTimingText({ cancelled: true, reason: 'signal' })).toBe('');
    expect(splitTimingText(null)).toBe('');
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

describe('VocalSplitDialog · runtime (docs/26 P3b)', () => {
  it('runtimeBadgeText: kosong sebelum probe, WASM/WEBGPU, NATIVE · CPU/COREML', () => {
    expect(runtimeBadgeText(null, 'cpu')).toBe('');
    expect(runtimeBadgeText('wasm', 'coreml')).toBe('WASM');
    expect(runtimeBadgeText('wasm', 'cpu', 'webgpu')).toBe('WEBGPU');
    expect(runtimeBadgeText('native', 'cpu')).toBe('NATIVE · CPU');
    expect(runtimeBadgeText('native', 'coreml', 'webgpu')).toBe('NATIVE · COREML');
  });

  it('host tanpa vocalSplit → badge WASM, tanpa pilihan akselerasi, THREAD ada', async () => {
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    await vi.waitFor(() => expect(badge().textContent).toBe('WASM'));
    expect(document.querySelector('[data-split-accel]')).toBeNull();
    expect(screen.getByLabelText('thread')).toBeTruthy();
  });

  it('host native cpu+coreml → badge NATIVE · COREML, pilihan CPU/COREML, THREAD hanya saat CPU', async () => {
    const native = new FakeNative(['cpu', 'coreml']);
    setPlatformHostForTests({ ...webHost, vocalSplit: native });
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    await vi.waitFor(() => expect(badge().textContent).toBe('NATIVE · COREML'));
    expect(document.querySelector('[data-split-accel]')).not.toBeNull();
    const coreml = screen.getByRole('button', { name: 'COREML' });
    const cpu = screen.getByRole('button', { name: 'CPU' });
    expect(coreml.getAttribute('aria-pressed')).toBe('true');
    expect(cpu.getAttribute('aria-pressed')).toBe('false');
    // CoreML mengatur threadnya sendiri: baris THREAD disembunyikan.
    expect(screen.queryByLabelText('thread')).toBeNull();

    fireEvent.click(cpu);
    await vi.waitFor(() => expect(badge().textContent).toBe('NATIVE · CPU'));
    expect(cpu.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('thread')).toBeTruthy();
    expect(vocalSplitSnapshot().accel).toBe('cpu');

    // Pilihan hidup di sesi, bukan di parameter job — job membacanya sendiri.
    fireEvent.click(pisahkan());
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'kim-vocal-2', maxThreads: 6 }));
    const params = (mocks.run.mock.calls as unknown as [[Record<string, unknown>]])[0][0];
    expect(params).not.toHaveProperty('accel');
  });

  it('host native hanya cpu → badge NATIVE · CPU, tanpa pilihan akselerasi, THREAD ada', async () => {
    setPlatformHostForTests({ ...webHost, vocalSplit: new FakeNative(['cpu']) });
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    await vi.waitFor(() => expect(badge().textContent).toBe('NATIVE · CPU'));
    expect(document.querySelector('[data-split-accel]')).toBeNull();
    expect(screen.getByLabelText('thread')).toBeTruthy();
  });

  it('UNDUH di host native → ensureModel host (unduhan saja), klien worker tidak dibuat, status siap', async () => {
    const native = new FakeNative(['cpu', 'coreml']);
    setPlatformHostForTests({ ...webHost, vocalSplit: native });
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    expect(modelStatus().textContent).toBe('belum diunduh (66,8 MB)');
    fireEvent.click(screen.getByRole('button', { name: 'UNDUH' }));
    expect(native.ensureCalls).toBe(1);
    expect(client.initCalls).toBe(0);
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('mengunduh …'));
    act(() => native.onProgress?.({ loaded: 25, total: 100, cacheHit: false }));
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('mengunduh 25%'));
    await act(async () => native.ready());
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('siap'));
    expect((screen.getByRole('button', { name: 'SIAP' }) as HTMLButtonElement).disabled).toBe(true);
    expect(vocalSplitSnapshot().model).toMatchObject({ kind: 'ready', info: { runtime: 'native' } });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe('VocalSplitDialog · WebGPU di jalur worker', () => {
  it('adapter ada → badge WEBGPU, tombol WASM/WEBGPU (WEBGPU bawaan), THREAD tetap; pilih WASM → badge WASM', async () => {
    installGpu();
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    await vi.waitFor(() => expect(badge().textContent).toBe('WEBGPU'));
    expect(document.querySelector('[data-split-accel]')).not.toBeNull();
    const webgpu = screen.getByRole('button', { name: 'WEBGPU' });
    const wasm = screen.getByRole('button', { name: 'WASM' });
    expect(webgpu.getAttribute('aria-pressed')).toBe('true');
    expect(wasm.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByLabelText('thread')).toBeTruthy();

    fireEvent.click(wasm);
    await vi.waitFor(() => expect(badge().textContent).toBe('WASM'));
    expect(wasm.getAttribute('aria-pressed')).toBe('true');
    expect(vocalSplitSnapshot().wasmAccel).toBe('wasm');
    // Pilihan hidup di sesi (EP `ensureVocalModel`), bukan di parameter job.
    fireEvent.click(pisahkan());
    const params = (mocks.run.mock.calls as unknown as [[Record<string, unknown>]])[0][0];
    expect(params).not.toHaveProperty('wasmAccel');
    expect(params).not.toHaveProperty('executionProvider');
  });

  it('UNDUH dengan WEBGPU → init klien dengan executionProvider webgpu; ganti ke WASM → klien baru init wasm', async () => {
    installGpu();
    const clients = clientFactory();
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    await vi.waitFor(() => expect(badge().textContent).toBe('WEBGPU'));
    fireEvent.click(screen.getByRole('button', { name: 'UNDUH' }));
    expect(clients).toHaveLength(1);
    await act(async () => clients[0]!.ready());
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('siap'));

    fireEvent.click(screen.getByRole('button', { name: 'WASM' }));
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('mengunduh …'));
    await act(async () => clients[1]!.ready());
    await vi.waitFor(() => expect(modelStatus().textContent).toBe('siap'));
    expect(vocalSplitSnapshot().model).toMatchObject({ kind: 'ready', info: { model: { executionProvider: 'wasm' } } });
  });

  it('init WebGPU gagal → jatuh ke WASM: badge WASM, WASM terpilih, catatan "WebGPU gagal" tampil', async () => {
    installGpu();
    const clients = clientFactory();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    await vi.waitFor(() => expect(badge().textContent).toBe('WEBGPU'));
    // Seperti UNDUH/PISAHKAN: `ensureVocalModel` dengan EP bawaan sesi (webgpu).
    act(() => {
      void ensureVocalModel('kim-vocal-2').catch(() => {});
    });
    expect(clients).toHaveLength(1);
    await act(async () => clients[0]!.fail('WebGPU: adapter hilang'));
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await act(async () => clients[1]!.ready());
    await vi.waitFor(() => expect(badge().textContent).toBe('WASM'));
    expect(screen.getByRole('button', { name: 'WASM' }).getAttribute('aria-pressed')).toBe('true');
    const note = document.querySelector('[data-split-runtime-note]')!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe('WebGPU gagal (init: WebGPU: adapter hilang), memakai WASM');
    expect(modelStatus().textContent).toBe('siap');
    expect(String(warn.mock.calls[0]![0])).toMatch(/webgpu gagal, jatuh ke wasm/);
    warn.mockRestore();
  });

  it('tanpa adapter → tidak ada tombol akselerasi, tanpa catatan', async () => {
    withClip();
    await act(async () => {
      render(<VocalSplitDialog onClose={() => {}} />);
    });
    await vi.waitFor(() => expect(badge().textContent).toBe('WASM'));
    expect(document.querySelector('[data-split-accel]')).toBeNull();
    expect(document.querySelector('[data-split-runtime-note]')).toBeNull();
  });
});
