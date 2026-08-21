/**
 * Model halaman ROBLOX — tipe + seluruh aturan yang bisa dijawab tanpa React
 * dan tanpa jaringan.
 *
 * Berkas ini sengaja MURNI. Tidak ada `fetch`, tidak ada store, tidak ada DOM.
 * Alasannya bukan kerapian: batas yang dipakai halaman ini (durasi, ukuran,
 * format, panjang nama) adalah aturan Roblox, dan aturan itu satu-satunya
 * bagian dari halaman ini yang akan tetap sama setelah lapisan unggah ditulis
 * agent lain. Menaruhnya di sini berarti pemasang backend cukup meng-import
 * `violationsOf` alih-alih menyalin ulang angkanya — dan kalau angkanya
 * berubah, ia berubah di SATU tempat.
 *
 * ## Yang TIDAK ada di sini, dan itu disengaja
 *
 * Tidak ada pemanggilan Open Cloud, tidak ada API key yang dikirim ke mana
 * pun, tidak ada antrean yang benar-benar berjalan. Iterasi ini hanya UI:
 * antrean bisa diisi, disunting, dan divalidasi, lalu berhenti di depan pintu
 * yang belum ada. Status `uploading`/`done`/`failed` sudah punya bentuk supaya
 * pemasang backend tinggal memanggil aksi yang sudah tersedia, bukan merombak
 * model.
 */

/** Ekstensi yang diterima Roblox untuk asset audio. */
export const AUDIO_EXTS: readonly string[] = ['.mp3', '.ogg'];

/** MIME yang dipetakan browser ke dua ekstensi di atas. */
export const AUDIO_MIMES: readonly string[] = [
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'application/ogg',
];

/** 20 MB — batas berkas satuan. */
export const MAX_BYTES = 20 * 1024 * 1024;

/** 7 menit. Audio yang lebih panjang ditolak Roblox. */
export const MAX_SECONDS = 7 * 60;

/** Batas panjang nama & deskripsi asset. */
export const MAX_NAME_LEN = 50;
export const MAX_DESC_LEN = 1000;

/**
 * Siklus hidup satu baris antrean.
 *
 * `processing` BUKAN hiasan: Roblox menerima berkasnya lalu memoderasinya
 * secara asinkron, dan asset yang sudah terkirim belum tentu sudah bisa
 * dipakai. Menggabungkannya dengan `done` membuat UI berbohong tentang
 * satu-satunya bagian proses ini yang benar-benar makan waktu.
 */
export type UploadStatus = 'draft' | 'queued' | 'uploading' | 'processing' | 'done' | 'failed';

/** Pemilik asset. Roblox membedakan keduanya di endpoint yang sama. */
export type CreatorKind = 'user' | 'group';

export interface RobloxTarget {
  readonly creatorKind: CreatorKind;
  /**
   * ID user atau group. Disimpan sebagai STRING: ia identitas, bukan angka
   * yang dihitung, dan id Roblox sudah cukup besar untuk membuat pembulatan
   * `number` jadi risiko nyata di masa depan.
   */
  readonly creatorId: string;
  /** API key Open Cloud. Hanya hidup di memori tab ini — lihat `store.ts`. */
  readonly apiKey: string;
}

export interface QueueItem {
  readonly id: number;
  /** Nama berkas asli. Dipajang apa adanya sebagai jangkar bagi user. */
  readonly fileName: string;
  readonly bytes: number;
  /**
   * Durasi hasil probe `<audio>`. `null` = belum atau tidak bisa diukur —
   * BUKAN nol. Membedakan keduanya penting: nol lolos batas 7 menit tanpa
   * pernah diukur.
   */
  readonly seconds: number | null;
  /** Nama asset yang akan dikirim. Awalnya nama berkas tanpa ekstensi. */
  readonly name: string;
  readonly description: string;
  readonly status: UploadStatus;
  /** 0..100. Hanya berarti saat `uploading`. */
  readonly progress: number;
  /** Terisi saat `failed` — pesan apa adanya, bukan "terjadi kesalahan". */
  readonly error: string | null;
  /** Terisi saat `done`: id asset dari Roblox, supaya bisa disalin user. */
  readonly assetId: string | null;
}

export interface RobloxState {
  readonly target: RobloxTarget;
  readonly items: readonly QueueItem[];
  /** Baris yang sedang dibuka panel detailnya. `null` = tidak ada. */
  readonly selected: number | null;
  /**
   * Apakah lapisan unggah benar-benar tersambung. Selama `false`, halaman
   * mengatakannya di badge header alih-alih memasang tombol yang diam-diam
   * tidak melakukan apa pun.
   */
  readonly backendReady: boolean;
  /** Sisa kuota unggah dari backend. `null` = belum diketahui, bukan nol. */
  readonly quotaLeft: number | null;
}

// ── Validasi ────────────────────────────────────────────────────────────────

export type ViolationCode =
  | 'format'
  | 'ukuran'
  | 'durasi-tidak-diketahui'
  | 'durasi'
  | 'nama-kosong'
  | 'nama-panjang'
  | 'deskripsi-panjang';

export interface Violation {
  readonly code: ViolationCode;
  /** Kalimat untuk user, sudah memuat angka yang dilanggar. */
  readonly message: string;
}

/** Ekstensi berkas dalam huruf kecil, termasuk titik. `''` kalau tidak ada. */
export function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? '' : fileName.slice(dot).toLowerCase();
}

/** Nama berkas tanpa ekstensi — nilai awal untuk nama asset. */
export function baseNameOf(fileName: string): string {
  const ext = extOf(fileName);
  const base = ext === '' ? fileName : fileName.slice(0, -ext.length);
  return base.slice(0, MAX_NAME_LEN);
}

/**
 * Apakah berkas ini layak MASUK antrean.
 *
 * Dipisah dari `violationsOf` karena pertanyaannya berbeda: yang ini menjaga
 * pintu (user menjatuhkan 30 berkas, hanya audio yang diterima), sedangkan
 * `violationsOf` menilai baris yang sudah masuk. Berkas berformat salah tidak
 * pernah jadi baris — kalau ia masuk lalu ditandai merah, antrean penuh sampah
 * yang tidak pernah bisa diperbaiki user selain dengan menghapusnya satu-satu.
 */
export function isAudioFile(fileName: string, mime: string): boolean {
  return AUDIO_EXTS.includes(extOf(fileName)) || AUDIO_MIMES.includes(mime.toLowerCase());
}

/**
 * Semua alasan satu baris belum bisa diunggah, terurut dari yang paling sulit
 * diperbaiki user (format) ke yang paling mudah (teks).
 *
 * Mengembalikan DAFTAR, bukan boolean atau pesan pertama: satu berkas bisa
 * sekaligus terlalu besar DAN terlalu panjang, dan user yang cuma diberi tahu
 * satu masalah akan memotong lagunya lalu bertemu masalah kedua.
 */
export function violationsOf(item: QueueItem): readonly Violation[] {
  const out: Violation[] = [];

  if (!AUDIO_EXTS.includes(extOf(item.fileName))) {
    const ext = extOf(item.fileName);
    out.push({
      code: 'format',
      message: `format ${ext === '' ? '?' : ext} tidak didukung — pakai MP3 atau OGG`,
    });
  }
  if (item.bytes > MAX_BYTES) {
    out.push({
      code: 'ukuran',
      message: `${formatBytes(item.bytes)} melewati batas ${formatBytes(MAX_BYTES)}`,
    });
  }
  if (item.seconds === null) {
    out.push({
      code: 'durasi-tidak-diketahui',
      message: 'durasi belum dapat diverifikasi — pilih berkas audio yang metadata durasinya terbaca',
    });
  } else if (item.seconds > MAX_SECONDS) {
    out.push({
      code: 'durasi',
      message: `${formatDuration(item.seconds)} melewati batas ${formatDuration(MAX_SECONDS)}`,
    });
  }
  if (item.name.trim() === '') {
    out.push({ code: 'nama-kosong', message: 'nama asset wajib diisi' });
  } else if (item.name.length > MAX_NAME_LEN) {
    out.push({
      code: 'nama-panjang',
      message: `nama ${item.name.length} karakter, maksimum ${MAX_NAME_LEN}`,
    });
  }
  if (item.description.length > MAX_DESC_LEN) {
    out.push({
      code: 'deskripsi-panjang',
      message: `deskripsi ${item.description.length} karakter, maksimum ${MAX_DESC_LEN}`,
    });
  }
  return out;
}

/** Baris ini boleh dikirim. */
export function isUploadable(item: QueueItem): boolean {
  return violationsOf(item).length === 0;
}

/**
 * Apakah TARGET-nya cukup untuk mengirim apa pun.
 *
 * Terpisah dari validasi baris karena kegagalannya di tempat lain: target yang
 * salah menghentikan SELURUH antrean, dan pesannya harus muncul di panel
 * target — bukan di baris yang sebenarnya tidak apa-apa.
 */
export function targetProblems(target: RobloxTarget): readonly string[] {
  const out: string[] = [];
  if (target.apiKey.trim() === '') out.push('API key Open Cloud belum diisi');
  const id = target.creatorId.trim();
  if (!/^\d+$/.test(id)) out.push(id === '' ? 'ID pemilik belum diisi' : 'ID pemilik harus angka');
  return out;
}

/** Baris yang benar-benar berangkat saat tombol unggah ditekan. */
export function readyItems(state: RobloxState): readonly QueueItem[] {
  return state.items.filter(
    (it) => (it.status === 'draft' || it.status === 'failed') && isUploadable(it),
  );
}

/** Ada baris yang sedang berjalan — dipakai untuk mengunci panel target. */
export function isBusy(state: RobloxState): boolean {
  return state.items.some((it) => it.status === 'uploading' || it.status === 'processing');
}

// ── Format ──────────────────────────────────────────────────────────────────

/**
 * `4.7 MB`. Basis 1024, karena batas yang dibandingkan (`MAX_BYTES`) juga
 * basis 1024 — memakai basis 1000 di sini membuat berkas 20.4 MB tampil
 * sebagai "20.4 MB melewati batas 21.0 MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** `3:07`. `—` untuk durasi yang belum terukur. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Label status untuk badge. Huruf besar, sama seperti seluruh UI ini. */
export const STATUS_LABEL: Readonly<Record<UploadStatus, string>> = {
  draft: 'SIAP',
  queued: 'ANTRE',
  uploading: 'UNGGAH',
  processing: 'MODERASI',
  done: 'SELESAI',
  failed: 'GAGAL',
};

export function createInitialRoblox(): RobloxState {
  return {
    target: { creatorKind: 'user', creatorId: '', apiKey: '' },
    items: [],
    selected: null,
    backendReady: false,
    quotaLeft: null,
  };
}
