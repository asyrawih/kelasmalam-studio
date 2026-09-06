/**
 * Penjaga kontrak menu native: tiap id di `DESKTOP_MENU_COMMAND_IDS` HARUS
 * benar-benar terdaftar oleh halaman pemiliknya (docs/20 D5: "himpunan id
 * menu ⊆ registry").
 *
 * Tanpa ini, mengganti nama sebuah command di halamannya hanya membuat item
 * menu desktop diam saja — dan tidak ada tes lain yang menyentuh jalur itu,
 * karena sisi Rust tidak bisa membaca registry TypeScript.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppShell } from './AppShell';
import { listCommands } from './command';
import { DESKTOP_MENU_COMMAND_IDS, menuCommandRoute } from './menu-ids';
import { pathOf, type Route } from './routes';
import { djActions } from '../dj/store';
import { studioActions } from '../studio/store';

const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 300,
  width: 900,
  height: 300,
  toJSON: () => ({}),
};

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  studioActions.__resetForTest();
});

afterEach(cleanup);

/** Render satu halaman dan kembalikan himpunan id yang terdaftar selama ia hidup. */
function registeredAt(route: Route): ReadonlySet<string> {
  window.history.pushState(null, '', pathOf(route));
  const view = render(<AppShell />);
  const ids = new Set(listCommands().map((c) => c.id));
  act(() => view.unmount());
  return ids;
}

describe('DESKTOP_MENU_COMMAND_IDS', () => {
  it('tidak ada id ganda', () => {
    expect(new Set(DESKTOP_MENU_COMMAND_IDS).size).toBe(DESKTOP_MENU_COMMAND_IDS.length);
  });

  it('tiap id punya halaman pemilik yang dikenal', () => {
    for (const id of DESKTOP_MENU_COMMAND_IDS) expect(() => menuCommandRoute(id)).not.toThrow();
  });

  it('tiap id terdaftar oleh halaman pemiliknya', () => {
    const pages: readonly Route[] = ['landing', 'studio', 'dj', 'roblox'];
    const byRoute = new Map<Route, ReadonlySet<string>>();
    for (const route of pages) byRoute.set(route, registeredAt(route));

    const missing: string[] = [];
    for (const id of DESKTOP_MENU_COMMAND_IDS) {
      const owner = menuCommandRoute(id);
      const routes = owner === 'any' ? pages : [owner];
      for (const route of routes) {
        if (!byRoute.get(route)?.has(id)) missing.push(`${id} (di /${route})`);
      }
    }
    expect(missing, `id menu yang tidak terdaftar: ${missing.join(', ')}`).toEqual([]);
  });
});
