/**
 * APP SHELL DESKTOP — kerangka yang memiliki routing, keyboard, command, dan
 * JENDELA (docs/25 P2; alasan registry/dispatcher di kepala
 * `apps/web/src/app-shell/AppShell.tsx`, tidak diulang di sini).
 *
 * Bedanya dengan shell web bukan sekumpulan `if (isDesktop())` — itu persis
 * yang dibuang P2 — melainkan komposisi yang berbeda:
 *
 *   - Tabel route sendiri (`./routes`): tanpa landing, tanpa halaman legal;
 *     `/` = Studio.
 *   - TANPA gerbang login dan tanpa `AuthApi`: cookie sesi tidak pernah ikut
 *     dari origin `tauri://` (docs/20 §1d), kepustakaannya lokal (docs/21),
 *     jadi tidak ada MASUK/KELUAR untuk dijaga.
 *   - Judul JENDELA Tauri (`document.title` tidak sampai ke sana), menu
 *     native sebagai pintu ketiga ke registry, dan penjaga tutup lewat
 *     `onCloseRequested` dengan dialog native — semuanya dari `../window`.
 *   - Halaman Studio menerima `extras`: tombol YOUTUBE + dialognya (docs/23).
 *   - `KeymapEditor` diberi `<StoreSettings/>` (folder kepustakaan lokal).
 *
 * Halaman-halamannya sendiri masih dari `@app-web/*` (TODO(P3)): yang
 * berbeda antara dua app hanya kerangkanya.
 */

import { useCallback, useEffect, useState } from 'react';

import { App } from '@app-web/App'; // TODO(P3)
import { KeymapEditor } from '@app-web/app-shell/KeymapEditor'; // TODO(P3)
import { DjPage } from '@app-web/dj'; // TODO(P3)
import { ProofStemPage } from '@app-web/proof-stem'; // TODO(P3)
import { RobloxRoute } from '@app-web/roblox'; // TODO(P3)
import { selectProjectDirty, studioStore, useStudio } from '@app-web/studio/store'; // TODO(P3)
import { CommandPalette } from '@kelasmalam/shell/CommandPalette';
import { windowTitle } from '@kelasmalam/shell/title';
import { useCommands } from '@kelasmalam/shell/useCommands';
import { useKeyDispatch } from '@kelasmalam/shell/useKeyDispatch';
import { StoreSettings } from '../library-local/StoreSettings';
import { guardWindowClose, listenMenuCommands, setWindowTitle } from '../window/desktop';
import { YouTubeDialog } from '../youtube/YouTubeDialog';
import { DJ_PATH, HOME_PATH, PROOF_STEM_PATH, ROBLOX_PATH, STUDIO_PATH, routeOf, type Route } from './routes';

export interface AppShellProps {
  readonly createEngine?: () => Promise<unknown>;
}

export function AppShell({ createEngine }: AppShellProps): JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));
  const [palette, setPalette] = useState(false);
  const [keymap, setKeymap] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  // Stabil: dialog memakainya di efek/ref — closure baru tiap render tidak
  // boleh berarti pemeriksaan perkakas (proses yt-dlp) ulang.
  const closeYoutube = useCallback(() => setYoutubeOpen(false), []);

  useEffect(() => {
    const onPopState = (): void => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((path: string): void => {
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setRoute(routeOf(path));
    window.scrollTo(0, 0);
  }, []);

  /**
   * Command milik shell — id yang SAMA dengan shell web, karena menu native
   * (`menu.rs`) dan `window/menu-ids.ts` menyasar id ini. `shell.goto.home`
   * tetap ada: di desktop "beranda" adalah Studio.
   */
  useCommands(
    [
      { id: 'shell.goto.proof-stem', title: 'Buka proof stem', group: 'Aplikasi', defaultChord: null, run: () => navigate(PROOF_STEM_PATH) },
      { id: 'shell.palette', title: 'Buka daftar perintah', group: 'Aplikasi', defaultChord: 'mod+KeyK', run: () => setPalette((v) => !v) },
      {
        id: 'shell.keymap',
        title: 'Pintasan keyboard',
        group: 'Aplikasi',
        // `/` DAN `?` — alasannya di shell web; di WebView pun `/` yang tidak
        // terikat jatuh ke pencarian halaman WKWebView.
        defaultChord: 'Slash',
        defaultAliases: ['shift+Slash'],
        run: () => setKeymap((v) => !v),
      },
      // `⌘,` konvensi OS untuk "Pengaturan…"; item menu native butuh id sendiri.
      { id: 'shell.preferences', title: 'Pengaturan…', group: 'Aplikasi', defaultChord: 'mod+Comma', run: () => setKeymap(true) },
      { id: 'shell.goto.dj', title: 'Buka mixer DJ', group: 'Aplikasi', defaultChord: null, run: () => navigate(DJ_PATH) },
      { id: 'shell.goto.studio', title: 'Buka Studio', group: 'Aplikasi', defaultChord: null, run: () => navigate(STUDIO_PATH) },
      { id: 'shell.goto.roblox', title: 'Buka unggah Roblox', group: 'Aplikasi', defaultChord: null, run: () => navigate(ROBLOX_PATH) },
      { id: 'shell.goto.home', title: 'Kembali ke beranda', group: 'Aplikasi', defaultChord: null, run: () => navigate(HOME_PATH) },
    ],
    [navigate],
  );

  // Dispatcher dimatikan saat editor keymap sedang MENANGKAP tombol.
  useKeyDispatch({ suspended: capturing });

  // ── Jendela (docs/20 D5) ──
  //
  // `document.title` tetap diatur (WebView menampilkannya di inspector, dan
  // aturannya satu), tapi judul jendela Tauri harus diatur terpisah.
  const projectName = useStudio((s) => s.projectName);
  const dirty = useStudio(selectProjectDirty);
  useEffect(() => {
    const title = windowTitle(projectName, dirty);
    document.title = title;
    void setWindowTitle(title);
  }, [projectName, dirty]);

  // Menu native = pintu ketiga ke registry: satu listener, satu penerjemah.
  useEffect(() => listenMenuCommands(), []);

  // Penjaga tutup lewat `onCloseRequested`: dialog native, jendela dihancurkan
  // hanya kalau user setuju. Tidak ada `beforeunload` di sini — satu penjaga
  // per platform.
  useEffect(
    () =>
      guardWindowClose(() => {
        const s = studioStore.getState();
        return { exportProgress: s.exportProgress, dirty: selectProjectDirty(s) };
      }),
    [],
  );

  // Esc menutup overlay — perilaku dialog, bukan perintah aplikasi.
  useEffect(() => {
    if (!palette && !keymap) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setPalette(false);
      setKeymap(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, keymap]);

  return (
    <>
      {route === 'dj' ? (
        <DjPage onClose={() => navigate(STUDIO_PATH)} />
      ) : route === 'roblox' ? (
        <RobloxRoute onClose={() => navigate(STUDIO_PATH)} onOpenStudio={() => navigate(STUDIO_PATH)} />
      ) : route === 'proof-stem' ? (
        <ProofStemPage onClose={() => navigate(STUDIO_PATH)} />
      ) : (
        <App
          createEngine={createEngine}
          onOpenDj={() => navigate(DJ_PATH)}
          onOpenRoblox={() => navigate(ROBLOX_PATH)}
          extras={{
            // Impor YouTube HANYA di desktop (docs/23): yt-dlp dijalankan Rust.
            importActions: [{ id: 'youtube', label: 'YOUTUBE', run: () => setYoutubeOpen(true) }],
            dialogs: youtubeOpen ? <YouTubeDialog onClose={closeYoutube} /> : null,
          }}
        />
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <KeymapEditor
        open={keymap}
        onClose={() => setKeymap(false)}
        onCaptureChange={setCapturing}
        storeSettings={<StoreSettings />}
      />
    </>
  );
}
