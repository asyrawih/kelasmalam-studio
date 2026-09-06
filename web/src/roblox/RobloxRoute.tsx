/**
 * Pembungkus tipis: halaman + sambungannya ke lapisan unggah.
 *
 * Pemisahannya disengaja. `RobloxPage` adalah UI murni — ia menerima `onUpload`
 * dan tidak tahu apa pun tentang HTTP maupun Tauri, dan itulah yang membuatnya
 * bisa dites tanpa jaringan sama sekali. Yang tahu soal URL, berkas rahasia, probe
 * kesiapan, dan siklus hidup runner adalah berkas ini, dan hanya berkas ini.
 *
 * ## Dua kabel, satu runner (docs/21 §1e)
 *
 * Web: `createHttpTransport(VITE_ROBLOX_API)` ke Worker unggah, Grant Access
 * lewat Worker kepustakaan — persis seperti sebelum desktop ada.
 * Desktop: `createDesktopTransport()` ke command Tauri; unggah dan poll
 * dilakukan Rust, API key di berkas rahasia, target di SQLite. Grant Access lewat
 * `createLocalGrantApi()` — command `roblox_grant_*`/`roblox_assets_*` yang
 * bicara ke Roblox langsung dari Rust dengan cookie di berkas rahasia (§3f, R5).
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

import { getPlatformHost, type PlatformKind } from '../platform';
import { RobloxPage } from './RobloxPage';
import { createRunner, type Runner } from './backend/runner';
import { createDesktopTransport, hasStoredApiKey } from './backend/desktop-transport';
import { createHttpTransport } from './backend/transport';
import { localInvoke } from './local/invoke';
import { descriptionForRoblox, type RobloxTarget } from './model';
import { restoreRobloxQueue, robloxActions, robloxStore } from './store';
import { createGrantApi, type GrantApi } from './grant/api';
import { createLocalGrantApi } from './grant/local-api';

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
  /** Ditimpa di tes. Default: `getPlatformHost().kind`. */
  readonly platform?: PlatformKind;
}

/** Deskripsi yang dikirim jalur web: + baris Genre kalau opsinya hidup (§3d). Desktop: Rust yang menambahkannya. */
function describeForWeb(item: Parameters<typeof descriptionForRoblox>[0]): string {
  const s = robloxStore.getState();
  return descriptionForRoblox(item, s.taxonomy, s.target.genreToDescription);
}

export function RobloxRoute({
  onClose,
  onOpenStudio,
  apiBase,
  makeRunner,
  probe,
  libraryBase,
  makeGrantApi,
  platform: platformProp,
}: RobloxRouteProps): JSX.Element {
  const platform = platformProp ?? getPlatformHost().kind;
  const desktop = platform === 'desktop';
  const base = desktop ? 'desktop' : (apiBase ?? import.meta.env.VITE_ROBLOX_API ?? '').trim();
  const catalogBase = desktop ? '' : (libraryBase ?? import.meta.env.VITE_LIBRARY_API ?? '').trim();
  // Naik setiap kali user menyimpan target di desktop: kesiapan diperiksa
  // ULANG, bukan diasumsikan dari klik SIMPAN yang berhasil.
  const [probeGeneration, setProbeGeneration] = useState(0);

  const grantApi = useMemo<GrantApi | null>(() => {
    // Desktop tidak punya URL: `base` hanya penanda supaya tes yang menyuntik
    // `makeGrantApi` tetap bisa membedakan dari mana ia dipanggil.
    if (desktop) return makeGrantApi?.('desktop') ?? createLocalGrantApi();
    if (catalogBase === '') return null;
    return makeGrantApi?.(catalogBase) ?? createGrantApi(catalogBase);
  }, [catalogBase, desktop, makeGrantApi]);

  const transport = useMemo(
    () =>
      desktop
        ? createDesktopTransport({
            creatorId: () => robloxStore.getState().target.creatorId,
            rowIdOf: (operationId) =>
              robloxStore.getState().items.find((it) => it.operationId === operationId)?.localId ?? null,
          })
        : base === ''
          ? null
          : createHttpTransport(base, { description: describeForWeb }),
    [desktop, base],
  );

  const runner = useMemo<Runner | null>(() => {
    if (makeRunner !== undefined) return base === '' ? null : makeRunner(base);
    if (transport === null) return null;
    return createRunner(transport, {
      // Desktop: baris `done` di tabel SUDAH katalog (§3d); tidak ada
      // `recordAsset` ke Worker mana pun.
      onApproved: desktop
        ? undefined
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
  }, [base, desktop, grantApi, makeRunner, transport]);

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
   * tempat yang paling mahal. Di desktop yang diperiksa berkas rahasia + target —
   * dan keduanya baru terisi setelah `restoreRobloxQueue` memuat tabel
   * `setting`, jadi probe menunggu itu dulu.
   */
  useEffect(() => {
    if (base === '') {
      robloxActions.setBackendReady(false);
      return undefined;
    }
    let alive = true;
    const ask =
      probe ??
      (desktop && transport !== null
        ? async () => {
            await restoreRobloxQueue().catch(() => {});
            const stored = await hasStoredApiKey().catch(() => false);
            if (alive) robloxActions.setApiKeyStored(stored);
            return transport.health();
          }
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
  }, [base, desktop, probe, transport, probeGeneration]);

  /**
   * SIMPAN di panel TUJUAN. Desktop: creator → `roblox_target_set`, kunci →
   * berkas rahasia lewat `secret_set` (docs/21 §1f), lalu kolom kunci DIKOSONGKAN —
   * salinan di memori WebView tidak punya alasan untuk hidup lebih lama
   * daripada perjalanan ke berkas rahasia. Web: Worker kepustakaan seperti semula.
   */
  const onSaveTarget = desktop
    ? async (target: RobloxTarget): Promise<void> => {
        await localInvoke('roblox_target_set', {
          creatorKind: target.creatorKind,
          creatorId: target.creatorId.trim(),
          genreToDescription: target.genreToDescription,
        });
        if (target.apiKey.trim() !== '') {
          await localInvoke('secret_set', { key: 'roblox.api_key', value: target.apiKey.trim() });
          robloxActions.setApiKey('');
          robloxActions.setApiKeyStored(true);
        }
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
      platform={platform}
      {...(runner === null ? null : { onUpload: runner.run })}
    />
  );
}
