/**
 * Baris judul halaman ROBLOX. Bentuknya mengikuti `dj/header/DjHeader.tsx`,
 * termasuk aturan yang paling penting untuk ditiru: **badge status tidak
 * pernah berbohong.**
 *
 * Di halaman ini badge itu menjawab satu pertanyaan yang tidak boleh
 * disamarkan: apakah menekan UNGGAH benar-benar mengirim sesuatu. Selama
 * lapisan unggah belum tersambung ia berkata `UI ONLY` — bukan `SIAP`, bukan
 * spinner, bukan tombol yang menyala lalu tidak melakukan apa-apa.
 */

import { VersionTag } from '../../app-shell/VersionTag';
import { Badge, Button } from '../../ui/cyber';
import { MAX_BYTES, MAX_SECONDS, formatBytes, formatDuration } from '../model';
import { useRoblox } from '../store';

export interface RobloxHeaderProps {
  readonly onClose?: () => void;
  /** Buka Studio. Halaman ini sering jadi langkah terakhir setelah export. */
  readonly onOpenStudio?: () => void;
}

export function RobloxHeader({ onClose, onOpenStudio }: RobloxHeaderProps): JSX.Element {
  const backendReady = useRoblox((s) => s.backendReady);
  const quotaLeft = useRoblox((s) => s.quotaLeft);
  const count = useRoblox((s) => s.items.length);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '8px 16px',
        background: 'var(--cy-surface-1)',
        borderBottom: '1px solid var(--cy-border)',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '18px',
            fontWeight: 700,
            letterSpacing: '.06em',
          }}
        >
          ROBLOX
        </span>
        <span style={{ fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-accent)' }}>
          // UNGGAH ASSET AUDIO
        </span>
        <VersionTag height={20} />
      </div>

      <div style={{ height: '18px', width: '1px', background: 'var(--cy-border)' }} />

      {/*
       * Batas ditulis di header, bukan disembunyikan di tooltip. Keduanya
       * (7 menit, 20 MB) adalah alasan paling sering sebuah berkas ditolak,
       * dan mengetahuinya SEBELUM menjatuhkan berkas menghemat satu putaran
       * penuh export ulang.
       */}
      <div style={{ fontSize: '10px', color: 'var(--cy-text-dim)', letterSpacing: '.1em' }}>
        MP3/OGG · MAKS {formatDuration(MAX_SECONDS)} · {formatBytes(MAX_BYTES)}
        {quotaLeft === null ? '' : ` · SISA KUOTA ${quotaLeft}`}
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '10px', color: 'var(--cy-text-muted)', letterSpacing: '.14em' }}>
          {count} BERKAS
        </span>
        {backendReady ? (
          <Badge tone="success" dot>
            SIAP
          </Badge>
        ) : (
          <Badge
            tone="warning"
            dot
            title="Lapisan unggah belum tersambung: antrean, validasi, dan metadata sudah berjalan, tapi belum ada yang dikirim ke Roblox."
          >
            UI ONLY
          </Badge>
        )}
        {onOpenStudio !== undefined ? (
          <Button size="sm" variant="ghost" onClick={onOpenStudio}>
            STUDIO
          </Button>
        ) : null}
        {onClose !== undefined ? (
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="tutup halaman">
            TUTUP
          </Button>
        ) : null}
      </div>
    </div>
  );
}
