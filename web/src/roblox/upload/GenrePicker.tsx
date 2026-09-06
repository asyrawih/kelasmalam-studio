/**
 * Dua `<select>` berantai: kategori → genre. Dipakai di baris antrean, panel
 * detail, bilah pilihan massal, dan penyaring katalog — SATU komponen supaya
 * "genre yang bukan anak kategorinya" tidak pernah bisa dipilih di mana pun.
 *
 * Genre dikosongkan otomatis oleh store saat kategorinya berganti; komponen
 * ini hanya menampilkan apa yang ada dan melapor pilihan user.
 */

import type { CSSProperties } from 'react';

import type { RobloxTaxonomy } from '../../platform/local-commands';
import { genresOf, sortedCategories } from '../model';

export interface GenrePickerProps {
  readonly taxonomy: RobloxTaxonomy;
  readonly categoryId: string | null;
  readonly genreId: string | null;
  readonly onCategory: (categoryId: string | null) => void;
  readonly onGenre: (genreId: string | null) => void;
  readonly disabled?: boolean;
  /** Awalan `aria-label`, mis. nama berkas — supaya tes dan pembaca layar bisa membedakan baris. */
  readonly labelPrefix: string;
  /** Teks pilihan kosong. Penyaring memakai "semua", baris memakai "pilih…". */
  readonly emptyLabel?: string;
  readonly style?: CSSProperties;
  /** Kecil untuk baris antrean; normal untuk panel. */
  readonly compact?: boolean;
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

const COMPACT: CSSProperties = { fontSize: '10px', padding: '3px 5px' };

export function GenrePicker({
  taxonomy,
  categoryId,
  genreId,
  onCategory,
  onGenre,
  disabled = false,
  labelPrefix,
  emptyLabel = 'pilih…',
  style,
  compact = false,
}: GenrePickerProps): JSX.Element {
  const categories = sortedCategories(taxonomy);
  const genres = genresOf(taxonomy, categoryId);
  const field = compact ? { ...FIELD, ...COMPACT } : FIELD;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', minWidth: 0, ...style }}>
      <select
        aria-label={`kategori ${labelPrefix}`}
        className="cy-focusable"
        value={categoryId ?? ''}
        disabled={disabled}
        onChange={(e) => onCategory(e.target.value === '' ? null : e.target.value)}
        onClick={(e) => e.stopPropagation()}
        style={field}
      >
        <option value="">{emptyLabel}</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        aria-label={`genre ${labelPrefix}`}
        className="cy-focusable"
        value={genreId ?? ''}
        // Tanpa kategori tidak ada genre yang bisa dipilih — dimatikan, bukan
        // daftar kosong yang tampak seperti bug.
        disabled={disabled || categoryId === null}
        onChange={(e) => onGenre(e.target.value === '' ? null : e.target.value)}
        onClick={(e) => e.stopPropagation()}
        style={field}
      >
        <option value="">{categoryId === null ? 'kategori dulu' : emptyLabel}</option>
        {genres.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </div>
  );
}
