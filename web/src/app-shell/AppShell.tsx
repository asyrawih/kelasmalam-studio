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

import { useCallback, useEffect, useState } from 'react';

import { App } from '../App';
import { DjPage } from '../dj';
import { LandingPage } from '../landing';
import { RobloxPage } from '../roblox';
import { CommandPalette } from './CommandPalette';
import { KeymapEditor } from './KeymapEditor';
import { useCommands } from './useCommands';
import { useKeyDispatch } from './useKeyDispatch';
import { DJ_PATH, HOME_PATH, ROBLOX_PATH, STUDIO_PATH, routeOf, type Route } from './routes';

export interface AppShellProps {
  readonly createEngine?: () => Promise<unknown>;
}

export function AppShell({ createEngine }: AppShellProps): JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));
  const [palette, setPalette] = useState(false);
  const [keymap, setKeymap] = useState(false);
  const [capturing, setCapturing] = useState(false);

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

  return (
    <>
      {route === 'studio' ? (
        <App
          createEngine={createEngine}
          onClose={() => navigate(HOME_PATH)}
          onOpenDj={() => navigate(DJ_PATH)}
        />
      ) : route === 'dj' ? (
        <DjPage onClose={() => navigate(HOME_PATH)} />
      ) : route === 'roblox' ? (
        <RobloxPage
          onClose={() => navigate(HOME_PATH)}
          onOpenStudio={() => navigate(STUDIO_PATH)}
        />
      ) : (
        <LandingPage
          onOpenStudio={() => navigate(STUDIO_PATH)}
          onOpenDj={() => navigate(DJ_PATH)}
          onOpenRoblox={() => navigate(ROBLOX_PATH)}
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
