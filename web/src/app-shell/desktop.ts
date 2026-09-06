/**
 * RASA DESKTOP — satu-satunya tempat di app-shell yang tahu ia sedang berjalan
 * di dalam jendela Tauri (docs/20 fase D5).
 *
 * ## Kenapa satu modul kecil, bukan `if (isTauri())` yang tersebar
 *
 * Perbedaan web vs desktop harus masuk lewat satu pintu (docs/20 §0 butir 3).
 * Adapter platform yang sebenarnya (`web/src/platform/`, §2c) mengurus berkas,
 * login, dan model; modul ini mengurus JENDELA: judul, permintaan tutup, dan
 * menu native. Ketiganya tidak butuh adapter — mereka butuh tahu "ada jendela
 * atau tidak", dan itu dijawab `isTauri()`.
 *
 * ## Impor dinamis
 *
 * Hanya `isTauri` yang diimpor statis (beberapa byte). `@tauri-apps/api/window`,
 * `/event`, dan `plugin-dialog` diimpor di dalam cabang desktop supaya bundel
 * web — yang dipakai jauh lebih banyak orang — tidak membawa kode yang tidak
 * pernah bisa jalan di browser.
 *
 * ## Menu native = pintu KETIGA ke registry
 *
 * Menu Rust (`desktop/src-tauri/src/menu.rs`) tidak tahu satu pun aksi. Ia
 * mengirim event `daw://menu-command` berisi id command, dan modul ini
 * menyerahkannya ke `runCommand` — fungsi yang SAMA dengan yang dipakai
 * keyboard dan palette. Tidak ada salinan daftar aksi (docs/15 "Menambah
 * pintu masuk berikutnya"). Daftar id yang boleh dipakai menu ada di
 * `menu-ids.ts`, dan tesnya memastikan tiap id itu benar-benar terdaftar.
 */

import { isTauri } from '@tauri-apps/api/core';

import { runCommand } from './command';

/**
 * Modul jendela diimpor SEKALI dan janjinya disimpan.
 *
 * Judul dan penjaga tutup sama-sama membutuhkannya pada render pertama, dan
 * dua `import()` serentak untuk modul yang sama bukan cuma pemborosan: mocker
 * vitest tidak menangani impor dinamis ganda yang beriringan — yang kedua
 * lolos ke modul asli, dan modul asli meledak di luar Tauri. Satu janji
 * bersama menghapus kelas masalah itu di kedua tempat.
 */
let windowApi: Promise<typeof import('@tauri-apps/api/window')> | null = null;
function tauriWindow(): Promise<typeof import('@tauri-apps/api/window')> {
  windowApi ??= import('@tauri-apps/api/window');
  return windowApi;
}

/** Nama event yang dikirim menu native. Kontrak dengan `menu.rs` — jangan diubah sepihak. */
export const MENU_COMMAND_EVENT = 'daw://menu-command';

/** Nama aplikasi di judul jendela — sama dengan `<title>` di `index.html`. */
export const APP_TITLE = 'KELAS MALAM STUDIO';

/** True kalau berjalan di dalam WebView Tauri. Dibungkus supaya bisa di-mock di tes. */
export function isDesktop(): boolean {
  return isTauri();
}

/**
 * Judul jendela: `<project> — KELAS MALAM STUDIO`, dengan `•` di depan saat
 * ada perubahan belum disimpan.
 *
 * Titik di DEPAN mengikuti konvensi macOS (titik di tombol tutup / judul
 * dokumen), dan diletakkan di depan bukan belakang supaya tetap terlihat saat
 * judul panjang terpotong di tengah oleh OS. Aturan yang sama dipakai
 * `document.title` di web — tab browser yang bertanda sama bergunanya.
 */
export function windowTitle(projectName: string, dirty: boolean): string {
  const name = projectName.trim() === '' ? 'Tanpa nama' : projectName.trim();
  return `${dirty ? '• ' : ''}${name} — ${APP_TITLE}`;
}

// ── Menu native → registry ───────────────────────────────────────────────────

/**
 * Id yang sudah pernah diperingatkan. SEKALI per id, bukan tiap kali: menu
 * "Putar / jeda" yang ditekan di halaman Studio memang tidak punya penerima
 * (command DJ hanya hidup di `/dj`), dan itu keadaan sah — bukan bug yang perlu
 * membanjiri konsol, tapi juga bukan sesuatu yang boleh senyap total.
 */
const warned = new Set<string>();

/**
 * Terjemahkan satu payload menu menjadi `runCommand`.
 *
 * Mengembalikan `true` kalau command-nya jalan. Payload yang bentuknya salah
 * dan id yang tidak terdaftar sama-sama diabaikan dengan `console.warn` —
 * melempar di dalam handler event Tauri hanya menghasilkan unhandled rejection
 * yang tidak dilihat siapa pun.
 */
export function dispatchMenuCommand(payload: unknown): boolean {
  const id =
    typeof payload === 'object' && payload !== null && typeof (payload as { id?: unknown }).id === 'string'
      ? (payload as { id: string }).id
      : null;
  if (id === null) {
    console.warn('[desktop] payload menu tidak dikenali:', payload);
    return false;
  }
  if (runCommand(id)) return true;
  if (!warned.has(id)) {
    warned.add(id);
    console.warn(`[desktop] command menu "${id}" tidak terdaftar di halaman ini — diabaikan`);
  }
  return false;
}

/** Hanya untuk tes: supaya tiap tes mulai dari "belum pernah memperingatkan". */
export function __resetMenuWarningsForTest(): void {
  warned.clear();
}

/**
 * Pasang listener `daw://menu-command`. Kembaliannya melepas listener.
 *
 * Pelepasan menunggu pemasangan selesai: `listen` asinkron, dan komponen bisa
 * unmount sebelum janjinya selesai (StrictMode melakukannya dengan sengaja).
 * Tanpa menunggu, listener yang terlambat terpasang tidak pernah dilepas.
 */
export function listenMenuCommands(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen<unknown>(MENU_COMMAND_EVENT, (e) => {
        dispatchMenuCommand(e.payload);
      });
      if (disposed) stop();
      else unlisten = stop;
    } catch (err: unknown) {
      console.warn('[desktop] gagal memasang listener menu:', err);
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

// ── Judul jendela ────────────────────────────────────────────────────────────

/**
 * `document.title` TIDAK mengubah judul jendela Tauri — WebView tidak
 * meneruskannya — jadi keduanya diatur terpisah. Kegagalan dicatat, bukan
 * dilempar: judul yang tidak terpasang bukan alasan menghentikan aplikasi.
 */
export async function setWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await tauriWindow();
    await getCurrentWindow().setTitle(title);
  } catch (err: unknown) {
    console.warn('[desktop] gagal mengatur judul jendela:', err);
  }
}

// ── Konfirmasi tutup ─────────────────────────────────────────────────────────

export type CloseGuardReason = 'export' | 'dirty';

/**
 * Kenapa penutupan harus ditanya dulu — atau `null` kalau boleh langsung.
 *
 * Export didahulukan: berkas yang terpotong di tengah lebih mahal daripada
 * edit yang hilang, dan pesannya harus menyebut itu, bukan "belum disimpan".
 */
export function closeGuardReason(s: {
  readonly exportProgress: number | null;
  readonly dirty: boolean;
}): CloseGuardReason | null {
  if (s.exportProgress !== null) return 'export';
  if (s.dirty) return 'dirty';
  return null;
}

const CLOSE_MESSAGE: Readonly<Record<CloseGuardReason, string>> = {
  export: 'Export sedang berjalan. Menutup sekarang meninggalkan berkas yang tidak lengkap. Tutup?',
  dirty: 'Ada perubahan yang belum disimpan ke kepustakaan. Tutup tanpa menyimpan?',
};

/**
 * Tanya user lewat dialog NATIVE (`plugin-dialog.ask`), bukan `window.confirm`.
 *
 * Bukan soal tampilan. `confirm()` memblokir thread WebView secara sinkron,
 * sedangkan handler `onCloseRequested` Tauri berjalan asinkron dan menunggu
 * janji handler-nya sebelum memutuskan menghancurkan jendela — dialog sinkron
 * di tengah alur asinkron itu berperilaku berbeda di WKWebView dan WebView2,
 * dan di WKWebView `confirm()` bergantung pada delegate yang tidak dijanjikan.
 * `ask` memakai dialog OS dan mengembalikan janji, persis bentuk yang
 * dibutuhkan handler-nya.
 */
export async function confirmClose(reason: CloseGuardReason): Promise<boolean> {
  try {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return await ask(CLOSE_MESSAGE[reason], {
      title: APP_TITLE,
      kind: 'warning',
      okLabel: 'Tutup',
      cancelLabel: 'Batal',
    });
  } catch (err: unknown) {
    // Dialog yang tidak bisa dibuka TIDAK boleh mengurung user di dalam
    // aplikasi: kalau tidak bisa bertanya, izinkan tutup — itu yang akan
    // terjadi kalau penjaga ini tidak ada sama sekali.
    console.warn('[desktop] dialog konfirmasi gagal, jendela ditutup:', err);
    return true;
  }
}

/**
 * Pasang penjaga tutup jendela. `state()` dibaca SAAT permintaan datang, bukan
 * saat pemasangan — kalau tidak, penjaga selalu melihat project seperti saat
 * aplikasi baru dibuka.
 *
 * Alurnya mengikuti kontrak `onCloseRequested` Tauri: handler dipanggil, dan
 * jendela dihancurkan hanya kalau handler TIDAK memanggil `preventDefault`.
 * Jadi: cegah dulu, tanya, lalu hancurkan sendiri kalau user setuju. Tidak ada
 * jalan untuk "cegah sementara sambil menunggu jawaban".
 */
export function guardWindowClose(
  state: () => { readonly exportProgress: number | null; readonly dirty: boolean },
): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void (async () => {
    try {
      const { getCurrentWindow } = await tauriWindow();
      const win = getCurrentWindow();
      const stop = await win.onCloseRequested(async (event) => {
        const reason = closeGuardReason(state());
        if (reason === null) return;
        event.preventDefault();
        if (await confirmClose(reason)) await win.destroy();
      });
      if (disposed) stop();
      else unlisten = stop;
    } catch (err: unknown) {
      console.warn('[desktop] gagal memasang penjaga tutup jendela:', err);
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
