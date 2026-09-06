/**
 * APP SHELL — kerangka yang memiliki routing, keyboard, dan command.
 *
 * ## Apa yang dimiliki shell, dan kenapa
 *
 * Sebelum ini, routing ada di `Root.tsx` dan keyboard tersebar sebagai listener
 * `window` di tiap halaman. Keduanya bekerja, tapi keduanya juga berarti tidak
 * ada satu pun tempat yang bisa menjawab dua pertanyaan yang akan terus
 * ditanyakan: **"apa yang bisa dilakukan sekarang"** dan **"tombol ini milik
 * siapa"**.
 *
 * Shell menjawab keduanya dengan satu registry dan satu dispatcher. Itu yang
 * membuat pintu masuk BERIKUTNYA — command palette (sudah ada), MIDI controller,
 * macro, remote — jadi satu penerjemah kecil ke id command, bukan satu salinan
 * daftar aksi yang harus dijaga tetap sama selamanya.
 *
 * ## Halaman berat tidak dirender saat tidak dibuka
 *
 * Bukan sekadar hemat render: `App` memasang interval playhead, autosave, dan
 * mencoba membangun `AudioContext` begitu ia mount; `DjPage` memasang jam audio
 * dan autosave sesinya sendiri. Keduanya tidak boleh jalan di halaman lain.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { App } from '../App';
import { DjPage } from '../dj';
import { LandingPage, LegalPage } from '../landing';
import { createLibraryApi, normalizeBase } from '../library/api';
import { libraryActions, useLibrary } from '../library/store';
import type { LibraryUser } from '../library/model';
import { getPlatformHost } from '../platform';
import { RobloxRoute } from '../roblox';
import { ProofStemPage } from '../proof-stem';
import { selectProjectDirty, studioStore, useStudio } from '../studio/store';
import { Button } from '../ui/cyber';
import { CommandPalette } from './CommandPalette';
import { KeymapEditor } from './KeymapEditor';
import {
  closeGuardReason,
  guardWindowClose,
  isDesktop,
  listenMenuCommands,
  setWindowTitle,
  windowTitle,
} from './desktop';
import { useCommands } from './useCommands';
import { useKeyDispatch } from './useKeyDispatch';
import { DJ_PATH, HOME_PATH, PROOF_STEM_PATH, ROBLOX_PATH, STUDIO_PATH, routeOf, type Route } from './routes';

export interface AppShellProps {
  readonly createEngine?: () => Promise<unknown>;
  /** Ditimpa di tes; produksi memakai `VITE_LIBRARY_API`. */
  readonly authApi?: AuthApi;
}

export interface AuthApi {
  me(): Promise<LibraryUser | null>;
  /**
   * Tidak dipakai shell: URL login dibangun `PlatformHost.login()` dari
   * `base`, karena ke mana dan bagaimana login berjalan adalah urusan platform
   * (web: navigasi; desktop: belum ada). Tetap di kontrak supaya `LibraryApi`
   * dan mock yang sudah ada memenuhinya apa adanya.
   */
  loginUrl(nextPath: string): string;
  /** Base URL Worker kepustakaan. Opsional hanya untuk mock lama di tes. */
  readonly base?: string;
}

const PROTECTED_ROUTES: ReadonlySet<Route> = new Set(['studio', 'dj', 'roblox']);

export function AppShell({ createEngine, authApi: injectedAuthApi }: AppShellProps): JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));
  const [palette, setPalette] = useState(false);
  const [keymap, setKeymap] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  // Naik tiap kali user minta cek sesi diulang. Di web muat ulang halaman
  // juga bisa, tapi di Tauri shell tidak pernah memuat ulang (docs/20 §2b) —
  // jadi jalur pulihnya harus ada di dalam aplikasi.
  const [authAttempt, setAuthAttempt] = useState(0);
  const authStatus = useLibrary((s) => s.status);
  const apiBase = (import.meta.env.VITE_LIBRARY_API ?? '').trim();
  const authApi = useMemo<AuthApi | null>(
    () => injectedAuthApi ?? (apiBase === '' ? null : createLibraryApi(apiBase)),
    [apiBase, injectedAuthApi],
  );
  // Development lokal sengaja melewati login supaya Studio, DJ, dan integrasi
  // backend bisa diuji tanpa sesi OAuth. Production tetap terkunci. Saat API
  // disuntikkan di tes, guard tetap aktif agar perilakunya bisa diverifikasi
  // tanpa jaringan sungguhan.
  //
  // DESKTOP TANPA LOGIN (keputusan produk, untuk sekarang): di jendela Tauri
  // gerbang ini dilewati seluruhnya. Alasannya bukan cuma "belum ada jalur
  // login desktop" (docs/20 §1d): cookie sesi tidak pernah ikut dari origin
  // `tauri://`, jadi `me()` selalu menjawab anonim dan seluruh .app terkunci
  // di balik gerbang login yang di desktop tidak punya tombol MASUK sama sekali
  // (host desktop tidak mendefinisikan `login`, lihat `canLogin`). Kepustakaan
  // tetap tidak tersedia di desktop sampai D3; halaman-halamannya sendiri
  // bekerja penuh tanpanya.
  const desktop = isDesktop();
  const authRequired = !desktop && (!import.meta.env.DEV || injectedAuthApi !== undefined);

  // Login lewat adapter platform, bukan `location.href` (docs/20 §2c): dari
  // WebView Tauri navigasi ke Google tidak pernah kembali, dan `guard.test.ts`
  // menjaga tidak ada jalan keluar dari WebView di luar `platform/`. `login`
  // OPSIONAL di host, dan ketiadaannya berarti sesuatu — platform ini tidak
  // punya cara membangun sesi — jadi tombol MASUK disembunyikan, bukan
  // dipasang lalu diam.
  const canLogin = getPlatformHost().login !== undefined;
  const startLogin = useCallback(
    (nextPath: string): void => {
      if (authApi === null) return;
      void getPlatformHost().login?.({ apiBase: authApi.base ?? normalizeBase(apiBase), nextPath });
    },
    [apiBase, authApi],
  );

  useEffect(() => {
    if (!authRequired) return undefined;
    if (authApi === null) {
      setAuthenticated(false);
      libraryActions.setStatus('tidak-dikonfigurasi');
      return undefined;
    }

    let alive = true;
    libraryActions.setStatus('memeriksa');
    void authApi
      .me()
      .then((user) => {
        if (!alive) return;
        if (user === null) {
          setAuthenticated(false);
          libraryActions.setStatus('anonim');
        } else {
          setAuthenticated(true);
          libraryActions.setStatus('masuk', user);
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          setAuthenticated(false);
          libraryActions.fail(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, [authApi, authRequired, authAttempt]);

  // Logout dari dock kepustakaan juga harus langsung menutup halaman aktif.
  // Status `memeriksa` sengaja tidak membatalkan akses: dock melakukan cek
  // ulang saat Studio mount, sesudah shell sendiri sudah memverifikasi sesi.
  useEffect(() => {
    if (authStatus === 'anonim') setAuthenticated(false);
  }, [authStatus]);

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
   * Command milik shell sendiri — berlaku di halaman mana pun.
   *
   * Sengaja SEDIKIT: shell tidak tahu apa-apa tentang audio atau timeline, dan
   * yang pantas ia miliki hanyalah navigasi dan pintu ke registry itu sendiri.
   */
  useCommands(
    [
      {
        id: 'shell.goto.proof-stem',
        title: 'Buka proof stem',
        group: 'Aplikasi',
        defaultChord: null,
        run: () => navigate(PROOF_STEM_PATH),
      },
      {
        id: 'shell.palette',
        title: 'Buka daftar perintah',
        group: 'Aplikasi',
        defaultChord: 'mod+KeyK',
        run: () => setPalette((v) => !v),
      },
      {
        id: 'shell.keymap',
        title: 'Pintasan keyboard',
        group: 'Aplikasi',
        /*
         * `/` DAN `?` keduanya membuka daftar ini.
         *
         * Keduanya sama-sama diraih orang, dan yang TIDAK terikat akan bocor ke
         * browser: `/` membuka Quick Find di Firefox. Mengikat cuma salah
         * satunya berarti separuh percobaan berakhir di kotak pencarian browser
         * alih-alih di daftar pintasan.
         */
        defaultChord: 'Slash',
        defaultAliases: ['shift+Slash'],
        run: () => setKeymap((v) => !v),
      },
      {
        id: 'shell.preferences',
        title: 'Pengaturan…',
        group: 'Aplikasi',
        /*
         * `⌘,` adalah konvensi OS untuk "Pengaturan…" (macOS), dan menu native
         * desktop butuh id sendiri untuk item itu — bukan alias dari `?`, karena
         * alias dilepas begitu user mengikat chord-nya sendiri, sedangkan item
         * menu harus tetap punya sasaran. Satu-satunya layar pengaturan hari ini
         * adalah editor pintasan, jadi ke sanalah ia membuka.
         */
        defaultChord: 'mod+Comma',
        run: () => setKeymap(true),
      },
      {
        id: 'shell.goto.dj',
        title: 'Buka mixer DJ',
        group: 'Aplikasi',
        defaultChord: null,
        run: () => navigate(DJ_PATH),
      },
      {
        id: 'shell.goto.studio',
        title: 'Buka Studio',
        group: 'Aplikasi',
        defaultChord: null,
        run: () => navigate(STUDIO_PATH),
      },
      {
        id: 'shell.goto.roblox',
        title: 'Buka unggah Roblox',
        group: 'Aplikasi',
        defaultChord: null,
        run: () => navigate(ROBLOX_PATH),
      },
      {
        id: 'shell.goto.home',
        title: 'Kembali ke beranda',
        group: 'Aplikasi',
        defaultChord: null,
        run: () => navigate(HOME_PATH),
      },
    ],
    [navigate],
  );

  // Dispatcher dimatikan saat editor keymap sedang MENANGKAP tombol: chord yang
  // ditangkap tidak boleh sekaligus menjalankan command yang sudah memilikinya,
  // kalau tidak tombol yang sudah terpakai mustahil direbut.
  useKeyDispatch({ suspended: capturing });

  // ── Rasa desktop (docs/20 fase D5) ──
  //
  // Judul dokumen mengikuti nama project + tanda kotor, di web DAN desktop.
  // `document.title` tidak sampai ke judul jendela Tauri, jadi keduanya diatur;
  // yang desktop hanya saat `isDesktop()` supaya web tidak menyentuh API Tauri.
  const projectName = useStudio((s) => s.projectName);
  const dirty = useStudio(selectProjectDirty);
  useEffect(() => {
    const title = windowTitle(projectName, dirty);
    document.title = title;
    if (isDesktop()) void setWindowTitle(title);
  }, [projectName, dirty]);

  // Menu native adalah pintu ketiga ke registry: satu listener, satu
  // penerjemah (`dispatchMenuCommand`), tanpa salinan daftar aksi.
  useEffect(() => {
    if (!isDesktop()) return undefined;
    return listenMenuCommands();
  }, []);

  // Penjaga tutup: export yang sedang jalan atau project kotor → tanya dulu.
  // Desktop lewat `onCloseRequested` (dialog native, jendela dihancurkan
  // hanya kalau user setuju); web lewat `beforeunload` (browser yang bertanya,
  // dengan kalimatnya sendiri). Satu aturan (`closeGuardReason`), dua pintu.
  useEffect(() => {
    const snapshot = (): { exportProgress: number | null; dirty: boolean } => {
      const s = studioStore.getState();
      return { exportProgress: s.exportProgress, dirty: selectProjectDirty(s) };
    };
    if (isDesktop()) return guardWindowClose(snapshot);
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (closeGuardReason(snapshot()) === null) return;
      e.preventDefault();
      // Chrome lama masih membutuhkan `returnValue` untuk memunculkan dialog.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Esc menutup overlay. Tidak lewat registry: ini perilaku dialog, bukan
  // perintah aplikasi, dan mengikatnya ke command berarti user bisa melepasnya
  // lalu terkurung di dalam overlay.
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

  const protectedRoute = PROTECTED_ROUTES.has(route);
  const blocked = authRequired && protectedRoute && !authenticated;

  return (
    <>
      {blocked ? (
        <AuthGuard
          status={authStatus}
          api={authApi}
          onLogin={canLogin ? () => startLogin(window.location.pathname) : null}
          onRetry={() => setAuthAttempt((n) => n + 1)}
        />
      ) : route === 'studio' ? (
        <App
          createEngine={createEngine}
          onClose={() => navigate(HOME_PATH)}
          onOpenDj={() => navigate(DJ_PATH)}
          onOpenRoblox={() => navigate(ROBLOX_PATH)}
        />
      ) : route === 'dj' ? (
        <DjPage onClose={() => navigate(HOME_PATH)} />
      ) : route === 'roblox' ? (
        <RobloxRoute
          onClose={() => navigate(HOME_PATH)}
          onOpenStudio={() => navigate(STUDIO_PATH)}
        />
      ) : route === 'proof-stem' ? (
        <ProofStemPage onClose={() => navigate(HOME_PATH)} />
      ) : route === 'privacy-policy' || route === 'terms-of-service' ? (
        <LegalPage kind={route} />
      ) : (
        <LandingPage
          onOpenStudio={() => navigate(STUDIO_PATH)}
          onOpenDj={() => navigate(DJ_PATH)}
          onOpenRoblox={() => navigate(ROBLOX_PATH)}
          showAppLinks={!authRequired || authenticated}
          // Tanpa `login` di host (desktop hari ini) tidak ada tombol MASUK
          // sama sekali: tautan aplikasi sudah terbuka (`showAppLinks`), dan
          // tombol yang tidak bisa berbuat apa-apa lebih buruk daripada tidak ada.
          onLogin={
            !canLogin
              ? undefined
              : authApi === null
                ? () => navigate(STUDIO_PATH)
                : () => startLogin(STUDIO_PATH)
          }
        />
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <KeymapEditor
        open={keymap}
        onClose={() => setKeymap(false)}
        onCaptureChange={setCapturing}
      />
    </>
  );
}

function AuthGuard({
  status,
  api,
  onLogin,
  onRetry,
}: {
  readonly status: string;
  readonly api: AuthApi | null;
  /** `null` = platform ini tidak punya jalur login; tombolnya tidak dirender. */
  readonly onLogin: (() => void) | null;
  readonly onRetry: () => void;
}): JSX.Element {
  const checking = status === 'memeriksa';
  const failed = status === 'gagal';
  const missing = status === 'tidak-dikonfigurasi' || api === null;

  return (
    <main
      data-testid="auth-guard"
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background: 'var(--cy-bg)',
      }}
    >
      <section
        aria-busy={checking}
        style={{
          width: 'min(460px, 100%)',
          padding: '32px',
          border: '1px solid var(--cy-border-strong)',
          background: 'var(--cy-surface-1)',
          boxShadow: '0 18px 60px #0008',
          textAlign: 'center',
        }}
      >
        <div style={{ color: 'var(--cy-accent)', fontSize: '11px', letterSpacing: '.24em' }}>
          DAWONWEB // AKSES TERBATAS
        </div>
        <h1 style={{ margin: '18px 0 10px', fontSize: '24px', letterSpacing: '.06em' }}>
          {checking ? 'MEMERIKSA SESI…' : failed ? 'SESI TIDAK BISA DIPERIKSA' : 'LOGIN DIPERLUKAN'}
        </h1>
        <p style={{ margin: '0 auto 24px', color: 'var(--cy-text-muted)', lineHeight: 1.7 }}>
          {missing
            ? 'Google OAuth belum dikonfigurasi untuk build ini.'
            : failed
              ? 'Server autentikasi sedang tidak dapat dijangkau.'
              : checking
                ? 'Tunggu sebentar, sesi Google kamu sedang diverifikasi.'
                : 'Masuk dengan akun Google untuk membuka Studio, DJ, dan Roblox.'}
        </p>
        {!checking && !failed && !missing && onLogin !== null ? (
          <Button onClick={onLogin}>MASUK DENGAN GOOGLE</Button>
        ) : null}
        {failed ? (
          // Ulangi cek sesi DI DALAM aplikasi. "Muat ulang halaman" bukan
          // nasihat yang bisa diikuti di jendela Tauri (docs/20 §2b).
          <Button onClick={onRetry}>COBA LAGI</Button>
        ) : null}
        <div style={{ marginTop: '18px' }}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              window.history.pushState(null, '', HOME_PATH);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
          >
            KEMBALI KE BERANDA
          </Button>
        </div>
      </section>
    </main>
  );
}
