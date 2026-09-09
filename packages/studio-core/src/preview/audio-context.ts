/**
 * SATU AudioContext dan SATU cache PCM untuk seluruh aplikasi.
 *
 * Dipisah dari `studio/preview/audio-preview.ts` (docs/25 P4): pemutar Studio
 * (generasi voice, audisi, scrub) tahu lane dan clip, tapi kepemilikan context
 * dan cache buffer tidak — dan keduanya dipakai halaman `/dj` (deck), jalur
 * import (`timeline/audio-import.ts`), pemulihan aset (`persist/decode-asset`),
 * dan export offline. Kontraknya tetap: satu-satunya pemilik AudioContext
 * untuk decode DAN playback, supaya `AudioBuffer` hasil decode bisa dipakai
 * ulang tanpa decode dua kali.
 */

import { assetStore } from '../assets/store';
import { DEFAULT_SAMPLE_RATE } from '../assets/model';
import { enqueueAutoStem } from '../stem/auto-stem';
import { registerFxWorklet } from './fx-node';

type AudioCtor = typeof AudioContext;

export function audioContextCtor(): AudioCtor | null {
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let ctx: AudioContext | null = null;
let ctxSampleRate = DEFAULT_SAMPLE_RATE;

/** PCM hasil decode, dipakai bersama oleh import (waveform) dan preview (suara). */
const buffers = new Map<number, AudioBuffer>();

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
    // Fire-and-forget: `addModule` asinkron sementara perakitan graf sinkron.
    // Sampai ia selesai, `createFxNode` mengembalikan null dan chain tidak
    // terdengar — sidik jari mix ikut menyertakan kesiapan ini, jadi begitu
    // siap, penjadwalan ulang berikutnya memasangnya.
    void registerFxWorklet(ctx);
  } catch {
    // Safari menolak sampleRate tertentu — biarkan browser memilih.
    ctx = new Ctor();
    void registerFxWorklet(ctx);
  }
  ctxSampleRate = ctx.sampleRate;
  return ctx;
}

/** Context yang sudah ada, atau null. Tidak pernah membuatnya. */
export function currentContext(): AudioContext | null {
  return ctx;
}

/**
 * Sample rate yang dipakai audio: milik context kalau sudah ada, kalau belum
 * `DEFAULT_SAMPLE_RATE`. Ini sumber yang dipakai `/dj` saat mengimpor tanpa
 * project — halaman itu tidak punya `sampleRate` project untuk dibaca.
 */
export function previewSampleRate(): number {
  return ctx?.sampleRate ?? ctxSampleRate;
}

export function registerBuffer(assetId: number, buffer: AudioBuffer): void {
  buffers.set(assetId, buffer);
  const name = assetStore.getState().assets[assetId]?.name ?? `TRACK ${assetId}`;
  enqueueAutoStem(assetId, name, buffer);
}

export function hasBuffer(assetId: number): boolean {
  return buffers.has(assetId);
}

/**
 * Lepas PCM dari cache.
 *
 * Dipanggil saat asset benar-benar dihapus. Tanpa ini, satu lagu lima menit
 * (~115 MB f32 stereo) tetap tertahan di memori sampai halaman ditutup —
 * padahal tidak ada lagi yang bisa memutarnya.
 */
export function unregisterBuffer(assetId: number): void {
  buffers.delete(assetId);
}

export function getBuffer(assetId: number): AudioBuffer | undefined {
  return buffers.get(assetId);
}

/** Akses cache PCM untuk konsumen lain (export offline memakai yang SAMA). */
export function bufferLookup(): (assetId: number) => AudioBuffer | undefined {
  return (id) => buffers.get(id);
}

/** Ada minimal satu PCM di cache. */
export function hasAnyBuffer(): boolean {
  return buffers.size > 0;
}
