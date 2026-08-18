/**
 * Tes sinkronisasi peta slot param Rust ↔ TS.
 *
 * Sumber kebenaran ada di `crates/engine/src/fx/params.rs`. Sebelum tes ini,
 * kedua sisi cuma diikat oleh komentar; menggeser `PARAMS_PER_TRACK` di salah
 * satunya akan membuat fader satu track mengemudikan gain track lain, tanpa
 * error di mana pun.
 *
 * Kalau cargo tidak tersedia (CI front-end saja), tes dilewati — job `wasm`
 * yang menegakkannya, pola yang sama dengan `sab-layout.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertParamMap, assertParamRegions, type RustParamMapJson } from './param-map';

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

function rustParamMap(): RustParamMapJson | null {
  const cwd = repoRoot();
  if (cwd === null) return null;
  try {
    const out = execFileSync(
      'cargo',
      ['test', '-p', 'daw-engine', '--lib', '--', '--nocapture', 'print_param_map_json'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const line = out.split('\n').find((l) => l.trim().startsWith('{"paramSlots"'));
    return line ? (JSON.parse(line.trim()) as RustParamMapJson) : null;
  } catch {
    return null;
  }
}

describe('param-map', () => {
  it('wilayah slot tidak tumpang tindih', () => {
    expect(() => assertParamRegions()).not.toThrow();
  });

  it('cocok dengan crates/engine/src/fx/params.rs', () => {
    const rust = rustParamMap();
    if (!rust) return;
    expect(() => assertParamMap(rust)).not.toThrow();
  });
});
