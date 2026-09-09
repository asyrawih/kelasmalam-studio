/**
 * Deklarasi untuk import bersuffix `?worklet&url`, ditangani
 * `audioWorkletPlugin()` di vite.config.ts.
 *
 * Suffix-nya WAJIB dipakai untuk memuat worklet. Tanpa itu — mis. dengan
 * `new URL('./audio/worklet-processor.ts', import.meta.url)` — Vite menyalin
 * berkas TypeScript-nya MENTAH sebagai aset, dan `audioWorklet.addModule()`
 * gagal dengan SyntaxError di produksi. Di dev tidak terlihat karena
 * dev-server men-transform berkasnya saat diminta.
 */
declare module '*?worklet&url' {
  const url: string;
  export default url;
}
