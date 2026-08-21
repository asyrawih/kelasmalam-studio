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
import { LandingPage } from '../landing';
import { createLibraryApi } from '../library/api';
import { libraryActions, useLibrary } from '../library/store';
import type { LibraryUser } from '../library/model';
import { RobloxRoute } from '../roblox';
import { ProofStemPage } from '../proof-stem';
import { Button } from '../ui/cyber';
import { CommandPalette } from './CommandPalette';
import { KeymapEditor } from './KeymapEditor';
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
  loginUrl(nextPath: string): string;
}

const PROTECTED_ROUTES: ReadonlySet<Route> = new Set(['studio', 'dj', 'roblox']);

export function AppShell({ createEngine, authApi: injectedAuthApi }: AppShellProps): JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));
  const [palette, setPalette] = useState(false);
  const [keymap, setKeymap] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const authStatus = useLibrary((s) => s.status);
  const apiBase = (import.meta.env.VITE_LIBRARY_API ?? '').trim();
  const authApi = useMemo<AuthApi | null>(
    () => injectedAuthApi ?? (apiBase === '' ? null : createLibraryApi(apiBase)),
    [apiBase, injectedAuthApi],
  );
  // Tes shell lama memang menguji audio/routing secara terisolasi. Saat API
  // disuntikkan, guard tetap aktif agar perilakunya bisa dites tanpa jaringan.
  const authRequired = import.meta.env.MODE !== 'test' || injectedAuthApi !== undefined;

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
  }, [authApi, authRequired]);

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
        <AuthGuard status={authStatus} api={authApi} />
      ) : route === 'studio' ? (
        <App
          createEngine={createEngine}
          onClose={() => navigate(HOME_PATH)}
          onOpenDj={() => navigate(DJ_PATH)}
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
      ) : (
        <LandingPage
          onOpenStudio={() => navigate(STUDIO_PATH)}
          onOpenDj={() => navigate(DJ_PATH)}
          onOpenRoblox={() => navigate(ROBLOX_PATH)}
          showAppLinks={!authRequired || authenticated}
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

function AuthGuard({ status, api }: { readonly status: string; readonly api: AuthApi | null }): JSX.Element {
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
              ? 'Server autentikasi sedang tidak dapat dijangkau. Coba muat ulang halaman.'
              : checking
                ? 'Tunggu sebentar, sesi Google kamu sedang diverifikasi.'
                : 'Masuk dengan akun Google untuk membuka Studio, DJ, dan Roblox.'}
        </p>
        {!checking && !failed && !missing ? (
          <Button
            onClick={() => {
              window.location.href = api.loginUrl(window.location.pathname);
            }}
          >
            MASUK DENGAN GOOGLE
          </Button>
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
