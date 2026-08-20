/**
 * Kartu ANTREAN — daftar berkas + ringkasan + aksi massal.
 *
 * Yang membuat kartu ini bukan sekadar `<ul>`: ringkasan di headernya menjawab
 * pertanyaan yang tidak bisa dijawab dengan melihat daftar panjang — berapa
 * yang benar-benar akan berangkat kalau tombol ditekan sekarang. Angka itu
 * datang dari `readyItems`, sumber yang SAMA dengan yang nanti dipakai
 * pengunggah, jadi ringkasannya tidak bisa berbeda dari kenyataan.
 */

import { Badge, Button, Card } from '../../ui/cyber';
import { readyItems, type QueueItem, type RobloxState } from '../model';
import { QueueRow } from './QueueRow';

export interface UploadQueueProps {
  readonly state: RobloxState;
  readonly onSelect: (id: number) => void;
  readonly onRemove: (id: number) => void;
  readonly onRetry: (id: number) => void;
  readonly onClearDone: () => void;
  readonly onClearAll: () => void;
}

export function UploadQueue({
  state,
  onSelect,
  onRemove,
  onRetry,
  onClearDone,
  onClearAll,
}: UploadQueueProps): JSX.Element {
  const items: readonly QueueItem[] = state.items;
  const ready = readyItems(state).length;
  const done = items.filter((it) => it.status === 'done').length;
  const blocked = items.filter((it) => it.status === 'draft').length - ready;

  return (
    <Card
      title="Antrean"
      subtitle={`${items.length} berkas`}
      notched
      actions={
        <div style={{ display: 'flex', gap: '6px' }}>
          <Button size="sm" variant="ghost" disabled={done === 0} onClick={onClearDone}>
            BERSIHKAN SELESAI
          </Button>
          <Button size="sm" variant="ghost" disabled={items.length === 0} onClick={onClearAll}>
            KOSONGKAN
          </Button>
        </div>
      }
      style={{ display: 'grid', gap: '12px', minHeight: 0 }}
    >
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <Badge tone="accent" height={22}>
          {ready} SIAP KIRIM
        </Badge>
        {blocked > 0 ? (
          <Badge tone="danger" height={22}>
            {blocked} PERLU DIPERBAIKI
          </Badge>
        ) : null}
        {done > 0 ? (
          <Badge tone="success" height={22}>
            {done} SELESAI
          </Badge>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: '18px 0',
            textAlign: 'center',
            fontSize: '10px',
            letterSpacing: '.14em',
            color: 'var(--cy-text-muted)',
          }}
        >
          BELUM ADA BERKAS
        </p>
      ) : (
        <div role="table" aria-label="antrean unggah" style={{ display: 'grid', gap: '6px' }}>
          {items.map((it) => (
            <QueueRow
              key={it.id}
              item={it}
              selected={state.selected === it.id}
              onSelect={onSelect}
              onRemove={onRemove}
              onRetry={onRetry}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
