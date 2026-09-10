/**
 * Model ASET — bagian model Studio yang tidak tahu lane (docs/25 P4).
 *
 * Yang ada di sini adalah sifat MATERI SUMBER: hasil decode (envelope, panjang,
 * sample rate), hasil analisis tempo, dan koreksi grid dari user. Tidak ada
 * clip, tidak ada lane, tidak ada transport — itu milik `@kelasmalam/studio`
 * (lane) atau `studio-fl` (docs/24). Halaman `/dj` memuat lagu ke deck tanpa
 * satu pun clip, dan justru itulah alasan lapisan ini dipisah: dua Studio dan
 * satu DJ berbagi SATU registry aset, satu jalur decode, satu grid.
 *
 * Tipe-tipe kecil yang dipakai lintas lapisan (`Samples`, `FxInsert`,
 * `FadeCurve`) ikut di sini supaya matematika fade dan node FX preview bisa
 * hidup di core tanpa menarik model lane; `studio/model.ts` mengekspornya
 * ulang, jadi pemakai lama tidak berubah.
 */

import type { BeatAnchor } from '../analysis/beat-grid';
import type { Envelope } from '../timeline/envelope';

/** Posisi/panjang dalam sample pada sample rate project. */
export type Samples = number;

/**
 * Sample rate yang dipakai kalau belum ada AudioContext dan belum ada project
 * yang menentukannya. Sama dengan `DEMO_SAMPLE_RATE` studio; `previewSampleRate`
 * (`preview/audio-context.ts`) jatuh ke sini.
 */
export const DEFAULT_SAMPLE_RATE = 48_000;

export const secToSamples = (sec: number, sr: number): Samples => Math.round(sec * sr);
export const samplesToSec = (s: Samples, sr: number): number => s / sr;

/**
 * Bentuk fade. Rumus dan alasan pemilihannya ada di `timeline/fade.ts` —
 * di sini cuma tipenya, supaya model tidak bergantung pada modul UI.
 */
export type FadeCurve = 'linear' | 'equalPower';

/**
 * Default clip baru. Sengaja equal-power: kasus paling sering adalah menyusun
 * dua lagu yang saling menimpa, dan di sanalah linear terdengar melubang.
 */
export const DEFAULT_FADE_CURVE: FadeCurve = 'equalPower';

/**
 * Satu efek terpasang di insert chain.
 *
 * `kind` adalah id dari katalog Rust (`fxCatalogJson`), dan `params` bernama —
 * bukan berurutan. Itu yang membuat menambah efek ke-7 tidak mengubah satu
 * baris pun di model, store, maupun payload: efek baru hanya berarti `kind`
 * baru dan nama parameter baru, yang keduanya sudah dideklarasikan katalog.
 *
 * Parameter yang tidak diisi memakai default katalog (diterapkan di sisi Rust),
 * jadi menyimpan hanya yang benar-benar diubah user sudah cukup.
 */
export interface FxInsert {
  readonly kind: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, number>>;
}

/**
 * Tempo hasil analisis WASM (`daw-analysis`, lewat `audio/tempo-worker.ts`).
 *
 * Disimpan pada ASSET, bukan pada clip: BPM adalah sifat materi sumbernya.
 * Dua clip dari lagu yang sama punya BPM sumber yang sama; yang membedakannya
 * adalah kecepatan lane tempat mereka duduk — dan itu dihitung saat dipakai
 * (`selectPlayheadTempo` di studio), bukan disalin ke tiap clip.
 */
export interface AssetTempo {
  readonly bpm: number;
  /** 0..1. Di bawah `TEMPO_UNCERTAIN` angka BPM tidak layak dipajang polos. */
  readonly confidence: number;
  readonly beatOffsetSec: number;
  /** Posisi beat individual hasil tracker. Opsional untuk asset/project lama. */
  readonly beatTimesSec?: readonly number[];
}

/**
 * Ambang "tidak yakin". Di bawah ini UI menandai angkanya, bukan
 * menyembunyikannya — materi tanpa ketukan jelas tetap punya jawaban paling
 * mungkin, dan menyembunyikannya sama menyesatkannya dengan memajangnya polos.
 *
 * Nilainya DIUKUR, bukan ditebak. `detectTempo` dijalankan atas materi nyata
 * lewat artefak WASM yang sama dengan yang dipakai aplikasi:
 *
 *   derau putih                    0.015
 *   pad ambient (tanpa transien)   0.017
 *   burst mirip bicara             0.046
 *   lagu nyata #1 (155 BPM)        0.191
 *   lagu nyata #2 (135 BPM)        0.224
 *   groove sintetis (tes Rust)     0.45 – 0.60
 *
 * 0.1 duduk di celah antara dua kelompok itu. Angka pertama yang dipakai di
 * sini adalah 0.2, dan itu SALAH: kedua lagu nyata di atas — yang BPM-nya
 * terbukti benar karena tiap potongan 25 detiknya memberi angka yang sama —
 * akan ditandai "tidak yakin". Musik nyata punya banyak isi ODF yang bukan
 * ketukan, jadi periodisitasnya wajar lebih rendah dari materi sintetis.
 */
export const TEMPO_UNCERTAIN = 0.1;

/** Asset audio yang sudah di-decode. Peak nyata, bukan mock. */
export interface StudioAsset {
  readonly id: number;
  readonly name: string;
  /**
   * SHA-256 berkas asalnya — identitas yang BERTAHAN melewati sesi (docs/16 §2).
   *
   * `''` berarti tidak punya berkas asal: hasil `bakeClipStem` lahir dari
   * render, bukan dari file. Itu keadaan yang sah, dan sengaja dibedakan dari
   * "belum dihitung" — asset tanpa hash tidak bisa diunggah ke kepustakaan,
   * dan project yang merujuknya akan ditolak server (docs/16 §8e).
   */
  readonly contentHash: string;
  /**
   * Peak pyramid multi-resolusi (min/max/rms per bucket, 64/512/4096 sample).
   * Menggantikan `peaks: Float32Array` beresolusi tunggal: dengan satu
   * resolusi tetap, waveform lagu panjang mentok jadi persegi panjang rata.
   * Lihat `timeline/envelope.ts`.
   */
  readonly envelope: Envelope;
  readonly frames: Samples;
  readonly sampleRate: number;
  /**
   * `null` selama analisis belum selesai ATAU kalau materinya tidak bisa
   * dianalisis (< 8 detik, senyap). Dua keadaan itu sengaja tidak dibedakan di
   * sini; yang membedakannya adalah `tempoPending`.
   */
  readonly tempo: AssetTempo | null;
  /** true selama worker masih bekerja. Memisahkan "belum tahu" dari "tidak ada". */
  readonly tempoPending: boolean;
  /**
   * Koreksi oktaf dari user: BPM efektif = `tempo.bpm * 2 ** tempoOctave`.
   *
   * Ada karena oktaf tempo memang tidak selalu bisa diputuskan oleh mesin —
   * lagu 170 BPM dengan backbeat sama sahnya didengar sebagai 85. Setiap
   * perkakas DJ menyediakan ×2 / ÷2 untuk alasan yang sama.
   */
  readonly tempoOctave: number;
  /**
   * BPM yang DIKETIK user. null = pakai hasil deteksi (× koreksi oktaf).
   *
   * Terpisah dari `tempo.bpm` dan bukan menimpanya: deteksi tetap tersimpan
   * supaya tombol AUTO benar-benar bisa mengembalikan keadaan semula. Dibaca
   * lewat `resolveBeatGrid` di `analysis/beat-grid.ts` — jangan dibaca langsung.
   */
  readonly bpmOverride: number | null;
  /**
   * Posisi ketukan pertama (detik, SOURCE-space) menurut user. null = pakai
   * `tempo.beatOffsetSec`.
   *
   * Ada karena yang dideteksi mesin adalah fase KETUKAN, bukan fase birama —
   * tidak ada cara otomatis untuk tahu ketukan mana yang "satu", dan grid yang
   * downbeat-nya meleset tidak bisa dipakai memotong apa pun.
   */
  readonly beatOffsetOverride: number | null;
  /**
   * Anchor tempo TAMBAHAN, urut menaik — `[Dynamic]` rekordbox.
   *
   * `null` (yang biasa) berarti satu tempo untuk seluruh lagu, dan seluruh
   * jalur lama berjalan persis seperti sebelumnya. Begitu ada isinya, grid
   * lagu ini dibaca per posisi lewat `resolveBeatGridAt`.
   *
   * Disimpan di ASSET, bukan di deck, karena ia koreksi atas MATERI — sama
   * dengan `bpmOverride` di atasnya, dan dengan alasan yang sama.
   */
  readonly beatAnchors?: readonly BeatAnchor[] | null;
  /**
   * `[Analysis Lock]` rekordbox: *"Set to disable re-analysis and grid edit."*
   *
   * Di rekordbox kunci ini ada karena analisis ulang MENIMPA koreksi grid
   * manual. Di sini tidak: `resolveBeatGrid` membaca `bpmOverride ?? deteksi`,
   * jadi override user sudah kebal dengan sendirinya. Yang tersisa untuk
   * dijaga kunci ini adalah jalan HILANGNYA koreksi itu — tombol AUTO, yang
   * satu klik salahnya membuang kerja sepuluh menit — dan mencegah lagu ini
   * ikut antre analisis batch yang tidak akan mengubah apa pun untuknya.
   *
   * Penjagaannya ada di `setAssetBeatGrid`, `resetAssetBeatGrid`, dan
   * `markAssetTempoPending`. Ketiganya adalah CADANGAN, bukan jalur utama: UI
   * mematikan kontrolnya lebih dulu, karena setter yang diam-diam mengabaikan
   * tulisan adalah bentuk kegagalan yang paling sulit dilacak dari layar.
   */
  readonly analysisLock: boolean;
}

/** assetId → asset. Bentuk yang disimpan `assetStore`. */
export type AssetMap = Readonly<Record<number, StudioAsset>>;

/**
 * Tahap yang sedang dikerjakan satu import. Urutannya = urutan kejadiannya.
 *
 * Bernama, bukan satu bar "loading", karena tiap tahap punya perilaku waktu
 * yang berbeda dan user perlu tahu bedanya: `reading` bisa diukur persis
 * (ukuran file diketahui), `decoding` dikerjakan browser di luar kendali kita
 * dan TIDAK bisa diukur, `analyzing` (peak pyramid) singkat tapi sinkron. Satu
 * bar tanpa nama tahap akan terlihat menggantung di 60% selama decode berjalan,
 * dan itu terbaca sebagai macet.
 *
 * Tiga tahap terakhir milik job PEMISAHAN VOKAL (docs/26 §3a), yang memakai
 * bar progres lane yang sama karena hasilnya juga "materi baru di lane":
 * `model` mengunduh bobot ORT (terukur), `separating` inferensi per segmen
 * (terukur, bisa lama), `assembling` menyusun dua asset hasil (singkat).
 */
export type ImportStage =
  | 'reading'
  | 'decoding'
  | 'analyzing'
  | 'model'
  | 'separating'
  | 'assembling';
