/**
 * Tab KATALOG — menjawab tiga pertanyaan docs/21 §3a yang tidak bisa dijawab
 * halaman sebelumnya:
 *
 *   1. "Lagu genre apa saja yang sudah kuunggah, dan berapa?" → kelompok
 *      kategori → genre dengan hitungan, `assetId` yang bisa disalin.
 *   2. "Yang mana yang masih ditinjau / ditolak?" → status moderasi per baris,
 *      dan "coba lagi" untuk yang gagal (baris draft baru dari hash yang sama).
 *   3. "Genre apa yang belum kupunya?" → ringkasan per kategori di kepala,
 *      dan kelompok kosong yang TETAP ditampilkan dengan hitungan 0.
 *
 * Yang TIDAK dijanjikan, dan ditulis apa adanya di kepala tab: Roblox tidak
 * menampilkan genre di katalognya sendiri. Genre tersimpan di mesin ini (dan
 * di deskripsi asset kalau opsinya hidup).
 *
 * Pengelompokan dan penyaringan dihitung di TS untuk KEDUA platform dari
 * `state.catalog` — desktop mengisi daftarnya dari `roblox_catalog_list`,
 * web dari dokumen IndexedDB. Satu komponen, satu perilaku.
 */

import { useState, type CSSProperties } from 'react';

import { Badge, Button, Card } from '../../ui/cyber';
import type { RobloxUploadRow } from '../../platform/local-commands';
import {
  MODERATION_LABEL,
  catalogSummary,
  filterCatalog,
  formatBytes,
  formatDuration,
  groupCatalog,
  type RobloxState,
} from '../model';
import { robloxActions } from '../store';
import { GenrePicker } from '../upload/GenrePicker';

export interface CatalogPanelProps {
  readonly state: RobloxState;
}

const FIELD: CSSProperties = {
  background: 'var(--cy-surface-2)',
  color: 'var(--cy-text)',
  border: '1px solid var(--cy-border)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  padding: '6px 8px',
  minWidth: 0,
  width: '100%',
};

const NOTE: CSSProperties = { fontSize: '9px', lineHeight: 1.7, color: 'var(--cy-text-muted)' };

function dateOf(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CatalogRow({ row, onMessage }: { readonly row: RobloxUploadRow; readonly onMessage: (m: string | null) => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const failed = row.status === 'failed';
  const moderation = row.moderationState;

  const copy = (): void => {
    if (row.assetId === null) return;
    const text = `rbxassetid://${row.assetId}`;
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      onMessage(`salin manual: ${text}`);
      return;
    }
    void clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => onMessage(`tidak bisa menyalin — salin manual: ${text}`),
    );
  };

  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto auto auto auto',
        alignItems: 'center',
        gap: '10px',
        padding: '7px 10px',
        border: '1px solid var(--cy-border)',
        background: 'var(--cy-surface-1)',
      }}
    >
      <div style={{ minWidth: 0, display: 'grid', gap: '2px' }}>
        <span style={{ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
        <span style={{ ...NOTE, letterSpacing: '.08em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.fileName} · {formatDuration(row.seconds)} · {formatBytes(row.bytes)} · {dateOf(row.approvedAt ?? row.uploadedAt ?? row.updatedAt)}
        </span>
        {row.error !== null ? <span style={{ fontSize: '9px', color: '#ff4d4d' }}>! {row.error}</span> : null}
      </div>
      <span style={{ fontSize: '9px', letterSpacing: '.1em', color: row.assetId === null ? 'var(--cy-text-muted)' : 'var(--cy-success)', fontVariantNumeric: 'tabular-nums' }}>
        {row.assetId === null ? 'tanpa asset id' : `rbxassetid://${row.assetId}`}
      </span>
      <Badge tone={failed ? 'danger' : moderation === 'approved' ? 'success' : 'warning'} height={22} dot>
        {failed && moderation === null ? 'GAGAL' : moderation === null ? 'TANPA STATUS' : MODERATION_LABEL[moderation]}
      </Badge>
      <Button size="sm" variant="ghost" disabled={row.assetId === null} onClick={copy} aria-label={`salin asset id ${row.name}`}>
        {copied ? 'TERSALIN' : 'SALIN ID'}
      </Button>
      {failed ? (
        <Button
          size="sm"
          variant="outline"
          aria-label={`coba lagi ${row.name}`}
          onClick={() => {
            void robloxActions.retryFromCatalog(row).then((m) => onMessage(m ?? `"${row.name}" masuk antrean lagi sebagai draft — buka tab UNGGAH`));
          }}
        >
          COBA LAGI
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

export function CatalogPanel({ state }: CatalogPanelProps): JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const { catalog, taxonomy, catalogFilter } = state;
  const shown = filterCatalog(catalog, catalogFilter);
  const groups = groupCatalog(shown, taxonomy);
  const approved = catalog.filter((r) => r.status === 'done').length;
  const failed = catalog.length - approved;

  return (
    <div style={{ padding: '16px', display: 'grid', gap: '16px', alignContent: 'start' }} className="rbx-body">
      <Card
        title="Katalog"
        subtitle={`${approved} disetujui · ${failed} gagal`}
        notched
        actions={<Badge tone="accent" height={22}>{catalogSummary(catalog, taxonomy) || 'BELUM ADA KATEGORI'}</Badge>}
        style={{ display: 'grid', gap: '10px' }}
      >
        <p style={{ ...NOTE, margin: 0 }}>
          Genre tersimpan di mesin ini (dan di deskripsi asset kalau opsinya hidup). Roblox sendiri
          tidak menampilkan genre di katalognya.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '8px' }} className="rbx-catalog-filter">
          <GenrePicker
            taxonomy={taxonomy}
            categoryId={catalogFilter.categoryId}
            genreId={catalogFilter.genreId}
            onCategory={(categoryId) => robloxActions.setCatalogFilter({ categoryId, genreId: null })}
            onGenre={(genreId) => robloxActions.setCatalogFilter({ genreId })}
            labelPrefix="penyaring katalog"
            emptyLabel="semua"
          />
          <input
            aria-label="cari di katalog"
            className="cy-focusable"
            placeholder="cari nama, berkas, atau asset id"
            value={catalogFilter.query}
            onChange={(e) => robloxActions.setCatalogFilter({ query: e.target.value })}
            style={FIELD}
          />
        </div>
        {message !== null ? (
          <p role="status" style={{ margin: 0, fontSize: '10px', lineHeight: 1.6, color: 'var(--cy-warning)' }}>
            {message}
          </p>
        ) : null}
      </Card>

      {catalog.length === 0 ? (
        <p style={{ ...NOTE, margin: 0, textAlign: 'center', padding: '18px 0', letterSpacing: '.14em' }}>
          BELUM ADA UNGGAHAN YANG SELESAI
        </p>
      ) : null}

      {groups.map((group) => (
        <Card
          key={group.category?.id ?? '__lepas'}
          title={group.category?.name ?? 'Tanpa kategori'}
          subtitle={`${group.count} lagu`}
          notched
          style={{ display: 'grid', gap: '10px' }}
        >
          {group.genres.length === 0 ? <p style={{ ...NOTE, margin: 0 }}>Belum ada genre di kategori ini.</p> : null}
          {group.genres.map((g) => (
            <section key={g.genre?.id ?? '__lepas'} aria-label={`genre ${g.genre?.name ?? 'tanpa genre'}`} style={{ display: 'grid', gap: '6px' }}>
              <h3 style={{ margin: 0, fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-text-dim)', display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                <span>{(g.genre?.name ?? 'TANPA GENRE').toUpperCase()}</span>
                <span style={{ color: 'var(--cy-accent)', fontVariantNumeric: 'tabular-nums' }}>{g.rows.length}</span>
              </h3>
              {g.rows.length > 0 ? (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '4px' }}>
                  {g.rows.map((row) => (
                    <CatalogRow key={row.id} row={row} onMessage={setMessage} />
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </Card>
      ))}
    </div>
  );
}
