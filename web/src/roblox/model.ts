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

import type {
  RobloxCategory,
  RobloxGenre,
  RobloxModerationState,
  RobloxTaxonomy,
  RobloxUploadRow,
} from '../platform/local-commands';

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

// ── Taksonomi: kategori → genre (docs/21 §1d) ───────────────────────────────

export type { RobloxCategory, RobloxGenre, RobloxTaxonomy } from '../platform/local-commands';

/**
 * Taksonomi bawaan supaya halaman tidak lahir kosong. Ini BARIS BIASA, bukan
 * enum: user boleh mengganti nama, memindah, dan menghapusnya. Di desktop
 * Rust yang menanam seed-nya (docs/21 §1d); di web seed yang sama ditanam dari
 * sini ke IndexedDB — dua sumber, satu daftar, supaya UI-nya satu.
 */
export const DEFAULT_TAXONOMY_SEED: readonly { readonly category: string; readonly genres: readonly string[] }[] = [
  { category: 'Musik', genres: ['Lo-fi', 'Hip-hop', 'EDM', 'Pop', 'Rock', 'Ambient', 'Orkestra', 'Jazz', 'Chiptune'] },
  { category: 'Efek suara', genres: ['UI', 'Ambience', 'Foley', 'Stinger', 'Senjata'] },
  { category: 'Suara', genres: ['Jingle', 'Narasi', 'Vokal'] },
];

/**
 * Id taksonomi bawaan dibuat DETERMINISTIK dari namanya (`kat:musik`,
 * `gen:musik/lo-fi`), bukan acak: taksonomi yang sama di dua mesin web
 * menghasilkan id yang sama, dan tes bisa menyebut `gen:musik/lo-fi` tanpa
 * membaca state dulu. Genre buatan user memakai id acak — namanya boleh sama
 * dengan yang pernah dihapus tanpa menghidupkan kembali id lamanya.
 */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function defaultTaxonomy(): RobloxTaxonomy {
  const categories: RobloxCategory[] = [];
  const genres: RobloxGenre[] = [];
  DEFAULT_TAXONOMY_SEED.forEach((entry, ci) => {
    const categoryId = `kat:${slugOf(entry.category)}`;
    categories.push({ id: categoryId, name: entry.category, sort: ci });
    entry.genres.forEach((genre, gi) => {
      genres.push({ id: `gen:${slugOf(entry.category)}/${slugOf(genre)}`, categoryId, name: genre, sort: gi });
    });
  });
  return { categories, genres };
}

/** Kategori terurut `sort`, lalu nama — urutan yang sama di semua panel. */
export function sortedCategories(t: RobloxTaxonomy): readonly RobloxCategory[] {
  return [...t.categories].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

/** Genre milik satu kategori, terurut. `categoryId` null = tidak ada genre. */
export function genresOf(t: RobloxTaxonomy, categoryId: string | null): readonly RobloxGenre[] {
  if (categoryId === null) return [];
  return t.genres
    .filter((g) => g.categoryId === categoryId)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export function categoryById(t: RobloxTaxonomy, id: string | null): RobloxCategory | null {
  return id === null ? null : (t.categories.find((c) => c.id === id) ?? null);
}

export function genreById(t: RobloxTaxonomy, id: string | null): RobloxGenre | null {
  return id === null ? null : (t.genres.find((g) => g.id === id) ?? null);
}

/**
 * `Musik / Lo-fi` — label yang dipakai di baris antrean, katalog, dan baris
 * terakhir deskripsi asset. `—` kalau salah satu belum dipilih ATAU id-nya
 * menunjuk baris yang sudah dihapus: label harus bisa dipercaya, bukan
 * menampilkan nama genre yang sudah tidak ada.
 */
export function genreLabel(t: RobloxTaxonomy, categoryId: string | null, genreId: string | null): string {
  const cat = categoryById(t, categoryId);
  const gen = genreById(t, genreId);
  if (cat === null || gen === null || gen.categoryId !== cat.id) return '—';
  return `${cat.name} / ${gen.name}`;
}

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
  /**
   * API key Open Cloud aktif. Web: salinan aktif yang dimuat dari D1. Desktop:
   * HANYA isi kolom yang belum disimpan — begitu ditekan SIMPAN ia pindah ke
   * keychain OS dan kolomnya dikosongkan (docs/21 §1f); yang menandai bahwa
   * kuncinya ada adalah `RobloxState.apiKeyStored`.
   */
  readonly apiKey: string;
  /**
   * Tulis baris `Genre: <kategori> / <genre>` di akhir deskripsi asset
   * (docs/21 §1d). Hidup secara bawaan: itu satu-satunya cara metadata ini
   * terlihat di Creator Hub, dan memakan ≤ 40 dari 1000 karakter.
   */
  readonly genreToDescription: boolean;
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
  /** Operasi Open Cloud yang dipoll selama moderasi; dipersist agar bisa resume. */
  readonly operationId?: string | null;
  /** Kategori → genre (docs/21 §1d). WAJIB sebelum unggah; lihat `violationsOf`. */
  readonly categoryId: string | null;
  readonly genreId: string | null;
  /**
   * Identitas baris yang BERTAHAN melewati sesi — pola yang sama dengan
   * `assetId`/`contentHash` di kepustakaan: `id` numerik adalah kunci runtime
   * (memo baris, `fileOf`), `localId` adalah kunci baris `roblox_upload` di
   * SQLite (desktop) dan kunci katalog (web). Dibuat saat baris lahir.
   */
  readonly localId: string;
  /**
   * Hash lagu di kepustakaan. Desktop: byte-nya di `tracks/<hash>`, diisi
   * setelah berkas selesai masuk kepustakaan — sebelum itu `null`, dan baris
   * belum bisa ditulis ke tabel. Web: selalu `null`, byte-nya di IndexedDB.
   */
  readonly hash: string | null;
}

/** Penyaring tab KATALOG. Dihitung di TS untuk kedua platform. */
export interface CatalogFilter {
  readonly categoryId: string | null;
  readonly genreId: string | null;
  readonly query: string;
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
  /** Kategori → genre milik user (docs/21 §1d). Disunting di tab TAKSONOMI. */
  readonly taxonomy: RobloxTaxonomy;
  /**
   * Baris yang sudah `done`/`failed` — dipisah dari `items` supaya antrean
   * tetap ringan setelah ratusan unggahan (docs/21 §3b). Desktop: dari
   * `roblox_catalog_list`; web: dari dokumen IndexedDB yang sama.
   */
  readonly catalog: readonly RobloxUploadRow[];
  readonly catalogFilter: CatalogFilter;
  /**
   * Desktop: API key ada di keychain OS. Web: selalu `false` — di sana kuncinya
   * ada di `target.apiKey`. Yang dibaca `targetProblems` adalah salah satunya.
   */
  readonly apiKeyStored: boolean;
}

// ── Validasi ────────────────────────────────────────────────────────────────

export type ViolationCode =
  | 'format'
  | 'ukuran'
  | 'durasi-tidak-diketahui'
  | 'durasi'
  | 'nama-kosong'
  | 'nama-panjang'
  | 'deskripsi-panjang'
  | 'kategori-kosong'
  | 'genre-kosong';

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
  /*
   * Kategori & genre WAJIB (docs/21 §1d). Bukan disiplin: seluruh manfaat tab
   * KATALOG adalah menjawab "genre apa", dan katalog yang separuh isinya
   * "belum dikategorikan" tidak menjawab apa-apa. Dua kode terpisah, karena
   * perbaikannya dua langkah berbeda — dan pesannya menyebut langkahnya.
   */
  if (item.categoryId === null) {
    out.push({
      code: 'kategori-kosong',
      message: 'kategori belum dipilih — pilih di kolom KATEGORI baris ini, atau centang beberapa baris lalu terapkan sekaligus',
    });
  } else if (item.genreId === null) {
    out.push({
      code: 'genre-kosong',
      message: 'genre belum dipilih — pilih di kolom GENRE, atau buat lewat "+ genre baru"',
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
export function targetProblems(target: RobloxTarget, apiKeyStored = false): readonly string[] {
  const out: string[] = [];
  if (target.apiKey.trim() === '' && !apiKeyStored) out.push('API key Open Cloud belum diisi');
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
  done: 'DISETUJUI',
  failed: 'GAGAL',
};

export function createInitialRoblox(): RobloxState {
  return {
    target: { creatorKind: 'user', creatorId: '', apiKey: '', genreToDescription: true },
    items: [],
    selected: null,
    backendReady: false,
    quotaLeft: null,
    taxonomy: defaultTaxonomy(),
    catalog: [],
    catalogFilter: { categoryId: null, genreId: null, query: '' },
    apiKeyStored: false,
  };
}

// ── Deskripsi yang dikirim ke Roblox (docs/21 §3d) ──────────────────────────

/**
 * Deskripsi + baris `Genre: Musik / Lo-fi` kalau opsinya hidup. Kalau baris
 * itu membuat deskripsi melewati `MAX_DESC_LEN`, ia TIDAK ditambahkan —
 * lebih baik metadata absen di Creator Hub daripada Roblox menolak asset
 * yang sudah lolos validasi di layar. Desktop: Rust yang menambahkannya dari
 * tabel `setting`; fungsi ini dipakai jalur web dan pratinjau.
 */
export function descriptionForRoblox(
  item: Pick<QueueItem, 'description' | 'categoryId' | 'genreId'>,
  taxonomy: RobloxTaxonomy,
  genreToDescription: boolean,
): string {
  if (!genreToDescription) return item.description;
  const label = genreLabel(taxonomy, item.categoryId, item.genreId);
  if (label === '—') return item.description;
  const line = `Genre: ${label}`;
  const joined = item.description.trim() === '' ? line : `${item.description.trimEnd()}\n\n${line}`;
  return joined.length > MAX_DESC_LEN ? item.description : joined;
}

// ── Katalog (docs/21 §3a) ───────────────────────────────────────────────────

/** Baris tabel ↔ baris antrean. Dua arah, di satu tempat, supaya tidak ada kolom yang tercecer. */
export function toUploadRow(
  item: QueueItem,
  target: Pick<RobloxTarget, 'creatorKind' | 'creatorId'>,
  now: number,
): RobloxUploadRow {
  return {
    id: item.localId,
    hash: item.hash ?? '',
    fileName: item.fileName,
    bytes: item.bytes,
    seconds: item.seconds,
    name: item.name,
    description: item.description,
    categoryId: item.categoryId,
    genreId: item.genreId,
    creatorKind: target.creatorKind,
    creatorId: target.creatorId.trim(),
    status: item.status,
    operationId: item.operationId ?? null,
    assetId: item.assetId,
    moderationState: moderationOf(item),
    error: item.error,
    createdAt: now,
    updatedAt: now,
    uploadedAt: item.status === 'processing' || item.status === 'done' ? now : null,
    approvedAt: item.status === 'done' ? now : null,
  };
}

function moderationOf(item: QueueItem): RobloxModerationState | null {
  if (item.status === 'done') return 'approved';
  if (item.status === 'processing') return 'reviewing';
  if (item.status === 'failed' && item.assetId !== null) return 'rejected';
  return null;
}

export function fromUploadRow(row: RobloxUploadRow, id: number): QueueItem {
  return {
    id,
    localId: row.id,
    hash: row.hash === '' ? null : row.hash,
    fileName: row.fileName,
    bytes: row.bytes,
    seconds: row.seconds,
    name: row.name,
    description: row.description,
    categoryId: row.categoryId,
    genreId: row.genreId,
    status: row.status,
    progress: row.status === 'processing' || row.status === 'done' ? 100 : 0,
    error: row.error,
    assetId: row.assetId,
    operationId: row.operationId,
  };
}

/** Baris katalog yang cocok dengan penyaring; nama/berkas/assetId dicari tanpa peduli huruf. */
export function filterCatalog(
  rows: readonly RobloxUploadRow[],
  filter: CatalogFilter,
): readonly RobloxUploadRow[] {
  const q = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.categoryId !== null && row.categoryId !== filter.categoryId) return false;
    if (filter.genreId !== null && row.genreId !== filter.genreId) return false;
    if (q === '') return true;
    return (
      row.name.toLowerCase().includes(q) ||
      row.fileName.toLowerCase().includes(q) ||
      (row.assetId ?? '').includes(q)
    );
  });
}

export interface CatalogGenreGroup {
  /** `null` = baris yang genrenya sudah dihapus dari taksonomi (atau kosong). */
  readonly genre: RobloxGenre | null;
  readonly rows: readonly RobloxUploadRow[];
}

export interface CatalogCategoryGroup {
  readonly category: RobloxCategory | null;
  readonly count: number;
  readonly genres: readonly CatalogGenreGroup[];
}

/**
 * Kelompok kategori → genre, dengan hitungan. Kategori kosong TETAP muncul
 * (hitungan 0): pertanyaan §3a butir 3 adalah "genre apa yang BELUM kupunya",
 * dan kelompok yang hilang tidak bisa menjawabnya. Baris yang taksonominya
 * sudah dihapus masuk kelompok `null` di akhir, bukan hilang.
 */
export function groupCatalog(
  rows: readonly RobloxUploadRow[],
  taxonomy: RobloxTaxonomy,
): readonly CatalogCategoryGroup[] {
  const out: CatalogCategoryGroup[] = [];
  const orphans: RobloxUploadRow[] = [];
  for (const category of sortedCategories(taxonomy)) {
    const mine = rows.filter((r) => r.categoryId === category.id);
    const genres: CatalogGenreGroup[] = genresOf(taxonomy, category.id).map((genre) => ({
      genre,
      rows: mine.filter((r) => r.genreId === genre.id),
    }));
    const known = new Set(genres.map((g) => g.genre?.id));
    const lost = mine.filter((r) => !known.has(r.genreId ?? undefined));
    if (lost.length > 0) genres.push({ genre: null, rows: lost });
    out.push({ category, count: mine.length, genres });
  }
  const knownCategories = new Set(taxonomy.categories.map((c) => c.id));
  for (const row of rows) if (!knownCategories.has(row.categoryId ?? '')) orphans.push(row);
  if (orphans.length > 0) out.push({ category: null, count: orphans.length, genres: [{ genre: null, rows: orphans }] });
  return out;
}

/** `14 Musik · 0 Efek suara · 2 Suara` — ringkasan di kepala tab KATALOG. */
export function catalogSummary(rows: readonly RobloxUploadRow[], taxonomy: RobloxTaxonomy): string {
  const approved = rows.filter((r) => r.status === 'done');
  return sortedCategories(taxonomy)
    .map((c) => `${approved.filter((r) => r.categoryId === c.id).length} ${c.name}`)
    .join(' · ');
}

export const MODERATION_LABEL: Readonly<Record<RobloxModerationState, string>> = {
  reviewing: 'DITINJAU',
  approved: 'DISETUJUI',
  rejected: 'DITOLAK',
};
