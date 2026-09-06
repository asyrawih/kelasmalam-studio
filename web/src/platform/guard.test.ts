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

/** Pola dan alasannya — pesan gagalnya harus menyebut ke mana harus pindah. */
const FORBIDDEN: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /\blocation\.href\s*=/, why: 'navigasi keluar → PlatformHost.login()/openExternal()' },
  { re: /\blocation\.(assign|replace|reload)\s*\(/, why: 'navigasi/reload tidak dijanjikan di tauri:// (docs/20 §2b)' },
  { re: /\bshowSaveFilePicker\b/, why: 'simpan berkas → PlatformHost.pickSaveTarget()' },
  { re: /\bwindow\.open\s*\(/, why: 'tautan keluar → PlatformHost.openExternal()' },
];

/**
 * Pengecualian, masing-masing dengan alasan:
 *   - `audio/caps.ts`: hanya `'showSaveFilePicker' in globalThis` — probe
 *     kemampuan untuk laporan, bukan panggilan.
 *   - `app-shell/AppShell.tsx`: dua `location.href =` untuk login di landing
 *     dan gerbang halaman. Milik pekerjaan app-shell (docs/20 D5); sampai
 *     dipindahkan ke `PlatformHost.login()`, login dari sana hanya benar di
 *     web. Hapus baris ini begitu dipindahkan.
 */
const ALLOWED: ReadonlySet<string> = new Set(['audio/caps.ts', 'app-shell/AppShell.tsx']);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(SRC, full);
    if (rel === 'platform' || rel === 'wasm' || name === '__tests__' || name === 'node_modules') continue;
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || name.endsWith('.d.ts')) continue;
    yield rel;
  }
}

describe('pintu platform hanya di platform/', () => {
  const files = [...sources(SRC)];

  it('ada berkas yang diperiksa', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN)('$re tidak dipakai langsung ($why)', ({ re }) => {
    const hits = files.filter((rel) => !ALLOWED.has(rel) && re.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(hits, `pindahkan ke web/src/platform/: ${hits.join(', ')}`).toEqual([]);
  });

  it('pengecualian yang tercatat masih memang perlu (kalau tidak, hapus dari ALLOWED)', () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(
        FORBIDDEN.some(({ re }) => re.test(text)),
        `${rel} sudah bersih — keluarkan dari ALLOWED supaya penjagaan ini berlaku lagi untuknya`,
      ).toBe(true);
    }
  });

  it('bundel web tidak meng-import plugin Tauri secara statis di luar platform/', () => {
    const hits = files.filter((rel) =>
      /^\s*import\s[^;]*from\s+['"]@tauri-apps\//m.test(readFileSync(join(SRC, rel), 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});
