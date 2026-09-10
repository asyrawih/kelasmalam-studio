/**
 * Pemasangan SPLIT (vocal split MDX-Net, docs/26) ke Studio di desktop.
 * `apps/web` memasangnya sendiri (`apps/web/src/vocal-split/register.tsx`,
 * P5) dengan gerbang kapabilitas; di sini tanpa gerbang karena server
 * loopback selalu memberi COOP/COEP dan inferensinya native (docs/26 §3b).
 *
 * Bentuknya `ReactNode` untuk `extras.toolbarActions` di `StudioPage`, sama
 * seperti `dialogs` untuk YouTube. Paket `@kelasmalam/vocal-split` sendiri
 * netral platform; di desktop ia menemukan `PlatformHost.vocalSplit`
 * (docs/26 P3b: unduhan lewat `model_download`, inferensi `ort` native lewat
 * `vocal_split_run`) dan memakainya alih-alih worker WASM — keputusan itu
 * dibuat dari kontrak host, bukan dari berkas ini.
 */

import type { ReactNode } from 'react';

import { SplitToolbarButton } from '@kelasmalam/vocal-split/SplitToolbarButton';

/** Tombol SPLIT untuk `StudioExtras.toolbarActions` (dirender di kiri SNAP). */
export function vocalSplitToolbarActions(): ReactNode {
  return <SplitToolbarButton />;
}
