/**
 * @vitest-environment node
 *
 * Alias sementara P2 ke sumber `apps/web` (docs/25 P2 → P3) sudah TIDAK ADA:
 * setiap modul halaman adalah paket `@kelasmalam/*`, dan `apps/desktop` tidak
 * boleh menarik satu berkas pun dari `apps/web` — lewat alias, lewat path
 * relatif, maupun lewat `vi.mock`. Tes ini menjaga alias itu tidak lahir
 * kembali "sementara": string aliasnya dilarang di SELURUH repo (kode,
 * konfigurasi, CSS), bukan hanya di app ini, karena yang membuatnya bekerja
 * adalah satu entri `paths` di `tsconfig.base.json`.
 *
 * Specifier-nya disusun dari potongan supaya berkas ini sendiri tidak
 * mengandung string yang dicarinya — `grep -rn` di dokumen verifikasi harus
 * KOSONG, termasuk untuk penjaganya.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const DESKTOP_SRC = fileURLToPath(new URL('..', import.meta.url));

/** Nama alias lama, tanpa menuliskannya utuh. */
const LEGACY_ALIAS = ['@app', 'web'].join('-');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', 'wasm', 'src-tauri', '.claude']);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* files(full);
      continue;
    }
    if (/\.(ts|tsx|json|css|mjs|cjs|js)$/.test(name)) yield full;
  }
}

describe('alias sementara ke apps/web tidak ada lagi (docs/25 P3)', () => {
  it(`string "${LEGACY_ALIAS}" tidak muncul di berkas ts/tsx/json/css mana pun di repo`, () => {
    const hits = [...files(ROOT)]
      .filter((f) => readFileSync(f, 'utf8').includes(LEGACY_ALIAS))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it('tsconfig.base.json tidak punya entri paths ke apps/*', () => {
    const raw = readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const paths = (JSON.parse(raw) as { compilerOptions: { paths: Record<string, string[]> } }).compilerOptions.paths;
    const toApps = Object.entries(paths).filter(([, targets]) => targets.some((t) => t.startsWith('apps/')));
    expect(toApps).toEqual([]);
  });

  it('apps/desktop/src tidak mengimpor apps/web lewat path relatif', () => {
    // `__tests__/setup.ts` sengaja mengimpor setup vitest web (shim jsdom yang
    // sama untuk komponen yang sama) — itu perkakas tes, bukan kode app.
    const hits = [...files(DESKTOP_SRC)]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('/__tests__/'))
      .filter((f) => /from\s+['"](?:\.\.\/)+web\//.test(readFileSync(f, 'utf8')))
      .map((f) => relative(DESKTOP_SRC, f));
    expect(hits).toEqual([]);
  });
});
