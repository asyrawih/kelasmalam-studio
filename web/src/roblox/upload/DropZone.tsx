/**
 * Kotak jatuh berkas + tombol pilih berkas.
 *
 * Dua pintu masuk, satu jalur: keduanya berakhir di `onFiles`. Tombolnya bukan
 * pelengkap — drag-and-drop tidak bisa dijangkau lewat keyboard sama sekali,
 * jadi `<input type="file">` adalah satu-satunya cara halaman ini bisa dipakai
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
import { AUDIO_EXTS } from '../model';

export interface DropZoneProps {
  readonly onFiles: (files: readonly File[]) => void;
  /** Dimatikan selama antrean berjalan. */
  readonly disabled?: boolean;
}

export function DropZone({ onFiles, disabled = false }: DropZoneProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const [over, setOver] = useState(false);

  const accept = (list: FileList | null): void => {
    if (list === null || list.length === 0) return;
    onFiles(Array.from(list));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounter.current = 0;
    setOver(false);
    if (disabled) return;
    accept(e.dataTransfer.files);
  };

  return (
    <div
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

      <input
        ref={inputRef}
        type="file"
        multiple
        // `accept` menyaring dialog, BUKAN hasilnya: user tetap bisa memilih
        // "semua berkas" di sebagian OS. Penyaring sebenarnya ada di
        // `isAudioFile`, dan yang ini cuma membuat dialognya sopan.
        accept={[...AUDIO_EXTS, 'audio/mpeg', 'audio/ogg'].join(',')}
        aria-label="pilih berkas audio"
        style={{ display: 'none' }}
        onChange={(e) => {
          accept(e.target.files);
          // Direset supaya memilih BERKAS YANG SAMA dua kali tetap memicu
          // `change` — tanpa ini percobaan kedua diam saja.
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => inputRef.current?.click()}>
        PILIH BERKAS
      </Button>
    </div>
  );
}
