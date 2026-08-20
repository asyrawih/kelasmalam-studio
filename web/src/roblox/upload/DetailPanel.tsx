/**
 * Kartu DETAIL — metadata satu baris yang sedang dipilih.
 *
 * Dipisah dari baris antrean, bukan disunting di tempat, karena dua bidang
 * yang dikirim ke Roblox (nama & deskripsi) butuh ruang yang tidak dimiliki
 * baris setinggi 40 px — dan karena antrean 30 berkas dengan 60 kolom teks
 * di dalamnya adalah dinding, bukan daftar.
 *
 * Penghitung karakter selalu terlihat, bukan hanya saat lewat batas: batas
 * nama Roblox 50 karakter cukup pendek untuk ditabrak tanpa sengaja, dan
 * mengetahui sisanya lebih berguna daripada diberi tahu setelah terlambat.
 */

import { Badge, Card } from '../../ui/cyber';
import {
  MAX_DESC_LEN,
  MAX_NAME_LEN,
  STATUS_LABEL,
  formatBytes,
  formatDuration,
  type QueueItem,
} from '../model';

export interface DetailPanelProps {
  readonly item: QueueItem | null;
  readonly onName: (id: number, name: string) => void;
  readonly onDescription: (id: number, description: string) => void;
  /** Baris yang sedang berjalan tidak boleh disunting metadatanya. */
  readonly locked: boolean;
}

const LABEL = {
  fontSize: '9px',
  letterSpacing: '.18em',
  color: 'var(--cy-text-muted)',
  textTransform: 'uppercase',
} as const;

const FIELD = {
  width: '100%',
  background: 'var(--cy-surface-2)',
  color: 'var(--cy-text)',
  border: '1px solid var(--cy-border)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  padding: '7px 9px',
} as const;

export function DetailPanel({ item, onName, onDescription, locked }: DetailPanelProps): JSX.Element {
  if (item === null) {
    return (
      <Card title="Detail" subtitle="tidak ada baris terpilih" notched>
        <p style={{ margin: 0, fontSize: '10px', lineHeight: 1.7, color: 'var(--cy-text-muted)' }}>
          Pilih satu baris di antrean untuk menyunting nama dan deskripsi asset.
        </p>
      </Card>
    );
  }

  const disabled = locked || item.status === 'done';

  return (
    <Card
      title="Detail"
      subtitle={item.fileName}
      notched
      actions={<Badge height={22}>{STATUS_LABEL[item.status]}</Badge>}
      style={{ display: 'grid', gap: '12px' }}
    >
      <div style={{ display: 'grid', gap: '5px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="rbx-name" style={LABEL}>
            Nama asset
          </label>
          <span
            style={{
              fontSize: '9px',
              fontVariantNumeric: 'tabular-nums',
              color: item.name.length > MAX_NAME_LEN ? '#ff4d4d' : 'var(--cy-text-muted)',
            }}
          >
            {item.name.length}/{MAX_NAME_LEN}
          </span>
        </div>
        <input
          id="rbx-name"
          className="cy-focusable"
          value={item.name}
          disabled={disabled}
          onChange={(e) => onName(item.id, e.target.value)}
          style={FIELD}
        />
      </div>

      <div style={{ display: 'grid', gap: '5px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="rbx-desc" style={LABEL}>
            Deskripsi
          </label>
          <span
            style={{
              fontSize: '9px',
              fontVariantNumeric: 'tabular-nums',
              color: item.description.length > MAX_DESC_LEN ? '#ff4d4d' : 'var(--cy-text-muted)',
            }}
          >
            {item.description.length}/{MAX_DESC_LEN}
          </span>
        </div>
        <textarea
          id="rbx-desc"
          className="cy-focusable"
          value={item.description}
          disabled={disabled}
          rows={4}
          onChange={(e) => onDescription(item.id, e.target.value)}
          style={{ ...FIELD, resize: 'vertical', lineHeight: 1.6 }}
        />
      </div>

      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 12px',
          fontSize: '10px',
        }}
      >
        <dt style={LABEL}>Durasi</dt>
        <dd style={{ margin: 0, color: 'var(--cy-text-dim)' }}>{formatDuration(item.seconds)}</dd>
        <dt style={LABEL}>Ukuran</dt>
        <dd style={{ margin: 0, color: 'var(--cy-text-dim)' }}>{formatBytes(item.bytes)}</dd>
        {item.assetId !== null ? (
          <>
            <dt style={LABEL}>Asset ID</dt>
            <dd style={{ margin: 0, color: 'var(--cy-success)' }}>rbxassetid://{item.assetId}</dd>
          </>
        ) : null}
      </dl>
    </Card>
  );
}
