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
 * Alias `@app-web/*` adalah utang yang DINYATAKAN: tiap pemakaiannya wajib
 * berkomentar `TODO(P3)`/`TODO(P4)` di baris impornya, dan daftar berkasnya
 * dikunci di `APP_WEB_ALLOWLIST`. Menambah pengecualian baru berarti mengubah
 * daftar itu dengan sadar — dan menghapus yang sudah bersih juga, supaya
 * daftar ini tidak jadi museum.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');

/** String yang berarti "tahu platformnya" — dilarang di paket, apa pun konteksnya. */
const FORBIDDEN: readonly string[] = ['@tauri-apps', '@vercel', 'isTauri', "kind === 'desktop'", 'localInvoke'];

/**
 * Berkas paket yang masih mengimpor kode app lewat `@app-web/*`, relatif
 * terhadap `packages/`. Harus SAMA PERSIS dengan kenyataan.
 *
 *   - `engine/src/audio/export-worker.ts`: pipeline export (`studio/export`)
 *     pindah ke `studio-core` di P4.
 *   - `platform/src/host.ts`: tipe `LibraryApi`, `ExportSink`, katalog SCNet
 *     pindah ke paketnya masing-masing di P3.
 */
const APP_WEB_ALLOWLIST: readonly string[] = ['engine/src/audio/export-worker.ts', 'platform/src/host.ts'];

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
    expect(packageDirs()).toEqual(expect.arrayContaining(['engine', 'ui', 'shell', 'platform']));
    expect(FILES.length).toBeGreaterThan(40);
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

  it('tiap impor @app-web/* berkomentar TODO(P3)/TODO(P4) di baris yang sama', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes("from '@app-web/") && !/TODO\(P[34]\)/.test(line)) {
          bad.push(`${relative(PACKAGES, f)}:${i + 1}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('daftar berkas pemakai @app-web/* sama persis dengan allowlist', () => {
    const actual = FILES.filter((f) => readFileSync(f, 'utf8').includes("from '@app-web/"))
      .map((f) => relative(PACKAGES, f))
      .sort();
    expect(actual).toEqual([...APP_WEB_ALLOWLIST].sort());
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
