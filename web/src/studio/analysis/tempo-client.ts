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
      return;
    }
    // Kegagalan analisis TIDAK boleh menjatuhkan import. BPM adalah pelengkap;
    // audionya sendiri sudah masuk dan bisa diputar. Jadi: catat, lalu tandai
    // asset ini "tidak ada tempo" supaya UI berhenti menunggu selamanya.
    console.warn(`[tempo] asset ${m.id}: ${m.message}`);
    studioActions.setAssetTempo(m.id, null);
    requested.delete(m.id);
  };
  worker.onerror = (e) => {
    console.warn('[tempo] worker gagal:', e.message);
  };
  return worker;
}

/**
 * Antre analisis tempo untuk `assetId`. Aman dipanggil berkali-kali — hanya
 * permintaan pertama yang benar-benar dikirim.
 *
 * PCM disalin (`.slice()`) lalu buffer salinannya DITRANSFER. Menyalin di sini
 * memang membayar memori sesaat, tapi alternatifnya menransfer `AudioBuffer`
 * milik cache preview — dan buffer yang ditransfer jadi detached di main
 * thread, yang berarti audio yang baru saja di-import berhenti bisa diputar.
 */
export function requestAssetTempo(assetId: number, buffer: AudioBuffer): void {
  if (requested.has(assetId)) return;
  const w = ensureWorker();
  if (w === null) return;
  requested.add(assetId);

  const left = buffer.getChannelData(0).slice();
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : null;
  const transfer: ArrayBuffer[] = [left.buffer as ArrayBuffer];
  if (right !== null) transfer.push(right.buffer as ArrayBuffer);

  studioActions.markAssetTempoPending(assetId);
  w.postMessage(
    {
      type: 'tempo',
      id: assetId,
      left: left.buffer,
      right: right === null ? null : right.buffer,
      sampleRate: buffer.sampleRate,
    },
    transfer,
  );
}

/** Hanya untuk tes: lupakan riwayat permintaan. */
export function __resetTempoClientForTest(): void {
  requested.clear();
  worker = null;
}
