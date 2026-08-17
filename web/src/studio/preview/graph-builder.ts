/**
 * PEMBANGUN GRAF WEB AUDIO — SATU-SATUNYA tempat susunan node dibuat.
 *
 * Kenapa file ini dipisah dari `audio-preview.ts`: sejak export offline ada,
 * ADA DUA yang perlu merakit graf yang sama — preview realtime (`AudioContext`)
 * dan bounce (`OfflineAudioContext`). docs/03 memperingatkan tepat pada titik
 * ini: begitu ada dua jalur render, yang terdengar dan yang ter-export bisa
 * berbeda tanpa ada yang menyadarinya. Karena itu keduanya WAJIB memanggil
 * `buildProjectGraph()` di sini; tidak boleh ada implementasi kedua untuk gain,
 * EQ, fade, atau speed.
 *
 * Parameternya `BaseAudioContext` (bukan `AudioContext`) justru supaya
 * `OfflineAudioContext` masuk tanpa cabang khusus.
 *
 * Rantai per lane (urutan mengikuti signal flow docs/07):
 *   clip gain (+fade) → EQ band 1..n → lane gain → destination
 */

import {
  DEFAULT_FADE_CURVE,
  effectiveSpeed,
  isAudible,
  type EqSettings,
  type StudioClip,
  type StudioState,
} from '../model';
import { fadeCurveArray, fadeOutGain } from '../timeline/fade';

/** Ramp pendek supaya perubahan parameter tidak menimbulkan klik. */
export const PARAM_RAMP_SEC = 0.02;

/** Jumlah titik kurva yang dikirim ke `setValueCurveAtTime`. 128 titik untuk
 *  fade sepanjang detik sudah jauh di bawah ambang terdengarnya tangga. */
export const FADE_CURVE_POINTS = 128;

export function dbToLin(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20);
}

/**
 * Node per lane yang masih hidup, supaya EQ dan fader bisa diubah SAAT
 * BERBUNYI tanpa menjadwalkan ulang apa pun.
 */
export interface LaneNodes {
  /** Satu filter per band, urutan SAMA dengan `lane.eq.bands` — itu yang
   *  membuat update parameter bisa dilakukan by-index tanpa mencari-cari. */
  readonly filters: BiquadFilterNode[];
  readonly gain: GainNode;
}

export interface BuiltGraph {
  readonly lanes: Map<string, LaneNodes>;
  /** Source yang sudah di-`start()`; perlu di-`stop()` saat preview berhenti. */
  readonly voices: AudioBufferSourceNode[];
  /** Node non-source (gain, filter) — perlu di-disconnect saat berhenti. */
  readonly nodes: AudioNode[];
}

export interface GraphBuildOptions {
  /** Posisi awal di TIMELINE (detik) yang dipetakan ke `startAt`. */
  readonly playheadSec: number;
  /** Waktu konteks (detik) tempat `playheadSec` jatuh. Offline: 0. */
  readonly startAt: number;
  /** PCM per asset. Clip tanpa buffer dilewati (clip demo tanpa audio nyata). */
  readonly getBuffer: (assetId: number) => AudioBuffer | undefined;
  /** Default `audio.destination`. */
  readonly destination?: AudioNode;
}

interface EnvelopeTiming {
  readonly startAt: number;
  readonly wallDurationSec: number;
  readonly transportSpeed: number;
  /** Sudah berapa detik (timeline) clip ini berjalan saat play ditekan. */
  readonly clipElapsedSec: number;
}

/**
 * Rantai EQ parametrik lane: satu BiquadFilterNode per band, dirangkai
 * berurutan lalu masuk ke `output`. Elemen pertama adalah MASUKAN rantai.
 *
 * Band dengan 0 dB tetap dibuat supaya rantainya seragam dan indeksnya cocok
 * satu-satu dengan `lane.eq.bands` — itulah yang membuat update parameter live
 * cukup mengubah nilai dan tidak pernah menambah/menghapus node.
 */
export function buildEqChain(
  audio: BaseAudioContext,
  eq: EqSettings,
  output: AudioNode,
): BiquadFilterNode[] {
  const filters = eq.bands.map((band) => {
    const f = audio.createBiquadFilter();
    f.type = band.kind;
    f.frequency.value = band.freq;
    f.Q.value = band.q;
    f.gain.value = band.gainDb;
    return f;
  });

  for (let i = 0; i < filters.length; i++) {
    const next = filters[i + 1] ?? output;
    filters[i]!.connect(next);
  }
  return filters;
}

/**
 * Gain clip + fade in/out sebagai otomasi pada satu GainNode.
 *
 * Kasus yang mudah salah: render/play dimulai di TENGAH fade-in. Kalau kita
 * selalu mulai dari 0, potongan yang seharusnya sudah keras akan terdengar
 * mengecil lagi. Karena itu kurva yang dijadwalkan adalah POTONGAN SISA-nya
 * (`from = elapsed/fadeIn`), bukan kurva penuh dari nol. Ini juga yang membuat
 * render bersegmen aman: segmen kedua menyambung di nilai yang benar.
 *
 * Kurvanya dikirim lewat `setValueCurveAtTime`, bukan `linearRampToValueAtTime`:
 * equal-power berbentuk sin/cos dan tidak bisa dinyatakan sebagai ramp lurus
 * sama sekali. Linear pun lewat jalur yang sama supaya hanya ada satu perilaku
 * penjadwalan yang perlu dipahami.
 */
export function applyClipGainEnvelope(
  gain: GainNode,
  clip: StudioClip,
  t: EnvelopeTiming,
): void {
  const target = dbToLin(clip.gainDb);
  const { startAt, wallDurationSec, transportSpeed, clipElapsedSec } = t;
  // Durasi fade disimpan di waktu TIMELINE; jadwal Web Audio memakai jam
  // dinding. Transport 2× membuat fade 4 detik selesai dalam 2 detik nyata.
  const fadeInSec = clip.fadeInMs / 1000 / transportSpeed;
  const fadeOutSec = clip.fadeOutMs / 1000 / transportSpeed;
  const elapsedWall = clipElapsedSec / transportSpeed;
  const curve = clip.fadeCurve === 'linear' ? 'linear' : DEFAULT_FADE_CURVE;

  gain.gain.cancelScheduledValues(0);

  // ── Fade in ──
  // Sisa fade-out juga dihitung dulu: kalau fade-in dan fade-out sampai
  // bersentuhan, jadwal keduanya tidak boleh tumpang tindih — `setValueCurve`
  // melempar NotSupportedError kalau ada event lain di dalam rentangnya, dan
  // exception itu akan membunuh penjadwalan clip-clip berikutnya.
  const outLen = fadeOutSec > 0 ? Math.min(fadeOutSec, wallDurationSec) : 0;
  const outStart = wallDurationSec > 0 && outLen > 0 ? startAt + (wallDurationSec - outLen) : Infinity;

  const inRemaining = Math.min(fadeInSec - elapsedWall, outStart - startAt);
  if (fadeInSec > 0 && inRemaining > 0) {
    const from = Math.max(0, Math.min(1, elapsedWall / fadeInSec));
    const to = Math.min(1, from + inRemaining / fadeInSec);
    // TIDAK ada setValueAtTime di titik yang sama: kurva sudah dimulai dari
    // nilai yang benar, dan event tambahan di `startAt` justru bentrok.
    gain.gain.setValueCurveAtTime(
      fadeCurveArray(curve, 'in', target, FADE_CURVE_POINTS, from, to),
      startAt,
      inRemaining,
    );
  } else {
    gain.gain.setValueAtTime(target, startAt);
  }

  // ── Fade out ──
  if (outLen > 0) {
    // Fade out bisa SUDAH berjalan saat mulai (playhead di dalamnya): yang
    // dijadwalkan hanya sisanya, mulai dari posisi yang tepat.
    const from = 1 - outLen / fadeOutSec;
    if (outStart > startAt && !(fadeInSec > 0 && inRemaining > 0)) {
      // Tahan nilai penuh sampai fade-out mulai; tanpa ini titik otomasi
      // terakhir tertarik lebih awal dan seluruh clip ikut meredup.
      gain.gain.setValueAtTime(target * fadeOutGain(curve, from), Math.max(0, outStart - 1e-4));
    }
    gain.gain.setValueCurveAtTime(
      fadeCurveArray(curve, 'out', target, FADE_CURVE_POINTS, from, 1),
      outStart,
      outLen,
    );
  }
}

/**
 * Rakit SELURUH project menjadi graf Web Audio pada `audio`.
 *
 * `speed` (transport) diterapkan sebagai `playbackRate` DAN sebagai pembagi
 * waktu jadwal: clip yang mulai 10 detik lagi pada speed 2× harus berbunyi 5
 * detik lagi. `lane.speedRatio` selain itu juga mengubah RUANG WAKTU source:
 * satu detik timeline memakan `speedRatio` detik buffer.
 */
export function buildProjectGraph(
  audio: BaseAudioContext,
  state: StudioState,
  opts: GraphBuildOptions,
): BuiltGraph {
  const lanesOut = new Map<string, LaneNodes>();
  const voices: AudioBufferSourceNode[] = [];
  const nodes: AudioNode[] = [];

  const sr = state.sampleRate;
  const speed = state.speed;
  const { playheadSec, startAt } = opts;
  const destination = opts.destination ?? audio.destination;

  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    // Kecepatan efektif = kecepatan lane × transport (docs/07 §8d).
    const rate = effectiveSpeed(lane, speed);
    const laneRatio = lane.speedRatio;

    const laneGainNode = audio.createGain();
    laneGainNode.gain.value = dbToLin(lane.gainDb);
    const filters = buildEqChain(audio, lane.eq, laneGainNode);
    laneGainNode.connect(destination);
    nodes.push(laneGainNode, ...filters);
    lanesOut.set(lane.id, { filters, gain: laneGainNode });
    // Lane tanpa band sama sekali tetap harus berbunyi: masuk langsung ke fader.
    const eqInput: AudioNode = filters[0] ?? laneGainNode;

    for (const clip of lane.clips) {
      const buffer = opts.getBuffer(clip.assetId);
      if (buffer === undefined) continue; // clip demo tanpa PCM asli — dilewati

      const clipStartSec = clip.start / sr;
      const clipEndSec = (clip.start + clip.len) / sr;
      if (clipEndSec <= playheadSec) continue; // sudah lewat

      // Offset di dalam source kalau playhead jatuh di tengah clip.
      // KONVERSI RUANG: `intoClipSec` diukur di TIMELINE, tapi `offset` dan
      // `duration` milik AudioBufferSourceNode diukur di SOURCE (waktu buffer).
      // Clip 2× lebih cepat berarti tiap detik timeline memakan dua detik
      // source — mengabaikan ini membuat clip mulai dari titik yang salah dan
      // berhenti terlalu cepat/lambat.
      const intoClipSec = Math.max(0, playheadSec - clipStartSec);
      const offsetSec = clip.sourceStart / sr + intoClipSec * laneRatio;
      const remainingTimelineSec = clipEndSec - Math.max(playheadSec, clipStartSec);
      if (remainingTimelineSec <= 0) continue;
      const remainingSec = remainingTimelineSec * laneRatio;

      const whenSec = startAt + Math.max(0, clipStartSec - playheadSec) / speed;

      const src = audio.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;

      const gain = audio.createGain();
      applyClipGainEnvelope(gain, clip, {
        startAt: whenSec,
        // Durasi di JAM DINDING, bukan timeline: transport 2× membuat clip
        // 10 detik selesai dalam 5 detik nyata, jadi fade-nya juga separuh.
        wallDurationSec: remainingTimelineSec / speed,
        transportSpeed: speed,
        clipElapsedSec: intoClipSec,
      });

      src.connect(gain).connect(eqInput);
      try {
        src.start(whenSec, offsetSec, remainingSec);
      } catch {
        continue; // offset di luar buffer — lewati, jangan bunuh yang lain
      }
      nodes.push(gain);
      voices.push(src);
    }
  }

  return { lanes: lanesOut, voices, nodes };
}
