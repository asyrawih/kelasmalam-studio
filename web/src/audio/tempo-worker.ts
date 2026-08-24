/**
 * Worker analisis tempo — satu tugas: PCM masuk, BPM keluar.
 *
 * KENAPA WORKER TERPISAH, bukan menumpang `import-worker`: import-worker
 * menerima `WebAssembly.Module` engine di dalam pesannya karena PCM hasil
 * import harus mendarat di linear memory yang SAMA dengan engine. Analisis
 * tempo tidak punya kebutuhan itu — ia menerima salinan PCM, membacanya sekali,
 * lalu selesai. Menumpang berarti mengikatkan fitur ini pada tersedianya
 * jalur import WASM (yang saat ini belum dipakai studio; lihat
 * `studio/timeline/audio-import.ts`), padahal tidak ada alasannya.
 *
 * KENAPA VARIAN `st`: varian `mt` di-link dengan `--import-memory`, jadi ia
 * menuntut `WebAssembly.Memory` bersama dari luar. Analisis di sini tidak
 * berbagi apa pun dengan thread audio, jadi memory sendiri justru yang benar —
 * dan `st` bisa dimuat tanpa cross-origin isolation, sehingga BPM tetap muncul
 * di deployment yang tidak punya COOP/COEP (docs/01 §1d).
 *
 * Beban kerjanya nyata: satu lintasan filterbank enam biquad atas seluruh
 * materi. Lagu lima menit ≈ ratusan milidetik. Itu persis alasan kenapa ini
 * TIDAK boleh di main thread — di sana ia terlihat sebagai UI membeku tepat
 * saat user melepas file.
 */

import { WASM_URLS } from './wasm-urls';

export interface TempoRequest {
  type: 'tempo';
  /** Id asset — dikembalikan apa adanya supaya main thread bisa memetakan. */
  id: number;
  /** PCM planar. Ditransfer, bukan disalin. */
  left: ArrayBuffer;
  /** Kosong untuk mono. */
  right: ArrayBuffer | null;
  sampleRate: number;
}

export interface TempoResult {
  type: 'tempo-result';
  id: number;
  /** `null` = materi terlalu pendek / senyap. Itu jawaban yang sah, bukan error. */
  tempo: { bpm: number; confidence: number; beatOffsetSec: number; beatTimesSec?: number[] } | null;
}

export interface TempoError {
  type: 'tempo-error';
  id: number;
  message: string;
}

interface TempoGlue {
  default: (init: { module_or_path: string }) => Promise<unknown>;
  initNonRealtime: () => void;
  detectTempo: (
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
  ) => {
    bpm: number;
    confidence: number;
    beatOffsetSec: number;
    beatTimesSec?: Float32Array;
    free: () => void;
  } | undefined;
}

let gluePromise: Promise<TempoGlue> | null = null;

/**
 * Muat glue + artefak sekali, lalu pakai ulang. Disimpan sebagai PROMISE, bukan
 * sebagai hasil: dua file yang di-drop bersamaan akan memanggil ini dua kali
 * sebelum yang pertama selesai, dan menyimpan hasilnya saja berarti artefak
 * ter-fetch dan ter-instantiate dua kali.
 */
function ensureGlue(): Promise<TempoGlue> {
  if (gluePromise !== null) return gluePromise;
  gluePromise = (async () => {
    const g = (await import(/* @vite-ignore */ WASM_URLS.st.glue)) as unknown as TempoGlue;
    await g.default({ module_or_path: WASM_URLS.st.wasm });
    g.initNonRealtime();
    if (typeof g.detectTempo !== 'function') {
      throw new Error(
        'Artefak WASM ini belum punya detectTempo — bangun ulang dengan scripts/build-wasm.sh.',
      );
    }
    return g;
  })();
  // Kegagalan TIDAK boleh dicache selamanya: sekali artefak gagal ter-fetch
  // (jaringan putus saat dev-server restart), setiap import berikutnya akan
  // gagal tanpa pernah mencoba lagi.
  gluePromise.catch(() => {
    gluePromise = null;
  });
  return gluePromise;
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as TempoRequest;
  if (m.type !== 'tempo') return;
  void handle(m).catch((e: unknown) => {
    const msg: TempoError = {
      type: 'tempo-error',
      id: m.id,
      message: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(msg);
  });
};

async function handle(m: TempoRequest): Promise<void> {
  const g = await ensureGlue();
  const left = new Float32Array(m.left);
  const right = m.right === null ? new Float32Array(0) : new Float32Array(m.right);

  const est = g.detectTempo(left, right, m.sampleRate);
  const tempo =
    est === undefined
      ? null
      : {
          bpm: est.bpm,
          confidence: est.confidence,
          beatOffsetSec: est.beatOffsetSec,
          beatTimesSec: Array.from(est.beatTimesSec ?? []),
        };
  // Handle bindgen memiliki memori di sisi WASM; tanpa `free()` ia bocor satu
  // objek per import — kecil, tapi bocor yang tidak ada alasannya.
  est?.free();

  const msg: TempoResult = { type: 'tempo-result', id: m.id, tempo };
  (self as unknown as Worker).postMessage(msg);
}
