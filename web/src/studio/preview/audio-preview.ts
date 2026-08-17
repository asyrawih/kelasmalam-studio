/**
 * PREVIEW PLAYBACK — jalur SEMENTARA, bukan arsitektur akhir.
 *
 * Kenapa ada: engine Rust/WASM belum di-build (`web/src/wasm/` kosong, butuh
 * nightly + `-Z build-std`), jadi tanpa ini tombol PLAY tidak mengeluarkan
 * suara sama sekali. Modul ini memakai Web Audio biasa — satu
 * `AudioBufferSourceNode` per clip — supaya hasil drag & drop bisa langsung
 * didengar.
 *
 * BATASAN YANG DISENGAJA (jangan ditambah, jangan dianggap engine):
 *   - Tidak ada FX, tidak ada compressor. Yang ada hanya gain, mute/solo,
 *     playbackRate, dan EQ parametrik 4 band lewat BiquadFilterNode.
 *   - `playbackRate` = VARISPEED: pitch ikut berubah. Sama seperti perilaku
 *     engine untuk MVP (docs/07), jadi setidaknya tidak menyesatkan.
 *   - Penjadwalannya "sekali tembak" saat play: semua clip dijadwalkan di muka.
 *     Mengubah clip saat berbunyi tidak terdengar sampai stop/play lagi.
 *   - Mixing terjadi di JS, BUKAN lewat `render_block`. Artinya hasil preview
 *     TIDAK identik dengan hasil export — dan itu persis yang docs/03 peringatkan
 *     (dua jalur render). Karena itu modul ini HARUS DIHAPUS begitu engine hidup;
 *     lihat `docs/09-roadmap.md` M1.
 *
 * Kontrak: satu-satunya pemilik AudioContext untuk decode DAN playback, supaya
 * `AudioBuffer` hasil decode bisa dipakai ulang tanpa decode dua kali.
 */

import {
  DEFAULT_FADE_CURVE,
  effectiveSpeed,
  isAudible,
  type EqSettings,
  type StudioClip,
} from '../model';
import type { StudioAppState } from '../store';
import { fadeCurveArray, fadeOutGain } from '../timeline/fade';

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor | null {
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let ctx: AudioContext | null = null;
let ctxSampleRate = 48_000;

/** PCM hasil decode, dipakai bersama oleh import (waveform) dan preview (suara). */
const buffers = new Map<number, AudioBuffer>();

/** Node yang sedang berbunyi; dibersihkan tiap `stop()`. */
let voices: AudioBufferSourceNode[] = [];
/** Node non-source (gain lane, filter EQ) — perlu di-disconnect saat stop. */
let nodes: AudioNode[] = [];

/**
 * Node per lane yang masih hidup, supaya EQ dan fader bisa diubah SAAT
 * BERBUNYI tanpa menjadwalkan ulang apa pun.
 *
 * Ini perbedaan penting: posisi clip harus dijadwalkan ulang kalau berubah,
 * tapi EQ dan gain adalah parameter kontinu — memutar ulang seluruh voice
 * hanya untuk menggeser slider akan terdengar sebagai klik dan lompatan.
 */
interface LaneNodes {
  /** Satu filter per band, urutan SAMA dengan `lane.eq.bands` — itu yang
   *  membuat update parameter bisa dilakukan by-index tanpa mencari-cari. */
  readonly filters: BiquadFilterNode[];
  readonly gain: GainNode;
}
const laneNodes = new Map<string, LaneNodes>();

/** Ramp pendek supaya perubahan parameter tidak menimbulkan klik. */
const PARAM_RAMP_SEC = 0.02;

/**
 * AudioContext dibuat malas (lazy) karena browser mewajibkan user gesture.
 * Dipanggil dari handler drop dan dari tombol PLAY — keduanya gesture.
 */
export function ensureContext(sampleRate: number): AudioContext | null {
  if (ctx !== null) return ctx;
  const Ctor = audioContextCtor();
  if (Ctor === null) return null;
  try {
    ctx = new Ctor({ sampleRate });
  } catch {
    // Safari menolak sampleRate tertentu — biarkan browser memilih.
    ctx = new Ctor();
  }
  ctxSampleRate = ctx.sampleRate;
  return ctx;
}

export function previewSampleRate(): number {
  return ctx?.sampleRate ?? ctxSampleRate;
}

export function registerBuffer(assetId: number, buffer: AudioBuffer): void {
  buffers.set(assetId, buffer);
}

export function hasBuffer(assetId: number): boolean {
  return buffers.has(assetId);
}

export function getBuffer(assetId: number): AudioBuffer | undefined {
  return buffers.get(assetId);
}

export function isPreviewAvailable(): boolean {
  return buffers.size > 0 && audioContextCtor() !== null;
}

/** Hentikan semua suara. Aman dipanggil berkali-kali. */
export function stop(): void {
  for (const v of voices) {
    try {
      v.onended = null;
      v.stop();
    } catch {
      // sudah berhenti sendiri — abaikan
    }
    v.disconnect();
  }
  voices = [];
  for (const n of nodes) n.disconnect();
  nodes = [];
  laneNodes.clear();
}

/**
 * Terapkan gain & EQ lane ke node yang sedang berbunyi. Dipanggil tiap kali
 * store berubah — murah, dan TIDAK menyentuh penjadwalan voice.
 */
export function updateLaneParams(state: StudioAppState): void {
  if (laneNodes.size === 0 || ctx === null) return;
  const at = ctx.currentTime;
  for (const lane of state.lanes) {
    const n = laneNodes.get(lane.id);
    if (n === undefined) continue;
    n.gain.gain.setTargetAtTime(dbToLin(lane.gainDb), at, PARAM_RAMP_SEC);
    // Node EQ parametrik bisa digeser MENDATAR juga, jadi frekuensi (dan Q)
    // ikut di-ramp — bukan cuma gain seperti pada EQ 3-slider dulu. Semuanya
    // lewat setTargetAtTime pada node yang SUDAH ADA: membangun ulang rantai
    // di tengah drag akan terdengar sebagai klik di setiap pixel gerakan.
    lane.eq.bands.forEach((band, i) => {
      const f = n.filters[i];
      if (f === undefined) return;
      f.frequency.setTargetAtTime(band.freq, at, PARAM_RAMP_SEC);
      f.gain.setTargetAtTime(band.gainDb, at, PARAM_RAMP_SEC);
      f.Q.setTargetAtTime(band.q, at, PARAM_RAMP_SEC);
    });
  }
}

/**
 * Rantai EQ parametrik lane: satu BiquadFilterNode per band, dirangkai
 * berurutan lalu masuk ke `output`. Elemen pertama adalah MASUKAN rantai.
 *
 * Band dengan 0 dB tetap dibuat supaya rantainya seragam dan indeksnya cocok
 * satu-satu dengan `lane.eq.bands` — itulah yang membuat `updateLaneParams`
 * cukup mengubah nilai dan tidak pernah menambah/menghapus node.
 */
function buildEqChain(audio: AudioContext, eq: EqSettings, output: AudioNode): BiquadFilterNode[] {
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
  nodes.push(...filters);
  return filters;
}

interface EnvelopeTiming {
  readonly startAt: number;
  readonly wallDurationSec: number;
  readonly transportSpeed: number;
  /** Sudah berapa detik (timeline) clip ini berjalan saat play ditekan. */
  readonly clipElapsedSec: number;
}

/** Jumlah titik kurva yang dikirim ke `setValueCurveAtTime`. 128 titik untuk
 *  fade sepanjang detik sudah jauh di bawah ambang terdengarnya tangga. */
const FADE_CURVE_POINTS = 128;

/**
 * Gain clip + fade in/out sebagai otomasi pada satu GainNode.
 *
 * Kasus yang mudah salah: play ditekan di TENGAH fade-in. Kalau kita selalu
 * mulai dari 0, potongan yang seharusnya sudah keras akan terdengar mengecil
 * lagi. Karena itu kurva yang dijadwalkan adalah POTONGAN SISA-nya
 * (`from = elapsed/fadeIn`), bukan kurva penuh dari nol.
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
    // Fade out bisa SUDAH berjalan saat play ditekan (playhead di dalamnya):
    // yang dijadwalkan hanya sisanya, mulai dari posisi yang tepat.
    const from = 1 - outLen / fadeOutSec;
    if (outStart > startAt && !(fadeInSec > 0 && inRemaining > 0)) {
      // Tahan nilai penuh sampai fade-out mulai; tanpa ini titik otomasi
      // terakhir tertarik lebih awal dan seluruh clip ikut meredup.
      gain.gain.setValueAtTime(target * fadeOutGain(curve, from), outStart - 1e-4);
    }
    gain.gain.setValueCurveAtTime(
      fadeCurveArray(curve, 'out', target, FADE_CURVE_POINTS, from, 1),
      outStart,
      outLen,
    );
  }
}

/**
 * Jadwalkan semua clip yang terdengar, relatif terhadap `playhead`.
 *
 * `speed` diterapkan sebagai `playbackRate` DAN sebagai pembagi waktu jadwal:
 * clip yang mulai 10 detik lagi pada speed 2x harus berbunyi 5 detik lagi.
 */
export function play(state: StudioAppState): void {
  stop();
  const audio = ensureContext(state.sampleRate);
  if (audio === null) return;
  void audio.resume().catch(() => undefined);

  const sr = state.sampleRate;
  const speed = state.speed;
  const now = audio.currentTime + 0.05; // sedikit lookahead supaya start-nya rapi
  const playheadSec = state.playhead / sr;

  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    // Kecepatan efektif = kecepatan lane × transport (docs/07 §8d).
    const rate = effectiveSpeed(lane, speed);
    const laneRatio = lane.speedRatio;

    // RANTAI PER LANE — dibuat sekali, dipakai semua clip di lane ini:
    //   clip gain (+fade) → EQ band 1..n → lane gain → out
    // Urutannya mengikuti signal flow docs/07: gain clip dulu, baru insert
    // (EQ), baru fader lane.
    const laneGainNode = audio.createGain();
    laneGainNode.gain.value = dbToLin(lane.gainDb);
    const filters = buildEqChain(audio, lane.eq, laneGainNode);
    laneGainNode.connect(audio.destination);
    nodes.push(laneGainNode);
    laneNodes.set(lane.id, { filters, gain: laneGainNode });
    // Lane tanpa band sama sekali tetap harus berbunyi: masuk langsung ke fader.
    const eqInput: AudioNode = filters[0] ?? laneGainNode;

    for (const clip of lane.clips) {
      const buffer = buffers.get(clip.assetId);
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

      const whenSec = now + Math.max(0, clipStartSec - playheadSec) / speed;

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
        continue; // offset di luar buffer — lewati, jangan bunuh playback lain
      }
      src.onended = () => {
        voices = voices.filter((v) => v !== src);
      };
      voices.push(src);
    }
  }
}

function dbToLin(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20);
}
