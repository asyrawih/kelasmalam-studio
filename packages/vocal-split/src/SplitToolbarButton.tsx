/**
 * Tombol SPLIT di toolbar kanan (docs/26 §3a) — `ToolbarButton` yang sama
 * dengan SNAP supaya ukurannya identik, membuka `VocalSplitDialog`.
 *
 * `active` menyala saat dialog terbuka ATAU job split sedang berjalan: setelah
 * dialog ditutup, satu-satunya tanda ada job di toolbar adalah tombol ini
 * (progresnya sendiri di lane sumber). Klik saat job jalan tetap membuka
 * dialog — di sana ada HENTIKAN.
 *
 * Yang memasangnya adalah app lewat `extras.toolbarActions` (desktop dulu,
 * docs/26 §2 butir 1); paket ini tidak tahu di mana ia dirender.
 */

import { useState } from 'react';

import { ToolbarButton } from '@kelasmalam/studio/studio/shell/ToolbarButton';

import { useVocalSplit } from './split-session';
import { VocalSplitDialog } from './VocalSplitDialog';

export function SplitToolbarButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  const running = useVocalSplit((s) => s.job !== null);
  return (
    <>
      <ToolbarButton
        icon="⋔"
        label="SPLIT"
        title="Pisahkan vokal & instrumen (Kim_Vocal_2)"
        active={open || running}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? <VocalSplitDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
