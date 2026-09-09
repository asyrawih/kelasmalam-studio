/**
 * GRID EDIT — matematika menyunting beat grid dengan tangan.
 *
 * Sisi lain dari `beat-grid.ts`: yang itu MEMBACA grid, yang ini MENGUBAHNYA.
 * Dipisah karena keduanya punya pemanggil yang berbeda (penggambar vs panel
 * sunting) dan, lebih penting, karena **satuan yang dipakai berbeda** — lihat
 * jebakan 2 di bawah.
 *
 * Semua fungsi di sini murni dan mengembalikan **patch** `{ bpm?, offsetSec? }`
 * yang langsung bisa diberikan ke `studioActions.setAssetBeatGrid`. Tidak ada
 * yang menyentuh store, React, atau Web Audio; seluruh berkas ini bisa dites
 * tanpa merender apa pun. Pola yang sama dengan `dj/model.ts` dan `fade.ts`.
 *
 * ## TIGA JEBAKAN YANG HARUS DIPAHAMI SEBELUM MENGUBAH BERKAS INI
 *
 * **1. ANCHOR-NYA MENTAH, BUKAN YANG SUDAH DINORMALKAN.**
 * `resolveBeatGrid` menormalkan `offsetSec` ke `[0, satu bar)` SAAT DIBACA,
 * sementara `setAssetBeatGrid` menyimpan angka MENTAH. Perbedaan itu justru
 * yang membuat berkas ini murah: kalau anchor tersimpan sebagai `180.0`, grid
 * tetap melewati detik ke-180 **berapa pun BPM-nya diubah nanti** — karena
 * `180 ≡ offset (mod bar)` menurut definisi. Jadi "pivot" yang dicari tombol
 * renggangkan/rapatkan dan SET ULANG DARI SINI sudah terbangun di dalam model.
 *
 * Syaratnya satu, dan ia halus: fungsi di sini menerima `anchorSec` MENTAH
 * (`rawAnchorSec(asset)`), bukan `grid.offsetSec`. Kalau tertukar, setiap
 * perubahan BPM diam-diam mem-pivot di AWAL LAGU, dan downbeat yang baru saja
 * disetel user di menit ketiga akan melompat sendiri. Gejalanya terlihat
 * seperti bug penggambar, dan akan dicari di tempat yang salah selama berjam-jam.
 *
 * **2. SATUANNYA DETIK, BUKAN SAMPLE.** `beat-grid.ts` bekerja dalam sample
 * karena ia melayani penggambar. Di sini yang diperjuangkan justru presisi
 * BPM-nya (lihat `fitBpmToPoint`), dan mengonversi bolak-balik ke sample hanya
 * menambah pembulatan pada besaran yang sedang dijaga sampai empat angka di
 * belakang koma.
 *
 * **3. `clampGridBpm` DI SETIAP JALAN KELUAR.** `widenBeat` pada BPM tinggi
 * bisa membuat panjang ketukan menembus nol dan berbalik tanda; hasilnya grid
 * yang mundur, dan tidak ada satu pun pemanggil yang siap menghadapinya.
 */

import type { StudioAsset } from '../store';
import { BEATS_PER_BAR, clampGridBpm } from './beat-grid';
import { correctedBpm } from './playhead-tempo';

/** Patch untuk `studioActions.setAssetBeatGrid`. */
export interface GridPatch {
  readonly bpm?: number;
  readonly offsetSec?: number;
}

/**
 * Jarak minimal dua titik `fitBpmToPoint`, dalam BAR.
 *
 * Di bawah ini galat tangan user (±10 ms, optimis) lebih besar daripada
 * perbaikan yang ditawarkan, jadi alatnya justru MERUSAK grid yang tadinya
 * benar. Delapan bar pada 128 BPM ≈ 15 detik: ±10 ms di situ masih 0.085 BPM,
 * yang memang belum di dalam anggaran ±0.0089 (00-plan §Utang 3a) — tapi
 * setidaknya perbaikan, bukan kerusakan. Anggaran itu baru tercapai pada jarak
 * beberapa menit, dan itulah pemakaian yang sebenarnya dituju: bar 1 → drop
 * terakhir.
 */
export const MIN_FIT_BARS = 8;

/** Langkah geser anchor, detik. Kasar = mengejar fase; halus = menyetel telinga. */
export const NUDGE_STEP_SEC = 0.001;
export const NUDGE_STEP_FINE_SEC = 0.0001;

/**
 * Langkah renggang/rapat, dalam detik PER KETUKAN. Meniru rekordbox: 1 ms,
 * dan `[fine]` justru MEMBESARKANNYA jadi 3 ms.
 *
 * Arahnya berlawanan dengan `NUDGE_STEP_*` di atas dan itu bukan salah ketik —
 * kedua kontrol mengejar hal yang berbeda. Geser anchor mengejar FASE, yang
 * salahnya diukur dalam milidetik. Renggang/rapat mengejar DRIFT, yang salahnya
 * menumpuk sepanjang lagu, jadi langkah 1 ms sudah termasuk kecil di sana.
 */
export const WIDEN_STEP_SEC = 0.001;
export const WIDEN_STEP_COARSE_SEC = 0.003;

/**
 * Anchor MENTAH sebuah asset, dalam detik. Lihat jebakan 1 di kepala berkas.
 *
 * Urutan `??`-nya sengaja sama persis dengan `resolveBeatGrid`, dan itu satu-
 * satunya alasan keduanya tidak boleh berjauhan: dua urutan yang berbeda
 * menghasilkan grid yang berbeda antara yang DIGAMBAR dan yang DISUNTING.
 */
export function rawAnchorSec(asset: StudioAsset | undefined): number {
  if (asset === undefined) return 0;
  const raw = asset.beatOffsetOverride ?? asset.tempo?.beatOffsetSec ?? 0;
  return Number.isFinite(raw) ? raw : 0;
}

/** Detik per ketukan dari BPM mentah. Tidak memakai `BeatGrid`. */
function spb(bpm: number): number {
  return 60 / clampGridBpm(bpm);
}

/**
 * Jadikan `atSec` sebuah ketukan-pertama-bar (kontrol #1 rekordbox).
 *
 * Anchor disimpan APA ADANYA, tidak dinormalkan ke `[0, bar)` — justru itu yang
 * membuat pivot berikutnya gratis (jebakan 1).
 */
export function setDownbeatAt(atSec: number): GridPatch {
  return { offsetSec: Number.isFinite(atSec) ? atSec : 0 };
}

/** Geser seluruh grid (kontrol #4). BPM tidak disentuh. */
export function nudgeAnchor(anchorSec: number, deltaSec: number): GridPatch {
  const d = Number.isFinite(deltaSec) ? deltaSec : 0;
  return { offsetSec: anchorSec + d };
}

/**
 * Ganti BPM tanpa memindahkan anchor (kontrol #2).
 *
 * Anchor ikut dikirim ulang WALAU tidak berubah nilainya. Alasannya bukan
 * kerapian: kalau `beatOffsetOverride` masih `null` (grid murni hasil deteksi),
 * mengetik BPM saja akan meninggalkan offset di jalur deteksi — dan begitu
 * detektor berjalan lagi, anchor bergeser di bawah BPM yang sudah dipilih user.
 * Menuliskannya sekarang mengunci keduanya jadi keputusan user.
 */
export function setBpm(bpm: number, anchorSec: number): GridPatch {
  return { bpm: clampGridBpm(bpm), offsetSec: anchorSec };
}

/**
 * Renggangkan/rapatkan jarak ketukan sebanyak `deltaSec` PER KETUKAN
 * (kontrol #5). Positif = lebih renggang = BPM turun.
 */
export function widenBeat(bpm: number, deltaSec: number, anchorSec: number): GridPatch {
  const d = Number.isFinite(deltaSec) ? deltaSec : 0;
  const next = spb(bpm) + d;
  // Panjang ketukan yang menembus nol akan membalik arah grid. `clampGridBpm`
  // saja tidak menangkapnya — `60 / -0.001` adalah −60000, dan clamp
  // mengembalikannya jadi MIN_GRID_BPM tanpa ada yang tahu tandanya sempat
  // terbalik. Dijaga di sini, di tempat tanda itu masih terlihat.
  if (!(next > 0)) return { bpm: clampGridBpm(bpm), offsetSec: anchorSec };
  return { bpm: clampGridBpm(60 / next), offsetSec: anchorSec };
}

/**
 * ×2 / ÷2 (kontrol #6). `delta` = +1 atau −1 oktaf.
 *
 * SENGAJA tidak memakai `studioActions.shiftAssetTempoOctave`. Yang itu
 * mengubah `tempoOctave`, yaitu koreksi atas hasil DETEKSI; di panel grid, ×2
 * adalah keputusan manual yang harus mendarat di `bpmOverride` supaya tombol
 * AUTO bisa mengembalikan SEMUANYA sekaligus. Dua jalur menuju hal yang
 * terlihat sama di layar adalah cacat model — dan gejalanya persis yang ada
 * sekarang: menekan AUTO, lalu BPM-nya tetap salah oktaf, tanpa satu kontrol
 * pun yang terlihat menjelaskan kenapa.
 */
export function shiftOctave(bpm: number, delta: number, anchorSec: number): GridPatch {
  const factor = 2 ** Math.trunc(Number.isFinite(delta) ? delta : 0);
  return { bpm: clampGridBpm(bpm * factor), offsetSec: anchorSec };
}

/**
 * KUNCI-DUA-TITIK — selesaikan BPM supaya garis bar mendarat PERSIS di `atSec`,
 * dengan anchor tetap di tempatnya.
 *
 * Ini pengganti tombol "set ulang grid dari posisi sekarang" milik rekordbox,
 * dan ia menjawab hal yang panel aslinya tidak bisa jawab. Anggaran presisi
 * 00-plan §Utang 3a adalah ±0.0089 BPM pada 128 BPM. Satu langkah renggang
 * 1 ms menggerakkan BPM sebesar 0.273 — 30× terlalu kasar. Sedangkan di sini,
 * galat BPM = `bpm × galat_penempatan / jarak`: menaruh titik kedua dalam
 * ±10 ms pada jarak 300 detik memberi 0.0043 BPM, di DALAM anggaran, sekali
 * gestur.
 *
 * Caranya: hitung ada berapa ketukan di antara kedua titik menurut BPM yang
 * BERLAKU SEKARANG, bulatkan ke kelipatan bar terdekat (user menaruh titiknya
 * di downbeat — itu satu-satunya transien yang bisa dikenali dengan yakin di
 * tengah lagu), lalu balik rumusnya.
 *
 * `null` kalau jaraknya lebih pendek dari `MIN_FIT_BARS`, atau kalau
 * pembulatannya jatuh ke nol ketukan. Pemanggil menulis kalimat penolakan —
 * diam di sini akan terbaca sebagai tombol yang rusak.
 */
export function fitBpmToPoint(
  anchorSec: number,
  bpm: number,
  atSec: number,
  beatsPerBar: number = BEATS_PER_BAR,
): GridPatch | null {
  const span = atSec - anchorSec;
  if (!Number.isFinite(span)) return null;

  const bpb = beatsPerBar > 0 ? beatsPerBar : BEATS_PER_BAR;
  const barSec = spb(bpm) * bpb;
  // Nilai mutlak: menaruh titik kedua SEBELUM anchor sah sepenuhnya (anchor di
  // drop terakhir, titik kedua di intro), dan hasilnya sama saja karena yang
  // dicari hanya jarak.
  if (Math.abs(span) < MIN_FIT_BARS * barSec) return null;

  const bars = Math.round(span / barSec);
  if (bars === 0) return null;
  const beats = bars * bpb;

  return { bpm: clampGridBpm((beats * 60) / span), offsetSec: anchorSec };
}

/**
 * Berapa bar jarak `atSec` dari anchor menurut grid sekarang — untuk menulis
 * "8.0 bar" di tombol PAS DI SINI sebelum user menekannya.
 *
 * Ditampilkan PECAHAN dengan sengaja: kalau angkanya berbunyi "63.7 bar", user
 * melihat sendiri bahwa titiknya belum duduk di downbeat, dan itu satu-satunya
 * petunjuk yang tersedia sebelum ia menekan tombolnya.
 */
export function barsBetween(
  anchorSec: number,
  bpm: number,
  atSec: number,
  beatsPerBar: number = BEATS_PER_BAR,
): number {
  const bpb = beatsPerBar > 0 ? beatsPerBar : BEATS_PER_BAR;
  const barSec = spb(bpm) * bpb;
  return barSec > 0 ? (atSec - anchorSec) / barSec : 0;
}

/**
 * Garis BAR terdekat dari `atSec` menurut grid sekarang.
 *
 * Dipakai SET DI SINI supaya anchor tidak melompat sejauh setengah bar hanya
 * karena user menekannya saat playhead sedang di antara dua garis: kalau ia
 * sudah cukup dekat ke garis yang ada, yang dimaksud jelas garis itu.
 * Pemanggil yang memutuskan seberapa "cukup dekat" — lihat `SNAP_TOLERANCE_SEC`
 * di panelnya.
 */
export function nearestBarSec(
  anchorSec: number,
  bpm: number,
  atSec: number,
  beatsPerBar: number = BEATS_PER_BAR,
): number {
  const bpb = beatsPerBar > 0 ? beatsPerBar : BEATS_PER_BAR;
  const barSec = spb(bpm) * bpb;
  if (!(barSec > 0)) return atSec;
  return anchorSec + Math.round((atSec - anchorSec) / barSec) * barSec;
}

/**
 * BPM yang sedang berlaku untuk sebuah asset, TERMASUK `tempoOctave`, tanpa
 * lewat `resolveBeatGrid`.
 *
 * Ada karena panel butuh angka ini bahkan saat `resolveBeatGrid` mengembalikan
 * `null` — yaitu justru pada lagu yang paling butuh disunting tangan. `null`
 * hanya kalau memang tidak ada jawabannya sama sekali.
 */
export function currentBpm(asset: StudioAsset | undefined): number | null {
  if (asset === undefined) return null;
  const raw = asset.bpmOverride ?? correctedBpm(asset);
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  return clampGridBpm(raw);
}
