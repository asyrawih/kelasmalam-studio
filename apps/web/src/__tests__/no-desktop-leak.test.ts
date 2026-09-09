/**
 * @vitest-environment node
 *
 * Bundel WEB tidak membawa desktop (docs/25 §1b, P2).
 *
 * KENAPA TES, BUKAN `vite build --report`. Sebelum P2, `apps/web` memuat lima
 * paket `@tauri-apps/*`, seluruh `youtube/`, `roblox/local`, dan
 * `library/local-api` — kode yang tidak pernah jalan di browser, dijaga hanya
 * oleh `import()` dinamis yang ditambal per kasus (docs/25 §0 butir 3). Yang
 * memaksa semua itu keluar adalah titik suntik §1c, dan yang menjaganya tidak
 * kembali adalah tes ini: satu `import` ke modul desktop di mana pun di
 * `apps/web/src` = merah di CI.
 *
 * Yang diperiksa:
 *   1. Tidak ada specifier impor (statis, dinamis, maupun `vi.mock`) ke
 *      `@tauri-apps/*` atau ke modul yang kini milik `apps/desktop`
 *      (`local-invoke`, `local-commands`, `local-api`, `youtube/…`,
 *      `desktop-transport`, `window/desktop`).
 *   2. Tidak ada pemanggilan `isTauri(` / `localInvoke(` di kode (komentar
 *      boleh menyebutnya — sejarahnya tercatat di sana).
 *   3. Cabang `kind === 'desktop'` yang TERSISA dikunci dalam allowlist: tiap
 *      entri adalah pertanyaan ke KONTRAK host (bukan `isTauri`) dan sudah
 *      berkomentar `TODO(P3)` atau alasan tetapnya (docs/25 §1c).
 *   4. `apps/web/package.json` tidak mendeklarasikan `@tauri-apps/*`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const APP = fileURLToPath(new URL('../..', import.meta.url));

/** Specifier modul yang berarti "desktop". Dicocokkan pada SPECIFIER impor, bukan teks bebas. */
const FORBIDDEN_SPECIFIERS: readonly RegExp[] = [
  /^@tauri-apps\//,
  /(^|\/)local-invoke$/,
  /(^|\/)local-commands$/,
  /(^|\/)local-api$/,
  /(^|\/)youtube(\/|$)/,
  /(^|\/)desktop-transport$/,
  /(^|\/)window\/desktop$/,
  /(^|\/)app-shell\/desktop$/,
  /(^|\/)platform\/desktop$/,
  /(^|\/)StoreSettings$/,
  /(^|\/)queue-persistence$/,
];

/** Pemanggilan yang hanya masuk akal di desktop. */
const FORBIDDEN_CALLS: readonly RegExp[] = [/\bisTauri\s*\(/, /\blocalInvoke\s*\(/, /\bcallLocal\s*\(/];

/**
 * Cabang `kind === 'desktop'` / `kind !== 'desktop'` yang masih boleh ada,
 * relatif terhadap `apps/web/src`. Harus SAMA PERSIS dengan kenyataan.
 *
 *   - `proof-stem/scnet-model.ts`: tetap — pertanyaan ke kontrak host
 *     (`modelBytes` dijalankan di main thread karena IPC tidak ada di worker),
 *     bukan `isTauri` (docs/25 §1c baris terakhir).
 *   - `soundcloud/SoundCloudDialog.tsx`: `TODO(P3)` — tombol DOWNLOAD memilih
 *     `openExternal` vs `<a download>`; ikut disuntik saat soundcloud jadi paket.
 */
const KIND_BRANCH_ALLOWLIST: readonly string[] = ['proof-stem/scnet-model.ts', 'soundcloud/SoundCloudDialog.tsx'];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    // `__tests__` = tes penjaga (termasuk berkas ini) yang menyebut string
    // terlarang sebagai DATA; bukan kode yang masuk bundel.
    if (name === 'node_modules' || name === 'wasm' || name === 'dist' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

/** Buang komentar blok dan baris supaya sejarah yang tercatat di sana tidak dihitung sebagai kode. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Semua specifier dari `import … from 'x'`, `import 'x'`, `import('x')`, `vi.mock('x'`, `export … from 'x'`. */
function specifiers(code: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+|vi\.mock\s*\(\s*)['"]([^'"]+)['"]/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) out.push(m[1]!);
  return out;
}

const FILES = [...sources(SRC)];

describe('apps/web/src tidak membawa desktop (docs/25 P2)', () => {
  it('ada berkas yang diperiksa', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('tidak ada impor ke @tauri-apps/* maupun modul milik apps/desktop', () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const spec of specifiers(code)) {
        if (FORBIDDEN_SPECIFIERS.some((re) => re.test(spec))) hits.push(`${relative(SRC, f)} → ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it.each(FORBIDDEN_CALLS)('tidak memanggil %s', (re) => {
    const hits = FILES.filter((f) => re.test(stripComments(readFileSync(f, 'utf8')))).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it("cabang kind === 'desktop' yang tersisa sama persis dengan allowlist", () => {
    const actual = FILES.filter((f) => /\bkind\s*[!=]==\s*'desktop'/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f))
      .sort();
    expect(actual).toEqual([...KIND_BRANCH_ALLOWLIST].sort());
  });

  it('apps/web/package.json tidak mendeklarasikan @tauri-apps/*', () => {
    const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
    expect(names.filter((n) => n.startsWith('@tauri-apps/'))).toEqual([]);
  });
});
