/**
 * Sisi main-thread dari `audio/tempo-worker.ts`.
 *
 * Satu worker dipakai bersama untuk semua asset. Alasannya bukan hemat memori
 * melainkan hemat WAKTU: tiap worker baru harus mem-fetch dan meng-instantiate
 * artefak WASM 400 KB sendiri, dan menjatuhkan lima file sekaligus akan
 * membayarnya lima kali. Dengan satu worker, artefaknya dimuat sekali dan
 * permintaan berikutnya mengantre di belakangnya — analisis tempo bukan
 * pekerjaan interaktif, jadi antrean tidak terasa.
 */

import { studioActions, type AssetTempo } from '../store';

let worker: Worker | null = null;
/** Asset yang sedang/sudah diminta, supaya tidak dianalisis dua kali. */
const requested = new Set<number>();

function ensureWorker(): Worker | null {
  if (worker !== null) return worker;
  if (typeof Worker === 'undefined') return null; // jsdom / lingkungan tes
  try {
    worker = new Worker(new URL('../../audio/tempo-worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as
      | { type: 'tempo-result'; id: number; tempo: AssetTempo | null }
      | { type: 'tempo-error'; id: number; message: string };
    if (m.type === 'tempo-result') {
      studioActions.setAssetTempo(m.id, m.tempo);
      advance(m.id);
      return;
    }
    // Kegagalan analisis TIDAK boleh menjatuhkan import. BPM adalah pelengkap;
    // audionya sendiri sudah masuk dan bisa diputar. Jadi: catat, lalu tandai
    // asset ini "tidak ada tempo" supaya UI berhenti menunggu selamanya.
    console.warn(`[tempo] asset ${m.id}: ${m.message}`);
    studioActions.setAssetTempo(m.id, null);
    requested.delete(m.id);
    advance(m.id);
  };
  worker.onerror = (e) => {
    console.warn('[tempo] worker gagal:', e.message);
    // Giliran HARUS dilepas juga di sini. Kalau tidak, satu kegagalan yang
    // tidak pernah menghasilkan pesan `tempo-error` membuat antrean berhenti
    // selamanya — dan gejalanya bukan error melainkan BPM yang tidak pernah
    // muncul untuk semua file berikutnya.
    inFlight = null;
    if (worker !== null) pump(worker);
  };
  return worker;
}

/**
 * Asset yang menunggu giliran dianalisis. `buffer` disimpan APA ADANYA —
 * referensi ke cache preview, bukan salinan; salinannya baru dibuat saat
 * gilirannya tiba.
 */
interface Queued {
  readonly id: number;
  readonly buffer: AudioBuffer;
}

const queue: Queued[] = [];
/** Asset yang PCM-nya sedang ada di worker. `null` = worker menganggur. */
let inFlight: number | null = null;

/**
 * Antre analisis tempo untuk `assetId`. Aman dipanggil berkali-kali — hanya
 * permintaan pertama yang benar-benar dikirim.
 *
 * SATU PER SATU, dan itu soal memori, bukan soal antrean yang rapi. PCM-nya
 * harus disalin sebelum diseberangkan (lihat `channelCopy`), dan satu stem 28
 * menit stereo @48k = 610 MiB. Versi sebelumnya mengirim semuanya begitu
 * file-nya di-drop: menjatuhkan empat stem sekaligus berarti 2,4 GiB salinan
 * PCM mengantre di message queue worker — yang menganalisisnya satu per satu
 * juga, jadi tidak ada yang didapat dari mengirim semuanya di muka.
 *
 * Dengan giliran, yang berwujud di luar cache preview tidak pernah lebih dari
 * SATU asset.
 */
export function requestAssetTempo(assetId: number, buffer: AudioBuffer): void {
  if (requested.has(assetId)) return;
  const w = ensureWorker();
  if (w === null) return;
  requested.add(assetId);
  studioActions.markAssetTempoPending(assetId);
  queue.push({ id: assetId, buffer });
  pump(w);
}

/** Kirim asset berikutnya kalau worker sedang menganggur. */
function pump(w: Worker): void {
  if (inFlight !== null) return;
  const next = queue.shift();
  if (next === undefined) return;
  inFlight = next.id;

  const left = channelCopy(next.buffer, 0);
  const right = next.buffer.numberOfChannels > 1 ? channelCopy(next.buffer, 1) : null;
  const transfer: ArrayBuffer[] = [left.buffer];
  if (right !== null) transfer.push(right.buffer);

  w.postMessage(
    {
      type: 'tempo',
      id: next.id,
      left: left.buffer,
      right: right === null ? null : right.buffer,
      sampleRate: next.buffer.sampleRate,
    },
    transfer,
  );
}

/**
 * Salin satu channel — lewat `copyFromChannel`, BUKAN `getChannelData`.
 *
 * Salinannya sendiri tidak bisa dihindari: buffer yang ditransfer jadi detached
 * di sisi pengirim, jadi menransfer penyimpanan milik `AudioBuffer` cache
 * preview berarti audio yang baru di-import berhenti bisa diputar.
 *
 * Yang bisa dihindari adalah salinan KEDUA. Di Gecko, `AudioBuffer` hasil
 * `decodeAudioData` menyimpan datanya di luar heap JS, dan permintaan pertama
 * lewat `getChannelData` memindahkannya ke `Float32Array` JS yang lalu menempel
 * pada buffer itu (`mJSChannels`) selama ia hidup — terlihat di snapshot memori
 * sebagai satu ArrayBuffer sebesar satu channel penuh per channel per asset.
 * Kalau buffer-nya SEDANG diputar, penyimpanan lamanya tetap dipegang graf
 * audio dan yang JS itu jadi salinan kedua sungguhan.
 *
 * `copyFromChannel` membaca dari penyimpanan yang sama tanpa memicu perpindahan
 * itu. Tujuannya `ArrayBuffer` biasa (bukan view ke SharedArrayBuffer) — itu
 * memang syarat API-nya, dan di sini kebetulan yang kita mau.
 */
function channelCopy(buffer: AudioBuffer, channel: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(buffer.length);
  if (typeof buffer.copyFromChannel === 'function') buffer.copyFromChannel(out, channel);
  else out.set(buffer.getChannelData(channel));
  return out;
}

/** Lepas giliran, lalu jalankan yang berikutnya. */
function advance(id: number): void {
  if (inFlight === id) inFlight = null;
  if (worker !== null) pump(worker);
}

/** Hanya untuk tes: lupakan riwayat permintaan. */
export function __resetTempoClientForTest(): void {
  requested.clear();
  queue.length = 0;
  inFlight = null;
  worker = null;
}
