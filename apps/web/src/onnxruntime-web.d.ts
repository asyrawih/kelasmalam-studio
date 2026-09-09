// ORT 1.21 ships `types.d.ts` but omits a `types` condition from `exports`, so
// TypeScript's bundler resolution cannot see it. Keep this shim until ORT fixes
// the package export map.
declare module 'onnxruntime-web' {
  export * from 'onnxruntime-common';
}

declare module 'onnxruntime-web/wasm' {
  export * from 'onnxruntime-common';
}
