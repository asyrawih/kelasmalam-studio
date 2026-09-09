/**
 * Ekspor ulang: letak `onnxruntime-web/dist/` kini dihitung di
 * `packages/engine/vite/ort-dist.ts` (dipakai dua app, docs/25 P2). Berkas ini
 * dipertahankan supaya `src/__tests__/ort-dist.test.ts` tetap mengimpor
 * `../../ort-dist` — yang diuji adalah fungsi yang SAMA dengan yang dipakai
 * `vite.config.ts`, bukan salinannya.
 */
export { ORT_DIST_ALIAS, ortDistDir } from '../../packages/engine/vite/ort-dist';
