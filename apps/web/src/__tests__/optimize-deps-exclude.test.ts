/**
 * @vitest-environment node
 *
 * `optimizeDeps.exclude` hanya boleh berisi paket yang punya jalur ESM.
 *
 * KENAPA INI PUNYA TES SENDIRI. `exclude` mematikan pre-bundle esbuild, dan
 * pre-bundle itulah yang mengubah CommonJS jadi ESM untuk dev server. Paket
 * CJS-only yang di-exclude disajikan MENTAH ke browser, dan `module.exports` di
 * baris pertamanya meledak jadi `module is not defined`.
 *
 * Kegagalannya punya dua sifat yang membuatnya mahal:
 *
 *   1. Ia HANYA ada di dev. Build produksi tetap diproses plugin commonjs
 *      Rollup, jadi bug-nya lenyap begitu diuji lewat `pnpm build` — terasa
 *      muncul-hilang tanpa pola.
 *   2. Tes lain tidak bisa menangkapnya. Vitest berjalan di Node, dan Node
 *      memuat CommonJS dengan senang hati. Jalur OGG punya tes yang lulus
 *      sempurna sementara export OGG di browser gagal total.
 *
 * Ini bukan hipotesis: `vorbis-encoder-js` pernah ada di daftar itu dan export
 * OGG gagal di `pnpm dev` dengan persis pesan itu. Yang diperiksa di sini
 * adalah konfigurasi SUNGGUHAN yang dipakai Vite, bukan salinannya.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import viteConfig from '../../vite.config';

/**
 * `package.json` sebuah paket, di mana pun pengelola paket menaruhnya: naik
 * dari direktori tes ini sampai ketemu `node_modules/<pkg>/`. Workspace bun
 * (docs/25 P0) meng-hoist dependensi ke `node_modules` ROOT repo, jadi
 * `../../node_modules/<pkg>` yang dulu dipakai tidak ada lagi; linker
 * `isolated` menaruhnya di tempat lain lagi. `require.resolve` tidak dipakai
 * karena `exports` beberapa paket tidak mengekspos `./package.json`.
 */
function packageJsonOf(pkg: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`${pkg}/package.json tidak ditemukan di node_modules mana pun di atas ${dir}`);
    }
    dir = parent;
  }
}

/**
 * Dikecualikan dari aturan: glue wasm-bindgen memang WAJIB di-exclude, karena
 * esbuild memproses ulang `new URL('...wasm', import.meta.url)` dan
 * mengarahkannya ke berkas yang salah (docs/04). Ia juga bukan paket npm biasa
 * — tidak ada `package.json`-nya untuk diperiksa.
 */
const WASM_GLUE = '@daw/wasm';

interface PackageJson {
  type?: string;
  module?: string;
  main?: string;
  exports?: unknown;
}

/** Apakah `exports` menyediakan kondisi `import` di mana pun di dalamnya. */
function hasImportCondition(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj['import'] === 'string') return true;
  return Object.values(obj).some((v) => hasImportCondition(v));
}

function excludedPackages(): string[] {
  const cfg = viteConfig as { optimizeDeps?: { exclude?: string[] } };
  return (cfg.optimizeDeps?.exclude ?? []).filter((p) => p !== WASM_GLUE);
}

describe('optimizeDeps.exclude', () => {
  it('tidak kosong dan tetap mengecualikan glue wasm-bindgen', () => {
    const cfg = viteConfig as { optimizeDeps?: { exclude?: string[] } };
    // Kalau baris ini jatuh, konfigurasinya berpindah bentuk dan tes di bawah
    // diam-diam memeriksa daftar kosong — lulus tanpa menguji apa pun.
    expect(cfg.optimizeDeps?.exclude).toContain(WASM_GLUE);
  });

  it.each(excludedPackages())('%s punya jalur ESM, jadi aman di-exclude', (pkg) => {
    const manifest = JSON.parse(readFileSync(packageJsonOf(pkg), 'utf8')) as PackageJson;

    const esm =
      manifest.type === 'module' ||
      typeof manifest.module === 'string' ||
      hasImportCondition(manifest.exports);

    expect(
      esm,
      `${pkg} tidak punya jalur ESM (type=${manifest.type ?? 'commonjs'}, ` +
        `module=${manifest.module ?? '-'}, exports=${manifest.exports ? 'ada' : '-'}). ` +
        'Paket CommonJS yang di-exclude akan disajikan mentah ke browser di dev ' +
        'dan gagal dengan "module is not defined". Keluarkan dari ' +
        '`optimizeDeps.exclude` di web/vite.config.ts.',
    ).toBe(true);
  });

  /**
   * Penjaga arah sebaliknya: kalau suatu saat `vorbis-encoder-js` dimasukkan
   * lagi "biar konsisten dengan encoder lossy yang lain", tes di atas memang
   * akan merah — tapi kalimat ini yang menjelaskan kenapa ia pernah ada di sana.
   */
  it('vorbis-encoder-js tetap di luar daftar (paketnya CommonJS murni)', () => {
    expect(excludedPackages()).not.toContain('vorbis-encoder-js');
  });
});
