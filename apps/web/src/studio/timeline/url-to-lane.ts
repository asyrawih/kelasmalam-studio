/**
 * Jembatan tipis: URL → byte → jalur import yang sama dengan drop file.
 *
 * Sengaja terpisah dari `url-import.ts` (yang murni jaringan, tanpa store) dan
 * dari `audio-import.ts` (yang murni decode) supaya keduanya tetap bisa dites
 * tanpa saling menyeret.
 *
 * ## Importer yang DIDAFTARKAN app, bukan dipilih dari platform
 *
 * `classifyUrl` menggolongkan YouTube sebagai `needs-server`: dari browser
 * memang tidak akan pernah bisa. Di desktop ada jalan lain — yt-dlp yang
 * dijalankan Rust (docs/23) — dan dulu berkas ini bertanya
 * `getPlatformHost().kind` lalu mengimpor `youtube/` sendiri. Sejak docs/25
 * P2 tidak lagi: app desktop MENDAFTARKAN importer YouTube-nya lewat
 * `registerUrlImporter` (di `main.tsx`), dan berkas ini hanya menanyakan
 * "ada yang mau menangani URL ini?" kepada daftar itu SEBELUM menyentuh
 * `fetch`. Web tidak mendaftarkan apa pun, jadi pesannya tetap yang lama:
 * unduh dulu, lalu drop berkasnya. Bundel web tidak membawa satu byte pun
 * kode YouTube.
 */

import { importBytesToLane, type DropResult, type LaneImportOptions } from './audio-import';
import { classifyUrl, fetchAudioUrl, type UrlKind } from './url-import';

/** Satu jalur khusus untuk sebagian URL — didaftarkan app (docs/25 §1c). */
export interface UrlImporter {
  /** `true` kalau importer ini yang menangani URL bergolongan `cls`. */
  matches(cls: UrlKind, text: string): boolean;
  import(
    text: string,
    laneId: string,
    startSamples: number,
    projectSampleRate: number,
    opts: LaneImportOptions,
  ): Promise<DropResult>;
}

const importers: UrlImporter[] = [];

/** Kembaliannya melepas pendaftaran — dipakai tes; app memanggilnya sekali di `main.tsx`. */
export function registerUrlImporter(importer: UrlImporter): () => void {
  importers.push(importer);
  return () => {
    const i = importers.indexOf(importer);
    if (i !== -1) importers.splice(i, 1);
  };
}

export async function importUrlToLane(
  text: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  const cls = classifyUrl(text);
  const special = importers.find((imp) => imp.matches(cls, text));
  if (special !== undefined) {
    return special.import(text, laneId, startSamples, projectSampleRate, opts);
  }

  const got = await fetchAudioUrl(text);
  if (!got.ok || got.bytes === undefined) {
    return { ok: false, reason: got.reason ?? 'gagal mengambil URL' };
  }
  return importBytesToLane(
    got.bytes,
    got.name ?? 'AUDIO',
    laneId,
    startSamples,
    projectSampleRate,
    opts,
  );
}
