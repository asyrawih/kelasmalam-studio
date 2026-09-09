/**
 * State LAYOUT aplikasi (bukan state musik).
 *
 * Sengaja terpisah dari `state/store.ts`: file itu adalah mirror project +
 * state presentasi audio dan sedang disentuh agent lain. Lebar sidebar dan tab
 * dock tidak ada hubungannya dengan audio, tidak pernah di-serialize ke
 * project, dan tidak boleh ikut memicu selector di sana. Bentuknya tetap sama
 * (`useSyncExternalStore` + selector) supaya konsisten dengan store utama.
 */

import { useSyncExternalStore } from 'react';

export type DockTab = 'mixer' | 'clip' | 'automation' | 'piano' | 'steps';

export interface ShellState {
  readonly sidebarOpen: boolean;
  readonly sidebarWidth: number;
  readonly inspectorOpen: boolean;
  readonly inspectorWidth: number;
  readonly dockOpen: boolean;
  readonly dockHeight: number;
  readonly dockTab: DockTab;
  readonly exportOpen: boolean;
}

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;
export const INSPECTOR_MIN = 260;
export const INSPECTOR_MAX = 520;
export const DOCK_MIN = 160;
export const DOCK_MAX = 620;
/** Lebar rail saat sidebar/inspector ditutup — hanya cukup untuk tombol buka. */
export const RAIL_W = 30;

let state: ShellState = {
  sidebarOpen: true,
  sidebarWidth: 240,
  inspectorOpen: true,
  inspectorWidth: 320,
  dockOpen: true,
  dockHeight: 300,
  dockTab: 'mixer',
  exportOpen: false,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const shellStore = {
  getState: (): ShellState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export const shellActions = {
  patch(next: Partial<ShellState>): void {
    state = { ...state, ...next };
    emit();
  },
  setSidebarWidth(px: number): void {
    shellActions.patch({ sidebarWidth: clamp(Math.round(px), SIDEBAR_MIN, SIDEBAR_MAX) });
  },
  setInspectorWidth(px: number): void {
    shellActions.patch({ inspectorWidth: clamp(Math.round(px), INSPECTOR_MIN, INSPECTOR_MAX) });
  },
  setDockHeight(px: number): void {
    shellActions.patch({ dockHeight: clamp(Math.round(px), DOCK_MIN, DOCK_MAX) });
  },
  toggleSidebar(): void {
    shellActions.patch({ sidebarOpen: !state.sidebarOpen });
  },
  toggleInspector(): void {
    shellActions.patch({ inspectorOpen: !state.inspectorOpen });
  },
  toggleDock(): void {
    shellActions.patch({ dockOpen: !state.dockOpen });
  },
  /** Klik tab: buka dock kalau tertutup, atau tutup kalau tab yang sama diklik. */
  selectTab(tab: DockTab): void {
    if (state.dockOpen && state.dockTab === tab) {
      shellActions.patch({ dockOpen: false });
      return;
    }
    shellActions.patch({ dockTab: tab, dockOpen: true });
  },
  setExportOpen(open: boolean): void {
    shellActions.patch({ exportOpen: open });
  },
};

export function useShell<T>(select: (s: ShellState) => T): T {
  return useSyncExternalStore(
    shellStore.subscribe,
    () => select(state),
    () => select(state),
  );
}
