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
import { studioActions, studioStore, type ImportStage, type StudioAsset } from '../store';
import { ensureContext, registerBuffer } from '../preview/audio-preview';
import { saveAsset } from '../persist/db';
import { canGunzip, gunzip, sniff } from './sniff';
import { buildEnvelope } from './envelope';
import { requestAssetTempo } from '../analysis/tempo-client';

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
async function readFileBytes(file: File, onProgress?: ImportProgressFn): Promise<ArrayBuffer> {
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
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  let bytes: ArrayBuffer;
  try {
    bytes = await readFileBytes(file, opts.onProgress);
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : 'gagal membaca file' };
  }
  return importBytesToLane(bytes, file.name, laneId, startSamples, projectSampleRate, opts);
}

/**
 * BYTE → ASSET TERDAFTAR. Ini jalur decode SATU-SATUNYA di aplikasi:
 * sniff → gunzip → `decodeAudioData` → peak pyramid → `registerAsset` →
 * `requestAssetTempo` → `registerBuffer` → `saveAsset`.
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

    // Sejak titik ini kemajuan tidak bisa diukur lagi: `decodeAudioData` tidak
    // melaporkan apa pun sampai ia selesai. Yang bisa diberikan ke user adalah
    // NAMA tahapnya — dan itu yang membedakan "sedang decode" dari "macet".
    onProgress?.({ stage: 'decoding', ratio: null });

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

    const assetId = studioActions.newAssetId();
    // Panjang di project-space: decodeAudioData sudah me-resample ke
    // sampleRate context, jadi frame-nya langsung sepadan dengan project.
    const frames = buffer.length;
    studioActions.registerAsset(assetFromBuffer(assetId, name, buffer));
    // Setelah registerAsset, bukan sebelum: worker menjawab secara asinkron dan
    // `setAssetTempo` mengabaikan id yang belum ada di store.
    requestAssetTempo(assetId, buffer);
    // Simpan PCM-nya supaya preview playback bisa membunyikannya.
    registerBuffer(assetId, buffer);
    // Byte ASLI disimpan untuk pemulihan setelah refresh — bukan PCM-nya,
    // yang puluhan kali lebih besar dan bisa dihasilkan ulang. Sengaja tidak
    // di-`await`: import tidak boleh menunggu I/O penyimpanan.
    void saveAsset({ id: assetId, name, bytes });

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

/** Ujung materi terjauh di sebuah lane, dalam sample. 0 kalau lane kosong. */
export function laneContentEnd(laneId: string): number {
  const lane = studioStore.getState().lanes.find((l) => l.id === laneId);
  if (lane === undefined) return 0;
  let end = 0;
  for (const c of lane.clips) end = Math.max(end, c.start + c.len);
  return end;
}

export interface LaneImportOptions {
  readonly onProgress?: ImportProgressFn;
  /**
   * Taruh clip di belakang materi yang sudah ada di lane, bukan persis di
   * `startSamples`.
   *
   * Untuk SATU perbuatan yang membawa beberapa file (pilih 3 lagu dari file
   * manager, drop 3 file sekaligus). Tanpa ini ketiganya mendarat di titik yang
   * sama dan saling menumpuk — di layar hanya terlihat satu clip, dua sisanya
   * seperti hilang.
   *
   * Perhitungannya WAJIB terjadi di sini, tepat sebelum clip dibuat, bukan saat
   * import dimulai: ketiga import berjalan bersamaan, jadi saat dimulai lane-nya
   * masih kosong untuk ketiga-tiganya dan ketiganya akan menghitung posisi yang
   * sama persis. Yang membedakan mereka hanya keadaan lane pada saat masing-masing
   * SELESAI.
   */
  readonly avoidOverlap?: boolean;
}

/**
 * Jalur import ke LANE — sekarang tipis: decode lewat `importBytesToAsset`,
 * lalu satu clip. Dipakai drop file MAUPUN import dari URL, jadi keduanya tetap
 * berperilaku persis sama.
 */
export async function importBytesToLane(
  input: ArrayBuffer,
  name: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  const got = await importBytesToAsset(input, name, projectSampleRate, opts.onProgress);
  if (!got.ok) return { ok: false, reason: got.reason };

  const start = opts.avoidOverlap
    ? Math.max(startSamples, laneContentEnd(laneId))
    : startSamples;
  const clip: StudioClip = {
    id: studioActions.newClipId(),
    assetId: got.assetId,
    chain: [],
    start: Math.max(0, Math.round(start)),
    len: got.frames,
    sourceStart: 0,
    sourceLen: got.frames,
    label: name.toUpperCase(),
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: got.assetId % 97,
  };
  studioActions.addClip(laneId, clip);
  return { ok: true };
}
