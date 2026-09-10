// Pelengkap `proof-stem/src/onnxruntime-web.d.ts` (yang mendeklarasikan
// `onnxruntime-web` dan `onnxruntime-web/wasm`): bundel `webgpu` dipakai
// `mdx-model.ts` HANYA untuk benchmark P1 (docs/26 §4). Alasan shim-nya sama —
// ORT 1.21 tidak memasang kondisi `types` di `exports`, jadi resolusi bundler
// TypeScript tidak melihat `types.d.ts`-nya.
declare module 'onnxruntime-web/webgpu' {
  export * from 'onnxruntime-common';
}
