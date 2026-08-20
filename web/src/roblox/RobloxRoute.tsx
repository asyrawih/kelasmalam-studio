/**
 * Pembungkus tipis: halaman + sambungannya ke Worker unggah.
 *
 * Pemisahannya disengaja. `RobloxPage` adalah UI murni — ia menerima `onUpload`
 * dan tidak tahu apa pun tentang HTTP, dan itulah yang membuatnya bisa dites
 * tanpa jaringan sama sekali. Yang tahu soal URL, probe kesiapan, dan siklus
 * hidup runner adalah berkas ini, dan hanya berkas ini.
 *
 * ## Tanpa `VITE_ROBLOX_API`, halaman ini persis seperti sebelum backend ada
 *
 * Tidak ada URL bawaan, dan itu bukan kelalaian: URL bawaan yang menunjuk ke
 * mana pun akan membuat build lokal siapa pun mengirim API key user ke host
 * yang tidak mereka pilih. Kalau variabelnya tidak diisi, `onUpload` tetap
 * `undefined`, tombol UNGGAH tetap mati, dan badge tetap `UI ONLY` — keadaan
 * yang sudah benar dan jujur sejak halaman ini lahir.
 */

import { useEffect, useMemo } from 'react';

import { RobloxPage } from './RobloxPage';
import { createRunner, type Runner } from './backend/runner';
import { createHttpTransport } from './backend/transport';
import { robloxActions } from './store';

export interface RobloxRouteProps {
  readonly onClose?: () => void;
  readonly onOpenStudio?: () => void;
  /** Ditimpa di tes. Default: dibaca dari `import.meta.env.VITE_ROBLOX_API`. */
  readonly apiBase?: string;
  /** Ditimpa di tes supaya tidak ada HTTP sungguhan. */
  readonly makeRunner?: (base: string) => Runner;
  /** Ditimpa di tes. Default: probe `/health` lewat transport. */
  readonly probe?: (base: string) => Promise<boolean>;
}

export function RobloxRoute({
  onClose,
  onOpenStudio,
  apiBase,
  makeRunner,
  probe,
}: RobloxRouteProps): JSX.Element {
  const base = (apiBase ?? import.meta.env.VITE_ROBLOX_API ?? '').trim();

  const runner = useMemo<Runner | null>(() => {
    if (base === '') return null;
    return makeRunner === undefined ? createRunner(createHttpTransport(base)) : makeRunner(base);
  }, [base, makeRunner]);

  /*
   * Kesiapan diperiksa, bukan diasumsikan dari adanya konfigurasi. URL yang
   * terisi tapi Worker-nya mati adalah keadaan yang paling sering terjadi saat
   * pengembangan, dan badge yang berkata SIAP di situ berbohong tepat di
   * tempat yang paling mahal.
   */
  useEffect(() => {
    if (base === '') {
      robloxActions.setBackendReady(false);
      return undefined;
    }
    let alive = true;
    const ask = probe ?? ((b: string) => createHttpTransport(b).health());
    void ask(base).then((ok) => {
      if (alive) robloxActions.setBackendReady(ok);
    });
    return () => {
      alive = false;
      // Ditinggalkan dalam keadaan "belum tersambung": saat halaman ini dibuka
      // lagi, probe berjalan ulang. Menyimpan `true` yang basi berarti tombol
      // UNGGAH menyala sebelum ada yang memastikan Worker-nya masih hidup.
      robloxActions.setBackendReady(false);
    };
  }, [base, probe]);

  return (
    <RobloxPage
      onClose={onClose}
      onOpenStudio={onOpenStudio}
      {...(runner === null ? null : { onUpload: runner.run })}
    />
  );
}
