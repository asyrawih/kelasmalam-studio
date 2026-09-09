/**
 * Penyaring + pengurut Collection. MURNI — tanpa React, supaya perilaku yang
 * paling mudah salah (urutan nilai yang tidak diketahui) bisa dites langsung.
 */

import { resolveBeatGrid } from '../../studio/analysis/beat-grid';
import type { StudioAsset } from '../../studio/store';
import type { BrowseSort } from '../model';

export interface CollectionRow {
  readonly asset: StudioAsset;
  readonly name: string;
  /** `null` = belum/tidak bisa dianalisis. Ditampilkan `—`, bukan 0. */
  readonly bpm: number | null;
  readonly durationSec: number;
  readonly analyzing: boolean;
}

export function rowsOf(assets: Readonly<Record<number, StudioAsset>>): CollectionRow[] {
  return Object.values(assets).map((asset) => {
    const grid = resolveBeatGrid(asset);
    return {
      asset,
      name: asset.name,
      bpm: grid === null ? null : grid.bpm,
      durationSec: asset.sampleRate > 0 ? asset.frames / asset.sampleRate : 0,
      analyzing: asset.tempoPending,
    };
  });
}

/**
 * Saring + urutkan.
 *
 * Nilai yang TIDAK DIKETAHUI (`bpm === null`) selalu diletakkan **di akhir**,
 * berapa pun arah urutannya. Kalau ia ikut dibalik, mengurutkan menaik
 * berdasarkan BPM akan menaruh semua lagu yang belum dianalisis di PUNCAK
 * daftar — yaitu tepat menutupi lagu yang sedang dicari, dengan baris yang
 * justru paling tidak berguna.
 */
export function filterSort(
  rows: readonly CollectionRow[],
  query: string,
  sort: BrowseSort,
  ascending: boolean,
): CollectionRow[] {
  const q = query.trim().toLowerCase();
  const out = q === '' ? [...rows] : rows.filter((r) => r.name.toLowerCase().includes(q));
  const dir = ascending ? 1 : -1;

  out.sort((a, b) => {
    if (sort === 'name') return dir * a.name.localeCompare(b.name);
    if (sort === 'time') return dir * (a.durationSec - b.durationSec);
    if (a.bpm === null && b.bpm === null) return a.name.localeCompare(b.name);
    if (a.bpm === null) return 1;
    if (b.bpm === null) return -1;
    return dir * (a.bpm - b.bpm);
  });

  return out;
}
