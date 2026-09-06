/**
 * Katalog model SCNet: id, URL web, ukuran, dan hash.
 *
 * Dipisah dari `scnet-model.ts` supaya adapter platform (`platform/web.ts`
 * mengunduh dari `url`, `platform/desktop.ts` memverifikasi `bytes`) bisa
 * membacanya tanpa menarik ORT — dan tanpa siklus impor, karena
 * `scnet-model.ts` sendiri memakai adapter itu.
 */

export type ScnetModelId = 'base' | 'large';

export interface ScnetModelDefinition {
  readonly id: ScnetModelId;
  readonly label: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const SCNET_MODELS: Record<ScnetModelId, ScnetModelDefinition> = {
  base: {
    id: 'base', label: 'BASE · REALTIME',
    url: '/models/scnet/scnet-base.onnx', bytes: 44_516_685,
    sha256: '29137273515c3f10dc69e22a84a63bfc09b71abdf27cf801da463e0644870ade',
  },
  large: {
    id: 'large', label: 'LARGE · QUALITY',
    url: '/models/scnet/scnet-large.onnx', bytes: 170_914_085,
    sha256: 'b604b88207a8b3830b7969c7aef708c56710a39bd1c8b196f105ee7b68c0f939',
  },
};

export interface ScnetModelDownloadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly cacheHit: boolean;
}

/**
 * Ukuran adalah pemeriksaan termurah bahwa unduhan tidak terpotong; hash penuh
 * dari 170 MB terlalu mahal untuk dilakukan tiap kali model dimuat.
 */
export function assertModelSize(model: ScnetModelDefinition, actual: number): void {
  if (actual !== model.bytes) {
    throw new Error(`Model ${model.label} tidak lengkap: ${actual} / ${model.bytes} byte`);
  }
}
