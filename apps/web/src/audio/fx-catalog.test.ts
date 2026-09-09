/**
 * Kontrak katalog efek Rust ↔ TS.
 *
 * Dua hal yang diuji, dan keduanya gagal secara diam-diam kalau tidak diuji:
 * bentuk JSON-nya (UI merakit knob dari situ) dan matematika taper-nya (knob
 * yang menyimpang menunjuk nilai yang berbeda dari yang dipakai engine).
 *
 * Dilewati kalau cargo tidak ada — job `wasm` di CI yang menegakkannya.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { catalogById, fromNorm, parseCatalog, toNorm, type EffectDesc } from './fx-catalog';

/** Lihat catatan di `param-map.test.ts` soal kenapa bukan `new URL(...)`. */
function repoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'Cargo.toml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function cargoPrint(testName: string, startsWith: string): string | null {
  const cwd = repoRoot();
  if (cwd === null) return null;
  try {
    const out = execFileSync(
      'cargo',
      ['test', '-p', 'daw-wasm', '--lib', '--', '--nocapture', testName],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').find((l) => l.trim().startsWith(startsWith))?.trim() ?? null;
  } catch {
    return null;
  }
}

interface TaperRow {
  readonly effect: string;
  readonly param: string;
  readonly values: readonly number[];
}

describe('fx-catalog', () => {
  it('bentuk JSON-nya bisa diurai dan tiap efek punya parameter', () => {
    const json = cargoPrint('print_fx_catalog_json', '[{');
    if (json === null) return;
    const catalog: EffectDesc[] = parseCatalog(json);
    expect(catalog.length).toBeGreaterThan(0);
    const byId = catalogById(catalog);
    for (const d of catalog) {
      expect(byId.get(d.id)).toBe(d);
      expect(d.params.length).toBeGreaterThan(0);
      for (const p of d.params) {
        expect(typeof p.taper.kind).toBe('string');
        expect(p.min).toBeLessThanOrEqual(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('fromNorm menghasilkan angka yang sama dengan Rust', () => {
    const catalogJson = cargoPrint('print_fx_catalog_json', '[{');
    const fixtureJson = cargoPrint('print_taper_fixture_json', '[{');
    if (catalogJson === null || fixtureJson === null) return;

    const byId = catalogById(parseCatalog(catalogJson));
    const rows = JSON.parse(fixtureJson) as TaperRow[];
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const effect = byId.get(row.effect);
      expect(effect, `efek ${row.effect} tidak ada di katalog`).toBeDefined();
      const param = effect!.params.find((p) => p.id === row.param);
      expect(param, `param ${row.param} tidak ada`).toBeDefined();

      row.values.forEach((want, i) => {
        const got = fromNorm(param!, i / 4);
        // Rust berhitung f32, JS f64 — dibandingkan relatif, bukan bit.
        const tol = Math.max(Math.abs(want) * 1e-4, 1e-5);
        expect(
          Math.abs(got - want),
          `${row.effect}.${row.param} @ t=${i / 4}: TS ${got} vs Rust ${want}`,
        ).toBeLessThanOrEqual(tol);
      });
    }
  });

  it('toNorm membalik fromNorm pada taper kontinu', () => {
    const json = cargoPrint('print_fx_catalog_json', '[{');
    if (json === null) return;
    for (const d of parseCatalog(json)) {
      for (const p of d.params) {
        if (p.taper.kind === 'stepped') continue; // sengaja snap ke detent
        for (let i = 0; i <= 8; i += 1) {
          const t = i / 8;
          expect(Math.abs(toNorm(p, fromNorm(p, t)) - t)).toBeLessThan(1e-3);
        }
      }
    }
  });
});
