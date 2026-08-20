/**
 * Cue DJ + koreksi grid, tersimpan per LAGU (L5 docs/16).
 *
 * ## Kenapa terpisah dari project
 *
 * Cue milik lagunya, bukan milik project yang kebetulan memakainya. Hot cue
 * yang dipasang saat berlatih di `/dj` harus ada juga saat lagu yang sama
 * ditaruh di timeline besok — dan sebaliknya, membuka project lama tidak boleh
 * mengembalikan cue ke keadaan berbulan-bulan lalu.
 *
 * Server pun menyimpannya di tabel sendiri (`marks`), dengan alasan yang
 * sejalan: cue berubah puluhan kali per sesi, metadata lagu tidak pernah
 * berubah (docs/16 §3).
 *
 * ## Kenapa ditunda, bukan dikirim tiap perubahan
 *
 * Satu latihan berisi puluhan penekanan hot cue, dan tiap penekanan mengubah
 * state. Mengirim tiap kali berarti puluhan PUT untuk keadaan akhir yang sama.
 * Yang dikirim adalah keadaan setelah tangan berhenti — dan karena payload-nya
 * selalu keadaan LENGKAP (bukan tambalan), yang tertinggal di tengah tidak
 * pernah jadi masalah.
 */

import { EMPTY_TRACK_CUES, type TrackCues } from '../dj/model';
import { djActions, djStore } from '../dj/store';
import { studioActions, studioStore } from '../studio/store';
import type { LibraryApi } from './api';

/** Bentuk yang diserahkan ke `PUT /tracks/:hash/marks`. */
export interface Marks {
  readonly cues?: TrackCues;
  readonly grid?: {
    readonly bpm: number | null;
    readonly offsetSec: number | null;
    readonly lock: boolean;
    readonly anchors?: readonly { readonly atSec: number; readonly bpm: number }[];
  };
}

/**
 * Kumpulkan marks satu asset dari state sekarang.
 *
 * `null` berarti tidak ada yang layak disimpan — dan itu jawaban yang berbeda
 * dari "kosong": lagu tanpa cue dan tanpa koreksi tidak perlu menghasilkan
 * permintaan jaringan sama sekali.
 */
export function collectMarks(assetId: number): Marks | null {
  const cues = djStore.getState().cues[assetId];
  const asset = studioStore.getState().assets[assetId];

  const adaCue =
    cues !== undefined &&
    (cues.cuePoint !== 0 ||
      cues.memoryCues.length > 0 ||
      Object.values(cues.hotCues).some((c) => c !== null));

  const anchors = asset?.beatAnchors ?? null;
  const adaGrid =
    asset !== undefined &&
    (asset.bpmOverride !== null ||
      asset.beatOffsetOverride !== null ||
      anchors !== null ||
      asset.analysisLock);

  if (!adaCue && !adaGrid) return null;

  return {
    ...(adaCue ? { cues } : null),
    ...(adaGrid && asset !== undefined
      ? {
          grid: {
            bpm: asset.bpmOverride,
            offsetSec: asset.beatOffsetOverride,
            lock: asset.analysisLock,
            ...(anchors === null ? null : { anchors }),
          },
        }
      : null),
  };
}

/**
 * Pasang marks dari server ke state sesi ini.
 *
 * Dipanggil tepat setelah lagunya jadi asset — di situlah `assetId`-nya baru
 * diketahui. Bentuk yang tidak dikenali DIABAIKAN, bukan dilempar: marks yang
 * rusak tidak boleh membuat lagunya gagal dimuat.
 */
export function applyMarks(assetId: number, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const marks = raw as Marks;

  if (marks.cues !== undefined && typeof marks.cues === 'object') {
    djActions.restoreCues(assetId, { ...EMPTY_TRACK_CUES, ...marks.cues });
  }

  const grid = marks.grid;
  if (grid !== undefined && typeof grid === 'object') {
    // Grid DULU, kunci belakangan: `setAssetBeatGrid` menolak asset yang
    // terkunci, jadi urutan terbalik memulihkan kuncinya dan membuang justru
    // koreksi yang dikunci itu. Catatan yang sama ada di `persistence.ts`.
    studioActions.setAssetBeatGrid(assetId, {
      bpm: grid.bpm ?? null,
      offsetSec: grid.offsetSec ?? null,
    });
    studioActions.setAssetBeatAnchors(assetId, grid.anchors ?? null);
    if (grid.lock === true) studioActions.setAnalysisLock(assetId, true);
  }
}

export interface MarksSync {
  /** Catat bahwa asset ini berubah; pengiriman ditunda. */
  touch(assetId: number, hash: string): void;
  /** Kirim yang tertunda sekarang. Dipakai tes, dan saat halaman ditinggalkan. */
  flush(): Promise<void>;
  stop(): void;
}

const DEFAULT_DELAY_MS = 2_000;

export function createMarksSync(
  api: LibraryApi,
  opts: { readonly delayMs?: number } = {},
): MarksSync {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  /** assetId → hash, untuk yang menunggu dikirim. */
  const pending = new Map<number, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  const send = async (): Promise<void> => {
    const batch = [...pending.entries()];
    pending.clear();
    for (const [assetId, hash] of batch) {
      const marks = collectMarks(assetId);
      if (marks === null) continue;
      try {
        await api.putMarks(hash, marks);
      } catch {
        /*
         * Sengaja bisu, dan sengaja TIDAK dicoba ulang.
         *
         * Marks bukan pekerjaan yang bisa hilang: keadaan lengkapnya ada di
         * memori, dan perubahan berikutnya mengirim ulang semuanya. Bar merah
         * untuk cue yang gagal tersimpan hanya akan mengganggu di tengah mix,
         * untuk sesuatu yang memperbaiki dirinya sendiri pada penekanan
         * tombol berikutnya.
         */
      }
    }
  };

  return {
    touch(assetId, hash) {
      if (hash === '') return;
      pending.set(assetId, hash);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        running = send().finally(() => {
          running = null;
        });
      }, delayMs);
    },
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await send();
      await running;
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
