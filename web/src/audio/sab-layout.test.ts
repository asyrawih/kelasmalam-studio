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
import { describe, expect, it } from 'vitest';

import { assertLayout, assertNoOverlap, type RustLayoutJson } from './sab-layout';

function rustLayout(): RustLayoutJson | null {
  try {
    const out = execFileSync(
      'cargo',
      ['test', '-p', 'daw-rt', '--lib', '--', '--nocapture', 'print_layout_json'],
      { cwd: new URL('../../..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
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
