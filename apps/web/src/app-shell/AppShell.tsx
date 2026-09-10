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
 *
 * ## Ini shell WEB (docs/25 P2)
 *
 * Tidak ada `isDesktop()` di sini lagi. Judul jendela Tauri, menu native, dan
 * penjaga tutup lewat `onCloseRequested` hidup di
 * `apps/desktop/src/app-shell/AppShell.tsx` + `window/`, yang punya tabel
 * route dan gerbangnya sendiri. Yang tersisa di sini murni web: gerbang login,
 * `document.title`, dan `beforeunload`.
 *
 * ## Halaman adalah paket; yang MENYUSUNNYA adalah shell ini (docs/25 P3)
 *
 * `StudioPage` tidak tahu kepustakaan maupun SoundCloud: dok kepustakaan
 * (`<LibraryDock/>`) dan tombol + dialog SoundCloud disuntik dari sini lewat
 * `dock` dan `extras`, begitu juga tombol SPLIT (docs/26 P5, digerbangi
 * kapabilitas). Desktop menyusun yang sama plus YouTube.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { LandingPage, LegalPage } from '../landing';
import { getPlatformHost } from '../platform';
import { DjPage } from '@kelasmalam/dj/dj';
import { LibraryDock, createLibraryApi, libraryActions, normalizeBase, useLibrary, type LibraryUser } from '@kelasmalam/library/library';
import { ProofStemPage } from '@kelasmalam/proof-stem/proof-stem';
import { RobloxRoute } from '@kelasmalam/roblox/roblox';
import { useSoundCloudImport } from '@kelasmalam/soundcloud/soundcloud/studio-import';
import { StudioPage } from '@kelasmalam/studio/StudioPage';
import { selectProjectDirty, studioStore, useStudio } from '@kelasmalam/studio/studio/store';
import { Button } from '@kelasmalam/ui/cyber';
import { CommandPalette } from '@kelasmalam/shell/CommandPalette';
import { KeymapEditor } from '@kelasmalam/shell/KeymapEditor';
import { closeGuardReason, windowTitle } from '@kelasmalam/shell/title';
import { useCommands } from '@kelasmalam/shell/useCommands';
import { useKeyDispatch } from '@kelasmalam/shell/useKeyDispatch';
import { vocalSplitToolbarActions } from '../vocal-split/register';
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
  const soundCloud = useSoundCloudImport();
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
  // Desktop tidak punya gerbang ini sama sekali — bukan dilewati lewat `if`,
  // melainkan tidak ada di shell-nya (docs/25 P2; alasan produknya di
  // docs/20 §1d: cookie sesi tidak pernah ikut dari origin `tauri://`).
  const authRequired = !import.meta.env.DEV || injectedAuthApi !== undefined;

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

  // Judul dokumen mengikuti nama project + tanda kotor — aturan yang sama
  // dengan judul jendela desktop (`@kelasmalam/shell/title`), tab browser yang
  // bertanda sama bergunanya.
  const projectName = useStudio((s) => s.projectName);
  const dirty = useStudio(selectProjectDirty);
  useEffect(() => {
    document.title = windowTitle(projectName, dirty);
  }, [projectName, dirty]);

  // Penjaga tutup: export yang sedang jalan atau project kotor → tanya dulu.
  // Web lewat `beforeunload` (browser yang bertanya, dengan kalimatnya
  // sendiri); desktop lewat `onCloseRequested` di shell-nya sendiri. Satu
  // aturan (`closeGuardReason`), dua pintu.
  useEffect(() => {
    const snapshot = (): { exportProgress: number | null; dirty: boolean } => {
      const s = studioStore.getState();
      return { exportProgress: s.exportProgress, dirty: selectProjectDirty(s) };
    };
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
        <StudioPage
          createEngine={createEngine}
          onClose={() => navigate(HOME_PATH)}
          onOpenDj={() => navigate(DJ_PATH)}
          onOpenRoblox={() => navigate(ROBLOX_PATH)}
          dock={<LibraryDock />}
          extras={{
            importActions: [soundCloud.action],
            dialogs: soundCloud.dialog,
            // SPLIT (vocal split MDX-Net, docs/26 P5) lewat worker WASM;
            // digerbangi caps + bukan iOS di `vocal-split/register.tsx`.
            toolbarActions: vocalSplitToolbarActions(),
          }}
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
          // Tanpa `login` di host tidak ada tombol MASUK sama sekali: tautan
          // aplikasi sudah terbuka (`showAppLinks`), dan tombol yang tidak
          // bisa berbuat apa-apa lebih buruk daripada tidak ada.
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
