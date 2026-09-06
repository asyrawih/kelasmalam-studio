/**
 * Adapter platform: DESKTOP (Tauri 2), docs/20 §1d, §1g, §2c.
 *
 * Yang statis di-import hanya `@tauri-apps/api/core` (`invoke`; `isTauri`-nya
 * sudah dipakai `index.ts`) — modul kecil tanpa efek samping. Plugin dialog,
 * fs, opener, dan `webview`/`event` di-`import()` DINAMIS di dalam
 * method: bundel web tidak perlu membawa kode yang hanya hidup di Tauri, dan
 * Vite memecahnya jadi chunk yang tidak pernah diminta browser.
 *
 * Yang disediakan sisi Rust (`desktop/src-tauri/src/lib.rs`, dikawinkan
 * setelah merge): `model_download({id}) -> path` dengan event
 * `daw://model-progress` `{id, done, total}`, lalu `model_read({id}) -> byte`.
 *
 * TIDAK ADA LOGIN di sini. Kepustakaan butuh sesi, sesi web adalah cookie yang
 * tidak pernah ikut dari origin `tauri://`, dan alur penggantinya (docs/20
 * §1d) ditunda — jadi host ini tidak mendefinisikan `login`, dan dok
 * kepustakaan membaca ketiadaan itu sebagai "belum tersedia di versi desktop".
 */

import { invoke } from '@tauri-apps/api/core';
import { assertModelSize, SCNET_MODELS, type ScnetModelId } from '../proof-stem/scnet-catalog';
import type { ExportSink } from '../studio/export/sinks';
import type { DropPoint, ModelBytes, OpenAudioFilesOptions, PlatformHost, SaveTarget } from './host';

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

export function createDesktopHost(): PlatformHost {
  const readFiles = async (paths: readonly string[]): Promise<File[]> => {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const files: File[] = [];
    for (const path of paths) {
      const bytes = await readFile(path);
      const name = baseName(path);
      files.push(new File([bytes], name, { type: mimeOf(name) }));
    }
    return files;
  };

  return {
    kind: 'desktop',

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

    async authHeaders(): Promise<Record<string, string>> {
      // Tidak ada sesi desktop (lihat kepala berkas). Kosong, bukan bearer —
      // dan permintaan kepustakaan memang tidak pernah dikirim dari desktop
      // selama `login` tidak ada.
      return {};
    },

    async modelBytes(id: ScnetModelId, onProgress): Promise<ModelBytes> {
      const model = SCNET_MODELS[id];
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
      const raw = await invoke<RawBytes>('model_read', { id });
      const bytes =
        raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
      assertModelSize(model, bytes.byteLength);
      const cacheHit = !sawProgress;
      onProgress({ loaded: bytes.byteLength, total: model.bytes, cacheHit });
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
