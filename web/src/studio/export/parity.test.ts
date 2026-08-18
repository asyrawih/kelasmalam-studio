/**
 * Guard divergensi preview ↔ export.
 *
 * Ada satu kelas kegagalan yang benar-benar pernah terjadi di sini, dan ia
 * tidak menghasilkan error di mana pun: sebuah field dipakai graf preview dan
 * tidak pernah dikirim ke payload export. `clip.stem` hidup seperti itu selama
 * berbulan-bulan — terdengar saat diputar, hilang dari berkas.
 *
 * Membandingkan SAMPLE tidak mungkin: Node tidak punya Web Audio, dan biquad
 * Web Audio bukan implementasi yang sama dengan Rust. Yang bisa dibandingkan
 * adalah "apa yang diterapkan", dan itu sudah cukup — tuntutannya
 * `preview ⊆ export`.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildExportPayload, payloadFeatures } from './payload';
import { DEFAULT_FADE_CURVE, defaultEq, type StudioLane, type StudioState } from '../model';

vi.mock('../preview/fx-node', () => ({
  ensureFxRuntime: () => Promise.resolve(false),
  fxCatalog: () => null,
  fxPreviewStatus: () => ({ ready: false, error: null }),
  registerFxWorklet: () => Promise.resolve(false),
  // Node FX tidak bisa dibuat di jsdom; itu TIDAK mengurangi arti tes ini,
  // karena penanda fitur dicatat dari `lane.chain`, bukan dari node-nya.
  createFxNode: () => null,
  pushFxParams: () => undefined,
  chainShape: () => '',
}));

const { buildProjectGraph } = await import('../preview/graph-builder');

// ── konteks Web Audio palsu ────────────────────────────────────────────────

const param = (): unknown => ({
  value: 0,
  setValueAtTime: vi.fn(),
  setTargetAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

function node(extra: Record<string, unknown> = {}): unknown {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    ...extra,
  };
}

function fakeContext(): BaseAudioContext {
  return {
    sampleRate: 48_000,
    currentTime: 0,
    destination: node(),
    createGain: () => node({ gain: param() }),
    createBiquadFilter: () => node({ frequency: param(), Q: param(), gain: param(), type: 'peaking' }),
    createChannelSplitter: () => node(),
    createChannelMerger: () => node(),
    createBufferSource: () =>
      node({
        buffer: null,
        playbackRate: param(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      }),
  } as unknown as BaseAudioContext;
}

const PCM = new Float32Array(4_800);

const buffer = (): AudioBuffer =>
  ({
    length: PCM.length,
    duration: PCM.length / 48_000,
    numberOfChannels: 2,
    sampleRate: 48_000,
    getChannelData: () => PCM,
  }) as unknown as AudioBuffer;

// ── project yang menyentuh SEMUA jalur sekaligus ───────────────────────────

function maximalState(): StudioState {
  const lane = (id: string, extra: Partial<StudioLane> = {}): StudioLane => ({
    id,
    name: id,
    color: '#ffd400',
    mute: false,
    solo: false,
    gainDb: -3,
    chain: [
      { kind: 'filter', enabled: true, params: { knob: -0.5 } },
      { kind: 'echo', enabled: false, params: { time: 250 } },
    ],
    speedRatio: 1,
    eq: defaultEq(),
    clips: [
      {
        id: `${id}-c1`,
        assetId: 7,
        start: 0,
        len: 48_000,
        sourceStart: 0,
        sourceLen: 48_000,
        gainDb: -1,
        fadeInMs: 100,
        fadeOutMs: 200,
        fadeCurve: DEFAULT_FADE_CURVE,
        label: 'c1',
        seed: 1,
        // REMOVE aktif: inilah field yang dulu hilang tanpa jejak.
        stem: { vocal: 0.2, bass: 1, other: 1, bassSplitHz: 180, voiceTopHz: 6_000 },
      } as StudioLane['clips'][number],
    ],
    ...extra,
  });

  return {
    ...({} as StudioState),
    projectName: 'p',
    sampleRate: 48_000,
    duration: 96_000,
    lanes: [lane('L1'), lane('L2')],
    masterGainDb: -2,
    masterChain: [{ kind: 'reverb', enabled: true, params: { decay: 3_000 } }],
    speed: 1,
    renderSpeed: 1,
    playhead: 0,
    playing: false,
  } as StudioState;
}

describe('paritas preview ↔ export', () => {
  it('semua yang diterapkan preview ikut ke payload export', () => {
    const state = maximalState();
    const graph = buildProjectGraph(fakeContext(), state, {
      playheadSec: 0,
      startAt: 0,
      getBuffer: () => buffer(),
    });
    const exported = payloadFeatures(buildExportPayload(state, () => buffer()).json);

    const missing = [...graph.features].filter((f) => !exported.has(f));
    expect(
      missing,
      `preview menerapkan hal yang tidak pernah dikirim ke export: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /// Tes di atas hanya bermakna kalau ia benar-benar melihat sesuatu.
  it('benar-benar mengamati fitur, bukan himpunan kosong', () => {
    const state = maximalState();
    const graph = buildProjectGraph(fakeContext(), state, {
      playheadSec: 0,
      startAt: 0,
      getBuffer: () => buffer(),
    });
    expect(graph.features.size).toBeGreaterThan(5);
    expect([...graph.features].some((f) => f.startsWith('stem:'))).toBe(true);
    expect([...graph.features].some((f) => f.startsWith('fx:'))).toBe(true);
    expect([...graph.features].some((f) => f.startsWith('masterFx:'))).toBe(true);
  });
});
