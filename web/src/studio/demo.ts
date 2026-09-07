/**
 * Seed demo — angka-angkanya disalin dari `state` di design file, lalu
 * dikonversi dari detik ke sample (model.ts memakai sample, design memakai
 * detik karena ia mock).
 *
 * Ini data tampilan saja: tidak ada satu pun sample audio nyata di belakangnya,
 * jadi waveform-nya digambar dari `seed` (mock deterministik yang sama dengan
 * `bars()` di design). Begitu user men-drop file betulan, clip barunya punya
 * asset dan digambar dari peak asli.
 */

import { defaultEq, DEFAULT_FADE_CURVE, secToSamples, type StudioLane, type StudioState } from './model';

export const DEMO_SAMPLE_RATE = 48_000;

const sec = (v: number): number => secToSamples(v, DEMO_SAMPLE_RATE);

function lane(
  id: string,
  name: string,
  color: string,
  clips: readonly { id: string; start: number; len: number; label: string; seed: number }[],
): StudioLane {
  return {
    id,
    name,
    color,
    mute: false,
    solo: false,
    gainDb: 0,
    speedRatio: 1,
    eq: defaultEq(),
    chain: [],
    clips: clips.map((c) => ({
      id: c.id,
      assetId: 0,
      start: sec(c.start),
      len: sec(c.len),
      sourceLen: sec(c.len),
      sourceStart: 0,
      label: c.label,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      fadeCurve: DEFAULT_FADE_CURVE,
      seed: c.seed,
      chain: [],
    })),
  };
}

export function createDemoLanes(): StudioLane[] {
  return [
    lane('l1', 'MINGGU_MAKE IT PROJECTS', '#ffd400', [
      { id: 'c1', start: 0, len: 97, label: 'MINGGU_…MAKE IT PROJECTS.OGG', seed: 3 },
    ]),
    lane('l2', 'VOCAL TAKE', '#ffb020', [
      { id: 'c2', start: 12, len: 38, label: 'VOX_TAKE_04.WAV', seed: 8 },
      { id: 'c3', start: 62, len: 26, label: 'VOX_ADLIB.WAV', seed: 12 },
    ]),
    lane('l3', 'AMBIENCE', '#a07a10', [
      { id: 'c4', start: 4, len: 84, label: 'ROOM_TONE.WAV', seed: 21 },
    ]),
    lane('l4', 'LANE 4', '#6f6a5e', []),
  ];
}

/**
 * Lane tunggal yang kosong — INILAH kondisi awal aplikasi sebenarnya.
 *
 * Seed demo di atas hanya dipakai tes. Project baru tidak boleh berisi clip
 * yang tidak punya audio: waveform-nya digambar dari `seed` (mock), jadi ia
 * terlihat seperti materi sungguhan padahal tidak bisa dibunyikan sama sekali —
 * dan setelah refresh ia muncul lagi, seolah pekerjaan user tidak terhapus.
 */
export function createEmptyLane(): StudioLane {
  return lane('first', 'FIRST', '#ffd400', []);
}

/** State awal aplikasi: satu lane kosong, siap ditimpa file pertama. */
export function createInitialStudio(): StudioState {
  return {
    ...createDemoStudio(),
    lanes: [createEmptyLane()],
    playhead: 0,
    selectedLaneId: 'first',
    selectedClipId: null,
  };
}

/** Seed berisi clip mock. HANYA untuk tes — lihat catatan di createInitialStudio. */
export function createDemoStudio(): StudioState {
  return {
    projectName: 'PROJECT_BARU.STUDIO',
    sampleRate: DEMO_SAMPLE_RATE,
    duration: sec(120),
    lanes: createDemoLanes(),
    playing: false,
    playhead: sec(8),
    speed: 1,
    selectedLaneId: 'l1',
    selectedClipId: 'c1',
    pxPerSecond: null,
    tab: 'mix',
    format: 'AUTO',
    preset: 'FLAT',
    exportProgress: null,
    masterGainDb: 0,
    masterChain: [],
    renderSpeed: 1,
    exportFileName: '',
  };
}
