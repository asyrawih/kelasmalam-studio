/**
 * Pembungkus tipis: halaman + sambungannya ke lapisan unggah.
 *
 * Pemisahannya disengaja. `RobloxPage` adalah UI murni — ia menerima `onUpload`
 * dan tidak tahu apa pun tentang HTTP maupun Tauri, dan itulah yang membuatnya
 * bisa dites tanpa jaringan sama sekali. Yang tahu soal URL, probe kesiapan,
 * dan siklus hidup runner adalah berkas ini, dan hanya berkas ini.
 *
 * ## Dua kabel, satu runner (docs/21 §1e) — yang kedua DISUNTIK
 *
 * Web (bawaan, tanpa pendaftaran apa pun): `createHttpTransport(VITE_ROBLOX_API)`
 * ke Worker unggah, Grant Access lewat Worker kepustakaan — persis seperti
 * sebelum desktop ada.
 * Desktop: app-nya mendaftarkan `RobloxBackend` (`backend/backend.ts`) —
 * transport command Tauri, Grant Access lokal, target ke SQLite, API key ke
 * berkas rahasia — dan berkas ini memakainya tanpa tahu Tauri ada (docs/25
 * §1c). Dulu ada cabang platform di sini yang mengimpor semua itu;
 * sekarang bundel web tidak membawa satu byte pun dari jalur desktop.
 * `runner.ts` sama untuk keduanya.
 *
 * ## Tanpa `VITE_ROBLOX_API`, halaman web persis seperti sebelum backend ada
 *
 * Tidak ada URL bawaan, dan itu bukan kelalaian: URL bawaan yang menunjuk ke
 * mana pun akan membuat build lokal siapa pun mengirim API key user ke host
 * yang tidak mereka pilih. Kalau variabelnya tidak diisi, `onUpload` tetap
 * `undefined`, tombol UNGGAH tetap mati, dan badge tetap `UI ONLY`.
 */

import { useEffect, useMemo, useState } from 'react';

import { RobloxPage } from './RobloxPage';
import type { RobloxUiVariant } from './ui-variant';
import { getRobloxBackend, type RobloxBackend } from './backend/backend';
import { createRunner, type Runner } from './backend/runner';
import { createHttpTransport } from './backend/transport';
import { descriptionForRoblox, type RobloxTarget } from './model';
import { restoreRobloxQueue, robloxActions, robloxStore } from './store';
import { createGrantApi, type GrantApi } from './grant/api';

export interface RobloxRouteProps {
  readonly onClose?: () => void;
  readonly onOpenStudio?: () => void;
  /** Ditimpa di tes. Default: dibaca dari `import.meta.env.VITE_ROBLOX_API`. */
  readonly apiBase?: string;
  /** Ditimpa di tes supaya tidak ada HTTP sungguhan. */
  readonly makeRunner?: (base: string) => Runner;
  /** Ditimpa di tes. Default: probe `/health` lewat transport (web) atau `backend.probe()`. */
  readonly probe?: (base: string) => Promise<boolean>;
  /** Default: `VITE_LIBRARY_API`; Worker ini menyimpan katalog dan grant di D1. */
  readonly libraryBase?: string;
  readonly makeGrantApi?: (base: string) => GrantApi;
  /**
   * Ditimpa di tes. Default: `backend.variant` kalau ada backend terdaftar,
   * kalau tidak `'web'`. Hanya memilih TEKS UI (badge, kalimat bantuan).
   */
  readonly variant?: RobloxUiVariant;
  /** Ditimpa di tes. Default: `getRobloxBackend()` — yang didaftarkan app. */
  readonly backend?: RobloxBackend | null;
}

/** Deskripsi yang dikirim jalur web: + baris Genre kalau opsinya hidup (§3d). Desktop: Rust yang menambahkannya. */
function describeForWeb(item: Parameters<typeof descriptionForRoblox>[0]): string {
  const s = robloxStore.getState();
  return descriptionForRoblox(item, s.taxonomy, s.target.genreToDescription);
}

/** Penanda `base` untuk backend yang disuntik: tidak ada URL, tapi "terkonfigurasi". */
const INJECTED_BASE = 'desktop';

export function RobloxRoute({
  onClose,
  onOpenStudio,
  apiBase,
  makeRunner,
  probe,
  libraryBase,
  makeGrantApi,
  variant: variantProp,
  backend: backendProp,
}: RobloxRouteProps): JSX.Element {
  const backend = backendProp === undefined ? getRobloxBackend() : backendProp;
  const injected = backend !== null;
  const variant = variantProp ?? backend?.variant ?? 'web';
  const base = injected ? INJECTED_BASE : (apiBase ?? import.meta.env.VITE_ROBLOX_API ?? '').trim();
  const catalogBase = injected ? '' : (libraryBase ?? import.meta.env.VITE_LIBRARY_API ?? '').trim();
  // Naik setiap kali user menyimpan target lewat backend yang disuntik:
  // kesiapan diperiksa ULANG, bukan diasumsikan dari klik SIMPAN yang berhasil.
  const [probeGeneration, setProbeGeneration] = useState(0);

  const grantApi = useMemo<GrantApi | null>(() => {
    // Backend yang disuntik tidak punya URL: `INJECTED_BASE` hanya penanda
    // supaya tes yang menyuntik `makeGrantApi` tetap bisa membedakan dari
    // mana ia dipanggil.
    if (backend !== null) return makeGrantApi?.(INJECTED_BASE) ?? backend.grantApi;
    if (catalogBase === '') return null;
    return makeGrantApi?.(catalogBase) ?? createGrantApi(catalogBase);
  }, [catalogBase, backend, makeGrantApi]);

  const transport = useMemo(
    () =>
      backend !== null
        ? backend.transport
        : base === ''
          ? null
          : createHttpTransport(base, { description: describeForWeb }),
    [backend, base],
  );

  const runner = useMemo<Runner | null>(() => {
    if (makeRunner !== undefined) return base === '' ? null : makeRunner(base);
    if (transport === null) return null;
    return createRunner(transport, {
      // Web: catat asset yang disetujui ke Worker kepustakaan. Backend yang
      // disuntik memutuskan sendiri (desktop: tidak perlu — baris `done` di
      // tabel SUDAH katalog, §3d).
      onApproved:
        backend !== null
          ? backend.onApproved
          : async (item, assetId, target) => {
              await grantApi?.recordAsset({
                assetId,
                creatorKind: target.creatorKind,
                creatorId: target.creatorId.trim(),
                name: item.name,
                moderationState: 'approved',
              });
            },
    });
  }, [base, backend, grantApi, makeRunner, transport]);

  useEffect(() => {
    let alive = true;
    void restoreRobloxQueue().then(async () => {
      if (!alive || runner === null) return;
      // Settings membawa API key kembali dari penyimpanan akun; jangan mulai
      // polling dengan kredensial kosong bila keduanya sedang dimuat bersamaan.
      if (grantApi !== null) {
        const saved = await grantApi.settings().catch(() => null);
        if (!alive) return;
        if (saved !== null) {
          robloxActions.setCreatorKind(saved.creatorKind);
          robloxActions.setCreatorId(saved.creatorId);
          robloxActions.setApiKey(saved.apiKey);
        }
      }
      runner.resume?.(robloxStore.getState().items);
    });
    return () => { alive = false; };
  }, [grantApi, runner]);

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
   * tempat yang paling mahal. Backend yang disuntik memeriksa dengan caranya
   * sendiri (`probe()`; desktop: berkas rahasia + target dari tabel `setting`).
   */
  useEffect(() => {
    if (base === '') {
      robloxActions.setBackendReady(false);
      return undefined;
    }
    let alive = true;
    const ask =
      probe ??
      (backend !== null
        ? () => backend.probe()
        : (b: string) => createHttpTransport(b).health());
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
  }, [base, backend, probe, probeGeneration]);

  /**
   * SIMPAN di panel TUJUAN. Backend yang disuntik menyimpan dengan caranya
   * (desktop: `roblox_target_set` + berkas rahasia, lalu kolom kunci
   * dikosongkan) dan kesiapannya diperiksa ulang. Web: Worker kepustakaan.
   */
  const onSaveTarget =
    backend !== null
      ? async (target: RobloxTarget): Promise<void> => {
          await backend.saveTarget(target);
          setProbeGeneration((n) => n + 1);
        }
      : grantApi === null
        ? undefined
        : async (target: RobloxTarget): Promise<void> => grantApi.saveSettings(target);

  return (
    <RobloxPage
      onClose={onClose}
      onOpenStudio={onOpenStudio}
      grantApi={grantApi}
      onSaveTarget={onSaveTarget}
      variant={variant}
      {...(runner === null ? null : { onUpload: runner.run })}
    />
  );
}
