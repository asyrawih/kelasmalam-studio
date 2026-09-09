/**
 * @vitest-environment node
 *
 * Penjaga statis: pintu ke platform hanya ada di `platform/`.
 *
 * KENAPA INI PUNYA TES SENDIRI. `desktop.ts` bekerja hanya kalau SEMUA jalan
 * keluar dari WebView lewat host: `location.href =` menavigasi WebView ke
 * Google dan tidak pernah kembali; `showSaveFilePicker` tidak ada di
 * WKWebView; `window.open` membuka jendela Tauri kosong tanpa tombol kembali.
 * Tidak satu pun dari itu gagal di tes jsdom maupun di `pnpm build` — ia
 * hanya gagal di tangan user desktop. Jadi yang diperiksa adalah SUMBERNYA,
 * seperti `wasm-exclude.test.ts` memeriksa konfigurasi Vite sungguhan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
/**
 * `packages/*\/src` ikut dipindai (docs/25 P1): paket-paket itu masuk bundel
 * web yang sama, dan aturan "pintu keluar hanya lewat host" berlaku untuknya
 * lebih ketat lagi — paket bahkan tidak boleh tahu platformnya (§1b).
 */
const PACKAGES = fileURLToPath(new URL('../../../../packages', import.meta.url));

/** Pola dan alasannya — pesan gagalnya harus menyebut ke mana harus pindah. */
const FORBIDDEN: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /\blocation\.href\s*=/, why: 'navigasi keluar → PlatformHost.login()/openExternal()' },
  { re: /\blocation\.(assign|replace|reload)\s*\(/, why: 'navigasi/reload tidak dijanjikan di tauri:// (docs/20 §2b)' },
  { re: /\bshowSaveFilePicker\b/, why: 'simpan berkas → PlatformHost.pickSaveTarget()' },
  { re: /\bwindow\.open\s*\(/, why: 'tautan keluar → PlatformHost.openExternal()' },
];

/**
 * Pengecualian, masing-masing dengan alasan:
 *   - `packages/engine/src/audio/caps.ts`: hanya `'showSaveFilePicker' in
 *     globalThis` — probe kemampuan untuk laporan, bukan panggilan.
 *
 * `app-shell/AppShell.tsx` pernah ada di sini (dua `location.href =` untuk
 * login); sekarang login dari shell lewat `PlatformHost.login()`, dan penjagaan
 * ini berlaku lagi untuknya.
 */
const ALLOWED: ReadonlySet<string> = new Set(['packages/engine/src/audio/caps.ts']);

/** Path relatif yang dilaporkan: `apps/web/src/...` atau `packages/...`. */
function label(full: string): string {
  return full.startsWith(SRC) ? relative(SRC, full) : 'packages/' + relative(PACKAGES, full);
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(SRC, full);
    if (rel === 'platform' || name === 'wasm' || name === '__tests__' || name === 'node_modules') continue;
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || name.endsWith('.d.ts')) continue;
    yield full;
  }
}

describe('pintu platform hanya di platform/', () => {
  const files = [...sources(SRC), ...sources(PACKAGES)].map((full) => [label(full), full] as const);

  it('ada berkas yang diperiksa', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN)('$re tidak dipakai langsung ($why)', ({ re }) => {
    const hits = files
      .filter(([rel, full]) => !ALLOWED.has(rel) && re.test(readFileSync(full, 'utf8')))
      .map(([rel]) => rel);
    expect(hits, `pindahkan ke apps/web/src/platform/: ${hits.join(', ')}`).toEqual([]);
  });

  it('pengecualian yang tercatat masih memang perlu (kalau tidak, hapus dari ALLOWED)', () => {
    for (const rel of ALLOWED) {
      const full = files.find(([r]) => r === rel)?.[1];
      expect(full, `${rel} tidak ditemukan — path di ALLOWED sudah basi`).toBeDefined();
      const text = readFileSync(full!, 'utf8');
      expect(
        FORBIDDEN.some(({ re }) => re.test(text)),
        `${rel} sudah bersih — keluarkan dari ALLOWED supaya penjagaan ini berlaku lagi untuknya`,
      ).toBe(true);
    }
  });

  /**
   * Sejak docs/25 P2 tidak ada pengecualian: `app-shell/desktop.ts` (yang dulu
   * boleh mengimpor `isTauri` statis) pindah ke `apps/desktop/src/window/`.
   * Penjaga yang lebih luas — tanpa `@tauri-apps` sama sekali, statis maupun
   * dinamis — ada di `__tests__/no-desktop-leak.test.ts`; yang di sini tinggal
   * lapis kedua untuk impor statis.
   */
  it('bundel web tidak meng-import @tauri-apps/* secara statis', () => {
    const hits = files
      .filter(([, full]) => /^\s*import\s[^;]*from\s+['"]@tauri-apps\//m.test(readFileSync(full, 'utf8')))
      .map(([rel]) => rel);
    expect(hits).toEqual([]);
  });
});
