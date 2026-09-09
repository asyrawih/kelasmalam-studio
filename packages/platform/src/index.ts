/**
 * `@kelasmalam/platform` — KONTRAK `PlatformHost` (docs/20 §2c) dan pintu
 * untuk mendapatkannya (`host-registry.ts`). Paket ini tidak tahu web maupun
 * desktop (docs/25 §1d); app-nya yang mendaftarkan resolver host.
 *
 * Dua hook (`useAudioFilePicker`, `useNativeFileDrop`) SENGAJA tidak diekspor
 * ulang dari sini — impor lewat subpath `@kelasmalam/platform/useAudioFilePicker`.
 * Alasannya bundel worker: `stem/auto-stem.worker.ts` memuat pemilih platform
 * app untuk mendapat host, dan pemilih itu mengimpor modul ini. Hook mengimpor
 * `react`, yang CommonJS dan tidak bisa dibuang tree-shaking walau tidak
 * dipakai — hasilnya +2,7 KB gzip di TIAP worker (terukur saat P1). Jalur
 * "hanya butuh host" harus tetap bebas React.
 *
 * Registry ada di modul terpisah karena hook mengimpornya: kalau ia hidup di
 * sini, `index` → hook → `index` jadi siklus impor.
 */

export { getPlatformHost, registerPlatformHostResolver, setPlatformHostForTests } from './host-registry';
export type {
  DropPoint,
  LoginRequest,
  ModelBytes,
  OpenAudioFilesOptions,
  PlatformHost,
  PlatformKind,
  SaveTarget,
} from './host';
