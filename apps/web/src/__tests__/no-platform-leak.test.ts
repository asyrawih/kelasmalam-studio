/**
 * @vitest-environment node
 *
 * Aturan impor docs/25 §1b, ditegakkan tes: `packages/*` tidak tahu di mana ia
 * berjalan.
 *
 * KENAPA TES, BUKAN REVIEW. docs/20 §1a ("satu frontend, tidak ada fork
 * komponen") dijaga review saja, dan hasilnya 46 file bercabang pada
 * `kind === 'desktop'` / `localInvoke` / `@tauri-apps` (docs/25 §0). Paket
 * yang boleh diimpor dua app hanya berguna kalau ia benar-benar netral, dan
 * "benar-benar" berarti merah di CI, bukan catatan di PR.
 *
 * Sejak docs/25 P3 tidak ada lagi alias ke `apps/*`; penjaga bahwa alias
 * sementara P2 itu tidak kembali ada di
 * `apps/desktop/src/__tests__/app-web-imports.test.ts`, dan graf dependensi
 * antar-paket (tanpa siklus, `package.json` = kenyataan) dijaga
 * `no-package-cycles.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');

/** String yang berarti "tahu platformnya" — dilarang di paket, apa pun konteksnya. */
const FORBIDDEN: readonly string[] = ['@tauri-apps', '@vercel', 'isTauri', "kind === 'desktop'", 'localInvoke'];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'wasm' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

function packageDirs(): string[] {
  return readdirSync(PACKAGES).filter((n) => statSync(join(PACKAGES, n)).isDirectory());
}

const FILES = packageDirs().flatMap((p) => [...sources(join(PACKAGES, p, 'src'))]);

describe('packages/* tidak tahu platformnya (docs/25 §1b)', () => {
  it('ada paket dan berkas yang diperiksa', () => {
    expect(packageDirs()).toEqual(
      expect.arrayContaining([
        'engine',
        'ui',
        'shell',
        'platform',
        'studio',
        'dj',
        'library',
        'roblox',
        'soundcloud',
        'proof-stem',
      ]),
    );
    expect(FILES.length).toBeGreaterThan(300);
  });

  it.each(FORBIDDEN)('tidak memuat %s', (needle) => {
    const hits = FILES.filter((f) => readFileSync(f, 'utf8').includes(needle)).map((f) => relative(PACKAGES, f));
    expect(hits).toEqual([]);
  });

  it('tidak mengimpor apps/* lewat path relatif', () => {
    const hits = FILES.filter((f) => /from\s+['"](?:\.\.\/)+apps\//.test(readFileSync(f, 'utf8'))).map((f) =>
      relative(PACKAGES, f),
    );
    expect(hits).toEqual([]);
  });

  it('package.json paket tidak mendeklarasikan dependensi @tauri-apps/* atau @vercel/*', () => {
    for (const p of packageDirs()) {
      const manifest = JSON.parse(readFileSync(join(PACKAGES, p, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ];
      const bad = names.filter((n) => n.startsWith('@tauri-apps/') || n.startsWith('@vercel/'));
      expect(bad, `packages/${p}/package.json`).toEqual([]);
    }
  });
});
