/**
 * Import file audio yang di-drop ke sebuah lane.
 *
 * KENAPA TIDAK LEWAT `audio/import-worker`: worker itu menerima
 * `WebAssembly.Module` engine sebagai bagian dari pesannya (lihat
 * `ImportMessage`), dan build WASM belum ada di repo (`web/src/wasm` kosong).
 * Memanggilnya sekarang berarti janji palsu. Jadi kita memakai strategi kedua
 * yang memang sudah disahkan di file itu — `'web-audio'`, yaitu
 * `decodeAudioData` bawaan browser. Ini decode SUNGGUHAN: panjang clip dan
 * bentuk waveform-nya berasal dari sample asli, bukan dari mock.
 *
 * TODO(engine): begitu artifak WASM tersedia, alihkan ke import-worker supaya
 * PCM mendarat langsung di linear memory engine dan peak pyramid dibuat di
 * Rust (satu sumber peak untuk UI dan render).
 */

import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';
import { studioActions, type StudioAsset } from '../store';
import { ensureContext, registerBuffer } from '../preview/audio-preview';
import { saveAsset } from '../persist/db';
import { canGunzip, gunzip, sniff } from './sniff';
import { buildEnvelope } from './envelope';

/**
 * Buat asset dari `AudioBuffer` hasil decode dan daftarkan ke store.
 *
 * SATU jalur untuk import DAN pemulihan dari IndexedDB (`persist/usePersistence`
 * memanggil fungsi ini). Sebelumnya `computePeaks` ada dua salinan, dan dua
 * salinan berarti waveform bisa berubah bentuk hanya karena user me-refresh
 * halaman — bug yang mustahil dilacak dari layar.
 */
export function assetFromBuffer(id: number, name: string, buffer: AudioBuffer): StudioAsset {
  return {
    id,
    name,
    envelope: buildEnvelope(buffer),
    frames: buffer.length,
    sampleRate: buffer.sampleRate,
  };
}

export interface DropResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Decode `file` lalu buat clip di `laneId` mulai `startSamples`.
 * Mengembalikan alasan kegagalan alih-alih melempar, supaya UI bisa
 * menampilkannya tanpa merusak render.
 */
export async function importFileToLane(
  file: File,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
): Promise<DropResult> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : 'gagal membaca file' };
  }
  return importBytesToLane(bytes, file.name, laneId, startSamples, projectSampleRate);
}

/**
 * Jalur import sesungguhnya, berbasis byte — dipakai oleh drop file MAUPUN
 * import dari URL. Satu jalur berarti sniffing, gunzip, decode, peak, dan
 * pembuatan clip berperilaku persis sama dari sumber mana pun.
 */
export async function importBytesToLane(
  input: ArrayBuffer,
  name: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
): Promise<DropResult> {
  // Context dipinjam dari modul preview: dia yang memilikinya, supaya
  // `AudioBuffer` hasil decode bisa dipakai ulang untuk playback tanpa
  // decode dua kali (lihat studio/preview/audio-preview.ts).
  const ctx = ensureContext(projectSampleRate);
  if (ctx === null) {
    return { ok: false, reason: 'Web Audio tidak tersedia di lingkungan ini' };
  }
  try {
    let bytes = input;

    // Kenali isi sebenarnya sebelum menyerahkannya ke decoder — lihat sniff.ts.
    let probe = sniff(bytes);
    if (probe.kind === 'gzip') {
      if (!canGunzip()) {
        return {
          ok: false,
          reason: `${name}: terkompresi gzip dan browser ini tidak bisa membukanya. Jalankan \`gunzip\` pada file-nya lalu coba lagi.`,
        };
      }
      bytes = await gunzip(bytes);
      probe = sniff(bytes);
    }
    if (probe.kind === 'unknown') {
      return {
        ok: false,
        reason: `${name}: bukan berkas audio — terbaca sebagai ${probe.description}.`,
      };
    }
    if (probe.kind === 'gzip') {
      // Gzip di dalam gzip. Berhenti di sini daripada membuka berlapis-lapis.
      return { ok: false, reason: `${name}: terkompresi gzip berlapis, bukan audio.` };
    }

    let buffer: AudioBuffer;
    try {
      // `.slice(0)` WAJIB: `decodeAudioData` men-*detach* ArrayBuffer yang
      // diberikan padanya. Tanpa salinan, `bytes` di bawah sudah berukuran 0
      // saat disimpan ke IndexedDB — project tersimpan dengan audio KOSONG,
      // dan baru ketahuan setelah refresh berikutnya.
      buffer = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      // Formatnya dikenali tapi browser menolak men-decode — hampir selalu soal
      // dukungan codec (contoh: Safari tidak mendukung Ogg Vorbis).
      return {
        ok: false,
        reason: `${name}: browser ini tidak bisa men-decode ${probe.format}. Coba Chrome/Firefox, atau konversi ke WAV.`,
      };
    }

    const assetId = studioActions.newAssetId();
    // Panjang di project-space: decodeAudioData sudah me-resample ke
    // sampleRate context, jadi frame-nya langsung sepadan dengan project.
    const frames = buffer.length;
    studioActions.registerAsset(assetFromBuffer(assetId, name, buffer));
    // Simpan PCM-nya supaya preview playback bisa membunyikannya.
    registerBuffer(assetId, buffer);
    // Byte ASLI disimpan untuk pemulihan setelah refresh — bukan PCM-nya,
    // yang puluhan kali lebih besar dan bisa dihasilkan ulang. Sengaja tidak
    // di-`await`: import tidak boleh menunggu I/O penyimpanan.
    void saveAsset({ id: assetId, name, bytes });

    const clip: StudioClip = {
      id: studioActions.newClipId(),
      assetId,
      start: Math.max(0, Math.round(startSamples)),
      len: frames,
      sourceStart: 0,
      sourceLen: frames,
      label: name.toUpperCase(),
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      fadeCurve: DEFAULT_FADE_CURVE,
      seed: assetId % 97,
    };
    studioActions.addClip(laneId, clip);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : 'gagal men-decode file' };
  }
}
