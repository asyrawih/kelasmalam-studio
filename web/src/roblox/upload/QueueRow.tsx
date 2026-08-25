/**
 * Satu baris antrean.
 *
 * Baris ini memajang APA ADANYA: nama berkas, ukuran, durasi, status, dan —
 * kalau ada — semua alasan ia belum bisa dikirim. Pelanggaran tidak diringkas
 * jadi satu ikon merah dengan tooltip: yang perlu diketahui user adalah
 * kalimat "3.1 MB melewati batas 20.0 MB", dan menyembunyikannya di balik
 * hover berarti separuh user tidak pernah membacanya.
 */

import { memo } from 'react';

import { Badge, Button, ProgressBar, type BadgeTone } from '../../ui/cyber';
import {
  STATUS_LABEL,
  formatBytes,
  formatDuration,
  violationsOf,
  type QueueItem,
} from '../model';

export interface QueueRowProps {
  readonly item: QueueItem;
  readonly selected: boolean;
  readonly onSelect: (id: number) => void;
  readonly onRemove: (id: number) => void;
  readonly onRetry: (id: number) => void;
  readonly locked: boolean;
}

function QueueRowInner({
  item,
  selected,
  onSelect,
  onRemove,
  onRetry,
  locked,
}: QueueRowProps): JSX.Element {
  const problems = violationsOf(item);
  const tone: BadgeTone =
    item.status === 'failed'
      ? 'danger'
      : item.status === 'done'
        ? 'success'
        : item.status === 'draft' && problems.length > 0
          ? 'danger'
          : item.status === 'draft'
            ? 'default'
            : 'accent';

  return (
    <div
      // `<div>` dengan role, bukan `<button>`: baris ini SENDIRI berisi tombol
      // (HAPUS, ULANGI), dan tombol di dalam tombol adalah HTML tidak sah yang
      // membuat klik dalamnya ikut memilih baris di sebagian browser.
      role="row"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(item.id)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onSelect(item.id);
      }}
      className="cy-hover-row cy-focusable"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto auto auto auto',
        alignItems: 'center',
        gap: '12px',
        padding: '9px 12px',
        border: `1px solid ${selected ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
        background: selected ? 'var(--cy-surface-2)' : 'var(--cy-surface-1)',
        cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 0, display: 'grid', gap: '3px' }}>
        <span
          style={{
            fontSize: '11px',
            color: 'var(--cy-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.name.trim() === '' ? item.fileName : item.name}
        </span>
        <span
          style={{
            fontSize: '9px',
            letterSpacing: '.1em',
            color: 'var(--cy-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.fileName}
        </span>

        {problems.length > 0 ? (
          <ul style={{ margin: '2px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '2px' }}>
            {problems.map((p) => (
              <li key={p.code} style={{ fontSize: '9px', letterSpacing: '.06em', color: '#ff4d4d' }}>
                ! {p.message}
              </li>
            ))}
          </ul>
        ) : null}

        {item.error !== null ? (
          <span style={{ fontSize: '9px', letterSpacing: '.06em', color: '#ff4d4d' }}>
            ! {item.error}
          </span>
        ) : null}

        {item.assetId !== null ? (
          <span style={{ fontSize: '9px', letterSpacing: '.1em', color: 'var(--cy-success)' }}>
            rbxassetid://{item.assetId}
          </span>
        ) : null}

        {item.status === 'uploading' ? (
          <div style={{ marginTop: '4px' }}>
            <ProgressBar value={item.progress} showValue />
          </div>
        ) : null}
      </div>

      <span
        style={{
          fontSize: '10px',
          color: 'var(--cy-text-dim)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatDuration(item.seconds)}
      </span>
      <span
        style={{
          fontSize: '10px',
          color: 'var(--cy-text-dim)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatBytes(item.bytes)}
      </span>

      <Badge tone={tone} height={22} pulse={item.status === 'uploading'} dot>
        {STATUS_LABEL[item.status]}
      </Badge>

      <div style={{ display: 'flex', gap: '6px' }}>
        {item.status === 'failed' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={(e) => {
              e.stopPropagation();
              onRetry(item.id);
            }}
          >
            ULANGI
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={`hapus ${item.fileName}`}
          // Kesibukan baris lain tidak mengunci seluruh antrean. Baris yang
          // masih ANTRE aman dihapus; runner akan melihat File-nya sudah tidak
          // ada lalu melewatinya. Hanya request/polling milik baris ini sendiri
          // yang tidak boleh diputus dari UI.
          disabled={item.status === 'uploading' || item.status === 'processing'}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id);
          }}
        >
          HAPUS
        </Button>
      </div>
    </div>
  );
}

/**
 * Di-memo karena antrean 30 berkas berarti 30 baris, dan setiap ketikan di
 * kolom nama menyentuh SATU di antaranya. `patchItem` di store sudah menjaga
 * baris lain mengembalikan objek yang sama, jadi perbandingan dangkal di sini
 * benar-benar memotong render — bukan sekadar memindahkannya.
 */
export const QueueRow = memo(QueueRowInner);
