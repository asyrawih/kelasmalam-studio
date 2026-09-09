/**
 * @vitest-environment node
 *
 * Permukaan artefak WASM.
 *
 * Kegagalan yang dijaga di sini sudah terjadi dua kali, dan dua-duanya sampai
 * ke user sebagai kalimat yang tidak menyebut penyebabnya:
 *
 *   wasm.exports.assetBytesLive is not a function
 *   imported Memory with incompatible maximum size
 *
 * Keduanya berarti satu hal — artefak di `web/src/wasm/` lebih lama daripada
 * kode yang memanggilnya. Artefak itu tidak dilacak git, jadi `git pull` tidak
 * pernah membawanya dan tidak ada satu pun sinyal bahwa ia perlu dibangun
 * ulang. Cek ABI yang sudah ada pun tidak menangkapnya: sampai versi 2,
 * cakupannya hanya `raw` + layout SAB, tidak pernah permukaan `bindgen`.
 *
 * Jadi tes ini menuntut dua hal dari artefak yang BENAR-BENAR ada di pohon ini:
 * seluruh nama di `REQUIRED_EXPORTS` tersedia, dan `abiVersion()`-nya cocok.
 * Kalau tes ini merah, artefaknya basi — dan itu memang keadaan di mana
 * aplikasinya tidak akan jalan, jadi merahnya benar.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertArtifactSurface,
  EXPECTED_ABI_VERSION,
  REQUIRED_EXPORTS,
  REQUIRED_METHODS,
} from './wasm-loader';

/** Glue varian st — satu-satunya yang bisa di-instantiate di Node tanpa COI. */
const GLUE_URL = new URL('../wasm/st/engine.js', import.meta.url);
const WASM_PATH = fileURLToPath(new URL('../wasm/st/engine_bg.wasm', import.meta.url));

const haveArtifact = existsSync(fileURLToPath(GLUE_URL)) && existsSync(WASM_PATH);

describe('assertArtifactSurface', () => {
  /** Glue palsu yang memenuhi seluruh kontrak. */
  function completeGlue(): Record<string, unknown> {
    const mod: Record<string, unknown> = {};
    for (const name of REQUIRED_EXPORTS) mod[name] = () => undefined;
    for (const [className, methods] of Object.entries(REQUIRED_METHODS)) {
      const ctor = function Ctor(): void {};
      for (const m of methods) (ctor.prototype as Record<string, unknown>)[m] = () => undefined;
      mod[className] = ctor;
    }
    return mod;
  }

  it('lolos untuk glue yang lengkap', () => {
    expect(() => assertArtifactSurface(completeGlue())).not.toThrow();
  });

  it('menyebut nama tingkat atas yang hilang, dan perintah yang harus dijalankan', () => {
    const mod = completeGlue();
    delete mod['assetBytesLive'];
    // Persis nama yang meledak di tangan user, dengan kalimat yang kali ini
    // menyebut apa yang harus ia lakukan.
    expect(() => assertArtifactSurface(mod)).toThrow(/assetBytesLive/);
    expect(() => assertArtifactSurface(mod)).toThrow(/pnpm build:wasm/);
  });

  /**
   * Memeriksa nama tingkat atas saja tidak cukup: `beginAsset` adalah method di
   * `OfflineRender`, jadi artefak yang masih memakai `registerAsset` lama akan
   * lolos daftar tingkat atas dengan mulus.
   */
  it('menangkap method yang hilang di kelas, bukan cuma export tingkat atas', () => {
    const mod = completeGlue();
    const ctor = mod['OfflineRender'] as { prototype: Record<string, unknown> };
    delete ctor.prototype['beginAsset'];
    expect(() => assertArtifactSurface(mod)).toThrow(/OfflineRender\.beginAsset/);
  });

  /** Satu kelas yang hilang jangan dilaporkan sebagai belasan method hilang. */
  it('tidak melaporkan kelas yang hilang dua kali', () => {
    const mod = completeGlue();
    delete mod['WavEncoderHandle'];
    let message = '';
    try {
      assertArtifactSurface(mod);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/WavEncoderHandle/);
    expect(message).not.toMatch(/WavEncoderHandle\.header/);
    expect(message).toMatch(/1 nama yang dibutuhkan/);
  });

  it('tidak melempar untuk modul kosong atau null — hanya melaporkan semuanya', () => {
    expect(() => assertArtifactSurface(null)).toThrow(/pnpm build:wasm/);
    expect(() => assertArtifactSurface({})).toThrow(/initSync/);
  });
});

describe('artefak di pohon ini', () => {
  it('menyediakan seluruh permukaan yang dibutuhkan loader', async () => {
    if (!haveArtifact) return; // belum `pnpm build:wasm` — tes lain menutupinya
    const glue = (await import(/* @vite-ignore */ GLUE_URL.href)) as Record<string, unknown>;
    expect(() => assertArtifactSurface(glue)).not.toThrow();
  });

  it('ABI-nya cocok dengan yang diharapkan JS', async () => {
    if (!haveArtifact) return;
    const glue = (await import(/* @vite-ignore */ GLUE_URL.href)) as {
      initSync: (input: { module: WebAssembly.Module }) => unknown;
      abiVersion: () => number;
    };
    // Varian st mengekspor memory-nya sendiri, jadi `initSync` hanya butuh
    // modulnya.
    const module = await WebAssembly.compile(readFileSync(WASM_PATH));
    glue.initSync({ module });
    expect(glue.abiVersion()).toBe(EXPECTED_ABI_VERSION);
  });
});
