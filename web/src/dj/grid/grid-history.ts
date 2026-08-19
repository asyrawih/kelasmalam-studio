/**
 * UNDO/REDO khusus suntingan grid, per ASSET.
 *
 * ## Kenapa bukan sistem undo global
 *
 * Repo ini belum punya satu pun. `docs/08 §8a` memang menetapkan "satu entri
 * undo per gerakan", tapi yang membangunnya belum ada, dan grid edit adalah
 * tempat yang buruk untuk memulainya: satu-satunya keadaan yang perlu dibatalkan
 * di sini adalah TIGA angka (`bpmOverride`, `beatOffsetOverride`, `tempoOctave`)
 * milik satu asset. Undo global akan memaksa seluruh `StudioAppState` masuk
 * tumpukan hanya untuk melayaninya.
 *
 * ## Per ASSET, bukan per deck, bukan global
 *
 * Alasan yang sama dengan `TrackCues`: yang disunting adalah MATERI. Memuat
 * lagu yang sama ke deck lain harus mewarisi riwayatnya, dan menyunting deck B
 * tidak boleh muncul di UNDO deck A — dua hal yang keduanya salah kalau
 * tumpukannya per deck.
 *
 * ## Tumpukan ini menyimpan KEADAAN, bukan operasi
 *
 * Tiga angka per entri; membalik operasi (`widenBeat` lawan `widenBeat`) akan
 * menumpuk galat pembulatan, dan setelah sepuluh undo grid-nya tidak kembali ke
 * tempat semula. Menyimpan keadaan membuat undo TEPAT menurut definisi.
 *
 * Modul ini punya langganannya sendiri (bukan `djStore`) karena isinya bukan
 * keadaan sesi: ia tidak layak di-persist, tidak layak ikut `hydrate`, dan
 * tidak boleh membuat dua deck ikut me-render tiap kali salah satunya disunting.
 */

import { useSyncExternalStore } from 'react';

import { studioActions, studioStore } from '../../studio/store';

/** Keadaan grid sebuah asset yang bisa dikembalikan seutuhnya. */
export interface GridSnapshot {
  readonly bpm: number | null;
  readonly offsetSec: number | null;
  readonly octave: number;
}

/**
 * Batas tumpukan per asset. 32 gestur cukup untuk seluruh sesi menyetel satu
 * lagu; yang dijaga di sini adalah tab yang dibiarkan terbuka berhari-hari,
 * bukan pemakaian normalnya.
 */
export const MAX_HISTORY = 32;

interface Stack {
  undo: GridSnapshot[];
  redo: GridSnapshot[];
}

const stacks = new Map<number, Stack>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

function stackOf(assetId: number): Stack {
  const found = stacks.get(assetId);
  if (found !== undefined) return found;
  const fresh: Stack = { undo: [], redo: [] };
  stacks.set(assetId, fresh);
  return fresh;
}

/** Keadaan grid sebuah asset SEKARANG. `null` kalau asset-nya tidak ada. */
export function snapshotOf(assetId: number): GridSnapshot | null {
  const asset = studioStore.getState().assets[assetId];
  if (asset === undefined) return null;
  return {
    bpm: asset.bpmOverride,
    offsetSec: asset.beatOffsetOverride,
    octave: asset.tempoOctave,
  };
}

function sameSnapshot(a: GridSnapshot, b: GridSnapshot): boolean {
  return a.bpm === b.bpm && a.offsetSec === b.offsetSec && a.octave === b.octave;
}

/** Tulis sebuah snapshot kembali ke store. Tidak menyentuh riwayat. */
function applySnapshot(assetId: number, snap: GridSnapshot): void {
  studioActions.setAssetBeatGrid(assetId, { bpm: snap.bpm, offsetSec: snap.offsetSec });
  const asset = studioStore.getState().assets[assetId];
  if (asset !== undefined && asset.tempoOctave !== snap.octave) {
    studioActions.shiftAssetTempoOctave(assetId, snap.octave - asset.tempoOctave);
  }
}

/**
 * Catat keadaan SEBELUM sebuah gestur mengubahnya.
 *
 * Dipanggil sekali per GESTUR, bukan per `pointermove` — menarik grid sejauh
 * dua bar menghasilkan satu entri, bukan empat ratus. Itu aturan `docs/08 §8a`,
 * dan di sini ia dijaga oleh pemanggil (`grid-ops.ts`), bukan oleh modul ini:
 * hanya pemanggil yang tahu di mana gesturnya mulai.
 *
 * Entri yang identik dengan puncak tumpukan diabaikan, sehingga menekan tombol
 * yang tidak mengubah apa pun (nudge pada grid yang sudah mentok, misalnya)
 * tidak menghabiskan riwayat.
 */
export function recordGrid(assetId: number): void {
  const snap = snapshotOf(assetId);
  if (snap === null) return;
  const st = stackOf(assetId);
  const top = st.undo[st.undo.length - 1];
  if (top !== undefined && sameSnapshot(top, snap)) return;

  st.undo.push(snap);
  if (st.undo.length > MAX_HISTORY) st.undo.shift();
  // Cabang redo dibuang begitu ada suntingan baru — riwayat yang bercabang
  // membutuhkan pohon, dan tidak ada satu pun perkakas DJ yang menawarkannya.
  st.redo = [];
  bump();
}

export function canUndoGrid(assetId: number): boolean {
  return (stacks.get(assetId)?.undo.length ?? 0) > 0;
}

export function canRedoGrid(assetId: number): boolean {
  return (stacks.get(assetId)?.redo.length ?? 0) > 0;
}

export function undoGrid(assetId: number): boolean {
  const st = stacks.get(assetId);
  const prev = st?.undo.pop();
  if (st === undefined || prev === undefined) return false;
  const now = snapshotOf(assetId);
  if (now !== null) st.redo.push(now);
  applySnapshot(assetId, prev);
  bump();
  return true;
}

export function redoGrid(assetId: number): boolean {
  const st = stacks.get(assetId);
  const next = st?.redo.pop();
  if (st === undefined || next === undefined) return false;
  const now = snapshotOf(assetId);
  if (now !== null) st.undo.push(now);
  applySnapshot(assetId, next);
  bump();
  return true;
}

/**
 * Buang riwayat sebuah asset — dipanggil saat lagunya dihapus dari kepustakaan.
 * Tanpa ini, id yang dipakai ulang akan mewarisi riwayat lagu yang sudah tidak
 * ada, dan UNDO memindahkan grid ke tempat yang tidak pernah dilihat user.
 */
export function forgetGridHistory(assetId: number): void {
  if (stacks.delete(assetId)) bump();
}

export function __resetGridHistoryForTest(): void {
  stacks.clear();
  bump();
}

/**
 * Versi riwayat. `useSyncExternalStore` membandingkan snapshot dengan
 * `Object.is`, jadi yang dikembalikan harus primitif — bukan `{canUndo,
 * canRedo}` yang selalu terlihat baru dan me-render tanpa henti (jebakan yang
 * sama sudah ditulis panjang di `analysis/playhead-tempo.ts`).
 */
export function useGridHistoryVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => version,
  );
}
