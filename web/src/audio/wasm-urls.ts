/**
 * URL artefak WASM — HARUS literal statis, jangan pernah di-template.
 *
 * Vite menangani `new URL('...', import.meta.url)` secara khusus: ia memindai
 * pola itu saat transform dan menggantinya dengan URL aset yang benar. Kalau
 * argumennya template literal (`../wasm/${variant}/`), ia tidak bisa
 * menyelesaikannya secara statis dan menggantinya dengan lookup ke map aset —
 * yang di sini KOSONG. Hasilnya `undefined`, lalu URL relatif berikutnya jatuh
 * kembali ke direktori modul ini sendiri:
 *
 *     diminta : /src/wasm/mt/engine_bg.wasm
 *     diminta Vite : /src/audio/engine_bg.wasm      ← 404 → SPA fallback (HTML)
 *
 * Dan karena dev-server menjawab 404 dengan index.html berstatus 200, gejalanya
 * menyamar jadi "artefak WASM belum dibangun" padahal file-nya ada dan sehat.
 *
 * Satu entri literal per varian membuat Vite bisa menyelesaikannya, dan
 * membuat kesalahan ini mustahil terulang tanpa terlihat.
 */

import type { WasmVariant } from './caps';

export interface WasmUrls {
  readonly glue: string;
  readonly wasm: string;
}

export const WASM_URLS: Record<WasmVariant, WasmUrls> = {
  mt: {
    glue: new URL('../wasm/mt/engine.js', import.meta.url).href,
    wasm: new URL('../wasm/mt/engine_bg.wasm', import.meta.url).href,
  },
  st: {
    glue: new URL('../wasm/st/engine.js', import.meta.url).href,
    wasm: new URL('../wasm/st/engine_bg.wasm', import.meta.url).href,
  },
};
