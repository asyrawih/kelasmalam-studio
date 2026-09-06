/**
 * Kartu ANTREAN — daftar berkas + ringkasan + aksi massal.
 *
 * Yang membuat kartu ini bukan sekadar `<ul>`: ringkasan di headernya menjawab
 * pertanyaan yang tidak bisa dijawab dengan melihat daftar panjang — berapa
 * yang benar-benar akan berangkat kalau tombol ditekan sekarang. Angka itu
 * datang dari `readyItems`, sumber yang SAMA dengan yang nanti dipakai
 * pengunggah, jadi ringkasannya tidak bisa berbeda dari kenyataan.
 *
 * Bilah PILIHAN MASSAL (docs/21 §1d): kategori & genre wajib, dan kewajiban
 * untuk 12 berkas tidak boleh jadi 12 klik. Centang baris → pilih kategori
 * dan genre di bilah → TERAPKAN KE N BARIS.
 */

import { useState } from 'react';

import { Badge, Button, Card } from '../../ui/cyber';
import { isBusy, readyItems, type QueueItem, type RobloxState } from '../model';
import { GenrePicker } from './GenrePicker';
import { QueueRow } from './QueueRow';

export interface UploadQueueProps {
  readonly state: RobloxState;
  readonly checked: ReadonlySet<number>;
  readonly onSelect: (id: number) => void;
  readonly onCheck: (id: number, checked: boolean) => void;
  readonly onCheckAll: (ids: readonly number[]) => void;
  readonly onRemove: (id: number) => void;
  readonly onRetry: (id: number) => void;
  readonly onCategory: (ids: readonly number[], categoryId: string | null) => void;
  readonly onGenre: (ids: readonly number[], genreId: string | null) => void;
  readonly onClearDone: () => void;
  readonly onClearAll: () => void;
}

export function UploadQueue({
  state,
  checked,
  onSelect,
  onCheck,
  onCheckAll,
  onRemove,
  onRetry,
  onCategory,
  onGenre,
  onClearDone,
  onClearAll,
}: UploadQueueProps): JSX.Element {
  const items: readonly QueueItem[] = state.items;
  const ready = readyItems(state).length;
  const done = items.filter((it) => it.status === 'done').length;
  const blocked = items.filter((it) => it.status === 'draft').length - ready;
  const locked = isBusy(state);

  // Pilihan bilah massal hidup di sini, bukan di store: ia belum berarti apa-apa
  // sampai TERAPKAN ditekan, dan tidak perlu bertahan melewati refresh.
  const [bulkCategory, setBulkCategory] = useState<string | null>(null);
  const [bulkGenre, setBulkGenre] = useState<string | null>(null);

  const editableIds = items.filter((it) => it.status === 'draft' || it.status === 'failed').map((it) => it.id);
  const checkedIds = editableIds.filter((id) => checked.has(id));
  const allChecked = editableIds.length > 0 && checkedIds.length === editableIds.length;

  const apply = (): void => {
    if (checkedIds.length === 0) return;
    if (bulkGenre !== null) onGenre(checkedIds, bulkGenre);
    else onCategory(checkedIds, bulkCategory);
  };

  return (
    <Card
      title="Antrean"
      subtitle={`${items.length} berkas`}
      notched
      actions={
        <div style={{ display: 'flex', gap: '6px' }}>
          <Button
            size="sm"
            variant="ghost"
            disabled={done === 0 || locked}
            onClick={onClearDone}
          >
            BERSIHKAN SELESAI
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={items.length === 0 || locked}
            onClick={onClearAll}
          >
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
            {done} DISETUJUI
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
        <>
          <div
            role="group"
            aria-label="pilihan massal"
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0,1fr) auto',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 10px',
              border: '1px solid var(--cy-border)',
              background: 'var(--cy-surface-3)',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-dim)' }}>
              <input
                type="checkbox"
                aria-label="pilih semua baris yang bisa disunting"
                checked={allChecked}
                disabled={locked || editableIds.length === 0}
                onChange={(e) => onCheckAll(e.target.checked ? editableIds : [])}
              />
              {checkedIds.length} DIPILIH
            </label>
            <GenrePicker
              taxonomy={state.taxonomy}
              categoryId={bulkCategory}
              genreId={bulkGenre}
              onCategory={(categoryId) => {
                setBulkCategory(categoryId);
                setBulkGenre(null);
              }}
              onGenre={setBulkGenre}
              disabled={locked}
              labelPrefix="untuk baris terpilih"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={locked || checkedIds.length === 0 || bulkCategory === null}
              onClick={apply}
              title="Beri kategori/genre yang sama ke semua baris yang dicentang"
            >
              TERAPKAN KE {checkedIds.length} BARIS
            </Button>
          </div>

          <div role="table" aria-label="antrean unggah" style={{ display: 'grid', gap: '6px' }}>
            {items.map((it) => (
              <QueueRow
                key={it.id}
                item={it}
                selected={state.selected === it.id}
                checked={checked.has(it.id)}
                taxonomy={state.taxonomy}
                onSelect={onSelect}
                onCheck={onCheck}
                onRemove={onRemove}
                onRetry={onRetry}
                onCategory={(id, categoryId) => onCategory([id], categoryId)}
                onGenre={(id, genreId) => onGenre([id], genreId)}
                locked={locked}
              />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
