/**
 * Dua tingkat resolver (docs/25 P2): resolver APP menang atas resolver BAWAAN,
 * apa pun urutan pendaftarannya — karena urutannya ditentukan urutan `import`
 * yang tidak dijanjikan siapa pun.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformHost } from './host';

const hostOf = (kind: PlatformHost['kind']): PlatformHost =>
  ({ kind, pickSaveTarget: vi.fn(), openExternal: vi.fn(), authHeaders: async () => ({}), modelBytes: vi.fn(), libraryApi: () => null }) as PlatformHost;

async function fresh(): Promise<typeof import('./host-registry')> {
  vi.resetModules();
  return import('./host-registry');
}

describe('host-registry: app vs bawaan', () => {
  beforeEach(() => vi.resetModules());

  it('bawaan saja → dipakai (app web)', async () => {
    const r = await fresh();
    r.registerDefaultPlatformHostResolver(() => hostOf('web'));
    expect(r.getPlatformHost().kind).toBe('web');
  });

  it('app dulu, bawaan belakangan → app tetap menang (desktop: setup tes web dimuat sesudah ./platform)', async () => {
    const r = await fresh();
    r.registerPlatformHostResolver(() => hostOf('desktop'));
    r.registerDefaultPlatformHostResolver(() => hostOf('web'));
    expect(r.getPlatformHost().kind).toBe('desktop');
  });

  it('bawaan dulu, app belakangan → app menang, host yang sudah dibuat dibuang', async () => {
    const r = await fresh();
    r.registerDefaultPlatformHostResolver(() => hostOf('web'));
    expect(r.getPlatformHost().kind).toBe('web');
    r.registerPlatformHostResolver(() => hostOf('desktop'));
    expect(r.getPlatformHost().kind).toBe('desktop');
  });

  it('bawaan yang didaftar ulang berlaku hanya kalau tidak ada app', async () => {
    const r = await fresh();
    r.registerDefaultPlatformHostResolver(() => hostOf('web'));
    const first = r.getPlatformHost();
    r.registerDefaultPlatformHostResolver(() => hostOf('web'));
    expect(r.getPlatformHost()).not.toBe(first);
    r.registerPlatformHostResolver(() => hostOf('desktop'));
    const app = r.getPlatformHost();
    r.registerDefaultPlatformHostResolver(() => hostOf('web'));
    expect(r.getPlatformHost()).toBe(app);
  });

  it('tanpa keduanya → galat yang menyebut kedua pintu', async () => {
    const r = await fresh();
    expect(() => r.getPlatformHost()).toThrow(/registerPlatformHostResolver.*registerDefaultPlatformHostResolver/s);
  });
});
