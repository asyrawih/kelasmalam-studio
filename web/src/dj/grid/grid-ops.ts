/**
 * OPERASI GRID EDIT — satu pintu untuk tombol panel, keyboard, dan tes.
 *
 * `analysis/grid-edit.ts` menghitung; berkas ini yang MEMUTUSKAN: mengambil
 * deck mana yang sedang disunting, membaca asset-nya dari `studioStore`,
 * mencatat riwayat undo, menulis hasilnya, dan menolak dengan KALIMAT kalau
 * tidak bisa.
 *
 * Ada sebagai lapisan tersendiri karena tiap operasi punya tiga pintu masuk —
 * tombol di panel, chord keyboard lewat `commands.ts`, dan (nanti) MIDI. Kalau
 * masing-masing memanggil `studioActions.setAssetBeatGrid` sendiri, tiga hal
 * ikut tersalin tiga kali: penjagaan kunci analisis, pencatatan undo, dan
 * pemilihan anchor mentah. Yang ketiga adalah jebakan 1 di kepala
 * `analysis/grid-edit.ts`, dan menyalinnya tiga kali berarti menyediakan tiga
 * tempat untuk salah.
 *
 * SEMUA fungsi di sini mengembalikan `boolean`: `false` berarti tidak terjadi
 * apa-apa DAN `djActions.setNotice` sudah menuliskan alasannya. Pemanggil tidak
 * perlu memeriksa apa pun sebelum memanggil.
 */

import {
  MIN_FIT_BARS,
  NUDGE_STEP_SEC,
  WIDEN_STEP_COARSE_SEC,
  WIDEN_STEP_SEC,
  barsBetween,
  currentBpm,
  fitBpmToPoint,
  nearestBarSec,
  nudgeAnchor,
  rawAnchorSec,
  setBpm,
  setDownbeatAt,
  shiftOctave,
  widenBeat,
  type GridPatch,
} from '../../studio/analysis/grid-edit';
import { BEATS_PER_BAR } from '../../studio/analysis/beat-grid';
import { tapTempo } from '../../studio/analysis/tap-tempo';
import { studioActions, studioStore, type StudioAsset } from '../../studio/store';
import { djActions, djStore } from '../store';
import type { DeckId } from '../model';
import { canRedoGrid, canUndoGrid, recordGrid, redoGrid, undoGrid } from './grid-history';

/**
 * Seberapa dekat playhead harus ke sebuah garis bar supaya SET DI SINI
 * menganggap garis itulah yang dimaksud, alih-alih posisi tepatnya.
 *
 * 30 ms ≈ batas di mana dua transien masih terdengar sebagai satu kejadian.
 * Tanpa penempelan ini, menekan SET DI SINI saat playhead kebetulan berhenti
 * 5 ms dari garis yang sudah benar akan menggeser SELURUH grid sejauh 5 ms —
 * user kehilangan penyetelan yang baru saja ia selesaikan, karena menekan
 * tombol yang ia kira tidak mengubah apa-apa.
 */
export const SNAP_TOLERANCE_SEC = 0.03;

/** Semua yang dibutuhkan satu operasi. `null` = tidak ada yang bisa disunting. */
export interface GridTarget {
  readonly deckId: DeckId;
  readonly assetId: number;
  readonly asset: StudioAsset;
  /** Anchor MENTAH (jebakan 1 `analysis/grid-edit.ts`). */
  readonly anchorSec: number;
  readonly bpm: number;
  /** Posisi playhead deck, detik. */
  readonly atSec: number;
}

/**
 * Deck yang sedang disunting, lengkap dengan materinya.
 *
 * `deckId` opsional supaya command keyboard bisa menyebut deck secara eksplisit
 * tanpa lebih dulu menyalakan mode grid — menekan pintasan grid deck B saat
 * panel sedang menunjuk deck A harus mengenai B, bukan A.
 */
export function gridTarget(deckId?: DeckId): GridTarget | null {
  const s = djStore.getState();
  const id = deckId ?? s.gridEdit.deck;
  if (id === null || id === undefined) return null;

  const deck = s.decks[id];
  if (deck.assetId === null) return null;
  const asset = studioStore.getState().assets[deck.assetId];
  if (asset === undefined) return null;

  const bpm = currentBpm(asset);
  if (bpm === null) return null;

  const sr = deck.sampleRate > 0 ? deck.sampleRate : 48_000;
  return {
    deckId: id,
    assetId: deck.assetId,
    asset,
    anchorSec: rawAnchorSec(asset),
    bpm,
    atSec: deck.playhead / sr,
  };
}

/**
 * Kenapa sebuah deck tidak bisa disunting grid-nya, atau `null` kalau bisa.
 *
 * Terpisah dari `gridTarget` karena panel perlu MENULISKAN alasannya, sedangkan
 * `gridTarget` hanya perlu tahu ada atau tidak. Menggabungkannya berarti tiap
 * pemanggil ikut memikul kalimat yang tidak ia butuhkan.
 */
export function gridBlockedReason(deckId: DeckId | null): string | null {
  if (deckId === null) return 'tidak ada deck yang dipilih';
  const deck = djStore.getState().decks[deckId];
  if (deck.assetId === null) return `deck ${deckId} kosong`;
  const asset = studioStore.getState().assets[deck.assetId];
  if (asset === undefined) return `asset deck ${deckId} hilang dari kepustakaan`;
  if (asset.analysisLock) return `${asset.name} terkunci — buka 🔒 untuk menyunting grid`;
  if (currentBpm(asset) === null) {
    return asset.tempoPending ? 'analisis BPM masih berjalan' : 'lagu ini belum punya BPM';
  }
  return null;
}

/** Terapkan patch: catat riwayat, tulis, laporkan. */
function commit(t: GridTarget, patch: GridPatch): boolean {
  if (t.asset.analysisLock) {
    djActions.setNotice(`${t.asset.name} terkunci — buka 🔒 untuk menyunting grid`);
    return false;
  }
  recordGrid(t.assetId);
  studioActions.setAssetBeatGrid(t.assetId, {
    bpm: patch.bpm ?? t.asset.bpmOverride,
    offsetSec: patch.offsetSec ?? t.asset.beatOffsetOverride,
  });
  return true;
}

// ── Membuka / menutup ────────────────────────────────────────────────────────

/**
 * Buka atau tutup panel grid untuk sebuah deck, DAN katakan apa akibatnya kalau
 * deck itu sedang bekerja.
 *
 * Ini yang membedakan `/dj` dari Clip Detail Studio: di sini lagunya bisa
 * sedang mengudara. Yang perlu diketahui user, dan ketiganya benar:
 *
 * 1. **Loop yang sedang berputar TIDAK melompat.** `loop.inAt`/`outAt` disimpan
 *    sebagai SAMPLE, bukan sebagai indeks ketukan, jadi mengubah BPM tidak
 *    memindahkan batasnya. Yang berubah hanya angka `loop.beats` di layar.
 *    Dikunci oleh tes di `grid-edit.test.tsx`.
 * 2. **SYNC dan quantize memakai grid baru mulai aksi BERIKUTNYA** — keduanya
 *    membaca grid saat dipanggil, bukan saat dipasang.
 * 3. Kalau deck ini MASTER dan deck lain mengikutinya, menggeser BPM di sini
 *    menggeser acuan tempo seluruh mix.
 *
 * Memperingatkan, bukan menolak. rekordbox memang MELARANG grid edit saat
 * tersambung PRO DJ LINK, tapi larangan di sini akan mengunci alatnya justru
 * pada saat orang paling membutuhkannya — grid yang meleset baru ketahuan saat
 * lagunya diputar.
 */
export function toggleGridEditFor(deckId: DeckId): void {
  const before = djStore.getState();
  const opening = before.gridEdit.deck !== deckId;
  djActions.toggleGridEdit(deckId);
  if (!opening) return;

  const s = djStore.getState();
  const deck = s.decks[deckId];
  const other: DeckId = deckId === 'A' ? 'B' : 'A';
  const leading = s.masterDeck === deckId && s.decks[other].sync !== 'off';

  if (leading) {
    djActions.setNotice(
      `deck ${deckId} jadi MASTER dan deck ${other} mengikutinya — mengubah BPM di sini menggeser acuan tempo keduanya`,
    );
  } else if (deck.playing) {
    djActions.setNotice(
      `deck ${deckId} sedang berbunyi — loop yang berputar tidak akan melompat, tapi SYNC dan quantize memakai grid baru mulai aksi berikutnya`,
    );
  } else {
    djActions.setNotice(null);
  }
}

// ── Operasi ──────────────────────────────────────────────────────────────────

/**
 * Kontrol #1 — jadikan posisi sekarang ketukan-pertama-bar.
 *
 * Menempel ke garis bar yang sudah ada kalau playhead sudah cukup dekat. Lihat
 * `SNAP_TOLERANCE_SEC`.
 */
export function setDownbeatHere(deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);

  const snapped = nearestBarSec(t.anchorSec, t.bpm, t.atSec, BEATS_PER_BAR);
  const at = Math.abs(snapped - t.atSec) <= SNAP_TOLERANCE_SEC ? snapped : t.atSec;
  return commit(t, setDownbeatAt(at));
}

/** Kontrol #2 — BPM yang diketik. */
export function setGridBpm(bpm: number, deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);
  return commit(t, setBpm(bpm, t.anchorSec));
}

/** Kontrol #4 — geser seluruh grid. `dir` = ±1. */
export function nudgeGrid(dir: number, deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);
  // `fine` SENGAJA tidak dibaca di sini: di rekordbox ia hanya mengubah langkah
  // renggang/rapat. Geser anchor selalu 1 ms, berapa pun keadaan tombol itu.
  return commit(t, nudgeAnchor(t.anchorSec, Math.sign(dir) * NUDGE_STEP_SEC));
}

/** Kontrol #5 — renggangkan (`dir > 0`) atau rapatkan jarak ketukan. */
export function widenGrid(dir: number, deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);
  // `fine` MEMBESARKAN langkah di sini — meniru rekordbox, dan alasannya ada di
  // `WIDEN_STEP_COARSE_SEC`.
  const step = djStore.getState().gridEdit.fine ? WIDEN_STEP_COARSE_SEC : WIDEN_STEP_SEC;
  return commit(t, widenBeat(t.bpm, Math.sign(dir) * step, t.anchorSec));
}

/** Kontrol #6 — ×2 / ÷2. */
export function octaveGrid(delta: number, deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);
  return commit(t, shiftOctave(t.bpm, delta, t.anchorSec));
}

/**
 * KUNCI-DUA-TITIK — selesaikan BPM supaya garis bar mendarat persis di playhead.
 *
 * Menolak dengan kalimat kalau terlalu dekat ke anchor, karena di jarak itu ia
 * merusak alih-alih memperbaiki (lihat `MIN_FIT_BARS`). Diam di sini akan
 * terbaca sebagai tombol rusak — dan tombol inilah yang paling menentukan
 * seluruh fitur.
 */
export function fitGridHere(deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);

  const patch = fitBpmToPoint(t.anchorSec, t.bpm, t.atSec, BEATS_PER_BAR);
  if (patch === null) {
    const bars = Math.abs(barsBetween(t.anchorSec, t.bpm, t.atSec, BEATS_PER_BAR));
    djActions.setNotice(
      `terlalu dekat ke downbeat (${bars.toFixed(1)} bar) — butuh minimal ${MIN_FIT_BARS} bar, dan makin jauh makin teliti`,
    );
    return false;
  }
  const ok = commit(t, patch);
  if (ok) {
    djActions.setNotice(`BPM dikunci ke ${(patch.bpm ?? 0).toFixed(3)} dari dua titik`);
  }
  return ok;
}

/**
 * Kontrol #3 — TAP. Baru menghasilkan angka setelah `MIN_TAPS`; sebelum itu
 * ia hanya mengumpulkan, dan itu bukan kegagalan.
 */
export function tapGrid(nowMs: number, deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);

  djActions.pushGridTap(nowMs);
  const result = tapTempo(djStore.getState().gridEdit.taps, t.bpm);
  if (result === null) return true;
  return commit(t, setBpm(result.bpm, t.anchorSec));
}

/** AUTO — buang semua koreksi manual, kembali ke hasil deteksi. */
export function autoGrid(deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);
  if (t.asset.analysisLock) {
    djActions.setNotice(`${t.asset.name} terkunci — AUTO akan membuang koreksinya`);
    return false;
  }
  recordGrid(t.assetId);
  studioActions.resetAssetBeatGrid(t.assetId);
  return true;
}

/** Kontrol #11 — `[Analysis Lock]`. Membuka kunci selalu boleh. */
export function toggleGridLock(deckId?: DeckId): boolean {
  const s = djStore.getState();
  const id = deckId ?? s.gridEdit.deck;
  if (id === null) return fail(null);
  const assetId = s.decks[id].assetId;
  if (assetId === null) return fail(id);
  const asset = studioStore.getState().assets[assetId];
  if (asset === undefined) return fail(id);

  studioActions.setAnalysisLock(assetId, !asset.analysisLock);
  djActions.setNotice(asset.analysisLock ? null : `${asset.name} dikunci — grid tidak bisa diubah`);
  return true;
}

// ── Tarikan waveform ─────────────────────────────────────────────────────────

/**
 * Awal sebuah tarikan grid. Mencatat riwayat SEKALI di sini, bukan di tiap
 * `pointermove` — aturan satu-entri-per-gestur (docs/08 §8a).
 */
export function beginAnchorDrag(deckId: DeckId): number | null {
  const t = gridTarget(deckId);
  if (t === null) return null;
  if (t.asset.analysisLock) {
    djActions.setNotice(`${t.asset.name} terkunci — buka 🔒 untuk menyunting grid`);
    return null;
  }
  recordGrid(t.assetId);
  return t.anchorSec;
}

/**
 * Lanjutan tarikan: taruh anchor di `anchorSec`. TIDAK mencatat riwayat.
 *
 * Pemanggil yang menghitung `anchorSec`, dan tandanya penting — lihat catatan
 * di `DeckScrollingWave.tsx`.
 */
export function dragAnchorTo(deckId: DeckId, anchorSec: number): boolean {
  const t = gridTarget(deckId);
  if (t === null || t.asset.analysisLock) return false;
  studioActions.setAssetBeatGrid(t.assetId, {
    bpm: t.asset.bpmOverride,
    offsetSec: anchorSec,
  });
  return true;
}

// ── Riwayat ──────────────────────────────────────────────────────────────────

export function undoGridEdit(deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);
  if (!undoGrid(t.assetId)) {
    djActions.setNotice('tidak ada suntingan grid untuk dibatalkan');
    return false;
  }
  return true;
}

export function redoGridEdit(deckId?: DeckId): boolean {
  const t = gridTarget(deckId);
  if (t === null) return fail(deckId ?? null);
  if (!redoGrid(t.assetId)) {
    djActions.setNotice('tidak ada suntingan grid untuk diulang');
    return false;
  }
  return true;
}

export function gridHistoryState(assetId: number | null): {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
} {
  if (assetId === null) return { canUndo: false, canRedo: false };
  return { canUndo: canUndoGrid(assetId), canRedo: canRedoGrid(assetId) };
}

/** Satu tempat untuk kalimat penolakan, supaya bunyinya tidak bercabang. */
function fail(deckId: DeckId | null): false {
  djActions.setNotice(gridBlockedReason(deckId) ?? 'grid tidak bisa disunting sekarang');
  return false;
}
