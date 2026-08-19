/**
 * GRAF WEB AUDIO halaman DJ — satu-satunya tempat node dirangkai.
 *
 * Jalur sinyal per kanal, urutannya kontrak:
 *
 * ```
 *  DeckPlayer → ① TRIM → ② EQ hi/mid/low → ③ COLOR (2 biquad) → ④ CHANNEL FADER
 *                                                                   │
 *                                       ⑧ CUE BUS ◄─────────────────┤ (pre-crossfader)
 *                                                                   ▼
 *                                                        ⑤ CROSSFADER GAIN
 *                                                                   ▼
 *                                                        ⑥ MASTER ─► ⑦ tujuan
 * ```
 *
 * Dua urutan yang bukan selera:
 *
 * - **CUE diambil SEBELUM crossfader (⑧ setelah ④).** Seluruh guna monitor
 *   headphone adalah mendengar lagu yang **belum** masuk mix. Mengambilnya
 *   setelah crossfader berarti CUE ikut senyap justru saat paling dibutuhkan.
 * - **Channel fader sebelum crossfader (④ sebelum ⑤).** Menurunkan channel
 *   fader harus juga menurunkan kontribusinya ke crossfader; kalau dibalik,
 *   fader yang mentok di nol masih terdengar lewat sisi crossfader-nya.
 *
 * Semua parameter kontinu diubah lewat `setTargetAtTime`, bukan penugasan
 * langsung: satu tarikan fader menghasilkan puluhan nilai per detik, dan nilai
 * yang dilompati terdengar sebagai zipper noise.
 */

import {
  DECK_IDS,
  EQ_BAND_HZ,
  bandDb,
  colorFilterCoeffs,
  crossfaderGains,
  channelFaderGain,
  dbToGain,
  type ChannelState,
  type CrossfaderCurve,
  type DeckId,
} from '../model';
import { DeckPlayer } from './deck-player';

/** Tetapan waktu ramp. 12 ms membunuh zipper tanpa terasa lamban di tangan. */
const RAMP = 0.012;

export interface ChannelNodes {
  readonly input: GainNode;
  readonly trim: GainNode;
  readonly eq: Readonly<Record<'hi' | 'mid' | 'low', BiquadFilterNode>>;
  /** Dua biquad COLOR, SELALU terpasang seri. Lihat `colorFilterCoeffs`. */
  readonly colorLp: BiquadFilterNode;
  readonly colorHp: BiquadFilterNode;
  readonly fader: GainNode;
  /** Kirim ke bus CUE, pre-crossfader. 0 atau 1. */
  readonly cueSend: GainNode;
  readonly cross: GainNode;
  readonly analyser: AnalyserNode;
  readonly player: DeckPlayer;
}

export interface DjGraph {
  readonly ctx: AudioContext;
  readonly channels: Readonly<Record<DeckId, ChannelNodes>>;
  readonly master: GainNode;
  readonly masterAnalyser: AnalyserNode;
  /** Titik sisip Beat FX pada master; node FX dipasang di antara ini dan master. */
  readonly masterFxIn: GainNode;
  /** Jumlah kirim CUE dari kanal, pre-crossfader. */
  readonly cueBus: GainNode;
  /** Sisi CUE dari campuran headphone: `1 − cueMix`. */
  readonly cueSide: GainNode;
  /** Sisi MASTER dari campuran headphone: `cueMix`. */
  readonly masterSide: GainNode;
  /** Volume headphone keseluruhan. */
  readonly cueLevel: GainNode;
  readonly cueOut: MediaStreamAudioDestinationNode | null;
}

function makeChannel(ctx: AudioContext, master: AudioNode, cueBus: AudioNode): ChannelNodes {
  const input = ctx.createGain();
  const trim = ctx.createGain();

  const hi = ctx.createBiquadFilter();
  hi.type = 'highshelf';
  hi.frequency.value = EQ_BAND_HZ.hi;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = EQ_BAND_HZ.mid;
  mid.Q.value = 0.9;

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = EQ_BAND_HZ.low;

  const colorLp = ctx.createBiquadFilter();
  colorLp.type = 'lowpass';
  const colorHp = ctx.createBiquadFilter();
  colorHp.type = 'highpass';

  const fader = ctx.createGain();
  const cueSend = ctx.createGain();
  cueSend.gain.value = 0;
  const cross = ctx.createGain();

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  // Meter dibaca sebagai peak dari domain waktu, jadi penghalusan FFT bawaan
  // tidak relevan — dan meninggalkannya tinggi justru menyembunyikan transien.
  analyser.smoothingTimeConstant = 0;

  input.connect(trim);
  trim.connect(low);
  low.connect(mid);
  mid.connect(hi);
  hi.connect(colorLp);
  colorLp.connect(colorHp);
  colorHp.connect(fader);

  fader.connect(analyser);
  fader.connect(cueSend);
  cueSend.connect(cueBus);
  fader.connect(cross);
  cross.connect(master);

  const player = new DeckPlayer({ ctx, destination: input });

  return { input, trim, eq: { hi, mid, low }, colorLp, colorHp, fader, cueSend, cross, analyser, player };
}

export function buildDjGraph(ctx: AudioContext): DjGraph {
  const master = ctx.createGain();
  const masterFxIn = ctx.createGain();
  const masterAnalyser = ctx.createAnalyser();
  masterAnalyser.fftSize = 1024;
  masterAnalyser.smoothingTimeConstant = 0;

  // Titik sisip FX master: kanal masuk ke `masterFxIn`, dan `masterFxIn`
  // tersambung ke `master`. Menyisipkan efek berarti memutus satu sambungan
  // itu dan menaruh node di antaranya — tidak ada bagian graf lain yang perlu
  // tahu.
  masterFxIn.connect(master);
  master.connect(masterAnalyser);
  master.connect(ctx.destination);

  /**
   * Campuran headphone: `cue × (1 − mix) + master × mix`, lalu satu volume.
   *
   * Persis prosedur manual rekordbox — `[MIX]` di tengah berarti "volume MASTER
   * dan CUE sama". Dua gain terpisah, bukan satu crossfade, karena keduanya
   * memang dua sumber yang berbeda dan bukan dua ujung satu sinyal.
   */
  const cueBus = ctx.createGain();
  const cueSide = ctx.createGain();
  const masterSide = ctx.createGain();
  const cueLevel = ctx.createGain();

  cueBus.gain.value = 1;
  cueSide.gain.value = 1;
  masterSide.gain.value = 0;
  cueLevel.gain.value = 0;

  cueBus.connect(cueSide);
  cueSide.connect(cueLevel);
  master.connect(masterSide);
  masterSide.connect(cueLevel);

  /**
   * Keluaran CUE terpisah lewat `MediaStreamAudioDestinationNode`, supaya bisa
   * diarahkan ke PERANGKAT LAIN lewat `HTMLAudioElement.setSinkId`
   * (`cue-output.ts`).
   *
   * Ia sengaja TIDAK tersambung ke `ctx.destination`: kalau tersambung, menyalakan
   * CUE akan menambahkan lagu yang sama ke speaker utama — yaitu kebalikan dari
   * gunanya. Selama belum ada perangkat kedua yang dipilih, bus ini tidak
   * terdengar di mana pun, dan UI mengatakannya alih-alih berpura-pura memonitor.
   */
  const cueOut =
    typeof ctx.createMediaStreamDestination === 'function'
      ? ctx.createMediaStreamDestination()
      : null;
  if (cueOut !== null) cueLevel.connect(cueOut);

  const channels = {
    A: makeChannel(ctx, masterFxIn, cueBus),
    B: makeChannel(ctx, masterFxIn, cueBus),
  } as const;

  return {
    ctx,
    channels,
    master,
    masterAnalyser,
    masterFxIn,
    cueBus,
    cueSide,
    masterSide,
    cueLevel,
    cueOut,
  };
}

// ── Penerapan parameter ──────────────────────────────────────────────────────

function ramp(p: AudioParam, value: number, now: number): void {
  if (p.value === value) return;
  p.setTargetAtTime(value, now, RAMP);
}

export function applyChannel(nodes: ChannelNodes, ch: ChannelState, now: number): void {
  ramp(nodes.trim.gain, dbToGain(ch.trimDb), now);
  // dB EFEKTIF: nilai knob, atau −26 dB kalau band-nya dimatikan. Knob-nya
  // sendiri tidak disentuh — "while they light up, each controller is not
  // activated", bukan "controller-nya dipindahkan".
  ramp(nodes.eq.hi.gain, bandDb(ch.eq, ch.eqKill, 'hi'), now);
  ramp(nodes.eq.mid.gain, bandDb(ch.eq, ch.eqKill, 'mid'), now);
  ramp(nodes.eq.low.gain, bandDb(ch.eq, ch.eqKill, 'low'), now);

  const c = colorFilterCoeffs(ch.filter);
  ramp(nodes.colorLp.frequency, c.lpHz, now);
  ramp(nodes.colorLp.Q, c.lpQ, now);
  ramp(nodes.colorHp.frequency, c.hpHz, now);
  ramp(nodes.colorHp.Q, c.hpQ, now);

  ramp(nodes.fader.gain, channelFaderGain(ch.fader), now);
  ramp(nodes.cueSend.gain, ch.cue ? 1 : 0, now);
}

export function applyCrossfader(
  g: DjGraph,
  x: number,
  curve: CrossfaderCurve,
  now: number,
): void {
  const gains = crossfaderGains(x, curve);
  ramp(g.channels.A.cross.gain, gains.a, now);
  ramp(g.channels.B.cross.gain, gains.b, now);
}

export interface MasterParams {
  readonly masterDb: number;
  readonly cueDb: number;
  readonly cueMix: number;
  /** false = tidak ada perangkat CUE yang dipilih; headphone dibisukan. */
  readonly cueMonitored: boolean;
}

export function applyMaster(g: DjGraph, p: MasterParams, now: number): void {
  ramp(g.master.gain, dbToGain(p.masterDb), now);
  ramp(g.cueSide.gain, 1 - p.cueMix, now);
  ramp(g.masterSide.gain, p.cueMix, now);
  ramp(g.cueLevel.gain, p.cueMonitored ? dbToGain(p.cueDb) : 0, now);
}

export function disposeGraph(g: DjGraph): void {
  for (const id of DECK_IDS) g.channels[id].player.dispose();
}
