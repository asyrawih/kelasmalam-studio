/**
 * Seed project yang isinya SAMA PERSIS dengan data di design file
 * (`trackData()`, `chanData()`, `library`, `rack` di blok `<script type="text/x-dc">`).
 *
 * Kenapa ada: tanpa asset yang di-import, seluruh UI akan kosong dan tidak bisa
 * dibandingkan dengan design. Ini BUKAN mock data yang dikarang — setiap nama,
 * warna, posisi, dan lebar clip disalin dari design supaya screenshot aplikasi
 * bisa ditumpuk di atas design file.
 *
 * Posisi/lebar di design dinyatakan dalam PERSEN dari 32 bar. Di sini
 * dikonversi ke sample memakai tempo & sample rate nyata, jadi begitu asset
 * asli masuk, satu-satunya yang berubah adalah dari mana peak-nya datang.
 */

import { dbToLin, faderToDb } from './gain';
import type { AudioAsset, Clip, Project, Track } from './model';
import { sourceSample, timelineSample } from './model';

const BARS = 32;
const BEATS_PER_BAR = 4;

export const projectLengthSamples = (sampleRate: number, bpm: number): number =>
  Math.round((BARS * BEATS_PER_BAR * 60 * sampleRate) / bpm);

interface DesignClip {
  readonly id: number;
  /** left dalam persen, seperti di design. */
  readonly l: number;
  /** width dalam persen. */
  readonly w: number;
  readonly label: string;
}

interface DesignTrack {
  readonly id: number;
  readonly name: string;
  readonly kind: Track['kind'];
  readonly color: string;
  readonly fx: string;
  /** travel fader 0..1 (design memakai 0..100). */
  readonly fader: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly clips: readonly DesignClip[];
}

/** Disalin dari `trackData()` + `chanData()` di design. */
const DESIGN_TRACKS: readonly DesignTrack[] = [
  {
    id: 0,
    name: 'LEAD VOX',
    kind: 'AUDIO',
    color: '#ffd400',
    fx: 'DE-ESS · DLY',
    fader: 0.79,
    pan: 0,
    mute: false,
    clips: [
      { id: 1, l: 6, w: 26, label: 'VERSE A' },
      { id: 2, l: 40, w: 34, label: 'CHORUS' },
    ],
  },
  {
    id: 1,
    name: 'DRUM BUS',
    kind: 'GROUP',
    color: '#ffb020',
    fx: 'GATE · VERB',
    fader: 0.74,
    pan: -0.12,
    mute: false,
    clips: [{ id: 3, l: 0, w: 82, label: 'BREAKBEAT LOOP' }],
  },
  {
    id: 2,
    name: '808 BASS',
    kind: 'MIDI',
    color: '#ff7ad9',
    fx: 'SUB · GLUE',
    fader: 0.88,
    pan: 0,
    mute: false,
    clips: [
      { id: 4, l: 6, w: 30, label: 'SUB LINE' },
      { id: 5, l: 44, w: 22, label: 'SUB LINE' },
      { id: 6, l: 70, w: 14, label: 'FILL' },
    ],
  },
  {
    id: 3,
    name: 'ANALOG PAD',
    kind: 'MIDI',
    color: '#6ee7ff',
    fx: 'CHORUS',
    fader: 0.61,
    pan: 0.24,
    mute: false,
    clips: [{ id: 7, l: 18, w: 56, label: 'CHORD BED' }],
  },
  {
    id: 4,
    name: 'FX / RISERS',
    kind: 'AUDIO',
    color: '#a78bfa',
    fx: 'REVERB',
    fader: 0.45,
    pan: -0.3,
    mute: true,
    clips: [
      { id: 8, l: 34, w: 10, label: 'RISE' },
      { id: 9, l: 66, w: 8, label: 'IMPACT' },
    ],
  },
];

/** Disalin dari `rack` di design — insert chain LEAD VOX. */
const DESIGN_RACK = [
  { id: 1, kind: 'GATE', on: true, val: 'THR -34 dB' },
  { id: 2, kind: 'COMP 1176', on: true, val: 'RATIO 4:1' },
  { id: 3, kind: 'TAPE SAT', on: true, val: 'DRIVE 38%' },
  { id: 4, kind: 'TAPE DELAY', on: false, val: '1/8 · 22%' },
  { id: 5, kind: 'PLATE VERB', on: true, val: 'SIZE 62%' },
] as const;

/** Disalin dari `library` di design. */
export const DESIGN_LIBRARY = [
  { id: '1', name: 'NEON_KICK_01.wav', meta: '0.6 s · 48k', tag: 'DRUM' },
  { id: '2', name: 'GLASS_SNARE.wav', meta: '0.4 s · 48k', tag: 'DRUM' },
  { id: '3', name: 'SUB_808_Fmin.wav', meta: '2.1 s · 48k', tag: 'BASS' },
  { id: '4', name: 'RISER_LONG.wav', meta: '4.0 s · 48k', tag: 'FX' },
  { id: '5', name: 'VOX_CHOP_PACK', meta: '24 files', tag: 'FOLDER' },
  { id: '6', name: 'ANALOG_PAD.preset', meta: 'synth', tag: 'PRESET' },
] as const;

/** Knob di design: DRIVE 62, TONE 38, MIX 80, WIDTH 45. */
export const DESIGN_KNOB_LABELS = ['DRIVE', 'TONE', 'MIX', 'WIDTH'] as const;
const DESIGN_KNOB_VALUES = [0.62, 0.38, 0.8, 0.45];

export function createDemoProject(sampleRate: number, bpm = 128): Project {
  const total = projectLengthSamples(sampleRate, bpm);
  const pct = (v: number): number => Math.round((v / 100) * total);

  const assets: AudioAsset[] = DESIGN_TRACKS.map((t) => ({
    id: t.id,
    name: `${t.name.replace(/[^A-Z0-9]+/g, '_')}.wav`,
    sampleRate,
    channels: 2,
    lengthSamples: total,
    // Belum ada PCM: peakPtr 0 berarti "pakai PeakSource sintetis"
    // (ui/lib/peaks.ts). Begitu import nyata jalan, nilai ini datang dari
    // worker import dan tidak ada satu pun komponen yang perlu berubah.
    peakPtr: 0,
    memGeneration: 0,
  }));

  const tracks: Track[] = DESIGN_TRACKS.map((t) => {
    const clips: Clip[] = t.clips.map((c) => ({
      id: c.id,
      name: c.label,
      assetId: t.id,
      sourceStart: sourceSample(0),
      sourceLen: pct(c.w),
      timelinePos: timelineSample(pct(c.l)),
      gain: 1,
      fadeIn: { lengthSamples: Math.round(sampleRate * 0.01), curve: 'equalPower' },
      fadeOut: { lengthSamples: Math.round(sampleRate * 0.01), curve: 'equalPower' },
      speedRatio: 1,
      insertChain: [],
    }));

    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      color: t.color,
      fxSummary: t.fx,
      gain: dbToLin(faderToDb(t.fader)),
      pan: t.pan,
      mute: t.mute,
      solo: false,
      armed: false,
      clips,
      insertChain:
        t.id === 0
          ? DESIGN_RACK.map((fx, i) => ({
              id: fx.id,
              kind: fx.kind,
              bypassed: !fx.on,
              valueLabel: fx.val,
              params: DESIGN_KNOB_VALUES,
              paramBase: 512 + i * 8,
            }))
          : [],
      sends: [],
    };
  });

  return {
    name: 'DEMO',
    sampleRate,
    tempoMap: [{ atTick: 0, bpm }],
    tracks,
    assets,
    masterGain: dbToLin(-0.3),
    masterSpeedRatio: 1,
    loopStart: timelineSample(pct(12)),
    loopEnd: timelineSample(pct(44)),
    loopEnabled: true,
  };
}
