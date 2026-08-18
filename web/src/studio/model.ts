/**
 * Model data Audio Studio — SATU sumber kebenaran untuk seluruh UI.
 *
 * Design: `design/Audio Studio.dc.html`. Design itu memakai detik (`start`,
 * `len`) karena ia mock. Di sini semuanya **sample (u64-ish)**, sesuai aturan
 * docs/00: posisi tidak pernah disimpan sebagai detik float. Detik hanya untuk
 * ditampilkan.
 *
 * Catatan pemetaan istilah: design menyebut "lane"; engine menyebutnya "track"
 * (`daw_engine`). Keduanya hal yang sama — UI memakai kata design, boundary ke
 * engine memakai kata engine.
 */

/** Posisi/panjang dalam sample pada sample rate project. */
export type Samples = number;

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

export interface StudioClip {
  id: string;
  assetId: number;
  /** Posisi di timeline (sample). */
  start: Samples;
  /**
   * Panjang di TIMELINE-space. TURUNAN: `round(sourceLen / lane.speedRatio)`.
   * Jangan diubah langsung — pakai action `setLaneSpeed`/`splitClipAtPlayhead`
   * supaya tetap konsisten dengan `sourceLen`.
   */
  len: Samples;
  /** Offset trim-in di dalam source asset (sample, SOURCE-space). */
  sourceStart: Samples;
  /** Panjang region yang dipakai di SOURCE-space. Tidak berubah oleh speed. */
  sourceLen: Samples;
  label: string;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  /**
   * Bentuk kurva untuk KEDUA fade clip ini. Satu nilai per clip, bukan per
   * sisi: fade-in dan fade-out sebuah clip selalu dipakai untuk keperluan yang
   * sama (masuk/keluar dari transisi), dan memberi dua pilihan berbeda hanya
   * menambah cara untuk salah tanpa kasus nyata yang membutuhkannya.
   *
   * Project lama tidak punya field ini — lihat `normalizeClipFade` di
   * `timeline/fade.ts`, yang mengisinya saat load.
   */
  fadeCurve: FadeCurve;
  /**
   * REGION LOOP di dalam clip, panjangnya di SOURCE-space. `undefined` (atau
   * 0) = clip diputar lurus seperti biasa.
   *
   * Artinya: materi yang berbunyi adalah `[sourceStart, sourceStart + loopLen)`
   * SAJA, diulang terus sampai clip habis — panjang clip di timeline (`len`)
   * tidak berubah karenanya. Ini yang membedakannya dari LOOP CUT, yang
   * memotong clip jadi beberapa clip nyata.
   *
   * KENAPA HANYA PANJANGNYA, BUKAN PASANGAN start+len SENDIRI: awal region
   * SELALU `sourceStart`. Kalau loop punya awalnya sendiri, akan ada dua titik
   * masuk ke materi yang sama (trim-in dan awal loop) yang bisa berselisih, dan
   * setiap trim/slip harus menjaga keduanya tetap sinkron. Dengan satu titik,
   * slip menggeser loop-nya juga — itu justru gerakan yang dicari.
   *
   * `len`/`sourceLen` TETAP pada hubungan lamanya (`len = sourceLen / ratio`),
   * jadi speed, trim, dan drag tidak perlu tahu apa-apa soal loop. Yang berubah
   * hanya cara materi itu dibaca: melingkar, bukan lurus.
   */
  loopLen?: Samples;
  /**
   * Sisa dari era mock waveform. Waveform sekarang SELALU digambar dari peak
   * pyramid asset (`timeline/envelope.ts`); clip tanpa asset mendapat
   * placeholder yang sengaja tidak menyerupai audio, bukan bentuk dari seed.
   * Field-nya dipertahankan karena ikut tersimpan di project user — membuangnya
   * berarti migrasi untuk nilai yang tidak mahal disimpan.
   */
  seed: number;
  /**
   * Pembuangan stem (vokal / bass / instrumen). OPSIONAL — project lama tidak
   * punya field ini, dan `undefined` diperlakukan sama dengan `STEM_BYPASS`
   * oleh `isStemBypass`. Dinormalkan sekali di pintu masuk lewat
   * `normalizeClipStem` (`timeline/stem.ts`).
   */
  stem?: StemMix;
}

/**
 * PEMISAHAN STEM ALA MID/SIDE — bukan stem separation ML.
 *
 * Yang bisa dilakukan tanpa FFT dan tanpa model adalah menguraikan sinyal jadi
 * tiga bagian yang menjumlah kembali PERSIS ke aslinya:
 *
 *   M = (L+R)/2                 S = (L-R)/2
 *   bass  = LP(M, bassSplitHz)                    → yang di tengah dan rendah
 *   vocal = LP(M - bass, voiceTopHz)              → yang di tengah dan menengah
 *   other = (M - bass - vocal) + S                → sisi + treble tengah
 *
 * Tiap angka di bawah adalah SEBERAPA BANYAK BAGIAN ITU DISISAKAN, 0..1.
 * Semua 1 = bypass, dan bypass-nya transparan secara aritmetika, bukan sekadar
 * "kira-kira sama" — lihat `preview/stem-chain.ts`.
 *
 * BATASNYA HARUS DIKATAKAN, BUKAN DISEMBUNYIKAN: materi MONO tidak punya `S`,
 * jadi "buang vokal" di sana akan ikut membuang instrumen di pita yang sama,
 * dan vokal yang di-reverb lebar tidak berada di tengah sehingga tidak ikut
 * terbuang. Ini alat karaoke, bukan Demucs.
 */
export interface StemMix {
  /** Bagian tengah di pita suara. */
  readonly vocal: number;
  /** Bagian tengah di bawah `bassSplitHz`. */
  readonly bass: number;
  /** Sisi (stereo) + tengah di atas `voiceTopHz`. */
  readonly other: number;
  /** Batas bass ↔ suara (Hz). */
  readonly bassSplitHz: number;
  /** Batas atas pita suara (Hz). */
  readonly voiceTopHz: number;
}

export type StemId = 'vocal' | 'bass' | 'other';

/** Semua bagian utuh. Nilai default untuk clip baru dan hasil BAKE. */
export const STEM_BYPASS: StemMix = {
  vocal: 1,
  bass: 1,
  other: 1,
  bassSplitHz: 180,
  voiceTopHz: 6000,
};

export const STEM_MIN_BASS_HZ = 60;
export const STEM_MAX_BASS_HZ = 300;
export const STEM_MIN_VOICE_TOP_HZ = 2000;
export const STEM_MAX_VOICE_TOP_HZ = 12_000;

/**
 * true kalau rantai stem tidak perlu dibangun sama sekali.
 *
 * Dipakai `graph-builder` sebagai gerbang: clip biasa tidak boleh membayar dua
 * puluh node Web Audio untuk pemrosesan yang hasilnya sama dengan tidak
 * memproses apa pun. Frekuensi TIDAK ikut diperiksa — mengubah crossover saat
 * semua bagian disisakan penuh memang tidak mengubah apa-apa.
 */
export function isStemBypass(s: StemMix | undefined): boolean {
  return s === undefined || (s.vocal >= 1 && s.bass >= 1 && s.other >= 1);
}

/** Jaga nilai stem tetap sah — dipanggil di store dan saat load project. */
export function clampStemMix(s: StemMix): StemMix {
  const amt = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
  const hz = (v: number, lo: number, hi: number, fallback: number): number =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    vocal: amt(s.vocal),
    bass: amt(s.bass),
    other: amt(s.other),
    bassSplitHz: hz(s.bassSplitHz, STEM_MIN_BASS_HZ, STEM_MAX_BASS_HZ, STEM_BYPASS.bassSplitHz),
    voiceTopHz: hz(
      s.voiceTopHz,
      STEM_MIN_VOICE_TOP_HZ,
      STEM_MAX_VOICE_TOP_HZ,
      STEM_BYPASS.voiceTopHz,
    ),
  };
}

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

export interface StudioLane {
  id: string;
  name: string;
  /** Hex, dari palet design: #ffd400, #ffb020, #a07a10, #6f6a5e. */
  color: string;
  mute: boolean;
  solo: boolean;
  gainDb: number;
  /** Insert chain lane, dijalankan setelah EQ bawaan. */
  chain: FxInsert[];
  /**
   * Kecepatan lane. 1 = normal, 2 = dua kali lebih cepat. VARISPEED — pitch
   * ikut berubah. Berlaku untuk SEMUA clip di lane ini.
   *
   * Semantik: hanya DURASI clip yang berubah, POSISI mulai tetap. Kalau posisi
   * ikut diskalakan, mengubah speed satu lane akan menggeser semua clip-nya
   * relatif terhadap lane lain — sinkronisasi antar lane rusak tanpa user
   * menyentuh apa pun di lane itu.
   */
  speedRatio: number;
  eq: EqSettings;
  clips: StudioClip[];
}

/** Jenis biquad yang dipakai band EQ. Sama persis dengan `BiquadFilterType`
 *  Web Audio, jadi nilainya bisa langsung dipasang ke node tanpa pemetaan. */
export type EqBandKind = 'lowshelf' | 'peaking' | 'highshelf';

export type EqBandId = 'low' | 'mid' | 'pres' | 'air';

export interface EqBand {
  /** Stabil seumur hidup band — dipakai sebagai key React dan target action. */
  id: EqBandId;
  label: string;
  /** Warna node di kurva (palet design). */
  color: string;
  kind: EqBandKind;
  /** Hz. */
  freq: number;
  q: number;
  gainDb: number;
}

/**
 * EQ parametrik 4 band. Bukan lagi tiga angka gain di frekuensi tetap:
 * frekuensi ikut jadi data karena node di kurva bisa digeser mendatar.
 *
 * Disimpan sebagai array (bukan map per id) supaya urutan rantai filter =
 * urutan array — rantai audio dan urutan gambar tidak bisa jadi beda diam-diam.
 */
export interface EqSettings {
  bands: EqBand[];
}

/** Batas gain node kurva. Lebih lebar dari slider lama (±12) karena EQ
 *  parametrik dengan Q sempit memang butuh cut yang dalam. */
export const EQ_MAX_GAIN_DB = 18;
/** Batas frekuensi yang boleh dicapai node saat digeser mendatar. */
export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20_000;

/** Batas amplify master (dB). Cukup untuk mengangkat mix pelan tanpa absurd. */
export const MIN_MASTER_GAIN_DB = -24;
export const MAX_MASTER_GAIN_DB = 12;

/** Rentang kecepatan render saat compile. */
export const MIN_RENDER_SPEED = 0.25;
export const MAX_RENDER_SPEED = 4;

export type EqPreset = 'FLAT' | 'BASS' | 'VOCAL' | 'CLUB';

/**
 * Cara EQ ditampilkan. Keduanya mengedit DATA YANG SAMA (`EqSettings`) —
 * ini murni pilihan tampilan, bukan dua engine EQ berbeda.
 *
 *  - `curve`   : node bisa digeser dua sumbu (gain + frekuensi). Untuk
 *                membentuk suara secara halus.
 *  - `sliders` : satu slider gain per band, frekuensi tetap. Lebih cepat kalau
 *                cuma mau menaikkan/menurunkan sesuatu.
 */
export type EqMode = 'curve' | 'sliders';
/**
 * Format file hasil compile.
 *
 *  - `AUTO` : resolve ke WAV — lossless, nol dependensi, selalu bisa dibuka.
 *  - `WAV`  : PCM mentah (Rust), kedalaman bit bisa dipilih.
 *  - `FLAC` : lossless TERKOMPRESI (Rust) — sample yang sama persis, ±setengah
 *             ukuran WAV. Ini jawaban untuk "WAV-nya kebesaran".
 *  - `MP3`  : lossy, lamejs (di-`import()` saat dipilih).
 *  - `OGG`  : lossy Vorbis, vorbis-encoder-js (di-`import()` saat dipilih).
 *
 * Project lama hanya menyimpan tiga nilai pertama; nilai yang tidak dikenal
 * jatuh ke AUTO lewat `resolveFormat` di `CompileCard`.
 */
export type ExportFormat = 'AUTO' | 'WAV' | 'FLAC' | 'MP3' | 'OGG';
export type RailTab = 'mix' | 'eq' | 'compile';

/** Nilai kecepatan yang ditawarkan design. PITCH LOCKED — lihat catatan bawah. */
export const SPEEDS = [0.5, 0.75, 1, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * Titik awal 4 band: frekuensi, Q, dan warna dari design. Semua gain 0 —
 * project baru tidak boleh diam-diam mewarnai suara user.
 */
export const EQ_DEFAULT_BANDS: readonly EqBand[] = [
  { id: 'low', label: 'LOW', color: '#ff7ad9', kind: 'lowshelf', freq: 90, q: 0.7, gainDb: 0 },
  { id: 'mid', label: 'MID', color: '#ffd400', kind: 'peaking', freq: 620, q: 1.0, gainDb: 0 },
  { id: 'pres', label: 'PRES', color: '#6ee7ff', kind: 'peaking', freq: 3800, q: 1.2, gainDb: 0 },
  { id: 'air', label: 'AIR', color: '#a78bfa', kind: 'highshelf', freq: 11000, q: 0.7, gainDb: 0 },
];

/** EQ netral baru. Selalu objek baru: band bisa diedit per lane, jadi tidak
 *  boleh ada dua lane yang berbagi array yang sama. */
export function defaultEq(): EqSettings {
  return { bands: EQ_DEFAULT_BANDS.map((b) => ({ ...b })) };
}

/** Preset = default + override per band. Hanya nilai yang benar-benar berbeda
 *  yang ditulis, supaya frekuensi/Q/warna tetap satu sumber di atas. */
function preset(over: Partial<Record<EqBandId, Partial<EqBand>>>): EqSettings {
  return { bands: EQ_DEFAULT_BANDS.map((b) => ({ ...b, ...over[b.id] })) };
}

export const EQ_PRESETS: Record<EqPreset, EqSettings> = {
  FLAT: preset({}),
  BASS: preset({ low: { gainDb: 6, freq: 80 }, mid: { gainDb: -1.5 }, air: { gainDb: 0 } }),
  VOCAL: preset({
    low: { gainDb: -3, freq: 120 },
    mid: { gainDb: 2.5, freq: 900 },
    pres: { gainDb: 4, freq: 3200 },
    air: { gainDb: 2 },
  }),
  CLUB: preset({
    low: { gainDb: 5, freq: 70 },
    mid: { gainDb: -3, freq: 500 },
    pres: { gainDb: 1.5 },
    air: { gainDb: 4 },
  }),
};

/**
 * Jaga band tetap di rentang yang sah. Dipasang di store (bukan hanya di UI)
 * supaya nilai dari drag, keyboard, atau state lama tidak bisa membuat
 * `BiquadFilterNode` menerima frekuensi 0/NaN dan mematikan lane.
 */
export function clampEqBand(b: EqBand): EqBand {
  const freq = Number.isFinite(b.freq) ? b.freq : EQ_MIN_HZ;
  const gainDb = Number.isFinite(b.gainDb) ? b.gainDb : 0;
  const q = Number.isFinite(b.q) ? b.q : 1;
  return {
    ...b,
    freq: Math.min(EQ_MAX_HZ, Math.max(EQ_MIN_HZ, freq)),
    gainDb: Math.min(EQ_MAX_GAIN_DB, Math.max(-EQ_MAX_GAIN_DB, gainDb)),
    q: Math.min(18, Math.max(0.1, q)),
  };
}

/** Salinan dalam sebuah preset — tanpa ini semua lane akan menunjuk objek band
 *  yang sama dan mengedit satu lane ikut mengubah lane lain. */
export function cloneEq(eq: EqSettings): EqSettings {
  return { bands: eq.bands.map((b) => ({ ...b })) };
}

/** Batas kecepatan lane yang masih masuk akal untuk varispeed. */
export const MIN_LANE_SPEED = 0.25;
export const MAX_LANE_SPEED = 4;

/** Pilihan cepat di header lane. Nilai lain tetap sah lewat `setLaneSpeed`. */
export const LANE_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Kecepatan efektif = kecepatan lane × kecepatan transport.
 * Rumus dari docs/07 §8d (`effective_ratio = lane_ratio × master_ratio`).
 */
export function effectiveSpeed(lane: StudioLane, transportSpeed: number): number {
  return lane.speedRatio * transportSpeed;
}

/**
 * Panjang TIMELINE dari sebuah region source pada kecepatan tertentu.
 * Lebih cepat = lebih pendek di timeline. Inilah satu-satunya tempat konversi
 * source→timeline dilakukan, supaya tidak tersebar dan tidak saling beda.
 */
export function timelineLenFor(sourceLen: Samples, speedRatio: number): Samples {
  const r = Math.max(MIN_LANE_SPEED, Math.min(MAX_LANE_SPEED, speedRatio));
  return Math.max(1, Math.round(sourceLen / r));
}

export const LANE_COLORS = ['#ffd400', '#ffb020', '#a07a10', '#6f6a5e'];
/**
 * Tinggi baris lane. Tiga pilihan, bukan satu angka mati.
 *
 * 64 px — nilai lama, dan terlalu pendek untuk mengedit: waveform di dalamnya
 * hanya setinggi ±40 px, sehingga transien tidak terbaca dan sasaran klik clip
 * pendek jadi sempit. Default sekarang MEDIUM. SMALL tetap ada karena project
 * dengan banyak lane butuh melihat semuanya sekaligus.
 */
export type LaneHeightId = 'S' | 'M' | 'L';
export const LANE_HEIGHTS: Readonly<Record<LaneHeightId, number>> = { S: 64, M: 96, L: 144 };
export const DEFAULT_LANE_HEIGHT: LaneHeightId = 'M';
export const LANE_HEIGHT_IDS: readonly LaneHeightId[] = ['S', 'M', 'L'];

/** Tinggi lama. Dipertahankan hanya untuk pemakai yang belum ikut diubah. */
export const LANE_HEIGHT_PX = LANE_HEIGHTS.S;

export function laneHeightPx(id: LaneHeightId | undefined): number {
  return LANE_HEIGHTS[id ?? DEFAULT_LANE_HEIGHT] ?? LANE_HEIGHTS[DEFAULT_LANE_HEIGHT];
}

export interface StudioState {
  projectName: string;
  sampleRate: number;
  /** Panjang timeline (sample). Diturunkan dari clip terjauh, minimal 2 menit. */
  duration: Samples;
  lanes: StudioLane[];

  playing: boolean;
  playhead: Samples;
  speed: Speed;

  selectedLaneId: string | null;
  selectedClipId: string | null;

  /** null = mode FIT (timeline dipaskan ke lebar viewport). */
  pxPerSecond: number | null;
  tab: RailTab;
  format: ExportFormat;
  preset: EqPreset;

  /** 0..1 saat export berjalan, null saat idle. */
  exportProgress: number | null;

  /**
   * Amplify master (dB) — diterapkan SETELAH semua lane dijumlahkan.
   * Berlaku untuk preview DAN export; kalau hanya salah satu, file hasilnya
   * beda level dari yang didengar.
   */
  masterGainDb: number;
  /** Insert chain master. */
  masterChain: FxInsert[];
  /**
   * Kecepatan pemutaran yang dipakai SAAT COMPILE. Terpisah dari `speed`
   * (transport) supaya mengubah kecepatan saat mendengarkan tidak diam-diam
   * mengubah kecepatan file yang dihasilkan.
   */
  renderSpeed: number;
  /** Nama berkas hasil export, tanpa ekstensi. Kosong = pakai nama project. */
  exportFileName: string;
}

// ── Helper murni (dipakai UI dan tes) ────────────────────────────────────────

export const secToSamples = (sec: number, sr: number): Samples => Math.round(sec * sr);
export const samplesToSec = (s: Samples, sr: number): number => s / sr;

/** Format mm:ss seperti `time()` di design. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function laneTotalSamples(lane: StudioLane): Samples {
  return lane.clips.reduce((a, c) => a + c.len, 0);
}

export function findClip(
  lanes: StudioLane[],
  clipId: string | null,
): { lane: StudioLane; clip: StudioClip } | null {
  if (!clipId) return null;
  for (const lane of lanes) {
    const clip = lane.clips.find((c) => c.id === clipId);
    if (clip) return { lane, clip };
  }
  return null;
}

/**
 * Solo bersifat eksklusif secara global: kalau ADA lane yang solo, lane tanpa
 * solo dianggap mute. Engine tidak punya opcode solo (lihat catatan integrasi),
 * jadi UI menerjemahkannya jadi mute efektif.
 */
export function isAudible(lane: StudioLane, lanes: StudioLane[]): boolean {
  if (lane.mute) return false;
  const anySolo = lanes.some((l) => l.solo);
  return !anySolo || lane.solo;
}

/**
 * CATATAN PRODUK — "SPEED · PITCH LOCKED" di design.
 *
 * Label itu menjanjikan time-stretch yang mempertahankan pitch (WSOLA/phase
 * vocoder), BUKAN varispeed. Di docs/07 kita memutuskan varispeed dulu untuk
 * MVP justru karena time-stretch mahal. Jadi ada selisih antara design dan
 * kemampuan engine saat ini.
 *
 * Keputusan sementara: tombol speed tetap ada dan berfungsi (varispeed), tapi
 * label "PITCH LOCKED" TIDAK boleh ditampilkan sampai stretch benar-benar ada —
 * menampilkannya berarti berbohong ke user tentang apa yang terjadi pada audio.
 * Lihat `PITCH_LOCK_AVAILABLE`.
 */
export const PITCH_LOCK_AVAILABLE = false;
