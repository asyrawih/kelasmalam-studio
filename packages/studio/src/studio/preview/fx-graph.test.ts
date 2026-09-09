/**
 * Setiap chain yang tidak kosong HARUS diminta node-nya.
 *
 * Ini tes yang seharusnya ada sejak awal. Versi pertama worklet menyambungkan
 * node untuk chain lane dan master tapi TIDAK untuk chain clip — efek clip
 * sampai ke berkas hasil export dan tidak pernah berbunyi saat diputar.
 *
 * Guard paritas tidak menangkapnya, dan alasannya layak diingat: graf preview
 * menandai `clipFx:` sebagai fitur yang "diterapkan" padahal node-nya tidak
 * pernah dibangun. Penanda yang berbohong membuat `preview ⊆ export` lulus
 * dengan mulus. Penandanya sekarang ditulis tepat di sebelah perakitannya, dan
 * tes ini memeriksa perakitannya langsung — bukan penandanya.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_FADE_CURVE, defaultEq, type StudioLane, type StudioState } from '../model';

const created: { chain: readonly { kind: string }[] }[] = [];

vi.mock('./fx-node', () => ({
  ensureFxRuntime: () => Promise.resolve(true),
  fxCatalog: () => null,
  fxPreviewStatus: () => ({ ready: true, error: null }),
  registerFxWorklet: () => Promise.resolve(true),
  createFxNode: (_audio: unknown, chain: readonly { kind: string }[]) => {
    if (chain.length === 0) return null;
    created.push({ chain });
    return { connect: vi.fn(), disconnect: vi.fn(), port: { postMessage: vi.fn() } };
  },
  pushFxParams: () => undefined,
  chainShape: (c: readonly { kind: string }[]) => c.map((f) => f.kind).join('>'),
}));

const { buildProjectGraph } = await import('./graph-builder');

const param = (): unknown => ({
  value: 0,
  setValueAtTime: vi.fn(),
  setTargetAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

const node = (extra: Record<string, unknown> = {}): unknown => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  channelCount: 2,
  channelCountMode: 'explicit',
  channelInterpretation: 'speakers',
  ...extra,
});

const ctx = (): BaseAudioContext =>
  ({
    sampleRate: 48_000,
    currentTime: 0,
    destination: node(),
    createGain: () => node({ gain: param() }),
    createBiquadFilter: () => node({ frequency: param(), Q: param(), gain: param() }),
    createChannelSplitter: () => node(),
    createChannelMerger: () => node(),
    createBufferSource: () =>
      node({ buffer: null, playbackRate: param(), start: vi.fn(), stop: vi.fn(), onended: null }),
  }) as unknown as BaseAudioContext;

const PCM = new Float32Array(4_800);
const buffer = (): AudioBuffer =>
  ({
    length: PCM.length,
    duration: 1,
    numberOfChannels: 2,
    sampleRate: 48_000,
    getChannelData: () => PCM,
  }) as unknown as AudioBuffer;

function state(): StudioState {
  const lane: StudioLane = {
    id: 'L1',
    name: 'L1',
    color: '#ffd400',
    mute: false,
    solo: false,
    gainDb: 0,
    chain: [{ kind: 'filter', enabled: true, params: {} }],
    speedRatio: 1,
    eq: defaultEq(),
    clips: [
      {
        id: 'c1',
        assetId: 7,
        chain: [{ kind: 'pitch', enabled: true, params: { semitones: 4 } }],
        start: 0,
        len: 48_000,
        sourceStart: 0,
        sourceLen: 48_000,
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        fadeCurve: DEFAULT_FADE_CURVE,
        label: 'c1',
        seed: 1,
      } as StudioLane['clips'][number],
    ],
  };
  return {
    ...({} as StudioState),
    sampleRate: 48_000,
    duration: 96_000,
    lanes: [lane],
    masterGainDb: 0,
    masterChain: [{ kind: 'reverb', enabled: true, params: {} }],
    speed: 1,
    renderSpeed: 1,
    playhead: 0,
    playing: false,
  } as StudioState;
}

describe('perakitan node FX di graf preview', () => {
  it('meminta node untuk chain lane, clip, DAN master', () => {
    created.length = 0;
    buildProjectGraph(ctx(), state(), {
      playheadSec: 0,
      startAt: 0,
      getBuffer: () => buffer(),
    });

    const kinds = created.map((c) => c.chain.map((f) => f.kind).join(','));
    expect(kinds, 'chain lane tidak diminta node-nya').toContain('filter');
    expect(kinds, 'chain CLIP tidak diminta node-nya').toContain('pitch');
    expect(kinds, 'chain master tidak diminta node-nya').toContain('reverb');
  });

  it('node yang terbentuk bisa dijangkau untuk update parameter live', () => {
    const graph = buildProjectGraph(ctx(), state(), {
      playheadSec: 0,
      startAt: 0,
      getBuffer: () => buffer(),
    });
    // Tanpa ini, menggeser knob tidak punya jalan sampai ke node yang berbunyi.
    expect(graph.clipFx.get('c1'), 'node clip tidak terdaftar').toBeDefined();
    expect(graph.lanes.get('L1')?.fx, 'node lane tidak terdaftar').toBeTruthy();
    expect(graph.masterFx, 'node master tidak terdaftar').toBeTruthy();
  });

  it('chain kosong tidak membuat node sama sekali', () => {
    created.length = 0;
    const s = state();
    const bare: StudioState = {
      ...s,
      masterChain: [],
      lanes: s.lanes.map((l) => ({
        ...l,
        chain: [],
        clips: l.clips.map((c) => ({ ...c, chain: [] })),
      })),
    };
    const graph = buildProjectGraph(ctx(), bare, {
      playheadSec: 0,
      startAt: 0,
      getBuffer: () => buffer(),
    });
    expect(created).toHaveLength(0);
    expect(graph.clipFx.size).toBe(0);
    expect(graph.masterFx).toBeNull();
  });
});
