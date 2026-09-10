/**
 * Adapter platform: DESKTOP (Tauri 2), docs/20 §1d, §1g, §2c.
 *
 * Yang statis di-import hanya `@tauri-apps/api/core` (`invoke`; `isTauri`-nya
 * sudah dipakai `index.ts`) — modul kecil tanpa efek samping. Plugin dialog,
 * fs, opener, dan `webview`/`event` di-`import()` DINAMIS di dalam
 * method: bundel web tidak perlu membawa kode yang hanya hidup di Tauri, dan
 * Vite memecahnya jadi chunk yang tidak pernah diminta browser.
 *
 * Yang disediakan sisi Rust (`src-tauri/src/lib.rs`, dikawinkan
 * setelah merge): `model_download({id}) -> path` dengan event
 * `daw://model-progress` `{id, done, total}`, lalu `model_read({id}) -> byte`.
 * Untuk vocal split native (docs/26 P3b): `vocal_split_accels`,
 * `vocal_split_run` (badan mentah PCM + header, pola `library_put_bytes`)
 * dengan event `daw://vocal-split-progress`, dan `vocal_split_cancel`.
 *
 * TIDAK ADA LOGIN di sini, dan sekarang memang tidak perlu: kepustakaan
 * desktop adalah `createLocalLibraryApi()` di atas SQLite + folder lokal
 * (docs/21 §1c) — tanpa sesi, tanpa Worker — dan `main.tsx` yang
 * mendaftarkannya (`registerLibraryApi`), bukan host ini: kepustakaan bukan
 * soal platform (docs/25 P3). `login` tetap tidak didefinisikan, dan dok
 * membaca ketiadaan itu sebagai "tidak ada tombol MASUK/KELUAR".
 */

import { invoke } from '@tauri-apps/api/core';
import { assertModelSize, SCNET_MODELS } from '@kelasmalam/proof-stem/proof-stem/scnet-catalog';
import { assertVocalModelSize, VOCAL_MODELS } from '@kelasmalam/vocal-split/catalog';
import type { ExportSink } from '@kelasmalam/platform/export-sink';
import type {
  DropPoint,
  ModelBytes,
  OpenAudioFilesOptions,
  PlatformHost,
  SaveTarget,
  ModelId,
  VocalModelId,
  VocalSplitAccel,
  VocalSplitHost,
  VocalSplitInput,
  VocalSplitOutput,
} from '@kelasmalam/platform/host';
import type { VocalSplitProgress, VocalSplitRunHeaders } from './local-commands';

export const AUDIO_EXTENSIONS: readonly string[] = ['wav', 'mp3', 'flac', 'ogg', 'aif', 'aiff', 'm4a', 'aac'];

const MIME_OF_EXT: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

/** Byte model boleh datang sebagai `number[]` (JSON) atau `Uint8Array` (raw IPC). */
type RawBytes = number[] | Uint8Array | ArrayBuffer;

interface ModelProgressPayload {
  readonly id: string;
  readonly done: number;
  readonly total: number;
}

function toBytes(raw: RawBytes): Uint8Array {
  return raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}

// ── Vocal split native: PCM ⇄ byte (docs/26 P3b) ────────────────────────────

/**
 * Kontrak IPC-nya Float32 LITTLE-ENDIAN. `Float32Array` memakai endian mesin;
 * semua target (x86, ARM) little-endian, jadi jalur cepatnya salin byte apa
 * adanya — tapi kontraknya tetap ditulis eksplisit lewat `DataView` untuk
 * mesin big-endian, supaya "LE" di kontrak bukan asumsi diam-diam.
 */
const LITTLE_ENDIAN: boolean = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Badan `vocal_split_run`: `[left(N), right(N)]` sebagai Float32 LE. */
export function encodeSplitInput(left: Float32Array, right: Float32Array): Uint8Array {
  const n = left.length;
  if (right.length !== n) throw new Error(`PCM kiri ${n} frame, kanan ${right.length} frame — harus sama`);
  if (LITTLE_ENDIAN) {
    const pcm = new Float32Array(2 * n);
    pcm.set(left, 0);
    pcm.set(right, n);
    return new Uint8Array(pcm.buffer);
  }
  const out = new Uint8Array(2 * n * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i += 1) view.setFloat32(i * 4, left[i]!, true);
  for (let i = 0; i < n; i += 1) view.setFloat32((n + i) * 4, right[i]!, true);
  return out;
}

/**
 * Balasan `vocal_split_run`: `[voc_l(N), voc_r(N), inst_l(N), inst_r(N)]`
 * Float32 LE → empat `Float32Array` yang masing-masing punya buffer sendiri.
 *
 * Disalin per bagian LEWAT BYTE (`Uint8Array.set` ke buffer keluaran), bukan
 * `new Float32Array(raw.buffer, offset)`: view yang datang dari IPC boleh punya
 * `byteOffset` yang bukan kelipatan 4, dan `Float32Array` menolak offset
 * seperti itu. Panjangnya diperiksa dulu — balasan yang pendek berarti Rust
 * dan TS tidak sepakat soal N, bukan sesuatu yang boleh diisi nol.
 */
export function decodeSplitOutput(raw: RawBytes, frames: number): VocalSplitOutput {
  const bytes = toBytes(raw);
  const expected = frames * 4 * 4;
  if (bytes.byteLength !== expected) {
    throw new Error(
      `Balasan vocal_split_run ${bytes.byteLength} byte, diharapkan ${expected} ` +
        `(${frames} frame × 4 kanal × 4 byte)`,
    );
  }
  const part = (k: number): Float32Array => {
    const out = new Float32Array(frames);
    const src = bytes.subarray(k * frames * 4, (k + 1) * frames * 4);
    if (LITTLE_ENDIAN) {
      new Uint8Array(out.buffer).set(src);
    } else {
      const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
      for (let i = 0; i < frames; i += 1) out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  };
  return {
    vocals: { left: part(0), right: part(1) },
    instrumental: { left: part(2), right: part(3) },
  };
}

/** Galat `vocal_split_run` dari Rust (`{ code, message }`); `CANCELLED` menjadi `AbortError`, bukan ini. */
export class VocalSplitCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VocalSplitCommandError';
  }
}

function toVocalSplitError(reason: unknown): VocalSplitCommandError {
  if (reason instanceof VocalSplitCommandError) return reason;
  const r = reason as { code?: unknown; message?: unknown } | null;
  const code = typeof r?.code === 'string' ? r.code : 'IO';
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : typeof r?.message === 'string'
          ? r.message
          : 'vocal split native gagal tanpa pesan';
  return new VocalSplitCommandError(code, message);
}

function abortError(): DOMException {
  return new DOMException('Vocal split dibatalkan', 'AbortError');
}

const VOCAL_SPLIT_ACCELS: ReadonlySet<string> = new Set<VocalSplitAccel>(['cpu', 'coreml']);

let vocalSplitJobSeq = 0;

/** Id job yang unik selama proses hidup; Rust memakainya untuk progres dan batal. */
function nextVocalSplitJobId(): string {
  vocalSplitJobSeq += 1;
  return `vs-${Date.now().toString(36)}-${vocalSplitJobSeq}`;
}

/** Sample rate yang diterima `vocal_split_run` (Kim_Vocal_2 dilatih di rate ini). */
const VOCAL_SPLIT_SAMPLE_RATE = 44_100;

/**
 * Implementasi [`VocalSplitHost`] di atas tiga command Rust. Dipisah dari
 * `createDesktopHost` supaya tesnya bisa membaca bentuk IPC-nya langsung.
 */
export function createVocalSplitHost(): VocalSplitHost {
  return {
    async accels(): Promise<readonly VocalSplitAccel[]> {
      const raw = await invoke<readonly string[]>('vocal_split_accels');
      // Nilai asing (versi Rust lebih baru) dibuang, bukan diteruskan ke
      // dialog sebagai tombol yang tidak dimengerti sisi ini.
      const known = raw.filter((a): a is VocalSplitAccel => VOCAL_SPLIT_ACCELS.has(a));
      return known.includes('cpu') ? known : ['cpu', ...known];
    },

    async ensureModel(id: VocalModelId, onProgress): Promise<void> {
      const total = VOCAL_MODELS[id].bytes;
      const { listen } = await import('@tauri-apps/api/event');
      // Sama dengan `modelBytes`: tanpa event progres berarti berkasnya sudah
      // ada — itu cache hit. Bytenya TIDAK dibaca ke JS; Rust yang memakainya.
      let sawProgress = false;
      const unlisten = await listen<ModelProgressPayload>('daw://model-progress', (event) => {
        if (event.payload.id !== id) return;
        sawProgress = true;
        onProgress({ loaded: event.payload.done, total: event.payload.total, cacheHit: false });
      });
      try {
        await invoke<string>('model_download', { id });
      } finally {
        unlisten();
      }
      onProgress({ loaded: total, total, cacheHit: !sawProgress });
    },

    async run(input: VocalSplitInput, onProgress, signal): Promise<VocalSplitOutput> {
      if (input.sampleRate !== VOCAL_SPLIT_SAMPLE_RATE) {
        throw new Error(`vocal split native menerima ${VOCAL_SPLIT_SAMPLE_RATE} Hz, bukan ${input.sampleRate} Hz — resample dulu`);
      }
      if (signal?.aborted) throw abortError();
      const id = nextVocalSplitJobId();
      const frames = input.left.length;
      const body = encodeSplitInput(input.left, input.right);
      const headers: VocalSplitRunHeaders = {
        'x-job-id': id,
        'x-frames': String(frames),
        'x-model': input.modelId,
        'x-overlap': input.overlap === 0.5 ? '0.5' : '0.25',
        'x-denoise': input.denoise ? '1' : '0',
        'x-accel': input.accel,
        ...(input.threads !== undefined ? { 'x-threads': String(Math.max(1, Math.floor(input.threads))) } : {}),
      };

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<VocalSplitProgress>('daw://vocal-split-progress', (event) => {
        if (event.payload.id !== id) return;
        onProgress(event.payload.done, event.payload.total);
      });
      // Batal: minta Rust berhenti; `vocal_split_run`-nya sendiri yang akan
      // menolak (`CANCELLED`), jadi tidak ada dua jalur penyelesaian.
      const onAbort = (): void => {
        void invoke<null>('vocal_split_cancel', { id }).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      let raw: RawBytes;
      try {
        raw = await invoke<RawBytes>('vocal_split_run', body, { headers: { ...headers } });
      } catch (reason: unknown) {
        const err = toVocalSplitError(reason);
        if (err.code === 'CANCELLED' || signal?.aborted) throw abortError();
        throw err;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        unlisten();
      }
      // Pembatalan yang kalah cepat dari segmen terakhir: pemanggil sudah
      // tidak menunggu hasilnya (pola `split-client.ts`).
      if (signal?.aborted) throw abortError();
      return decodeSplitOutput(raw, frames);
    },
  };
}

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i === -1 ? path : path.slice(i + 1);
}

function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return MIME_OF_EXT[ext] ?? '';
}

/** Bentuk minimal `FileHandle` plugin-fs yang dipakai sink. */
interface TauriFile {
  write(data: Uint8Array): Promise<number>;
  seek(offset: number, whence: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Sink export ke berkas lewat plugin-fs — jalur STREAMING desktop.
 *
 * Chunk turun ke disk begitu di-encode; tidak ada Blob 500 MB di heap WebView.
 * `patchHeader` memakai `seek(0)` lalu menulis ulang header WAV yang panjangnya
 * dijamin sama dengan placeholder (kontrak `ExportSink`). `abort()` MENGHAPUS
 * berkasnya: dialog "simpan sebagai" sudah menunjuk nama tujuan, jadi berkas
 * separuh jadi di sana akan terlihat seperti export yang berhasil.
 */
export class TauriFileSink implements ExportSink {
  private headerLen = 0;

  private constructor(
    private readonly file: TauriFile,
    private readonly path: string,
    private readonly fs: Pick<typeof import('@tauri-apps/plugin-fs'), 'remove' | 'SeekMode'>,
  ) {}

  static async create(path: string): Promise<TauriFileSink> {
    const fs = await import('@tauri-apps/plugin-fs');
    const file = await fs.open(path, { write: true, create: true, truncate: true });
    return new TauriFileSink(file, path, fs);
  }

  /** `write` boleh menulis sebagian — seperti `std::io::Write::write`. Ulangi sampai habis. */
  private async writeAll(bytes: Uint8Array): Promise<void> {
    let at = 0;
    while (at < bytes.byteLength) {
      const n = await this.file.write(at === 0 ? bytes : bytes.subarray(at));
      if (n <= 0) throw new Error(`tidak ada byte yang tertulis ke ${this.path}`);
      at += n;
    }
  }

  async header(bytes: Uint8Array): Promise<void> {
    this.headerLen = bytes.byteLength;
    await this.writeAll(bytes);
  }

  async chunk(bytes: Uint8Array): Promise<void> {
    await this.writeAll(bytes);
  }

  async patchHeader(bytes: Uint8Array): Promise<void> {
    if (this.headerLen > 0 && bytes.byteLength !== this.headerLen) {
      throw new Error(
        `Header final ${bytes.byteLength} byte tidak sepanjang placeholder ` +
          `${this.headerLen} byte — menimpanya akan menggeser seluruh data.`,
      );
    }
    await this.file.seek(0, this.fs.SeekMode.Start);
    await this.writeAll(bytes);
    await this.file.seek(0, this.fs.SeekMode.End);
  }

  async close(): Promise<void> {
    await this.file.close();
  }

  async abort(): Promise<void> {
    try {
      await this.file.close();
    } catch {
      /* penyebab aslinya sudah dalam perjalanan naik */
    }
    await this.fs.remove(this.path).catch(() => {});
  }
}

/**
 * Path berkas yang baru masuk lewat drop/dialog, menunggu diklaim kepustakaan.
 *
 * Kunci `(name, size)` — lihat `PlatformHost.droppedPathFor`. Dibatasi jumlah
 * DAN umur: entri yang tidak pernah diklaim (decode gagal, zona yang tidak
 * mengumumkan import) tidak boleh menumpuk selama app hidup, dan entri tua
 * tidak boleh mengklaim berkas lain yang kebetulan senama dan seukuran
 * berminggu-minggu kemudian.
 */
export class DroppedPathRegistry {
  private readonly entries: { name: string; size: number; path: string; at: number }[] = [];

  constructor(
    private readonly maxEntries = 64,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  remember(name: string, size: number, path: string): void {
    this.prune();
    this.entries.push({ name, size, path, at: this.now() });
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  /** Klaim SATU entri yang cocok — yang paling lama dulu — dan buang dari daftar. */
  take(name: string, size: number): string | null {
    this.prune();
    const i = this.entries.findIndex((e) => e.name === name && e.size === size);
    if (i === -1) return null;
    const [hit] = this.entries.splice(i, 1);
    return hit?.path ?? null;
  }

  private prune(): void {
    const limit = this.now() - this.ttlMs;
    let keep = 0;
    while (keep < this.entries.length && this.entries[keep]!.at < limit) keep++;
    if (keep > 0) this.entries.splice(0, keep);
  }
}

export function createDesktopHost(): PlatformHost {
  const dropped = new DroppedPathRegistry();

  const readFiles = async (paths: readonly string[]): Promise<File[]> => {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const files: File[] = [];
    for (const path of paths) {
      const bytes = await readFile(path);
      const name = baseName(path);
      // Path-nya diingat SEBELUM `File` diserahkan: begitu import mengumumkan
      // `(name, size)` yang sama, kepustakaan menyalin dari path ini di Rust
      // alih-alih mengirim byte yang baru saja dibaca kembali lewat IPC.
      dropped.remember(name, bytes.byteLength, path);
      files.push(new File([bytes], name, { type: mimeOf(name) }));
    }
    return files;
  };

  return {
    kind: 'desktop',

    // Inferensi vocal split di Rust (docs/26 P3b). Ada-nya properti ini yang
    // dibaca `vocal-split/split-session.ts`; web tidak mendaftarkannya.
    vocalSplit: createVocalSplitHost(),

    droppedPathFor(name, size): string | null {
      return dropped.take(name, size);
    },

    async pickSaveTarget(fileName, _mime, ext): Promise<SaveTarget> {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        defaultPath: fileName,
        filters: [{ name: 'Audio', extensions: [ext] }],
      });
      // Batal di dialog native = "jangan simpan". Tidak ada jalur Blob di
      // sini: unduhan anchor tidak berarti apa-apa di WebView.
      if (path === null) return { kind: 'cancelled' };
      return { kind: 'stream', sink: await TauriFileSink.create(path) };
    },

    async openAudioFiles(opts: OpenAudioFilesOptions = {}): Promise<readonly File[]> {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: opts.multiple ?? true,
        directory: false,
        filters: [{ name: 'Audio', extensions: [...(opts.extensions ?? AUDIO_EXTENSIONS)] }],
      });
      if (picked === null) return [];
      return readFiles(Array.isArray(picked) ? picked : [picked]);
    },

    async openExternal(url): Promise<void> {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    },

    async downloadUrl(url): Promise<void> {
      // WebView tidak mengunduh dari `<a download>`; browser OS yang menangani
      // unduhannya sendiri. Ada-nya method ini yang dibaca dialog SoundCloud.
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    },

    async authHeaders(): Promise<Record<string, string>> {
      // Tidak ada sesi desktop (lihat kepala berkas). Kosong, bukan bearer —
      // dan permintaan kepustakaan memang tidak pernah dikirim dari desktop
      // selama `login` tidak ada.
      return {};
    },

    async modelBytes(id: ModelId, onProgress): Promise<ModelBytes> {
      // Ukuran diverifikasi dari katalog yang tepat: `SCNET_MODELS` untuk
      // SCNet, `VOCAL_MODELS` untuk Kim_Vocal_2 (docs/26 P2). Kedua katalog
      // hanya butuh `bytes`/`label`, jadi tidak ada ORT yang tertarik.
      const verify: { readonly total: number; readonly assertSize: (actual: number) => void } =
        id === 'kim-vocal-2'
          ? { total: VOCAL_MODELS[id].bytes, assertSize: (n) => assertVocalModelSize(VOCAL_MODELS[id], n) }
          : { total: SCNET_MODELS[id].bytes, assertSize: (n) => assertModelSize(SCNET_MODELS[id], n) };
      const { listen } = await import('@tauri-apps/api/event');
      // Kalau Rust tidak pernah mengirim progres, unduhannya tidak terjadi —
      // berkasnya sudah ada di `appDataDir()/models/`. Itu definisi cache hit.
      let sawProgress = false;
      const unlisten = await listen<ModelProgressPayload>('daw://model-progress', (event) => {
        if (event.payload.id !== id) return;
        sawProgress = true;
        onProgress({ loaded: event.payload.done, total: event.payload.total, cacheHit: false });
      });
      try {
        await invoke<string>('model_download', { id });
      } finally {
        unlisten();
      }
      const bytes = toBytes(await invoke<RawBytes>('model_read', { id }));
      verify.assertSize(bytes.byteLength);
      const cacheHit = !sawProgress;
      onProgress({ loaded: bytes.byteLength, total: verify.total, cacheHit });
      return { bytes, cacheHit };
    },

    onFilesDropped(cb): () => void {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void import('@tauri-apps/api/webview')
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            if (event.payload.type !== 'drop' || disposed) return;
            const { paths, position } = event.payload;
            if (paths.length === 0) return;
            // Tauri memberi posisi FISIK; komponen bekerja dalam piksel CSS
            // (`clientX/clientY`, `elementFromPoint`).
            const scale = window.devicePixelRatio || 1;
            const point: DropPoint = { x: position.x / scale, y: position.y / scale };
            void readFiles(paths).then((files) => {
              if (!disposed && files.length > 0) cb(files, point);
            });
          }),
        )
        .then((un) => {
          if (disposed) un();
          else unlisten = un;
        })
        .catch((e: unknown) => console.warn('[platform] drop native tidak bisa dipasang:', e));
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}
