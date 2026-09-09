/**
 * SoundCloud sebagai FITUR yang dipasang ke Studio, bukan bagian Studio.
 *
 * `StudioPage` tidak mengimpor paket ini — `soundcloud → studio` sudah ada
 * (dialognya menulis ke store dan lane), dan panah balik berarti siklus
 * (docs/25 P3). Jadi tombol SOUNDCLOUD di grup TOOLS dan dialognya diberikan
 * app lewat `extras`, sama seperti YouTube di desktop (docs/25 §1c). Hook ini
 * supaya kedua app tidak menyalin state buka/tutup yang sama.
 *
 *   const soundCloud = useSoundCloudImport();
 *   <StudioPage extras={{ importActions: [soundCloud.action], dialogs: soundCloud.dialog }} />
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ImportAction } from '@kelasmalam/studio/studio/shell/StudioHeader';
import { SoundCloudDialog } from './SoundCloudDialog';

export interface SoundCloudImport {
  /** Tombol di grup TOOLS header Studio. */
  readonly action: ImportAction;
  /** Dialognya; `null` saat tertutup. Dirender di dalam `BeatProvider` Studio. */
  readonly dialog: ReactNode;
}

export function useSoundCloudImport(): SoundCloudImport {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const action = useMemo<ImportAction>(() => ({ id: 'soundcloud', label: 'SOUNDCLOUD', run: () => setOpen(true) }), []);
  return { action, dialog: open ? <SoundCloudDialog onClose={close} /> : null };
}
