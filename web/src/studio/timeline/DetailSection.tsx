/**
 * Blok yang bisa dilipat di dalam Clip Detail.
 *
 * Ada karena panel ini tumbuh sampai empat blok dan tinggi penuhnya menutupi
 * timeline — dan timeline adalah tempat pekerjaan sebenarnya terjadi.
 *
 * ATURAN YANG MEMBUATNYA BUKAN SEKADAR "SEMBUNYIKAN": blok yang terlipat WAJIB
 * menampilkan ringkasan keadaannya di kepala. Kontrol yang hilang tanpa jejak
 * membuat user tidak bisa tahu bahwa clip-nya sedang di-fade, atau bahwa vokal
 * sedang dibuang — dan keduanya mengubah suara. Ringkasannya kecil, tapi ia
 * yang membedakan "dilipat" dari "disembunyikan".
 */

import type { ReactNode } from 'react';

export function DetailSection({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  readonly id: string;
  readonly title: string;
  /** Keadaan blok ini dalam satu baris. Ditampilkan saat terlipat. */
  readonly summary: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-detail-section={id}
      style={{ marginTop: '10px', borderTop: '1px solid var(--cy-border)' }}
    >
      <button
        type="button"
        className="cy-btn-reset cy-focusable cy-hover-accent-border"
        aria-expanded={open}
        onClick={onToggle}
        title={open ? `tutup ${title.toLowerCase()}` : `buka ${title.toLowerCase()}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '8px 2px',
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid transparent',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden
          style={{
            fontSize: '9px',
            color: open ? 'var(--cy-accent)' : 'var(--cy-text-muted)',
            width: '10px',
          }}
        >
          {open ? '▾' : '▸'}
        </span>
        <span
          style={{
            fontSize: '9px',
            letterSpacing: '.16em',
            color: open ? 'var(--cy-accent)' : 'var(--cy-text-muted)',
          }}
        >
          {title}
        </span>
        {/* Ringkasan hanya saat terlipat: kalau blok-nya terbuka, isinya sudah
            di layar dan mengulanginya di kepala hanya menambah keramaian yang
            justru sedang dikurangi. */}
        {open ? null : (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '10px',
              color: 'var(--cy-text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary}
          </span>
        )}
      </button>
      {open ? <div style={{ paddingBottom: '4px' }}>{children}</div> : null}
    </div>
  );
}
