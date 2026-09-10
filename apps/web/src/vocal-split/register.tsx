/**
 * Pemasangan SPLIT (vocal split MDX-Net, docs/26 P5) ke Studio di WEB.
 *
 * Bentuknya sama dengan `apps/desktop/src/vocal-split/register.tsx`: satu
 * `ReactNode` untuk `extras.toolbarActions` di `StudioPage`. Bedanya, di web
 * tombolnya DIGERBANGI kapabilitas — paket `@kelasmalam/vocal-split` sendiri
 * netral platform dan tidak tahu apa-apa soal ini; ia menemukan host web
 * tanpa `vocalSplit`/`modelBytes` dan memakai jalur worker WASM: `fetch`
 * model dari HuggingFace + cache OPFS (docs/26 §2 butir 3).
 *
 * Kenapa digerbangi, dan kenapa di sini:
 *   - ORT-web multi-thread butuh `SharedArrayBuffer`, jadi `crossOriginIsolated`
 *     (COOP/COEP dari `public/_headers`) + `sab` + `wasmThreads`; tanpa SIMD
 *     angka docs/26 §4 tidak berlaku sama sekali. Deteksinya milik
 *     `engine/audio/caps.ts` — TIDAK diduplikasi, hanya dibaca.
 *   - iOS (iPhone/iPad, termasuk iPadOS yang menyamar sebagai Mac) dikecualikan
 *     sejak awal: batas memori per tab hampir pasti OOM setelah user mengunduh
 *     66,8 MB (docs/14 §"Yang harus diputuskan" butir 3, docs/26 §8).
 *   - Desktop tidak punya gerbang ini (WKWebView/WebView2 selalu isolated dan
 *     runtime-nya native), jadi gerbangnya hidup di app web, bukan di paket.
 *
 * Kalau gerbang tidak lolos, tombolnya TETAP dirender tapi `disabled` dengan
 * alasan di `title` — fitur yang hilang diam-diam lebih membingungkan daripada
 * tombol abu-abu yang menjelaskan dirinya.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { degradedReasons, detectCaps, peekCaps, type Caps } from '@kelasmalam/engine/audio/caps';
import { ToolbarButton } from '@kelasmalam/studio/studio/shell/ToolbarButton';
import { SplitToolbarButton } from '@kelasmalam/vocal-split/SplitToolbarButton';

/** Sama dengan `TITLE` di `SplitToolbarButton`; ditulis ulang karena tombol nonaktif dirender di sini. */
const TITLE = 'Pisahkan vokal & instrumen (Kim_Vocal_2)';

/** Alasan iOS, dipakai `title` tombol dan tes. */
export const IOS_REASON = 'tidak tersedia di iOS/iPadOS (batas memori per tab, docs/14).';

/** Bagian `navigator` yang dibaca [`isIosLike`]; dipisah supaya bisa diuji tanpa menyentuh global. */
export type NavigatorLike = Pick<Navigator, 'platform' | 'userAgent' | 'maxTouchPoints'>;

/**
 * iPhone/iPod/iPad, termasuk iPadOS 13+ yang mengaku `MacIntel` — satu-satunya
 * "Mac" dengan layar sentuh multi-titik. Mac sungguhan melaporkan
 * `maxTouchPoints` 0.
 */
export function isIosLike(nav: NavigatorLike = navigator): boolean {
  if (/iPhone|iPad|iPod/.test(nav.userAgent) || /iPhone|iPad|iPod/.test(nav.platform)) return true;
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
}

/**
 * Alasan tombol SPLIT nonaktif di browser ini, atau `null` kalau boleh dipakai.
 * `caps === null` = deteksi belum selesai (tombol nonaktif sebentar saat mount).
 */
export function vocalSplitBlockedReason(caps: Caps | null, nav: NavigatorLike = navigator): string | null {
  if (isIosLike(nav)) return IOS_REASON;
  if (caps === null) return 'memeriksa kapabilitas browser…';
  if (caps.isolated && caps.sab && caps.wasmThreads && caps.simd) return null;
  const reasons = degradedReasons(caps);
  return reasons.length > 0 ? reasons.join(' ') : 'kapabilitas WASM multi-thread tidak terpenuhi.';
}

/**
 * Caps yang sudah ada langsung dipakai (engine biasanya sudah mendeteksinya
 * saat memuat WASM); kalau belum, dideteksi sekali di sini — `detectCaps`
 * idempoten dan hasilnya di-cache di modulnya.
 */
function useCaps(): Caps | null {
  const [caps, setCaps] = useState<Caps | null>(peekCaps);
  useEffect(() => {
    if (caps !== null) return;
    let alive = true;
    void detectCaps().then((c) => {
      if (alive) setCaps(c);
    });
    return () => {
      alive = false;
    };
  }, [caps]);
  return caps;
}

function WebSplitToolbarButton(): JSX.Element {
  const caps = useCaps();
  const blocked = vocalSplitBlockedReason(caps);
  if (blocked === null) return <SplitToolbarButton />;
  return (
    <ToolbarButton
      icon="⋔"
      label="SPLIT"
      title={`${TITLE} — ${blocked}`}
      disabled
      onClick={() => {}}
    />
  );
}

/** Tombol SPLIT untuk `StudioExtras.toolbarActions` (dirender di kiri SNAP). */
export function vocalSplitToolbarActions(): ReactNode {
  return <WebSplitToolbarButton />;
}
