/**
 * MAGNET CLIP — menempelkan tepi clip yang digeser ke tepi clip yang diam.
 *
 * Yang dijanjikan fungsi di sini hanya satu, tapi harus dipegang mutlak:
 * SETELAH magnet, tepi yang menempel sama PERSIS dalam satuan sample
 * (`movingEnd === fixed.start` atau `movingStart === fixed.end`). "Hampir"
 * tidak cukup — celah 3 sample tidak terlihat di layar tapi terdengar sebagai
 * klik, dan tumpang tindih 3 sample membuat dua materi berbunyi bersamaan.
 *
 * KENAPA KOREKSI DIPILIH SEKALI, BUKAN DIAKUMULASI: versi lama menjumlahkan
 * setiap koreksi yang lolos ambang ke `delta` sambil tetap mengukur dari tepi
 * LAMA. Dua kandidat yang sama-sama dekat (mis. tepi kanan clip diam DAN tepi
 * kiri clip diam berikutnya) karenanya diterapkan dua kali, dan hasilnya tidak
 * menempel ke satu pun dari keduanya — justru inilah "magnetnya kelihatan
 * nempel tapi hasilnya bercelah" yang dilaporkan. Sekarang semua kandidat
 * dikumpulkan lebih dulu, yang TERDEKAT dipilih, dan diterapkan satu kali.
 *
 * KENAPA BATAS NOL DIHITUNG DI SINI JUGA: `moveClips` menjepit selisih supaya
 * tidak ada clip berposisi negatif. Kalau magnet tidak tahu batas itu, ia bisa
 * memulangkan selisih yang store tolak sebagian — dan clip mendarat di tempat
 * yang bukan hasil magnet, kadang tumpang tindih dengan tetangganya. Aturan
 * jepitannya disamakan dengan store (termasuk jepitan nomor lane).
 */

import type { StudioLane } from '../model';
import type { ClipOrigin } from '../store';

export interface ClipSnapResult {
  readonly deltaSamples: number;
  readonly guideSample: number | null;
}

/** Toleransi magnet dalam piksel, stabil pada semua level zoom. */
export const SNAP_THRESHOLD_PX = 10;

/** Rentang waktu clip yang TIDAK bergerak, di lane tujuan sebuah clip. */
interface FixedSpan {
  readonly start: number;
  readonly end: number;
}

/** Satu clip yang ikut digeser + clip diam yang menghalanginya di lane tujuan. */
interface MovingItem {
  /** Posisi saat tarikan dimulai (sample). */
  readonly start: number;
  /** Panjang di TIMELINE-space — sudah termasuk efek `speedRatio` lane. */
  readonly len: number;
  readonly fixed: readonly FixedSpan[];
}

/** Snap rombongan clip ke edge clip diam dan cegah overlap pada lane tujuan. */
export function snapClipMove(
  lanes: readonly StudioLane[],
  origins: readonly ClipOrigin[],
  rawDelta: number,
  deltaLanes: number,
  samplesPerPx: number,
): ClipSnapResult {
  if (origins.length === 0) return { deltaSamples: rawDelta, guideSample: null };
  const threshold = Math.max(1, samplesPerPx * SNAP_THRESHOLD_PX);
  const items = movingItems(lanes, origins, deltaLanes);
  if (items.length === 0) return { deltaSamples: Math.round(rawDelta), guideSample: null };

  // Batas kiri timeline. Sama dengan `dx = Math.max(dx, -o.start)` di store.
  const floor = -Math.min(...items.map((item) => item.start));
  const base = Math.max(Math.round(rawDelta), floor);

  const desired = magnet(items, base, threshold, floor);
  const delta = overlaps(items, desired) ? resolve(items, desired, floor) : desired;
  return { deltaSamples: delta, guideSample: flushEdge(items, delta) };
}

/**
 * Pasangan clip-bergerak ↔ clip-diam, dengan nomor lane tujuan yang SUDAH
 * dijepit persis seperti `moveClips`.
 *
 * Tanpa jepitan itu, menyeret rombongan melewati lane terakhir membuat lane
 * tujuan tidak ditemukan di sini (magnet dan pencegahan overlap mati diam-diam)
 * sementara store tetap menaruh clip-nya di lane terakhir.
 */
function movingItems(
  lanes: readonly StudioLane[],
  origins: readonly ClipOrigin[],
  deltaLanes: number,
): MovingItem[] {
  const lastLane = lanes.length - 1;
  let dl = Math.round(deltaLanes);
  for (const origin of origins) {
    dl = Math.max(dl, -origin.laneIndex);
    dl = Math.min(dl, lastLane - origin.laneIndex);
  }

  const moving = new Set(origins.map((origin) => origin.id));
  const lenById = new Map<string, number>();
  for (const lane of lanes) {
    for (const clip of lane.clips) if (moving.has(clip.id)) lenById.set(clip.id, clip.len);
  }

  const out: MovingItem[] = [];
  for (const origin of origins) {
    const len = lenById.get(origin.id);
    const targetLane = lanes[origin.laneIndex + dl];
    if (len === undefined || targetLane === undefined) continue;
    const fixed = targetLane.clips
      .filter((clip) => !moving.has(clip.id))
      .map((clip) => ({ start: clip.start, end: clip.start + clip.len }));
    out.push({ start: origin.start, len, fixed });
  }
  return out;
}

/** Tepi clip diam di lane tujuan sebuah item, tanpa duplikat. */
function fixedEdges(item: MovingItem): number[] {
  return item.fixed.flatMap((span) => [span.start, span.end]);
}

/**
 * Selisih setelah magnet: koreksi TERDEKAT yang masih di dalam ambang.
 *
 * Kandidat yang menghasilkan tumpang tindih dilewati kalau masih ada kandidat
 * lain — menempel ke tepi yang justru menaruh clip di atas tetangganya bukan
 * magnet, itu cuma memaksa langkah pembetulan berikutnya melompat jauh.
 */
function magnet(
  items: readonly MovingItem[],
  base: number,
  threshold: number,
  floor: number,
): number {
  const candidates: number[] = [];
  for (const item of items) {
    const edges = [item.start + base, item.start + base + item.len];
    for (const fixedEdge of fixedEdges(item)) {
      for (const movingEdge of edges) {
        const correction = fixedEdge - movingEdge;
        if (Math.abs(correction) <= threshold) candidates.push(base + correction);
      }
    }
  }
  if (candidates.length === 0) return base;
  // Terdekat lebih dulu; `sort` stabil, jadi seri diputuskan oleh urutan lane.
  candidates.sort((a, b) => Math.abs(a - base) - Math.abs(b - base));
  const legal = candidates.find((delta) => delta >= floor && !overlaps(items, delta));
  return legal ?? candidates.find((delta) => delta >= floor) ?? base;
}

/** true kalau ada satu saja clip bergerak yang menindih clip diam. */
function overlaps(items: readonly MovingItem[], delta: number): boolean {
  for (const item of items) {
    const start = item.start + delta;
    const end = start + item.len;
    for (const span of item.fixed) if (end > span.start && start < span.end) return true;
  }
  return false;
}

/**
 * Dorong rombongan keluar dari tumpang tindih ke posisi TERDEKAT yang menempel.
 *
 * Dua arah dicoba dan yang paling dekat dengan keinginan user yang dipakai:
 * mendorong selalu ke arah drag membuat clip melompati deretan yang rapat,
 * padahal celah yang pas ada di belakangnya.
 */
function resolve(items: readonly MovingItem[], desired: number, floor: number): number {
  const left = push(items, desired, floor, 'left');
  const right = push(items, desired, floor, 'right');
  if (left === null) return right ?? desired;
  if (right === null) return left;
  return Math.abs(left - desired) <= Math.abs(right - desired) ? left : right;
}

/**
 * Geser ke satu arah sampai tidak ada lagi yang tertindih.
 *
 * MONOTON: setiap langkah melewati setidaknya satu clip diam sepenuhnya, jadi
 * jumlah langkahnya tidak mungkin melebihi jumlah clip diam — tidak ada
 * kemungkinan bolak-balik seperti pada versi lama yang memasang batas 4 putaran
 * dan menyerah begitu saja (kadang masih tumpang tindih) kalau belum selesai.
 */
function push(
  items: readonly MovingItem[],
  from: number,
  floor: number,
  dir: 'left' | 'right',
): number | null {
  const steps = items.reduce((n, item) => n + item.fixed.length, 0) + 1;
  let delta = from;
  for (let i = 0; i < steps; i += 1) {
    let next = delta;
    for (const item of items) {
      const start = item.start + delta;
      const end = start + item.len;
      for (const span of item.fixed) {
        if (end <= span.start || start >= span.end) continue;
        next =
          dir === 'left'
            ? Math.min(next, span.start - item.start - item.len)
            : Math.max(next, span.end - item.start);
      }
    }
    if (next === delta) return delta;
    delta = next;
    if (delta < floor) return null;
  }
  return null;
}

/**
 * Tepi clip diam yang PERSIS disentuh salah satu clip bergerak, atau null.
 *
 * Dihitung dari hasil akhir, bukan dari kandidat yang dipilih di tengah jalan:
 * garis bantu tidak boleh menunjuk tepi yang ternyata tidak jadi ditempeli.
 */
function flushEdge(items: readonly MovingItem[], delta: number): number | null {
  for (const item of items) {
    const edges = [item.start + delta, item.start + delta + item.len];
    for (const fixedEdge of fixedEdges(item)) {
      if (edges.includes(fixedEdge)) return fixedEdge;
    }
  }
  return null;
}

export interface TrimSnapResult {
  /** Posisi timeline tepi yang ditarik (sample, sudah bulat). */
  readonly at: number;
  readonly guideSample: number | null;
}

/**
 * Magnet untuk TEPI yang di-trim.
 *
 * Tanpa ini, satu-satunya cara membuat dua clip benar-benar bertemu lewat trim
 * adalah keberuntungan piksel: `at` datang dari posisi pointer, dan sample yang
 * tepat sama dengan tepi tetangga hampir tidak pernah kena.
 *
 * CATATAN SATU SAMPLE: pada lane dengan `speedRatio` ≠ 1, `trimRight`/`trimLeft`
 * membulatkan dua kali (timeline → source → timeline), jadi tepi hasilnya bisa
 * berselisih satu sample dari nilai yang dikembalikan di sini. Itu batas model
 * (`len` turunan dari `sourceLen`), bukan magnetnya.
 */
export function snapTrimEdge(
  lanes: readonly StudioLane[],
  clipId: string,
  at: number,
  samplesPerPx: number,
): TrimSnapResult {
  const target = Math.round(at);
  const threshold = Math.max(1, samplesPerPx * SNAP_THRESHOLD_PX);
  const lane = lanes.find((l) => l.clips.some((clip) => clip.id === clipId));
  if (lane === undefined) return { at: target, guideSample: null };

  let best: number | null = null;
  for (const clip of lane.clips) {
    if (clip.id === clipId) continue;
    for (const edge of [clip.start, clip.start + clip.len]) {
      const correction = Math.abs(edge - target);
      if (correction > threshold) continue;
      if (best === null || correction < Math.abs(best - target)) best = edge;
    }
  }
  return best === null ? { at: target, guideSample: null } : { at: best, guideSample: best };
}
