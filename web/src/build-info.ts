/**
 * Identitas build — supaya pertanyaan "yang jalan di produksi itu versi mana"
 * bisa dijawab dari layar, bukan dari menebak deployment mana yang terakhir
 * naik.
 *
 * Nilainya DI-INJECT SAAT BUILD lewat `define` di `web/vite.config.ts`, bukan
 * dibaca saat runtime: bundel produksi tidak punya akses ke git maupun
 * `process.env`. Konsekuensinya, di lingkungan yang tidak melewati Vite
 * (vitest memakai `vitest.config.ts` sendiri) semua nilainya kosong — jadi
 * setiap field di sini WAJIB punya jalur "tidak diketahui" yang rapi, dan
 * labelnya tidak boleh berbohong dengan memampangkan versi palsu.
 */

/** Satu build, sebagaimana diketahui oleh bundel yang sedang berjalan. */
export interface BuildInfo {
  /** `version` dari `web/package.json`, mis. `0.1.0`. */
  readonly version: string;
  /** Commit pendek, mis. `678a10f`. Kosong kalau build-nya di luar git. */
  readonly commit: string;
  /** Branch sumber build, mis. `main`. Kosong kalau tidak diketahui. */
  readonly branch: string;
  /** Waktu build dalam ISO-8601. Kosong kalau tidak diketahui. */
  readonly builtAt: string;
}

/**
 * Referensinya HARUS statis dan utuh seperti ini — `define` mengganti teks
 * `import.meta.env.VITE_…` apa adanya, jadi bentuk dinamis
 * (`import.meta.env[key]`) tidak akan pernah tersubstitusi dan selalu kosong
 * di produksi.
 */
export const BUILD_INFO: BuildInfo = {
  version: import.meta.env.VITE_APP_VERSION ?? '',
  commit: import.meta.env.VITE_BUILD_COMMIT ?? '',
  branch: import.meta.env.VITE_BUILD_BRANCH ?? '',
  builtAt: import.meta.env.VITE_BUILD_TIME ?? '',
};

/**
 * Label pendek untuk topbar: `v0.1.0 · 678a10f`.
 *
 * Tanpa commit ia menjadi `v0.1.0`, dan tanpa keduanya `DEV` — lebih baik
 * mengaku tidak tahu daripada memampangkan `v` kosong.
 */
export function versionLabel(info: BuildInfo = BUILD_INFO): string {
  const parts: string[] = [];
  if (info.version !== '') parts.push(`v${info.version}`);
  if (info.commit !== '') parts.push(info.commit);
  return parts.length === 0 ? 'DEV' : parts.join(' · ');
}

/**
 * Keterangan lengkap untuk `title=` — di sinilah waktu build tinggal, karena
 * itulah yang sebenarnya membedakan dua deploy dengan nomor versi sama.
 */
export function versionTitle(info: BuildInfo = BUILD_INFO): string {
  const lines: string[] = [`Versi ${info.version === '' ? '(tidak diketahui)' : info.version}`];
  if (info.commit !== '') lines.push(`Commit ${info.commit}`);
  if (info.branch !== '') lines.push(`Branch ${info.branch}`);
  lines.push(`Build ${formatBuiltAt(info.builtAt)}`);
  return lines.join('\n');
}

/**
 * Waktu build dalam zona waktu pembaca. Tanggal ISO yang rusak (atau kosong)
 * tidak boleh bocor ke UI sebagai `Invalid Date`, jadi ia diturunkan menjadi
 * teks yang jujur.
 */
export function formatBuiltAt(iso: string): string {
  if (iso === '') return '(tidak diketahui)';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '(tidak diketahui)';
  return at.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
