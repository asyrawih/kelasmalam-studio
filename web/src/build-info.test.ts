/**
 * Penanda versi hanya berguna kalau ia JUJUR. Yang dijaga di sini: build yang
 * identitasnya tidak diketahui (vitest, atau bundel yang di-build di luar git)
 * tidak boleh menyamar jadi rilis bernomor, dan tanggal build yang rusak tidak
 * boleh bocor ke topbar sebagai `Invalid Date`.
 */

import { describe, expect, it } from 'vitest';
import { formatBuiltAt, versionLabel, versionTitle, type BuildInfo } from './build-info';

const info = (patch: Partial<BuildInfo> = {}): BuildInfo => ({
  version: '0.1.0',
  commit: '678a10f',
  branch: 'main',
  builtAt: '2026-08-20T07:30:00.000Z',
  ...patch,
});

describe('versionLabel', () => {
  it('menggabungkan versi dan commit', () => {
    expect(versionLabel(info())).toBe('v0.1.0 · 678a10f');
  });

  it('menjatuhkan commit yang tidak diketahui, bukan menampilkan pemisah kosong', () => {
    expect(versionLabel(info({ commit: '' }))).toBe('v0.1.0');
  });

  it('mengaku DEV kalau tidak ada identitas sama sekali', () => {
    expect(versionLabel(info({ version: '', commit: '' }))).toBe('DEV');
  });
});

describe('versionTitle', () => {
  it('menyebut commit, branch, dan waktu build', () => {
    const title = versionTitle(info());
    expect(title).toContain('Versi 0.1.0');
    expect(title).toContain('Commit 678a10f');
    expect(title).toContain('Branch main');
    expect(title).toContain('Build ');
  });

  it('tetap menyebut waktu build meski versinya tidak diketahui', () => {
    const title = versionTitle(info({ version: '', commit: '', branch: '' }));
    expect(title).toContain('Versi (tidak diketahui)');
    expect(title).toContain('Build ');
  });
});

describe('formatBuiltAt', () => {
  it('tidak pernah mengeluarkan Invalid Date', () => {
    expect(formatBuiltAt('')).toBe('(tidak diketahui)');
    expect(formatBuiltAt('bukan-tanggal')).toBe('(tidak diketahui)');
  });

  it('memformat ISO ke waktu lokal pembaca', () => {
    const out = formatBuiltAt('2026-08-20T07:30:00.000Z');
    expect(out).not.toContain('Invalid');
    expect(out).toContain('2026');
  });
});
