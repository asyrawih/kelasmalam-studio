/**
 * Tombol toolbar kanan: ikon di atas label, seukuran `SnapToggle`.
 *
 * Satu komponen untuk semua tombol di ujung kanan `MenuBar` (SNAP, dan yang
 * disuntik app lewat `extras.toolbarActions`, mis. SPLIT di desktop —
 * docs/26 §3a). Kalau tiap tombol menggambar dirinya sendiri, ukuran dan
 * warna aktifnya perlahan saling menjauh, dan toolbar yang tombolnya tidak
 * sejajar terbaca sebagai dua toolbar.
 *
 * Yang TIDAK diputuskan di sini: `aria-pressed` vs `aria-expanded`. Toggle
 * (SNAP) memakai `active` → `aria-pressed`; tombol pembuka dialog memberi
 * `aria-haspopup="dialog"` + `aria-expanded` sendiri, karena keduanya punya
 * arti yang berbeda untuk pembaca layar.
 */

import type { Ref } from 'react';

export interface ToolbarButtonProps {
  /** Glyph satu karakter, disembunyikan dari pembaca layar. */
  readonly icon: string;
  /** Teks pendek di bawah ikon; juga `aria-label`. */
  readonly label: string;
  readonly title: string;
  /** Menyala: border + warna aksen, dan `aria-pressed` ikut terisi. */
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly 'aria-haspopup'?: 'dialog';
  readonly 'aria-expanded'?: boolean;
  /** Untuk menjangkarkan popup ke tombolnya. */
  readonly buttonRef?: Ref<HTMLButtonElement>;
}

export function ToolbarButton({
  icon,
  label,
  title,
  active,
  disabled = false,
  onClick,
  'aria-haspopup': ariaHasPopup,
  'aria-expanded': ariaExpanded,
  buttonRef,
}: ToolbarButtonProps): JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      // `aria-pressed` hanya untuk toggle (yang memberi `active`); tombol
      // pembuka dialog menyatakan keadaannya lewat `aria-expanded`, dan dua
      // atribut keadaan sekaligus membingungkan pembaca layar.
      aria-pressed={ariaHasPopup === undefined ? active : undefined}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="cy-btn-reset cy-focusable cy-hover-accent-border"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1px',
        minWidth: '52px',
        height: '40px',
        padding: '0 8px',
        border: `1px solid ${active === true ? 'var(--cy-accent)' : 'transparent'}`,
        background: active === true ? 'var(--cy-surface-2)' : 'transparent',
        color: active === true ? 'var(--cy-accent)' : 'var(--cy-text-dim)',
        fontFamily: 'var(--cy-font-mono)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span aria-hidden style={{ fontSize: '16px', lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: '8px', letterSpacing: '.12em' }}>{label}</span>
    </button>
  );
}
