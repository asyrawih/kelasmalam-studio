/**
 * Pemasangan SPLIT (vocal split MDX-Net, docs/26) ke Studio — HANYA desktop
 * (docs/26 §2 butir 1): `apps/web` belum memasangnya, jadi tombolnya tidak
 * ada di sana dan `no-desktop-leak.test.ts` tidak perlu tahu paket ini.
 *
 * Bentuknya `ReactNode` untuk `extras.toolbarActions` di `StudioPage`, sama
 * seperti `dialogs` untuk YouTube. Paket `@kelasmalam/vocal-split` sendiri
 * netral platform; byte modelnya datang lewat `PlatformHost.modelBytes`
 * (Rust, `model_download`/`model_read`) karena host desktop menyediakannya.
 */

import type { ReactNode } from 'react';

import { SplitToolbarButton } from '@kelasmalam/vocal-split/SplitToolbarButton';

/** Tombol SPLIT untuk `StudioExtras.toolbarActions` (dirender di kiri SNAP). */
export function vocalSplitToolbarActions(): ReactNode {
  return <SplitToolbarButton />;
}
