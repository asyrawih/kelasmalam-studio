/**
 * Hook platform untuk komponen app desktop — bentuknya sama dengan
 * `apps/web/src/platform/hooks.ts`, alasannya pun sama: hook memanggil
 * `getPlatformHost()` milik paket, dan host-nya baru ada kalau pemilih app
 * (`./index`) sudah dimuat. Impor `./index` di bawah ada demi efek sampingnya.
 *
 * Tidak digabung ke `./index` karena modul itu boleh dimuat konteks tanpa
 * React (lihat komentar `@kelasmalam/platform`).
 */

import './index';

export { useAudioFilePicker, type AudioFilePicker, type AudioFilePickerOptions } from '@kelasmalam/platform/useAudioFilePicker';
export { hitTest, useNativeFileDrop } from '@kelasmalam/platform/useNativeFileDrop';
