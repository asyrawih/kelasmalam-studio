/**
 * Tab TAKSONOMI — menyunting kategori → genre milik user (docs/21 §1d).
 *
 * Empat aksi: tambah, ganti nama, pindah genre ke kategori lain, hapus. Yang
 * membedakan panel ini dari formulir CRUD biasa adalah HAPUS: ia ditolak
 * selama genre/kategori masih dipakai baris antrean atau katalog, dan
 * penolakannya menyebut JUMLAH ("masih dipakai 3 lagu") — pola yang sama
 * dengan hapus lagu di kepustakaan (docs/16 §8d). Panel ini tidak memutuskan
 * sendiri: keputusannya datang dari adapter (Rust di desktop, hitungan
 * store di web), dan panel hanya menampilkan kalimatnya.
 *
 * Ganti nama disunting DI TEMPAT (klik nama → kolom), bukan lewat dialog:
 * taksonomi 17 baris yang tiap barisnya butuh dialog adalah 17 dialog.
 */

import { useState, type CSSProperties } from 'react';

import { Badge, Button, Card } from '../../ui/cyber';
import type { RobloxCategory, RobloxGenre, RobloxTaxonomy } from '../../platform/local-commands';
import { genresOf, sortedCategories, type RobloxState } from '../model';
import { robloxActions, type TaxonomyResult } from '../store';

export interface TaxonomyPanelProps {
  readonly taxonomy: RobloxTaxonomy;
  /** Untuk hitungan "dipakai N" di samping tiap genre — informasi, bukan kunci. */
  readonly items: RobloxState['items'];
  readonly catalog: RobloxState['catalog'];
}

const FIELD: CSSProperties = {
  background: 'var(--cy-surface-2)',
  color: 'var(--cy-text)',
  border: '1px solid var(--cy-border)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  padding: '6px 8px',
  minWidth: 0,
};

const NOTE: CSSProperties = { fontSize: '9px', lineHeight: 1.7, color: 'var(--cy-text-muted)' };

/** Kolom nama yang bisa disunting di tempat. Enter = simpan, Escape = batal. */
function InlineName({
  value,
  onCommit,
  label,
}: {
  readonly value: string;
  readonly onCommit: (name: string) => Promise<TaxonomyResult>;
  readonly label: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  const commit = async (): Promise<void> => {
    const name = draft.trim();
    if (name === '' || name === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    const result = await onCommit(name);
    if (result.ok) {
      setEditing(false);
      setError(null);
    } else {
      setError(result.message);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="cy-btn-reset cy-focusable"
        aria-label={`ganti nama ${label}`}
        title="klik untuk mengganti nama"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        style={{ fontSize: '11px', color: 'var(--cy-text)', cursor: 'text', textAlign: 'left', padding: '4px 0' }}
      >
        {value}
      </button>
    );
  }
  return (
    <span style={{ display: 'grid', gap: '3px' }}>
      <input
        autoFocus
        aria-label={`nama baru ${label}`}
        className="cy-focusable"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            setEditing(false);
            setDraft(value);
          }
        }}
        onBlur={() => void commit()}
        style={FIELD}
      />
      {error !== null ? <span style={{ ...NOTE, color: 'var(--cy-warning)' }}>! {error}</span> : null}
    </span>
  );
}

function GenreRow({
  genre,
  categories,
  usedBy,
  onMessage,
}: {
  readonly genre: RobloxGenre;
  readonly categories: readonly RobloxCategory[];
  readonly usedBy: number;
  readonly onMessage: (m: string | null) => void;
}): JSX.Element {
  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto auto auto',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 0 4px 14px',
        borderLeft: '1px solid var(--cy-border)',
      }}
    >
      <InlineName value={genre.name} label={`genre ${genre.name}`} onCommit={(name) => robloxActions.renameGenre(genre.id, name)} />
      <span style={{ ...NOTE, fontVariantNumeric: 'tabular-nums' }}>{usedBy > 0 ? `dipakai ${usedBy}` : 'belum dipakai'}</span>
      <select
        aria-label={`pindahkan genre ${genre.name} ke kategori`}
        value={genre.categoryId}
        onChange={(e) => {
          void robloxActions.moveGenre(genre.id, e.target.value).then((r) => onMessage(r.ok ? null : r.message));
        }}
        style={FIELD}
      >
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`hapus genre ${genre.name}`}
        onClick={() => {
          void robloxActions.deleteGenre(genre.id).then((r) => onMessage(r.ok ? null : r.message));
        }}
      >
        HAPUS
      </Button>
    </li>
  );
}

function CategoryCard({
  category,
  categories,
  genres,
  usage,
  onMessage,
}: {
  readonly category: RobloxCategory;
  readonly categories: readonly RobloxCategory[];
  readonly genres: readonly RobloxGenre[];
  readonly usage: (genreId: string) => number;
  readonly onMessage: (m: string | null) => void;
}): JSX.Element {
  const [newGenre, setNewGenre] = useState('');
  const uploads = genres.reduce((n, g) => n + usage(g.id), 0);

  const add = (): void => {
    const name = newGenre.trim();
    if (name === '') return;
    void robloxActions.addGenre(category.id, name).then((r) => {
      onMessage(r.ok ? null : r.message);
      if (r.ok) setNewGenre('');
    });
  };

  return (
    <Card
      title={category.name}
      subtitle={`${genres.length} genre · ${uploads} lagu`}
      notched
      actions={
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <InlineName
            value={category.name}
            label={`kategori ${category.name}`}
            onCommit={(name) => robloxActions.renameCategory(category.id, name)}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`hapus kategori ${category.name}`}
            onClick={() => {
              void robloxActions.deleteCategory(category.id).then((r) => onMessage(r.ok ? null : r.message));
            }}
          >
            HAPUS
          </Button>
        </div>
      }
      style={{ display: 'grid', gap: '10px' }}
    >
      {genres.length === 0 ? (
        <p style={{ ...NOTE, margin: 0 }}>Belum ada genre di kategori ini.</p>
      ) : (
        <ul aria-label={`genre ${category.name}`} style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '2px' }}>
          {genres.map((g) => (
            <GenreRow key={g.id} genre={g} categories={categories} usedBy={usage(g.id)} onMessage={onMessage} />
          ))}
        </ul>
      )}
      <div style={{ display: 'flex', gap: '6px' }}>
        <input
          aria-label={`genre baru di ${category.name}`}
          className="cy-focusable"
          placeholder="genre baru"
          value={newGenre}
          onChange={(e) => setNewGenre(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          style={{ ...FIELD, flex: 1 }}
        />
        <Button size="sm" variant="outline" disabled={newGenre.trim() === ''} onClick={add}>
          + GENRE
        </Button>
      </div>
    </Card>
  );
}

export function TaxonomyPanel({ taxonomy, items, catalog }: TaxonomyPanelProps): JSX.Element {
  const [newCategory, setNewCategory] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const categories = sortedCategories(taxonomy);

  const usage = (genreId: string): number =>
    items.filter((it) => it.genreId === genreId).length + catalog.filter((r) => r.genreId === genreId).length;

  const addCategory = (): void => {
    const name = newCategory.trim();
    if (name === '') return;
    void robloxActions.addCategory(name).then((r) => {
      setMessage(r.ok ? null : r.message);
      if (r.ok) setNewCategory('');
    });
  };

  return (
    <div style={{ padding: '16px', display: 'grid', gap: '16px', alignContent: 'start' }} className="rbx-body">
      <Card
        title="Taksonomi"
        subtitle="kategori → genre milik kamu"
        notched
        actions={<Badge height={22}>{categories.length} KATEGORI · {taxonomy.genres.length} GENRE</Badge>}
        style={{ display: 'grid', gap: '10px' }}
      >
        <p style={{ ...NOTE, margin: 0 }}>
          Setiap baris antrean wajib punya kategori dan genre sebelum diunggah. Genre yang masih
          dipakai lagu tidak bisa dihapus — ganti dulu genre lagunya. Bawaan di sini hanya awalan;
          semuanya boleh diganti nama, dipindah, atau dihapus.
        </p>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            aria-label="kategori baru"
            className="cy-focusable"
            placeholder="kategori baru"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addCategory();
            }}
            style={{ ...FIELD, flex: 1 }}
          />
          <Button size="sm" variant="outline" disabled={newCategory.trim() === ''} onClick={addCategory}>
            + KATEGORI
          </Button>
        </div>
        {message !== null ? (
          <p role="alert" style={{ margin: 0, fontSize: '10px', lineHeight: 1.6, color: 'var(--cy-warning)' }}>
            ! {message}
          </p>
        ) : null}
      </Card>

      {categories.map((c) => (
        <CategoryCard
          key={c.id}
          category={c}
          categories={categories}
          genres={genresOf(taxonomy, c.id)}
          usage={usage}
          onMessage={setMessage}
        />
      ))}
    </div>
  );
}
