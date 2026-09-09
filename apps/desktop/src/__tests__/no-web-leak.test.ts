/**
 * @vitest-environment node
 *
 * App DESKTOP tidak membawa web (docs/25 §1b, P2) — cermin dari
 * `apps/web/src/__tests__/no-desktop-leak.test.ts`.
 *
 * Dua hal yang tidak boleh ada di `apps/desktop/src`:
 *   1. `@vercel/*` — telemetri Vercel tidak pernah dikirim dari aplikasi
 *      yang dipasang di mesin orang, dan tidak ada halaman Vercel yang
 *      menyajikan skripnya.
 *   2. `isTauri(` — app ini SELALU desktop; bertanya berarti ada cabang yang
 *      seharusnya tidak ada (docs/25 §1c: "paket menerima kemampuan sebagai
 *      nilai, tidak pernah bertanya di mana ia berjalan"). Komentar boleh
 *      menyebutnya (sejarah tercatat di sana); kode tidak.
 * Ditambah `package.json` tanpa `@vercel/*`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const APP = fileURLToPath(new URL('../..', import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'src-tauri' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FILES = [...sources(SRC)];

describe('apps/desktop/src tidak membawa web (docs/25 P2)', () => {
  it('ada berkas yang diperiksa', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('tidak mengimpor @vercel/*', () => {
    const hits = FILES.filter((f) => /['"]@vercel\//.test(stripComments(readFileSync(f, 'utf8')))).map((f) =>
      relative(SRC, f),
    );
    expect(hits).toEqual([]);
  });

  it('tidak memanggil isTauri( — app ini tidak perlu bertanya', () => {
    const hits = FILES.filter((f) => /\bisTauri\s*\(/.test(stripComments(readFileSync(f, 'utf8')))).map((f) =>
      relative(SRC, f),
    );
    expect(hits).toEqual([]);
  });

  it('apps/desktop/package.json tidak mendeklarasikan @vercel/*', () => {
    const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
    expect(names.filter((n) => n.startsWith('@vercel/'))).toEqual([]);
    // Dan memang membawa Tauri — kalau ini hilang, app-nya bukan desktop lagi.
    expect(names).toContain('@tauri-apps/api');
  });
});
