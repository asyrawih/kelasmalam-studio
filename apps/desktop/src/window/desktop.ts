/**
 * JENDELA — judul, permintaan tutup, dan menu native (docs/20 fase D5).
 *
 * Sejak docs/25 P2 modul ini milik `apps/desktop` dan tidak lagi bertanya
 * `isTauri()`: app ini selalu berjalan di dalam jendela Tauri, jadi tidak ada
 * "ada jendela atau tidak" yang perlu dijawab. Aturan MURNI-nya — bentuk judul
 * (`windowTitle`) dan alasan penjaga tutup (`closeGuardReason`) — tinggal di
 * `@kelasmalam/shell/title`, dipakai juga oleh shell web untuk
 * `document.title` dan `beforeunload`. Yang ada di sini hanya pintu Tauri-nya.
 *
 * Adapter platform (`../platform/desktop.ts`, docs/20 §2c) mengurus berkas,
 * dialog, drop, dan model; modul ini mengurus JENDELA saja.
 *
 * ## Impor dinamis
 *
 * `@tauri-apps/api/window`, `/event`, dan `plugin-dialog` diimpor di dalam
 * fungsi — kebiasaan dari masa bundelnya masih dibagi dengan web — dan tetap
 * dipertahankan karena mocker vitest bekerja paling jujur dengan `import()`
 * yang dipanggil di dalam fungsi (lihat `tauriWindow()`).
 *
 * ## Menu native = pintu KETIGA ke registry
 *
 * Menu Rust (`src-tauri/src/menu.rs`) tidak tahu satu pun aksi. Ia
 * mengirim event `daw://menu-command` berisi id command, dan modul ini
 * menyerahkannya ke `runCommand` — fungsi yang SAMA dengan yang dipakai
 * keyboard dan palette. Tidak ada salinan daftar aksi (docs/15 "Menambah
 * pintu masuk berikutnya"). Daftar id yang boleh dipakai menu ada di
 * `menu-ids.ts`, dan tesnya memastikan tiap id itu benar-benar terdaftar.
 */

import { getCommand, runCommand } from '@kelasmalam/shell/command';
import { APP_TITLE, closeGuardReason, type CloseGuardReason } from '@kelasmalam/shell/title';

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

/** Sama untuk `@tauri-apps/api/event` — satu janji bersama, alasan yang sama. */
let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null;
function tauriEvent(): Promise<typeof import('@tauri-apps/api/event')> {
  eventApi ??= import('@tauri-apps/api/event');
  return eventApi;
}

/** Nama event yang dikirim menu native. Kontrak dengan `menu.rs` — jangan diubah sepihak. */
export const MENU_COMMAND_EVENT = 'daw://menu-command';

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
 *
 * Command yang TERDAFTAR tapi sedang tidak bisa dijalankan (Undo tanpa
 * riwayat, Berhenti saat sudah berhenti) diabaikan tanpa peringatan: menu
 * native tidak tahu keadaan `enabled` — item-nya selalu bisa diklik — jadi ini
 * keadaan normal, bukan kontrak yang putus.
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
  if (getCommand(id) !== undefined) return false;
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
      const { listen } = await tauriEvent();
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
