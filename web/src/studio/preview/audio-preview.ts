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

import { isAudible } from '../model';
import type { StudioAppState } from '../store';
import {
  PARAM_RAMP_SEC,
  buildProjectGraph,
  dbToLin,
  type LaneNodes,
} from './graph-builder';

/**
 * Perakitan grafnya sendiri TIDAK ada di sini — lihat `graph-builder.ts`.
 * Modul ini hanya memiliki AudioContext, cache buffer, dan siklus play/stop.
 * Export offline memakai pembangun graf yang SAMA, dan itu disengaja.
 */
export { applyClipGainEnvelope } from './graph-builder';

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
const laneNodes = new Map<string, LaneNodes>();

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

/** Akses cache PCM untuk konsumen lain (export offline memakai yang SAMA). */
export function bufferLookup(): (assetId: number) => AudioBuffer | undefined {
  return (id) => buffers.get(id);
}

/** Apakah ada minimal satu clip terdengar yang PCM-nya sudah ada. */
export function hasRenderableAudio(state: StudioAppState): boolean {
  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    for (const c of lane.clips) if (buffers.has(c.assetId)) return true;
  }
  return false;
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
 * Jadwalkan semua clip yang terdengar, relatif terhadap `playhead`.
 * Perakitannya didelegasikan ke `buildProjectGraph` — jalur yang sama persis
 * dengan yang dipakai export offline.
 */
export function play(state: StudioAppState): void {
  stop();
  const audio = ensureContext(state.sampleRate);
  if (audio === null) return;
  void audio.resume().catch(() => undefined);

  const graph = buildProjectGraph(audio, state, {
    playheadSec: state.playhead / state.sampleRate,
    startAt: audio.currentTime + 0.05, // sedikit lookahead supaya start-nya rapi
    getBuffer: (id) => buffers.get(id),
  });

  nodes = [...graph.nodes];
  voices = [...graph.voices];
  for (const [id, ln] of graph.lanes) laneNodes.set(id, ln);

  for (const src of voices) {
    src.onended = () => {
      voices = voices.filter((v) => v !== src);
    };
  }
}
