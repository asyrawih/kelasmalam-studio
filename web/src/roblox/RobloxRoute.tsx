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
import { createGrantApi, type GrantApi } from './grant/api';

export interface RobloxRouteProps {
  readonly onClose?: () => void;
  readonly onOpenStudio?: () => void;
  /** Ditimpa di tes. Default: dibaca dari `import.meta.env.VITE_ROBLOX_API`. */
  readonly apiBase?: string;
  /** Ditimpa di tes supaya tidak ada HTTP sungguhan. */
  readonly makeRunner?: (base: string) => Runner;
  /** Ditimpa di tes. Default: probe `/health` lewat transport. */
  readonly probe?: (base: string) => Promise<boolean>;
  /** Default: `VITE_LIBRARY_API`; Worker ini menyimpan katalog dan grant di D1. */
  readonly libraryBase?: string;
  readonly makeGrantApi?: (base: string) => GrantApi;
}

export function RobloxRoute({
  onClose,
  onOpenStudio,
  apiBase,
  makeRunner,
  probe,
  libraryBase,
  makeGrantApi,
}: RobloxRouteProps): JSX.Element {
  const base = (apiBase ?? import.meta.env.VITE_ROBLOX_API ?? '').trim();
  const catalogBase = (libraryBase ?? import.meta.env.VITE_LIBRARY_API ?? '').trim();
  const grantApi = useMemo<GrantApi | null>(() => {
    if (catalogBase === '') return null;
    return makeGrantApi?.(catalogBase) ?? createGrantApi(catalogBase);
  }, [catalogBase, makeGrantApi]);

  const runner = useMemo<Runner | null>(() => {
    if (base === '') return null;
    return makeRunner === undefined
      ? createRunner(createHttpTransport(base), {
          onApproved: async (item, assetId, target) => {
            await grantApi?.recordAsset({
              assetId,
              creatorKind: target.creatorKind,
              creatorId: target.creatorId.trim(),
              name: item.name,
              moderationState: 'approved',
            });
          },
        })
      : makeRunner(base);
  }, [base, grantApi, makeRunner]);

  // Kredensial milik akun Google dimuat sejak route dibuka, bukan menunggu
  // user masuk ke subtab Grant Access.
  useEffect(() => {
    if (grantApi === null) return undefined;
    let alive = true;
    void grantApi.settings().then((saved) => {
      if (!alive || saved === null) return;
      robloxActions.setCreatorKind(saved.creatorKind);
      robloxActions.setCreatorId(saved.creatorId);
      robloxActions.setApiKey(saved.apiKey);
    }).catch(() => { /* belum login / belum pernah menyimpan */ });
    return () => { alive = false; };
  }, [grantApi]);

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
    void ask(base)
      .then((ok) => {
        if (alive) robloxActions.setBackendReady(ok);
      })
      .catch(() => {
        if (alive) robloxActions.setBackendReady(false);
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
      grantApi={grantApi}
      onSaveTarget={grantApi === null ? undefined : async (target) => grantApi.saveSettings(target)}
      {...(runner === null ? null : { onUpload: runner.run })}
    />
  );
}
