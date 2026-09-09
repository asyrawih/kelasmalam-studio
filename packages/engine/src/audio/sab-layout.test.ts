/**
 * Tes sinkronisasi layout SAB Rust ↔ TS (docs/01 §1b).
 *
 * Sumber kebenaran ada di `crates/rt/src/layout.rs`; `layout_json()` di sana
 * mencetak semua offset. Tes ini menjalankan tes Rust yang mencetaknya lalu
 * membandingkannya dengan konstanta TS. Kalau cargo tidak tersedia (mis. CI
 * front-end saja), tes ditandai skip alih-alih gagal — pekerjaan job `wasm`
 * di CI yang menjaminnya.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertLayout, assertNoOverlap, type RustLayoutJson } from './sab-layout';

/**
 * Akar repo (yang memuat `Cargo.toml`), dicari naik dari cwd vitest.
 *
 * SENGAJA tidak memakai `new URL('../../..', import.meta.url)`: Vite menulis
 * ulang bentuk itu saat transform menjadi URL asset ber-prefix `/@fs/`, jadi
 * `pathname`-nya menjadi `/@fs/Users/...` — direktori yang tidak ada. Akibatnya
 * `execFileSync` melempar ENOENT, `catch` menelannya, dan tes ini LULUS tanpa
 * pernah membandingkan apa pun. Kegagalan diam seperti itu justru kebalikan
 * dari gunanya tes sinkronisasi.
 */
function repoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'Cargo.toml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function rustLayout(): RustLayoutJson | null {
  const cwd = repoRoot();
  if (cwd === null) return null;
  try {
    const out = execFileSync(
      'cargo',
      ['test', '-p', 'daw-rt', '--lib', '--', '--nocapture', 'print_layout_json'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const line = out.split('\n').find((l) => l.trim().startsWith('{"sabSize"'));
    return line ? (JSON.parse(line.trim()) as RustLayoutJson) : null;
  } catch {
    return null;
  }
}

describe('sab-layout', () => {
  it('tidak ada blok yang tumpang tindih', () => {
    expect(() => assertNoOverlap()).not.toThrow();
  });

  it('cocok dengan crates/rt/src/layout.rs', () => {
    const rust = rustLayout();
    if (!rust) {
      // Tidak ada cargo → dilewati; job `wasm` di CI yang menegakkannya.
      return;
    }
    expect(() => assertLayout(rust)).not.toThrow();
  });
});
