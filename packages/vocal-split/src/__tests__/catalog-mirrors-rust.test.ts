/**
 * @vitest-environment node
 *
 * `VOCAL_MODELS` (TS) dan `ModelId::KimVocal2` (`crates/desktop-host/src/model.rs`)
 * adalah kebenaran yang sama ditulis dua kali — Rust dan TS tidak berbagi
 * konstanta (docs/26 §5, P2). Tes ini membaca berkas Rust sebagai TEKS dan
 * memastikan `bytes`, `sha256`, `fileName`, `url`, dan id tiap model vocal
 * muncul di sana. Pasangannya di sisi Rust:
 * `model_specs_mirror_typescript_definitions` di `crates/desktop-host/src/tests.rs`.
 *
 * Membandingkan teks, bukan menjalankan Rust: cukup untuk menangkap "angka
 * diubah di satu sisi saja", dan tidak butuh toolchain Rust di vitest.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VOCAL_MODELS, type VocalModelId } from '../catalog';

const MODEL_RS = fileURLToPath(new URL('../../../../crates/desktop-host/src/model.rs', import.meta.url));
const RUST = readFileSync(MODEL_RS, 'utf8');

/** Nama varian Rust untuk tiap id TS — dijaga eksplisit supaya id baru tidak lolos tanpa varian. */
const RUST_VARIANT: Record<VocalModelId, string> = {
  'kim-vocal-2': 'KimVocal2',
};

/** `66_759_214` di Rust ditulis dengan pemisah ribuan; `66759214` juga diterima. */
function rustIntegerPattern(n: number): RegExp {
  const digits = String(n);
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  return new RegExp(`\\b(${grouped}|${digits})\\b`);
}

describe('VOCAL_MODELS == ModelId di crates/desktop-host/src/model.rs (docs/26 P2)', () => {
  it('berkas Rust terbaca dan memang modul model', () => {
    expect(RUST).toMatch(/pub enum ModelId/);
    expect(Object.keys(VOCAL_MODELS).length).toBeGreaterThan(0);
  });

  it.each(Object.values(VOCAL_MODELS))('$id: varian, id string, nama berkas, bytes, sha256, url ada di Rust', (model) => {
    expect(RUST).toContain(`ModelId::${RUST_VARIANT[model.id]}`);
    expect(RUST).toContain(`"${model.id}"`);
    expect(RUST).toContain(`"${model.fileName}"`);
    expect(RUST).toMatch(rustIntegerPattern(model.bytes));
    expect(RUST).toContain(model.sha256);
    expect(RUST).toContain(`"${model.url}"`);
  });

  it('sha256 TS berbentuk 64 digit hex huruf kecil (bentuk yang dibaca hex32 di Rust)', () => {
    for (const model of Object.values(VOCAL_MODELS)) expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
