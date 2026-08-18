/**
 * Katalog efek untuk UI.
 *
 * Katalog datang dari Rust (`fxCatalogJson`), bukan dari daftar yang ditulis
 * ulang di TypeScript. Itu yang membuat panel FX tidak perlu tahu satu pun nama
 * efek: menambah efek ke-20 di Rust langsung memunculkannya di sini, lengkap
 * dengan rentang, default, taper, dan label parameternya.
 *
 * Pemuatannya asinkron karena artefak WASM di-fetch, jadi hook ini mengembalikan
 * `null` sampai siap — dan `error` kalau artefaknya memang belum dibangun.
 */

import { useEffect, useState } from 'react';

import type { EffectDesc } from '../../audio/fx-catalog';
import { ensureFxRuntime, fxCatalog, fxPreviewStatus } from '../preview/fx-node';

export interface FxCatalogState {
  readonly catalog: Map<string, EffectDesc> | null;
  readonly error: string | null;
}

export function useFxCatalog(): FxCatalogState {
  const [state, setState] = useState<FxCatalogState>(() => ({
    catalog: fxCatalog(),
    error: fxPreviewStatus().error,
  }));

  useEffect(() => {
    // Katalog yang SUDAH termuat saat mount tidak boleh memicu setState lagi:
    // pembaruan state setelah render yang tidak dibungkus `act()` membuat React
    // mencetak peringatan lewat `console.error`, dan smoke test studio memang
    // menggagalkan tes pada console.error apa pun.
    if (state.catalog !== null) return;
    let alive = true;
    void ensureFxRuntime().then(() => {
      if (!alive) return;
      const next = fxCatalog();
      const err = fxPreviewStatus().error;
      setState((prev) => (prev.catalog === next && prev.error === err ? prev : { catalog: next, error: err }));
    });
    return () => {
      alive = false;
    };
  }, [state.catalog]);

  return state;
}

/** Efek terurut nama, untuk menu tambah. */
export function sortedEffects(catalog: Map<string, EffectDesc>): EffectDesc[] {
  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
}
