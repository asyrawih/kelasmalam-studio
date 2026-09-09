/**
 * Import berkas audio → aset terdaftar. Bagian yang menaruhnya ke LANE ada di
 * `@kelasmalam/studio/studio/timeline/audio-import` (docs/25 P4); halaman
 * `/dj` memakai jalur ini langsung ke deck.
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

import type { ImportStage, StudioAsset } from '../assets/model';
import { assetActions, assetStore } from '../assets/store';
import { ensureContext, registerBuffer } from '../preview/audio-context';
import { canGunzip, gunzip, sniff } from './sniff';
import { sha256Hex } from './content-hash';
import { notifyImported } from './import-sink';
import { buildEnvelope } from './envelope';
import { requestAssetTempo } from '../analysis/tempo-client';

/**
 * Buat asset dari `AudioBuffer` hasil decode dan daftarkan ke store.
 *
 * SATU jalur untuk import DAN untuk pemulihan asset dari byte tersimpan
 * (`persist/decode-asset` memanggil fungsi ini). Sebelumnya `computePeaks` ada
 * dua salinan, dan dua salinan berarti waveform bisa berubah bentuk hanya
 * karena lagunya dimuat lewat jalur lain — bug yang mustahil dilacak dari
 * layar.
 */
export function assetFromBuffer(
  id: number,
  name: string,
  buffer: AudioBuffer,
  /** `''` = tidak punya berkas asal (hasil bake). Lihat `StudioAsset.contentHash`. */
  contentHash = '',
): StudioAsset {
  return {
    id,
    name,
    contentHash,
    envelope: buildEnvelope(buffer),
    frames: buffer.length,
    sampleRate: buffer.sampleRate,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  };
}

/**
 * Kabar kemajuan satu import.
 *
 * Callback, bukan penulisan langsung ke store: jalur decode ini dipakai
 * halaman `/dj` juga, dan halaman itu punya store sendiri. Yang tahu ke mana
 * kemajuan harus dipajang adalah pemanggilnya, bukan decoder.
 */
export interface ImportProgress {
  readonly stage: ImportStage;
  /** 0..1 kalau bisa diukur; null untuk tahap yang tidak punya ukuran. */
  readonly ratio: number | null;
}
export type ImportProgressFn = (p: ImportProgress) => void;

/** Kenaikan minimum sebelum satu kabar baru dikirim (2%). */
const READ_TICK = 0.02;

/**
 * Baca `file` sambil melaporkan kemajuan.
 *
 * Memakai `file.stream()` — SATU-SATUNYA cara mengetahui sudah berapa byte
 * yang terbaca; `file.arrayBuffer()` bersifat semua-atau-tidak dan tidak punya
 * titik laporan sama sekali. Kalau stream tidak tersedia (jsdom, browser lama)
 * atau tidak ada yang mendengarkan, jalurnya kembali ke `arrayBuffer()`.
 *
 * Tujuan alokasinya SATU larik seukuran file, bukan tumpukan chunk yang
 * digabung di akhir: menggabung berarti memegang dua salinan penuh sekaligus,
 * dan file WAV berukuran ratusan MB membuat itu terasa persis di titik yang
 * paling tidak diinginkan — saat beberapa import berjalan bersamaan.
 */
export async function readFileBytes(file: File, onProgress?: ImportProgressFn): Promise<ArrayBuffer> {
  const total = file.size;
  if (onProgress === undefined || typeof file.stream !== 'function' || total <= 0) {
    return file.arrayBuffer();
  }
  const reader = file.stream().getReader();
  const out = new Uint8Array(total);
  let read = 0;
  let reported = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value === undefined) continue;
      // `file.size` seharusnya persis; kalau ternyata tidak, potong daripada
      // melempar RangeError di tengah import.
      if (read + value.byteLength > total) {
        out.set(value.subarray(0, total - read), read);
        read = total;
        break;
      }
      out.set(value, read);
      read += value.byteLength;
      const ratio = read / total;
      if (ratio - reported >= READ_TICK) {
        reported = ratio;
        onProgress({ stage: 'reading', ratio });
      }
    }
  } finally {
    // Membatalkan reader yang sudah habis tidak berbahaya; yang berbahaya
    // adalah stream yang tetap terkunci kalau loop di atas melempar.
    void reader.cancel().catch(() => undefined);
  }
  return read === total ? out.buffer : out.buffer.slice(0, read);
}

/**
 * BYTE → ASSET TERDAFTAR. Ini jalur decode SATU-SATUNYA di aplikasi:
 * sniff → gunzip → `decodeAudioData` → peak pyramid → `registerAsset` →
 * `requestAssetTempo` → `registerBuffer`.
 *
 * Ia sengaja TIDAK membuat clip dan TIDAK menyentuh lane, karena tidak setiap
 * pemakai punya lane: halaman `/dj` memuat lagu ke DECK, bukan ke timeline.
 * Kalau jalur ini digandakan, sniffing, envelope, dan penyimpanan byte bisa
 * menyimpang antara dua halaman — dan gejalanya adalah waveform yang berubah
 * bentuk hanya karena file-nya diimpor dari tempat lain, persis cacat yang
 * `assetFromBuffer` sendiri sudah ada untuk mencegahnya.
 *
 * Tipe kegagalannya MEWAJIBKAN `reason` (beda dari `DropResult`, yang
 * membuatnya opsional) supaya tidak ada pemanggil baru yang bisa gagal bisu.
 */
export interface ImportedAsset {
  readonly ok: true;
  readonly assetId: number;
  readonly name: string;
  readonly frames: number;
  readonly sampleRate: number;
}
export type ImportAssetResult = ImportedAsset | { readonly ok: false; readonly reason: string };

export async function importBytesToAsset(
  input: ArrayBuffer,
  name: string,
  projectSampleRate: number,
  onProgress?: ImportProgressFn,
): Promise<ImportAssetResult> {
  // Context dipinjam dari modul preview: dia yang memilikinya, supaya
  // `AudioBuffer` hasil decode bisa dipakai ulang untuk playback tanpa decode
  // dua kali (lihat studio/preview/audio-preview.ts).
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

    /*
     * Hash DULU, decode belakangan.
     *
     * Inti dedup docs/16 §6: berkas yang sama, diimpor dua kali, adalah SATU
     * asset. Menghitung SHA-256 atas 25 MB butuh puluhan milidetik; men-decode
     * ulang lagu 27 menit butuh detik DAN puluhan MB PCM kedua yang isinya
     * identik dengan yang sudah ada di memori.
     *
     * Yang di-hash adalah byte SESUDAH gunzip — itu audio yang sebenarnya, dan
     * itu pula yang diunggah. Dua salinan lagu yang sama, satu ter-gzip dan
     * satu tidak, karena itu dikenali sebagai satu asset.
     *
     * BATAS YANG DIKETAHUI: dedup melihat store, dan store baru terisi setelah
     * decode selesai. Menjatuhkan berkas yang SAMA tiga kali dalam satu gerakan
     * karena itu tetap menghasilkan tiga decode — ketiganya sudah lewat titik
     * ini sebelum yang pertama mendaftar. Yang menahan biaya sebenarnya ada di
     * server: `/tracks/init` menjawab `exists` dan tidak ada byte yang naik.
     * Meng-coalesce yang sedang berjalan bisa dilakukan (peta hash → janji),
     * tapi belum ada yang mengeluhkannya, dan gerakan itu jarang disengaja.
     */
    const contentHash = await sha256Hex(bytes.slice(0));
    const already = Object.values(assetStore.getState().assets).find(
      (a) => a.contentHash !== '' && a.contentHash === contentHash,
    );
    if (already !== undefined) {
      return {
        ok: true,
        assetId: already.id,
        name: already.name,
        frames: already.frames,
        sampleRate: already.sampleRate,
      };
    }

    // Sejak titik ini kemajuan tidak bisa diukur lagi: `decodeAudioData` tidak
    // melaporkan apa pun sampai ia selesai. Yang bisa diberikan ke user adalah
    // NAMA tahapnya — dan itu yang membedakan "sedang decode" dari "macet".
    onProgress?.({ stage: 'decoding', ratio: null });

    let buffer: AudioBuffer;
    try {
      // `.slice(0)` WAJIB: `decodeAudioData` men-*detach* ArrayBuffer yang
      // diberikan padanya. Tanpa salinan, `bytes` MILIK PEMANGGIL berubah jadi
      // berukuran 0 setelah fungsi ini selesai — dan pemanggil berikutnya yang
      // membutuhkannya (jalur simpan/upload kepustakaan) mendapat berkas
      // kosong tanpa satu pun tanda bahwa ada yang salah.
      buffer = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      // Formatnya dikenali tapi browser menolak men-decode — hampir selalu soal
      // dukungan codec (contoh: Safari tidak mendukung Ogg Vorbis).
      return {
        ok: false,
        reason: `${name}: browser ini tidak bisa men-decode ${probe.format}. Coba Chrome/Firefox, atau konversi ke WAV.`,
      };
    }

    onProgress?.({ stage: 'analyzing', ratio: null });
    if (onProgress !== undefined) {
      // Satu tugas makro dilepas SEBELUM `buildEnvelope`, yang sinkron dan
      // memakan ~76 ms untuk lagu 3 menit. Tanpa jeda ini, React tidak sempat
      // menggambar tahap "ANALISIS" — bar-nya melompat dari "DECODE" langsung
      // ke hilang, dan pada tiga import sekaligus layar membeku tanpa satu pun
      // penjelasan di layar. `await Promise.resolve()` tidak cukup: microtask
      // berjalan di tugas yang sama, sebelum paint.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const assetId = assetActions.newAssetId();
    // Panjang di project-space: decodeAudioData sudah me-resample ke
    // sampleRate context, jadi frame-nya langsung sepadan dengan project.
    const frames = buffer.length;
    assetActions.registerAsset(assetFromBuffer(assetId, name, buffer, contentHash));
    // Setelah registerAsset, bukan sebelum: worker menjawab secara asinkron dan
    // `setAssetTempo` mengabaikan id yang belum ada di store.
    requestAssetTempo(assetId, buffer);
    // Simpan PCM-nya supaya preview playback bisa membunyikannya.
    registerBuffer(assetId, buffer);
    /*
     * Byte aslinya tidak disimpan di sini, tapi DIUMUMKAN.
     *
     * Yang mendengarkan (dok kepustakaan) memutuskan sendiri apakah ia
     * mengunggahnya — dan ia hanya melakukannya kalau user sudah login. Tanpa
     * pendengar, tidak ada yang terjadi dan lagunya hidup selama sesi ini saja,
     * persis seperti sebelum kepustakaan ada.
     */
    notifyImported({
      contentHash,
      assetId,
      name,
      bytes,
      format: probe.format,
      frames,
      sampleRate: buffer.sampleRate,
    });

    return { ok: true, assetId, name, frames, sampleRate: buffer.sampleRate };
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : 'gagal men-decode file' };
  }
}

/** Pembungkus `File` untuk pemakai yang tidak punya lane (halaman `/dj`). */
export async function importFileToAsset(
  file: File,
  projectSampleRate: number,
  onProgress?: ImportProgressFn,
): Promise<ImportAssetResult> {
  let bytes: ArrayBuffer;
  try {
    bytes = await readFileBytes(file, onProgress);
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : 'gagal membaca file' };
  }
  return importBytesToAsset(bytes, file.name, projectSampleRate, onProgress);
}
