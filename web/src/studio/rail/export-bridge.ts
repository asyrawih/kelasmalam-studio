/**
 * Jembatan rail → pipeline export (docs/03 §3a, §3d).
 *
 * Jalur nyatanya, dan inilah bayaran dari seluruh arsitektur: model studio →
 * `snapshotFromStudioJson` (Rust) → `OfflineRender` yang memanggil
 * `Engine::render_block` YANG SAMA dengan playback → `encoders/` →
 * `downloadBlob()`. Tidak ada `OfflineAudioContext`, tidak ada jalur DSP kedua.
 *
 * Yang tersisa sebagai prasyarat cuma satu: artefak WASM harus sudah dibangun.
 * Kalau belum, `loadWasm()` gagal dan tombol COMPILE di-*disable* dengan alasan
 * jujur — tidak ada animasi progress palsu.
 */

import { useEffect, useState } from 'react';
import { createEncoder, downloadBlob, pickSaveLocation } from '../../encoders';
import type { EncoderFormat } from '../../encoders';
import { loadWasm, type LoadedWasm } from '../../audio/wasm-loader';
import {
  buildExportPayload,
  type BufferLookup,
  type ExportAssetSource,
  type ExportPayload,
} from '../export/payload';
import {
  ExportCancelled,
  runExport,
  type ExportEncoder,
  type ExportResult,
} from '../export/run-export';
import { BlobSink, FileSystemSink, type ExportSink } from '../export/sinks';
import type { LoudnessAnalysis } from '../export/loudness-analyzer';
import {
  ExportWorkerUnavailable,
  canRunExportInWorker,
  runExportInWorker,
} from '../export/worker-host';
import { createWasmExportEngine } from '../export/wasm-engine';
import type { StudioState } from '../model';

/**
 * Yang harus disediakan shell begitu engine hidup: state project saat ini dan
 * cara mendapatkan PCM-nya. PCM diambil dari cache yang SAMA dengan preview
 * (`audio-preview.bufferLookup()`) — kalau export punya cache sendiri, apa yang
 * didengar dan apa yang ditulis bisa berasal dari audio yang berbeda.
 */
export interface ExportHost {
  state(): StudioState;
  getBuffer: BufferLookup;
}

let host: ExportHost | null = null;
const hostListeners = new Set<() => void>();

export function registerExportHost(h: ExportHost | null): void {
  host = h;
  for (const l of hostListeners) l();
}

export interface ExportAvailability {
  readonly ready: boolean;
  /** Alasan untuk tooltip kalau `ready === false`. */
  readonly reason: string;
}

const NO_WASM =
  'Engine belum dibangun (artefak WASM tidak ada). Export akan aktif setelah engine di-build.';
const NO_HOST = 'Engine belum terhubung ke rail — tidak ada project untuk di-render.';

let wasmCache: LoadedWasm | null = null;

export function useExportAvailability(): ExportAvailability {
  const [wasmOk, setWasmOk] = useState(wasmCache !== null);
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [hasHost, setHasHost] = useState(host !== null);

  useEffect(() => {
    const fn = (): void => setHasHost(host !== null);
    hostListeners.add(fn);
    return () => {
      hostListeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const w = await loadWasm();
        wasmCache = w;
        if (alive) setWasmOk(true);
      } catch (e: unknown) {
        // JANGAN menelan errornya. Sebelumnya semua kegagalan dilaporkan sebagai
        // "artefak tidak ada", padahal artefaknya bisa saja ADA dan sehat —
        // yang gagal instantiasi, cek ABI, atau layout blok kontrol. Pesan yang
        // salah membuat orang membangun ulang artefak berkali-kali untuk
        // masalah yang sama sekali berbeda.
        // Detailnya (URL, status HTTP, content-type) ikut ditampilkan JUGA
        // untuk error "belum dibangun". Menggantinya dengan kalimat generik
        // membuang satu-satunya informasi yang membedakan "file tidak ada" dari
        // "file ada tapi server menjawab HTML" — dua penyebab dengan perbaikan
        // yang sama sekali berbeda.
        // Selalu ke console juga: tooltip terpotong, stack trace tidak.
        console.error('[export] gagal memuat engine WASM:', e);
        if (alive) {
          setWasmOk(false);
          setWasmError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!wasmOk) return { ready: false, reason: wasmError ?? NO_WASM };
  if (!hasHost) return { ready: false, reason: NO_HOST };
  return { ready: true, reason: '' };
}

/** MIME per format — dipakai picker "save as" DAN tipe Blob-nya. */
const MIME: Record<EncoderFormat, string> = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

/**
 * Paket encoder lossy diunduh saat `init()`. Kalau unduhannya gagal (offline,
 * CDN diblokir, bundle rusak), pesannya harus menyebut FORMAT-nya — "Failed to
 * fetch dynamically imported module" tidak memberi tahu user bahwa ia cukup
 * memilih WAV dan semuanya jalan lagi. Format lain tidak ikut rusak: masing-
 * masing `import()` berdiri sendiri.
 */
const LAZY_ENCODER_LABEL: Partial<Record<EncoderFormat, string>> = {
  mp3: 'Encoder MP3 (lamejs)',
  ogg: 'Encoder OGG Vorbis (vorbis-encoder-js)',
};

// ── Nama berkas ──────────────────────────────────────────────────────────────

/** Dipakai kalau field DAN nama project sama-sama tidak menyisakan apa pun. */
export const DEFAULT_EXPORT_NAME = 'mixdown';
/**
 * Batas panjang basename. Bukan batas satu OS tertentu: limit per-komponen
 * ext4/APFS/NTFS ada di 255 BYTE, dan satu huruf non-ASCII bisa memakan 4 byte.
 * 120 karakter aman di semua kasus itu sekaligus menyisakan ruang untuk
 * ekstensi dan suffix " (1)" yang ditambahkan browser saat nama bentrok.
 */
export const MAX_EXPORT_NAME_LEN = 120;

/** Ilegal di Windows, dan `/` juga memecah path di POSIX. */
const ILLEGAL_CHARS = /[/\\:*?"<>|]/g;
/** Control char tidak terlihat di UI tapi merusak nama berkas — buang total. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
/** Ekstensi audio yang kita tambahkan sendiri; jangan sampai jadi `mix.wav.wav`. */
const AUDIO_EXT = /\.(wav|flac|mp3|ogg)$/i;
/**
 * Nama device DOS. Masih dipesan di Windows modern: `CON.wav` gagal ditulis,
 * dan pesan errornya tidak menyebut-nyebut nama berkas.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Titik dan spasi di ujung: Windows memangkasnya diam-diam, jadi kita duluan. */
const trimEdges = (s: string): string => s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

/**
 * Bersihkan satu basename agar aman ditulis ke disk. Hasilnya bisa string
 * KOSONG (mis. input `"///"`) — itu sinyal bagi pemanggil untuk jatuh ke
 * fallback, bukan kegagalan.
 *
 * Huruf non-ASCII sengaja DIPERTAHANKAN: "Café Sessions" adalah nama yang sah
 * di semua filesystem yang kita targetkan, dan meng-ASCII-kannya adalah persis
 * jenis pengubahan diam-diam yang ingin kita hindari.
 */
export function sanitizeFileName(raw: string): string {
  let s = raw.replace(CONTROL_CHARS, '').replace(ILLEGAL_CHARS, '-');
  // Newline/tab sudah hilang di atas; sisanya spasi beruntun.
  s = s.replace(/\s+/g, ' ');
  s = trimEdges(s.replace(AUDIO_EXT, ''));
  // Potong per CODE POINT, bukan per code unit: `slice` biasa bisa membelah
  // surrogate pair dan menyisakan setengah emoji di ujung nama.
  const cp = Array.from(s);
  if (cp.length > MAX_EXPORT_NAME_LEN) s = trimEdges(cp.slice(0, MAX_EXPORT_NAME_LEN).join(''));
  // Kalau yang tersisa cuma pemisah (`"///"` → `"---"`), itu bukan nama — itu
  // sisa pembersihan. Anggap kosong supaya jatuh ke fallback; file bernama
  // "---.wav" tidak lebih berguna daripada nama project.
  if (!/[^-_. ]/.test(s)) return '';
  return RESERVED.test(s) ? `_${s}` : s;
}

export interface ResolvedExportName {
  /** Basename siap pakai, tanpa ekstensi. Tidak pernah kosong. */
  readonly base: string;
  /** Dari mana `base` berasal — dipakai UI untuk memilih kalimat penjelasan. */
  readonly source: 'field' | 'project' | 'default';
  /** true kalau user mengetik sesuatu dan hasilnya TIDAK sama persis. */
  readonly changed: boolean;
}

/**
 * Rantai fallback nama export: field → nama project → `mixdown`.
 *
 * `changed` ada supaya UI bisa mengatakannya SEBELUM user mengunduh. Nama yang
 * diam-diam berubah baru ketahuan saat file sudah ada di folder Downloads
 * dengan nama yang tidak dicari siapa pun.
 */
export function resolveExportName(field: string, projectName: string): ResolvedExportName {
  const wanted = field.trim();
  const fromField = sanitizeFileName(field);
  if (fromField !== '') {
    return { base: fromField, source: 'field', changed: fromField !== wanted };
  }
  // Nama project membawa pseudo-ekstensi sendiri (`NEON_DRIFT.STUDIO`), jadi
  // segmen terakhirnya dibuang — `NEON_DRIFT.STUDIO.wav` bukan nama yang dicari
  // siapa pun. Aturan ini SENGAJA tidak berlaku untuk field: kalau user mengetik
  // "Mix v1.2", angka di belakang titik itu bagian dari nama, bukan ekstensi.
  const fromProject = sanitizeFileName(projectName.replace(/\.[^.]*$/, ''));
  const base = fromProject !== '' ? fromProject : DEFAULT_EXPORT_NAME;
  // `changed` hanya berarti kalau user MEMANG mengetik sesuatu: field kosong
  // adalah pilihan sadar untuk memakai nama project, bukan sesuatu yang perlu
  // diperingatkan.
  return {
    base,
    source: fromProject !== '' ? 'project' : 'default',
    changed: wanted !== '',
  };
}

export interface CompileParams {
  format: EncoderFormat;
  /**
   * Basename mentah seperti yang diketik user (boleh kosong / kotor). Dibersihkan
   * dan di-fallback DI SINI supaya nama yang ditawarkan picker, nama file yang
   * diunduh, dan nama yang ditampilkan kartu Compile berasal dari satu fungsi.
   */
  fileName: string;
  /** WAV: 16/24/32. FLAC: 16/24. Diabaikan untuk MP3/OGG. */
  bitDepth?: 16 | 24 | 32;
  /** MP3 kbps, atau quality Vorbis. Diabaikan untuk WAV/FLAC. */
  quality?: number;
  onProgress?: (fraction01: number | null) => void;
  /** Selisih preview vs file — UI WAJIB menampilkannya. */
  onWarnings?: (warnings: readonly string[]) => void;
  /** Dicek sekali per batch. */
  isCancelled?: () => boolean;
  /** Hasil master sesudah gain koreksi, sebelum encode. */
  onAnalysis?: (analysis: LoudnessAnalysis) => void;
  /** Gain hasil tombol FIX & EXPORT. */
  gainDb?: number;
}

export interface AnalyzeCompileParams {
  onProgress?: (fraction01: number | null) => void;
  onWarnings?: (warnings: readonly string[]) => void;
  isCancelled?: () => boolean;
}

/**
 * Render analysis pass tanpa membuat file. Hasilnya dipakai dialog keputusan,
 * sehingga file picker dan encoder baru berjalan setelah user memilih.
 */
export async function analyzeCompile(p: AnalyzeCompileParams = {}): Promise<LoudnessAnalysis> {
  if (!host) throw new Error(NO_HOST);
  const state = host.state();
  const { payload, pcm } = buildExportPayload(state, host.getBuffer);
  if (payload.endSample <= 0 || payload.assets.length === 0) {
    throw new Error('Tidak ada clip dengan audio untuk dianalisis.');
  }

  p.onProgress?.(0);
  try {
    const result = await renderAnalysis({
      payload,
      pcm,
      sampleRate: state.sampleRate,
      onProgress: p.onProgress,
      onWarnings: p.onWarnings,
      isCancelled: p.isCancelled,
    });
    if (result.analysis === null) throw new Error('Analyzer tidak menghasilkan laporan.');
    return result.analysis;
  } finally {
    p.onProgress?.(null);
  }
}

/**
 * Jalankan export. HARUS dipanggil dari handler klik: `pickSaveLocation()`
 * membutuhkan user gesture (docs/03 §3d).
 */
export async function runCompile(p: CompileParams): Promise<void> {
  if (!host) throw new Error(NO_HOST);

  const state = host.state();
  // PCM-nya TIDAK ikut di sini — `pcm` mengambilnya satu per satu saat
  // pendaftaran, dari cache preview yang sama dengan yang didengar user.
  const { payload, pcm } = buildExportPayload(state, host.getBuffer);
  if (payload.endSample <= 0 || payload.assets.length === 0) {
    throw new Error('Tidak ada clip dengan audio untuk di-render.');
  }

  const ext = p.format;
  const mime = MIME[p.format];
  const bitDepth = p.bitDepth ?? 16;
  // Satu nama untuk DUA jalur simpan: `suggestedName` picker File System Access
  // dan atribut `download` anchor. Kalau keduanya dihitung terpisah, file yang
  // sama bisa mendarat dengan dua nama berbeda tergantung browser.
  const fileName = `${resolveExportName(p.fileName, state.projectName).base}.${ext}`;
  // Picker DULU, sebelum render: ia butuh user gesture, dan gesture-nya hilang
  // begitu kita menunggu batch pertama. `null` = browser tanpa File System
  // Access API (atau user batal) → jalur anchor+Blob.
  const fileHandle = await pickSaveLocation(fileName, mime, ext);

  // Ke disk kalau user memilih lokasi, kalau tidak ditumpuk di memori.
  // Perbedaannya bukan kenyamanan: lewat `FileSystemSink` byte turun ke disk
  // begitu di-encode, jadi ukuran file tidak lagi dibatasi RAM. `BlobSink`
  // adalah yang terbaik yang bisa dilakukan di browser tanpa File System
  // Access (Firefox, Safari) — dan di sana batas itu memang tetap ada.
  const blobSink = fileHandle ? null : new BlobSink();
  const sink: ExportSink = blobSink ?? (await FileSystemSink.create(fileHandle!));

  try {
    const result = await render({
      payload,
      pcm,
      sink,
      sampleRate: state.sampleRate,
      format: p.format,
      bitDepth,
      quality: p.quality,
      onProgress: p.onProgress,
      onWarnings: p.onWarnings,
      isCancelled: p.isCancelled,
      analyze: true,
      gainDb: p.gainDb,
    });
    if (result.analysis !== null) p.onAnalysis?.(result.analysis);
    // Jalur mana pun sudah memanggil `sink.abort()` kalau gagal/dibatalkan,
    // jadi di sini kita hanya sampai kalau berkasnya memang lengkap.
    if (blobSink) downloadBlob(blobSink.takeBlob(mime), fileName);
  } catch (e) {
    // Batal bukan kegagalan — jangan tampilkan sebagai error merah.
    if (!(e instanceof ExportCancelled)) throw e;
  } finally {
    p.onProgress?.(null);
  }
}

/** Argumen bersama kedua jalur render — worker maupun main thread. */
interface RenderParams {
  payload: ExportPayload;
  pcm: ExportAssetSource;
  sink: ExportSink;
  sampleRate: number;
  format: EncoderFormat;
  bitDepth: 16 | 24 | 32;
  quality?: number;
  onProgress?: (fraction01: number | null) => void;
  onWarnings?: (warnings: readonly string[]) => void;
  isCancelled?: () => boolean;
  analyze?: boolean;
  gainDb?: number;
}

/**
 * Render di worker; main thread hanya sebagai cadangan.
 *
 * Worker BUKAN sekadar demi UI yang tidak membeku. Linear memory wasm tidak
 * pernah menyusut, jadi export yang berjalan di instance main thread menahan
 * seluruh PCM project di tab itu sampai halaman di-reload — walaupun engine
 * sudah membebaskannya. Worker punya satu langkah yang tidak dimiliki main
 * thread: `terminate()`. Lihat `export/worker-host.ts`.
 *
 * Cadangannya dipakai HANYA kalau worker gagal sebelum satu byte pun ditulis
 * (tidak ada `Worker` sama sekali, modul worker gagal dimuat, encoder lazy-nya
 * tidak bisa hidup di worker). Sesudah byte pertama, mengulang berarti berkas
 * berisi dua export yang disambung.
 */
async function render(r: RenderParams): Promise<ExportResult> {
  if (canRunExportInWorker()) {
    try {
      return await runExportInWorker({
        payload: r.payload,
        pcm: r.pcm,
        sink: r.sink,
        sampleRate: r.sampleRate,
        format: r.format,
        bitDepth: r.bitDepth,
        quality: r.quality,
        onProgress: r.onProgress,
        onWarnings: r.onWarnings,
        isCancelled: r.isCancelled,
        analyze: r.analyze,
        gainDb: r.gainDb,
      });
    } catch (e: unknown) {
      if (!(e instanceof ExportWorkerUnavailable)) throw e;
      // Jangan ditelan: jalur cadangan bekerja, tapi ia meninggalkan memori
      // yang tidak bisa dikembalikan, dan itu harus bisa dilihat kalau nanti
      // ada yang bertanya kenapa memori naik lagi.
      console.warn('[export] worker export tidak bisa dipakai, jatuh ke main thread:', e);
    }
  }
  return renderOnMainThread(r);
}

/**
 * Jalur cadangan: render di main thread, dengan instance WASM yang sama yang
 * dipakai sisa aplikasi. Berfungsi penuh — hanya saja memori yang ditumbuhkan
 * export tidak pernah kembali sampai tab di-reload.
 */
async function renderOnMainThread(r: RenderParams): Promise<ExportResult> {
  const wasm = wasmCache ?? (await loadWasm());
  wasmCache = wasm;

  const encoder = createEncoder(r.format, wasm.exports) as unknown as ExportEncoder;
  try {
    await encoder.init({
      sampleRate: r.sampleRate,
      channels: 2,
      bitDepth: r.bitDepth,
      quality: r.quality,
    });
  } catch (e) {
    const label = LAZY_ENCODER_LABEL[r.format];
    if (label) {
      throw new Error(
        `${label} gagal dimuat: ${e instanceof Error ? e.message : String(e)}. ` +
          'Format lain (WAV/FLAC) tetap bisa dipakai.',
      );
    }
    throw e;
  }

  return runExport({
    payload: r.payload,
    sampleRate: r.sampleRate,
    engine: createWasmExportEngine(wasm),
    encoder,
    sink: r.sink,
    pcm: r.pcm,
    onProgress: r.onProgress,
    onWarnings: r.onWarnings,
    isCancelled: r.isCancelled,
    analyze: r.analyze,
    gainDb: r.gainDb,
  });
}

interface AnalysisRenderParams {
  payload: ExportPayload;
  pcm: ExportAssetSource;
  sampleRate: number;
  onProgress?: (fraction01: number | null) => void;
  onWarnings?: (warnings: readonly string[]) => void;
  isCancelled?: () => boolean;
}

const nullSink: ExportSink = {
  header() {},
  chunk() {},
  patchHeader() {},
  close() {},
  abort() {},
};

const analysisEncoder = (): ExportEncoder => ({
  mime: 'application/x-analysis',
  async init(): Promise<void> {},
  encode(): Uint8Array {
    return new Uint8Array(0);
  },
  finish(): Uint8Array {
    return new Uint8Array(0);
  },
});

async function renderAnalysis(r: AnalysisRenderParams): Promise<ExportResult> {
  if (canRunExportInWorker()) {
    try {
      return await runExportInWorker({
        payload: r.payload,
        pcm: r.pcm,
        sink: nullSink,
        sampleRate: r.sampleRate,
        format: 'wav',
        bitDepth: 16,
        analyze: true,
        analysisOnly: true,
        onProgress: r.onProgress,
        onWarnings: r.onWarnings,
        isCancelled: r.isCancelled,
      });
    } catch (e: unknown) {
      if (!(e instanceof ExportWorkerUnavailable)) throw e;
      console.warn('[analysis] worker tidak bisa dipakai, jatuh ke main thread:', e);
    }
  }

  const wasm = wasmCache ?? (await loadWasm());
  wasmCache = wasm;
  return runExport({
    payload: r.payload,
    pcm: r.pcm,
    sink: nullSink,
    sampleRate: r.sampleRate,
    engine: createWasmExportEngine(wasm),
    encoder: analysisEncoder(),
    analyze: true,
    onProgress: r.onProgress,
    onWarnings: r.onWarnings,
    isCancelled: r.isCancelled,
  });
}
