/**
 * Dua hook platform, satu pintu — untuk KOMPONEN.
 *
 * Sengaja bukan bagian `index.ts`: modul itu dimuat worker (lewat pemilih
 * host app) dan hook membawa React ke bundel worker (+2,7 KB gzip per worker,
 * terukur saat P1). Komponen tidak punya masalah itu, dan satu specifier
 * (`@kelasmalam/platform/hooks`) lebih mudah dijaga daripada dua.
 *
 * Host-nya harus sudah terdaftar oleh pemilih app (`apps/<app>/src/platform`)
 * sebelum komponen dirender; di tes, `setup.ts` app yang menjaminnya.
 */
export { useAudioFilePicker, type AudioFilePicker, type AudioFilePickerOptions } from './useAudioFilePicker';
export { hitTest, useNativeFileDrop } from './useNativeFileDrop';
