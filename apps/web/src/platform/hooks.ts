/**
 * Hook platform untuk komponen app.
 *
 * Kenapa lewat modul ini, bukan langsung `@kelasmalam/platform/use…`: hook
 * memanggil `getPlatformHost()` milik paket, dan host-nya baru ada kalau
 * pemilih app (`./index`) sudah dimuat. Di produksi `main.tsx` menjaminnya;
 * komponen yang dirender sendirian di tes tidak — jadi impor `./index` di
 * bawah ada demi efek sampingnya: mendaftarkan resolver.
 *
 * Kenapa TIDAK digabung ke `./index`: modul itu dimuat worker, dan hook
 * membawa React ke bundel worker (lihat komentar `@kelasmalam/platform`).
 */

import './index';

export { useAudioFilePicker, type AudioFilePicker, type AudioFilePickerOptions } from '@kelasmalam/platform/useAudioFilePicker';
export { hitTest, useNativeFileDrop } from '@kelasmalam/platform/useNativeFileDrop';
