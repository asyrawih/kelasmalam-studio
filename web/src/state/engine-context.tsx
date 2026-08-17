/**
 * Satu-satunya tempat instance engine disimpan untuk pohon React.
 *
 * Context ini menyimpan referensi yang TIDAK PERNAH berubah setelah dipasang,
 * jadi ia tidak memicu render ulang. Semua data yang berubah mengalir lewat
 * `uiStore` (struktural) atau `useMeterFrame` (per-frame) — bukan lewat context.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { UiEngine } from './engine-types';

const EngineContext = createContext<UiEngine | null>(null);

export interface EngineProviderProps {
  readonly client: UiEngine | null;
  readonly children: ReactNode;
}

export function EngineProvider({ client, children }: EngineProviderProps): JSX.Element {
  return <EngineContext.Provider value={client}>{children}</EngineContext.Provider>;
}

/**
 * Akses mentah ke engine. Panel sebaiknya memakai `useEngineCommands()`.
 *
 * Mengembalikan `null` sebelum audio di-unlock — AudioContext baru boleh
 * dibuat setelah gesture user (docs/05 §Safari), jadi seluruh UI harus bisa
 * dirender tanpa engine. Ini bukan kasus tepi: itu keadaan saat first paint.
 */
export function useEngineOrNull(): UiEngine | null {
  return useContext(EngineContext);
}
