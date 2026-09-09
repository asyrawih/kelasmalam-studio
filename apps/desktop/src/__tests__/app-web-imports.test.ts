/**
 * @vitest-environment node
 *
 * Alias `@app-web/*` di `apps/desktop` adalah UTANG YANG DINYATAKAN (docs/25
 * P2 → P3): modul `apps/web/src` yang belum jadi paket (studio, dj, library,
 * roblox, soundcloud, proof-stem, `App`, `KeymapEditor`) masih ditarik
 * sebagai sumber. P3 menurunkannya ke NOL dengan memindahkan modul-modul itu
 * ke `packages/*`.
 *
 * Supaya penurunan itu terjadi dengan SADAR — bukan diam-diam bertambah —
 * daftar berkas pemakainya dikunci di sini. Menambah pemakai baru berarti
 * mengubah daftar ini; menghapus yang sudah bersih juga, supaya daftar ini
 * tidak jadi museum. Tiap baris impor `@app-web/*` juga wajib berkomentar
 * `TODO(P3)` (aturan yang sama dengan `no-platform-leak.test.ts` untuk
 * `packages/*`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Berkas `apps/desktop/src/**` yang mengimpor `@app-web/*`, relatif terhadap
 * `apps/desktop/src`. Harus SAMA PERSIS dengan kenyataan.
 *
 * Pengelompokan (apa yang ditarik, ke mana ia pergi di P3):
 *   - halaman & kerangka: `App`, `KeymapEditor`, `dj`, `proof-stem`, `roblox`,
 *     `studio/store` → paket `studio`, `dj`, `roblox`, `proof-stem`;
 *   - kepustakaan: `library/{api,model,store,fake-api,LibraryDock,api-contract}`
 *     → paket `library`;
 *   - roblox: `roblox/{model,persistence,store,backend/*,grant/*}` → paket `roblox`;
 *   - studio-core: `studio/timeline/{audio-import,content-hash,import-sink,
 *     url-to-lane}`, `studio/export/sinks` → paket `studio-core` (P4);
 *   - soundcloud: `soundcloud/api` → paket `soundcloud`;
 *   - kontrak: `local-error`, `library/model`, `roblox/model` → paket kontrak.
 */
const APP_WEB_ALLOWLIST: readonly string[] = [
  'app-shell/AppShell.tsx',
  'app-shell/desktop.test.tsx',
  'library-local/StoreSettings.test.tsx',
  'library-local/StoreSettings.tsx',
  'library-local/dock.test.tsx',
  'library-local/local-api-contract.test.ts',
  'library-local/local-api.test.ts',
  'library-local/local-api.ts',
  'library-local/store-settings.ts',
  'main.tsx',
  'platform/desktop.ts',
  'platform/local-commands.ts',
  'roblox-local/GrantAccess.desktop.test.tsx',
  'roblox-local/backend.ts',
  'roblox-local/desktop-transport.test.ts',
  'roblox-local/desktop-transport.ts',
  'roblox-local/grant-local-api.test.ts',
  'roblox-local/grant-local-api.ts',
  'roblox-local/queue-persistence.test.ts',
  'roblox-local/queue-persistence.ts',
  'roblox-local/route.test.tsx',
  'soundcloud/desktop-transport.test.ts',
  'soundcloud/desktop-transport.ts',
  'window/menu-ids.test.tsx',
  'youtube/YouTubeDialog.tsx',
  'youtube/dialog.test.tsx',
  'youtube/import.test.ts',
  'youtube/import.ts',
];

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

const FILES = [...sources(SRC)];

describe('pemakai @app-web/* di apps/desktop (utang P3)', () => {
  it('daftar berkas pemakai @app-web/* sama persis dengan allowlist', () => {
    const actual = FILES.filter((f) => readFileSync(f, 'utf8').includes("from '@app-web/"))
      .map((f) => relative(SRC, f))
      .sort();
    expect(actual).toEqual([...APP_WEB_ALLOWLIST].sort());
  });

  it('tiap impor @app-web/* berkomentar TODO(P3) di baris yang sama', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes("'@app-web/") && !/TODO\(P[34]\)/.test(line)) bad.push(`${relative(SRC, f)}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it('tidak mengimpor apps/web lewat path relatif (hanya lewat alias yang dihitung)', () => {
    const hits = FILES.filter((f) => /from\s+['"](?:\.\.\/)+web\//.test(readFileSync(f, 'utf8'))).map((f) =>
      relative(SRC, f),
    );
    expect(hits).toEqual([]);
  });
});
