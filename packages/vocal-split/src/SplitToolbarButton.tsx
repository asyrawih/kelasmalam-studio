/**
 * Tombol SPLIT di toolbar kanan (docs/26 §3a) — `ToolbarButton` yang sama
 * dengan SNAP supaya ukurannya identik, membuka `VocalSplitDialog`.
 *
 * `active` menyala saat dialog terbuka ATAU job split sedang berjalan: setelah
 * dialog ditutup, satu-satunya tanda ada job di toolbar adalah tombol ini
 * (progresnya sendiri di lane sumber). Klik saat job jalan tetap membuka
 * dialog — di sana ada HENTIKAN.
 *
 * Galat job yang datang saat dialog sudah tertutup juga hanya punya tombol
 * ini untuk memberi tanda: label jadi `SPLIT !` dan `title` memuat pesannya
 * (`lastError` di sesi), sampai dialog dibuka — di dalam dialog pesannya
 * tampil utuh dengan TUTUP. Tanda ini soal "belum dilihat", bukan "belum
 * ditutup": dialog yang dibuka lalu ditutup dengan BATAL tidak menyalakannya
 * lagi untuk galat yang sama; job baru (yang mengosongkan `lastError`)
 * memulai hitungan dari awal.
 *
 * Yang memasangnya adalah app lewat `extras.toolbarActions` (desktop dulu,
 * docs/26 §2 butir 1); paket ini tidak tahu di mana ia dirender.
 */

import { useRef, useState } from 'react';

import { ToolbarButton } from '@kelasmalam/studio/studio/shell/ToolbarButton';

import { useVocalSplit } from './split-session';
import { VocalSplitDialog } from './VocalSplitDialog';

const TITLE = 'Pisahkan vokal & instrumen (Kim_Vocal_2)';

export function SplitToolbarButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  const running = useVocalSplit((s) => s.job !== null);
  const lastError = useVocalSplit((s) => s.lastError);
  // Galat yang sudah pernah dibuka dialognya; ref, bukan state: nilainya
  // hanya dibaca saat render berikutnya, dan `lastError` sendiri yang memicu
  // render itu.
  const seen = useRef<string | null>(null);
  if (lastError === null) seen.current = null;
  const unseen = lastError !== null && !open && seen.current !== lastError;
  return (
    <>
      <ToolbarButton
        icon="⋔"
        label={unseen ? 'SPLIT !' : 'SPLIT'}
        title={unseen ? `${TITLE} — split terakhir GAGAL: ${lastError}` : TITLE}
        active={open || running}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) seen.current = lastError;
          setOpen(!open);
        }}
      />
      {open ? <VocalSplitDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
