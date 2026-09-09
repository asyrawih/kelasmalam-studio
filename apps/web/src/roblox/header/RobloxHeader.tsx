/**
 * Baris judul halaman ROBLOX. Bentuknya mengikuti `dj/header/DjHeader.tsx`,
 * termasuk aturan yang paling penting untuk ditiru: **badge status tidak
 * pernah berbohong.**
 *
 * Di halaman ini badge itu menjawab satu pertanyaan yang tidak boleh
 * disamarkan: apakah menekan UNGGAH benar-benar mengirim sesuatu. Selama
 * lapisan unggah belum tersambung ia berkata `UI ONLY` (web) — bukan `SIAP`,
 * bukan spinner, bukan tombol yang menyala lalu tidak melakukan apa-apa.
 *
 * Di desktop tidak ada Worker yang bisa "belum tersambung"; yang bisa kurang
 * adalah API key di berkas rahasia atau ID pemilik. Badge-nya menyebut PENYEBABNYA
 * (`BELUM ADA API KEY`, `ID PEMILIK KOSONG`), bukan keadaannya (docs/21 §3c),
 * karena penyebab itulah yang bisa diperbaiki user dari panel TUJUAN.
 */

import { VersionTag } from '../../app-shell/VersionTag';
import type { PlatformKind } from '../../platform';
import { Badge, Button } from '../../ui/cyber';
import { MAX_BYTES, MAX_SECONDS, formatBytes, formatDuration } from '../model';
import { useRoblox } from '../store';

export interface RobloxHeaderProps {
  readonly onClose?: () => void;
  /** Buka Studio. Halaman ini sering jadi langkah terakhir setelah export. */
  readonly onOpenStudio?: () => void;
  readonly platform?: PlatformKind;
}

export function RobloxHeader({ onClose, onOpenStudio, platform = 'web' }: RobloxHeaderProps): JSX.Element {
  const backendReady = useRoblox((s) => s.backendReady);
  const quotaLeft = useRoblox((s) => s.quotaLeft);
  const apiKeyStored = useRoblox((s) => s.apiKeyStored);
  const creatorId = useRoblox((s) => s.target.creatorId);
  const count = useRoblox((s) => s.items.length);

  const badge = backendReady ? (
    <Badge tone="success" dot>
      SIAP
    </Badge>
  ) : platform === 'desktop' ? (
    !apiKeyStored ? (
      <Badge
        tone="warning"
        dot
        title="Tempel API key Open Cloud di panel TUJUAN lalu SIMPAN — kuncinya disimpan dalam berkas lokal di mesin ini dan hanya dibaca Rust."
      >
        BELUM ADA API KEY
      </Badge>
    ) : creatorId.trim() === '' ? (
      <Badge tone="warning" dot title="Isi ID user/grup pemilik asset di panel TUJUAN.">
        ID PEMILIK KOSONG
      </Badge>
    ) : (
      <Badge tone="warning" dot title="Memeriksa kunci dan tujuan…">
        MEMERIKSA
      </Badge>
    )
  ) : (
    <Badge
      tone="warning"
      dot
      title="Lapisan unggah belum tersambung: antrean, validasi, dan metadata sudah berjalan, tapi belum ada yang dikirim ke Roblox."
    >
      UI ONLY
    </Badge>
  );

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
       * penuh export ulang. Kuota: di desktop tidak ada yang tahu (docs/21 §5)
       * — ditampilkan `—`, bukan angka karangan.
       */}
      <div style={{ fontSize: '10px', color: 'var(--cy-text-dim)', letterSpacing: '.1em' }}>
        MP3/OGG · MAKS {formatDuration(MAX_SECONDS)} · {formatBytes(MAX_BYTES)}
        {quotaLeft !== null ? ` · SISA KUOTA ${quotaLeft}` : platform === 'desktop' ? ' · KUOTA —' : ''}
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '10px', color: 'var(--cy-text-muted)', letterSpacing: '.14em' }}>
          {count} BERKAS
        </span>
        {badge}
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
