/**
 * Import ke lane + UMPAN BALIKNYA — satu tempat, supaya tidak ada jalur masuk
 * yang bisa berjalan diam-diam.
 *
 * `audio-import.ts` sengaja tidak tahu apa-apa soal store job: ia dipakai juga
 * oleh halaman `/dj`, yang punya store sendiri. Modul ini yang menjembatani:
 * ia membuka `ImportJob`, meneruskan tiap kabar kemajuan ke store, dan
 * MENUTUPNYA di `finally` — berhasil, gagal, atau melempar. Job yang tidak
 * pernah ditutup akan meninggalkan bar progres abadi di lane, dan bar seperti
 * itu tidak bisa dibedakan dari aplikasi yang menggantung.
 *
 * Fungsi di sini TIDAK di-`await` oleh pemanggilnya (lihat `ClipArea`): tiap
 * import berdiri sendiri, jadi menjatuhkan tiga lagu sekaligus berarti tiga
 * jalur yang berjalan bersamaan, bukan antrean di mana lagu ketiga baru mulai
 * dibaca setelah dua yang pertama selesai di-decode.
 */

import { studioActions } from '../store';
import {
  importFileToLane,
  type DropResult,
  type ImportProgressFn,
  type LaneImportOptions,
} from './audio-import';
import { importUrlToLane } from './url-to-lane';

/**
 * Jalankan `work` dengan satu `ImportJob` hidup selama ia berjalan.
 *
 * Dipakai kedua jalur (file dan URL) supaya siklus hidup job-nya identik;
 * kalau digandakan, satu dari keduanya akan lupa memanggil `endImport` dan
 * gejalanya baru terlihat sebagai bar yang tidak mau hilang.
 */
async function withJob(
  laneId: string,
  name: string,
  work: (report: ImportProgressFn) => Promise<DropResult>,
): Promise<DropResult> {
  const id = studioActions.newImportId();
  studioActions.beginImport({ id, laneId, name });
  try {
    return await work((p) => studioActions.setImportStage(id, p.stage, p.ratio));
  } finally {
    studioActions.endImport(id);
  }
}

/** File → clip di lane, dengan bar progres di lane itu selama berjalan. */
export function runFileImport(
  file: File,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  return withJob(laneId, file.name, (onProgress) =>
    importFileToLane(file, laneId, startSamples, projectSampleRate, { ...opts, onProgress }),
  );
}

/**
 * URL → clip di lane. Tahap `reading` di sini TIDAK punya rasio: `fetch`
 * lintas origin sering datang tanpa `Content-Length`, dan persen yang dikarang
 * dari ketiadaan angka lebih buruk daripada tidak ada persen sama sekali.
 */
export function runUrlImport(
  text: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  const name = text.trim().split('/').filter(Boolean).pop() ?? text.trim();
  return withJob(laneId, name, (onProgress) => {
    // Tidak ada rasio selama fetch berjalan; yang berubah cuma tahapnya.
    onProgress({ stage: 'reading', ratio: null });
    return importUrlToLane(text, laneId, startSamples, projectSampleRate, { ...opts, onProgress });
  });
}
