/**
 * Katalog model vocal split (docs/26 §1). Semua angka DIUKUR dari berkas
 * yang diunduh (September 2026), bukan disalin dari ingatan.
 *
 * Dipisah dari pemuat ORT (pola `proof-stem/scnet-catalog.ts`) supaya adapter
 * host (`apps/desktop/src/platform/desktop.ts` memverifikasi `bytes`) bisa
 * membacanya tanpa menarik ORT.
 *
 * `url` adalah URL *resolve* HuggingFace, bukan URL CDN yang berubah-ubah;
 * isi berkas dijaga `sha256`, bukan URL. Model diunduh dan disimpan di sisi
 * client di kedua platform — tidak pernah di-rehost (docs/26 §2 butir 3).
 *
 * Angka `bytes`/`sha256` HARUS sama dengan `ModelId::KimVocal2` di
 * `crates/desktop-host/src/model.rs`; Rust dan TS tidak berbagi konstanta,
 * jadi kebenaran yang sama ditulis dua kali dan dijaga tes.
 */

import type { VocalModelId } from '@kelasmalam/platform/host';

export type { VocalModelId };

/**
 * Parameter MDX-Net dari `model_data.json` UVR untuk hash model ini.
 * Semuanya menentukan bentuk tensor; salah satu saja meleset → ORT menolak
 * dengan shape mismatch.
 */
export interface MdxParams {
  /** Ukuran FFT (window Hann). */
  readonly nFft: number;
  /** Lompatan STFT; tetap 1024 di seluruh keluarga MDX-Net. */
  readonly hop: number;
  /** Bin frekuensi terbawah yang masuk model; sisanya dibuang lalu diisi nol saat iSTFT. */
  readonly dimF: number;
  /** Frame per segmen = 2^dimT. */
  readonly dimT: number;
  /** Pengali output vokal sebelum `inst = mix − vocals × compensate`. */
  readonly compensate: number;
}

export interface VocalModelDefinition {
  readonly id: VocalModelId;
  readonly label: string;
  /** Nama berkas di cache client (`appDataDir()/models/` di desktop, OPFS di web). */
  readonly fileName: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mdx: MdxParams;
  /** Atribusi yang ditampilkan di dialog (docs/26 §7 butir 1). */
  readonly attribution: string;
}

export const VOCAL_MODELS: Record<VocalModelId, VocalModelDefinition> = {
  'kim-vocal-2': {
    id: 'kim-vocal-2',
    label: 'KIM VOCAL 2 · MDX-NET',
    fileName: 'Kim_Vocal_2.onnx',
    url: 'https://huggingface.co/seanghay/uvr_models/resolve/main/Kim_Vocal_2.onnx',
    bytes: 66_759_214,
    sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
    mdx: { nFft: 7680, hop: 1024, dimF: 3072, dimT: 8, compensate: 1.009 },
    attribution: 'Kim_Vocal_2 oleh KimberleyJSN, disebarkan lewat Ultimate Vocal Remover (Anjok07). Diunduh langsung dari mirror publik ke perangkat ini.',
  },
};

/** Frame per segmen: `2^dimT`. */
export function framesPerSegment(mdx: MdxParams): number {
  return 2 ** mdx.dimT;
}

/** Sampel per segmen: `hop × (frames − 1)` — 261 120 untuk Kim_Vocal_2. */
export function samplesPerSegment(mdx: MdxParams): number {
  return mdx.hop * (framesPerSegment(mdx) - 1);
}

/** Sampel yang dipotong di kedua tepi tiap segmen: `nFft / 2`. */
export function segmentTrim(mdx: MdxParams): number {
  return mdx.nFft / 2;
}

/**
 * Ukuran adalah pemeriksaan termurah bahwa unduhan tidak terpotong; hash
 * penuh dihitung sekali saat unduh, bukan tiap kali model dimuat.
 */
export function assertVocalModelSize(model: VocalModelDefinition, actual: number): void {
  if (actual !== model.bytes) {
    throw new Error(`Model ${model.label} tidak lengkap: ${actual} / ${model.bytes} byte`);
  }
}
