/**
 * SINK EXPORT — ke mana byte hasil encode pergi.
 *
 * Kenapa lapisan ini ada. Sebelumnya `runExport` menumpuk SELURUH file di satu
 * array `BlobPart[]` lalu menyerahkannya sebagai satu `Blob`, dan worker
 * menambah satu tahap lagi: `blob.arrayBuffer()`, yaitu satu ArrayBuffer
 * sebesar seluruh export. Artinya semua kerja streaming di sisi Rust —
 * `WavStreamWriter` yang memotong 4 MiB dan memakai ulang kapasitasnya — dibayar
 * ulang di boundary JS, dan pemakaian memori tetap tumbuh selurus panjang lagu.
 * Export 3 jam gagal bukan karena engine-nya, melainkan karena ArrayBuffer
 * tidak bisa sebesar itu.
 *
 * Dengan sink, `runExport` tidak pernah memegang lebih dari satu chunk: begitu
 * satu chunk diserahkan, ia sudah jadi urusan sink dan boleh dilupakan.
 *
 * Tiga implementasi, tiga tempat berbeda:
 *   - [`FileSystemSink`]  — langsung ke disk lewat File System Access. Jalur
 *                           yang membuat ukuran file tidak lagi dibatasi RAM.
 *   - [`BlobSink`]        — fallback untuk browser tanpa API itu (Firefox,
 *                           Safari) dan jalur yang dipakai tes. Di sini file
 *                           MEMANG ditahan; itu batas browsernya, bukan pilihan
 *                           kita.
 *   - [`PostMessageSink`] — di dalam worker: teruskan tiap chunk ke main thread
 *                           sebagai transferable, jangan tahan apa pun.
 */

/**
 * Urutan panggilan yang dijamin `runExport`:
 *
 *   header?  →  chunk*  →  patchHeader?  →  close
 *                    ↘  abort  (batal / gagal, kapan saja)
 *
 * `header` dan `patchHeader` hanya muncul untuk format yang butuh menimpa
 * bagian depan file setelah panjang total diketahui (WAV). Keduanya SELALU
 * sama panjang — itu syarat yang dijaga tes di `crates/export/src/tests.rs`.
 */
export interface ExportSink {
  /** Header placeholder, ditulis sebelum chunk pertama. */
  header(bytes: Uint8Array): Promise<void> | void;
  /** Satu chunk terenkode. Sesudah ini sink yang memilikinya. */
  chunk(bytes: Uint8Array): Promise<void> | void;
  /** Timpa header di posisi 0 dengan versi final. */
  patchHeader(bytes: Uint8Array): Promise<void> | void;
  /** Tutup dengan sukses. */
  close(): Promise<void> | void;
  /**
   * Batalkan. Kontraknya: JANGAN tinggalkan file separuh jadi yang terlihat
   * seperti export yang berhasil.
   */
  abort(reason?: unknown): Promise<void> | void;
}

/**
 * Buffer yang bisa di-*transfer*.
 *
 * Byte dari glue wasm-bindgen selalu `Uint8Array` yang memiliki buffer-nya
 * sendiri (glue sudah memanggil `.slice()`), jadi jalur cepatnya yang normal
 * terpakai. Cabang salinan ada untuk view yang hanya sebagian: mentransfer
 * buffer induknya akan ikut menarik data yang bukan milik chunk ini.
 */
export function toTransferable(bytes: Uint8Array): ArrayBuffer {
  const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return exact ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
}

/** Bentuk minimal `FileSystemWritableFileStream` yang kita pakai. */
interface Writable {
  write(data: Uint8Array | { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface WritableCapableHandle {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<Writable>;
}

/**
 * Tulis langsung ke berkas yang dipilih user.
 *
 * Ini satu-satunya jalur yang benar-benar melepas batas ukuran: byte turun ke
 * disk begitu di-encode dan tidak pernah menumpuk di heap. Browser menulisnya
 * ke swap file dan baru memindahkannya ke lokasi tujuan saat `close()`, jadi
 * `abort()` benar-benar tidak meninggalkan apa-apa.
 */
export class FileSystemSink implements ExportSink {
  private headerLen = 0;

  private constructor(private readonly writable: Writable) {}

  static async create(handle: FileSystemFileHandle): Promise<FileSystemSink> {
    const w = await (handle as unknown as WritableCapableHandle).createWritable();
    return new FileSystemSink(w);
  }

  async header(bytes: Uint8Array): Promise<void> {
    this.headerLen = bytes.byteLength;
    await this.writable.write(bytes);
  }

  async chunk(bytes: Uint8Array): Promise<void> {
    await this.writable.write(bytes);
  }

  /**
   * Menimpa di posisi 0 — INI yang dulu hilang.
   *
   * `engine-client.ts` menerima pesan `header` final lalu menaruhnya di
   * `parts[0]`, bahkan ketika tujuannya berkas di disk. Di jalur disk `parts`
   * tidak pernah dipakai, jadi header final tidak pernah sampai ke mana pun dan
   * file di disk selamanya memakai placeholder: panjang data 0, dan pemutar
   * yang patuh menolaknya sebagai file kosong.
   */
  async patchHeader(bytes: Uint8Array): Promise<void> {
    if (this.headerLen > 0 && bytes.byteLength !== this.headerLen) {
      throw new Error(
        `Header final ${bytes.byteLength} byte tidak sepanjang placeholder ` +
          `${this.headerLen} byte — menimpanya akan menggeser seluruh data.`,
      );
    }
    await this.writable.write({ type: 'write', position: 0, data: bytes });
  }

  async close(): Promise<void> {
    await this.writable.close();
  }

  /**
   * `abort()` membuang swap file; berkas tujuan tidak pernah tersentuh. Kalau
   * browser tidak menyediakannya, tidak ada pilihan selain `close()` — dan
   * kegagalannya pun ditelan, karena error DI SINI akan menutupi alasan
   * sebenarnya export berhenti.
   */
  async abort(reason?: unknown): Promise<void> {
    try {
      if (this.writable.abort) await this.writable.abort(reason);
      else await this.writable.close();
    } catch {
      /* penyebab aslinya sudah dalam perjalanan naik */
    }
  }
}

/**
 * Kumpulkan di memori. Fallback untuk browser tanpa File System Access, dan
 * jalur yang dipakai tes.
 *
 * Batasnya nyata dan tidak bisa kita hilangkan dari sini: seluruh file ada di
 * memori sampai selesai. `canStreamToDisk()` di `encoders/index.ts` yang
 * memutuskan kapan jalur ini terpakai.
 */
export class BlobSink implements ExportSink {
  private parts: Uint8Array[] = [];
  private hasHeader = false;
  private aborted = false;

  header(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.hasHeader = true;
  }

  chunk(bytes: Uint8Array): void {
    this.parts.push(bytes);
  }

  patchHeader(bytes: Uint8Array): void {
    if (this.hasHeader) this.parts[0] = bytes;
    else this.parts.unshift(bytes);
    this.hasHeader = true;
  }

  close(): void {
    /* tidak ada yang perlu ditutup */
  }

  abort(): void {
    this.aborted = true;
    // Buang isinya: file separuh jadi tidak boleh bisa diambil lewat `blob()`.
    this.parts = [];
  }

  blob(mime: string): Blob {
    if (this.aborted) throw new Error('Export dibatalkan — tidak ada Blob untuk diambil.');
    return new Blob(this.parts as BlobPart[], { type: mime });
  }

  /** Byte gabungan. Dipakai tes; jalur produksi memakai `blob()`. */
  bytes(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
}

/** Pesan yang dikirim [`PostMessageSink`] ke main thread. */
export type ExportChunkMessage =
  | { type: 'header'; buffer: ArrayBuffer }
  | { type: 'chunk'; buffer: ArrayBuffer }
  | { type: 'patch-header'; buffer: ArrayBuffer };

/**
 * Di dalam worker: teruskan tiap chunk ke main thread dan lupakan.
 *
 * Byte-nya di-*transfer*, bukan disalin — structured clone untuk ratusan MB
 * adalah biaya yang tidak perlu dibayar, dan yang lebih penting: transfer
 * berarti worker benar-benar melepasnya, bukan menyimpan salinan kedua.
 *
 * Sink ini tidak tahu apa yang terjadi di ujung sana. Main thread-lah yang
 * memilih menulisnya ke disk atau menumpuknya jadi Blob.
 */
export class PostMessageSink implements ExportSink {
  constructor(private readonly post: (msg: ExportChunkMessage, transfer: Transferable[]) => void) {}

  private send(type: ExportChunkMessage['type'], bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const buffer = toTransferable(bytes);
    this.post({ type, buffer } as ExportChunkMessage, [buffer]);
  }

  header(bytes: Uint8Array): void {
    this.send('header', bytes);
  }

  chunk(bytes: Uint8Array): void {
    this.send('chunk', bytes);
  }

  patchHeader(bytes: Uint8Array): void {
    this.send('patch-header', bytes);
  }

  close(): void {
    // Pesan `done` dikirim worker sendiri, sesudah `runExport` kembali.
  }

  abort(): void {
    // Pesan `cancelled`/`error` juga; sink tidak perlu mengirim apa pun.
  }
}
