/**
 * `ExportSink` — ke mana byte hasil encode pergi. Bagian dari KONTRAK host:
 * `PlatformHost.pickSaveTarget()` menjawab dengan salah satunya
 * (`SaveTarget.kind === 'stream'`), dan itulah sebabnya antarmukanya tinggal di
 * sini, bukan di engine. Platform tidak boleh mengimpor paket lain (docs/25
 * §1b), sedangkan engine boleh mengimpor tipe ini — jadi arah panahnya
 * `engine → platform`, dan hanya tipe.
 *
 * Implementasinya di tempat masing-masing: `FileSystemSink`, `BlobSink`,
 * `PostMessageSink` di `@kelasmalam/engine/export/sinks` (alasan lapisan ini
 * ada dijelaskan di kepala berkas itu); `TauriFileSink` di
 * `apps/desktop/src/platform/desktop.ts`.
 *
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
