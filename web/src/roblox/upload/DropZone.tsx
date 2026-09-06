/**
 * Kotak jatuh berkas + tombol pilih berkas.
 *
 * Dua pintu masuk, satu jalur: keduanya berakhir di `onFiles`. Tombolnya bukan
 * pelengkap — drag-and-drop tidak bisa dijangkau lewat keyboard sama sekali,
 * jadi `<input type="file">` (atau dialog native di desktop, lewat
 * `useAudioFilePicker`) adalah satu-satunya cara halaman ini bisa dipakai
 * tanpa tetikus.
 *
 * ## Kenapa `dragCounter`, bukan boolean
 *
 * `dragleave` menyala setiap kali kursor menyeberangi anak elemen mana pun di
 * dalam zona, termasuk ke anaknya sendiri. Boolean sederhana membuat sorotan
 * berkedip-kedip saat kursor melewati teks di tengah kotak. Penghitung
 * masuk/keluar hanya nol saat kursor benar-benar meninggalkan kotaknya.
 */

import { useRef, useState, type DragEvent } from 'react';

import { Button } from '../../ui/cyber';
import { useAudioFilePicker } from '../../platform/useAudioFilePicker';
import { useNativeFileDrop } from '../../platform/useNativeFileDrop';
import { AUDIO_EXTS } from '../model';

export interface DropZoneProps {
  readonly onFiles: (files: readonly File[]) => void;
  /** Dimatikan selama antrean berjalan. */
  readonly disabled?: boolean;
}

export function DropZone({ onFiles, disabled = false }: DropZoneProps): JSX.Element {
  const zoneRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);
  const [over, setOver] = useState(false);

  const accept = (list: FileList | readonly File[] | null): void => {
    if (list === null || list.length === 0) return;
    onFiles(Array.from(list));
  };
  const picker = useAudioFilePicker(accept, {
    // `accept` menyaring dialog, BUKAN hasilnya: user tetap bisa memilih
    // "semua berkas" di sebagian OS. Penyaring sebenarnya ada di
    // `isAudioFile`, dan yang ini cuma membuat dialognya sopan.
    accept: [...AUDIO_EXTS, 'audio/mpeg', 'audio/ogg'].join(','),
    extensions: AUDIO_EXTS.map((ext) => ext.replace(/^\./, '')),
    ariaLabel: 'pilih berkas audio',
  });
  // Drop dari Finder/Explorer di desktop; di web `onDrop` yang bekerja.
  useNativeFileDrop(zoneRef, accept, !disabled);

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounter.current = 0;
    setOver(false);
    if (disabled) return;
    accept(e.dataTransfer.files);
  };

  return (
    <div
      ref={zoneRef}
      data-testid="roblox-dropzone"
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current += 1;
        if (!disabled) setOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        // `copy` mengubah kursor jadi ikon "tambah". Tanpa ini Chrome memakai
        // kursor "tidak boleh" walau drop-nya diterima.
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setOver(false);
      }}
      onDrop={onDrop}
      style={{
        display: 'grid',
        justifyItems: 'center',
        gap: '10px',
        padding: '26px 16px',
        border: `1px dashed ${over ? 'var(--cy-accent)' : 'var(--cy-border-strong)'}`,
        background: over ? 'var(--cy-surface-2)' : 'var(--cy-surface-3)',
        color: 'var(--cy-text-dim)',
        textAlign: 'center',
        opacity: disabled ? 0.45 : 1,
        transition: 'background .12s linear, border-color .12s linear',
      }}
    >
      <span style={{ fontSize: '11px', letterSpacing: '.18em', color: 'var(--cy-text)' }}>
        JATUHKAN BERKAS AUDIO DI SINI
      </span>
      <span style={{ fontSize: '10px', letterSpacing: '.1em', color: 'var(--cy-text-muted)' }}>
        {AUDIO_EXTS.join(' · ').toUpperCase()} — bisa banyak sekaligus
      </span>

      {picker.input}
      <Button size="sm" variant="outline" disabled={disabled} onClick={picker.open}>
        PILIH BERKAS
      </Button>
    </div>
  );
}
