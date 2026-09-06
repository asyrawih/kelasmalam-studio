/**
 * KONTRAK command Tauri untuk penyimpanan lokal desktop (docs/21).
 *
 * Berkas ini adalah satu-satunya sumber kebenaran untuk DUA sisi: TypeScript
 * memanggil nama dan bentuk di sini, dan `crates/desktop-host` +
 * `desktop/src-tauri` mengimplementasikan nama dan bentuk yang PERSIS sama.
 * Kalau salah satu sisi perlu bentuk lain, ubah berkas ini dulu — jangan
 * menyimpang diam-diam di salah satu sisi.
 *
 * Konvensi:
 * - Nama command `snake_case`; argumen satu objek `camelCase` (Tauri
 *   mengubahnya ke `snake_case` di Rust lewat `rename_all = "camelCase"`).
 * - Waktu = milidetik epoch (`number`).
 * - Kegagalan: `invoke` menolak dengan `LocalError` (`{ code, message }`),
 *   `message` ditulis untuk dibaca user, sama seperti Worker.
 * - Byte besar TIDAK lewat JSON: `library_blob` mengembalikan `ArrayBuffer`
 *   (Rust: `tauri::ipc::Response`), `library_put_bytes` mengirim badan mentah
 *   (`invoke(cmd, bytes, { headers })`, Rust: `tauri::ipc::Request`).
 */

// ── Galat ──────────────────────────────────────────────────────────────────

export interface LocalError {
  readonly code:
    | 'NOT_FOUND'
    | 'IN_USE' // hapus ditolak; `message` menyebut pemakainya, `count` jumlahnya
    | 'VERSION_CONFLICT' // simpan project dengan versi basi; `currentVersion` terisi
    | 'DISK_FULL'
    | 'INVALID'
    | 'SECRET_UNAVAILABLE' // keychain tidak bisa dipakai di mesin ini
    | 'HTTP' // Open Cloud menjawab galat; `status` terisi
    | 'IO';
  readonly message: string;
  readonly count?: number;
  readonly currentVersion?: number;
  readonly status?: number;
}

// ── Folder & rahasia ───────────────────────────────────────────────────────

export interface StoreInfo {
  /** Path absolut folder kepustakaan (docs/21 §1b). */
  readonly dir: string;
  readonly bytes: number;
  readonly tracks: number;
  readonly projects: number;
  readonly schemaVersion: number;
}

/** Hanya kunci yang terdaftar di sini yang diterima `secret_*`. */
export type SecretKey = 'roblox.api_key' | 'roblox.cookie';

// ── Kepustakaan (cermin `LibraryApi`, docs/21 §2c) ─────────────────────────

export interface LocalTrack {
  readonly hash: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  /** 0 = tidak diketahui, sama dengan kontrak Worker. */
  readonly frames: number;
  readonly sampleRate: number;
  readonly marks: unknown | null;
  readonly createdAt: number;
}

export interface TrackMetaInput {
  readonly hash: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  readonly frames: number;
  readonly sampleRate: number;
}

/** Hasil `library_import_path`: berkas sudah disalin & di-hash oleh Rust. */
export interface ImportedTrack extends LocalTrack {
  /** `true` = hash-nya sudah ada; tidak ada berkas baru yang ditulis. */
  readonly existed: boolean;
}

export interface LocalProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly version: number;
}

export interface LocalProjectBody extends LocalProjectSummary {
  readonly json: unknown;
  readonly tracks: readonly string[];
}

// ── Roblox (docs/21 §3) ────────────────────────────────────────────────────

export interface RobloxCategory {
  readonly id: string;
  readonly name: string;
  readonly sort: number;
}

export interface RobloxGenre {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly sort: number;
}

export interface RobloxTaxonomy {
  readonly categories: readonly RobloxCategory[];
  readonly genres: readonly RobloxGenre[];
}

export type RobloxUploadStatus =
  | 'draft'
  | 'queued'
  | 'uploading'
  | 'processing'
  | 'done'
  | 'failed';

export type RobloxModerationState = 'reviewing' | 'approved' | 'rejected';

/** Satu baris `roblox_upload`. Antrean = status bukan `done`; katalog = `done` | `failed`. */
export interface RobloxUploadRow {
  readonly id: string;
  /** Lagu kepustakaan yang byte-nya dikirim (`tracks/<hash>`). */
  readonly hash: string;
  readonly fileName: string;
  readonly bytes: number;
  /** Durasi; `null` = belum diukur (BUKAN nol — lihat `roblox/model.ts`). */
  readonly seconds: number | null;
  readonly name: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly genreId: string | null;
  readonly creatorKind: 'user' | 'group';
  readonly creatorId: string;
  readonly status: RobloxUploadStatus;
  readonly operationId: string | null;
  readonly assetId: string | null;
  readonly moderationState: RobloxModerationState | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly uploadedAt: number | null;
  readonly approvedAt: number | null;
}

export interface RobloxOperationState {
  readonly done: boolean;
  readonly assetId: string | null;
  readonly moderationState: RobloxModerationState | null;
}

export interface RobloxTargetSettings {
  readonly creatorKind: 'user' | 'group';
  readonly creatorId: string;
  /** Tulis baris `Genre: <kategori> / <genre>` di akhir deskripsi asset (§1d). */
  readonly genreToDescription: boolean;
}

// ── Roblox — Grant Access (docs/21 §3f, fase R5) ──────────────────────────

/**
 * Satu baris `roblox_catalog_asset` — cermin `roblox_asset` D1 tanpa
 * `user_id`. Bentuknya SAMA dengan `RobloxCatalogAsset` di
 * `roblox/grant/api.ts` supaya `GrantApi` lokal meneruskannya apa adanya.
 */
export interface RobloxCatalogAsset {
  readonly assetId: string;
  readonly creatorKind: 'user' | 'group';
  readonly creatorId: string;
  readonly name: string;
  readonly moderationState: string | null;
  readonly source: string;
}

/** Argumen `roblox_assets_import` / `roblox_assets_record`. */
export interface RobloxCatalogAssetInput {
  readonly assetId: string;
  readonly creatorKind: 'user' | 'group';
  readonly creatorId: string;
  readonly name: string;
  readonly moderationState?: string | null;
  readonly source: 'upload' | 'import';
}

/** Cermin `RobloxExperience` di `roblox/grant/api.ts`. */
export interface RobloxExperience {
  readonly universeId: string;
  readonly placeId: string;
  readonly name: string;
}

/**
 * Hasil `roblox_grant_settings_get`. Rahasia TIDAK pernah ikut: yang
 * dikembalikan hanya "ada/tidak" — nilai cookie dan API key tinggal di
 * keychain OS (docs/21 §1f) dan hanya Rust yang membacanya.
 */
export interface RobloxGrantSettings {
  readonly creatorKind: 'user' | 'group';
  readonly creatorId: string;
  readonly hasCookie: boolean;
  readonly hasApiKey: boolean;
}

/** Target grant, ejaan persis milik Asset Permissions API. */
export type RobloxGrantSubjectType = 'Universe' | 'Group' | 'User';

// ── Peta command → argumen → hasil ─────────────────────────────────────────

/**
 * Sumber kebenaran nama command dan tanda tangannya. Kedua sisi mengacu ke
 * sini; tes bentuk di TS dan Rust membaca daftar ini.
 */
export interface LocalCommands {
  // folder & rahasia
  store_info: { args: Record<string, never>; result: StoreInfo };
  /** Salin → verifikasi → tukar → hapus lama. Event `daw://store-relocate` `{ done, total }` (byte). */
  store_relocate: { args: { newDir: string }; result: StoreInfo };
  secret_get: { args: { key: SecretKey }; result: string | null };
  secret_set: { args: { key: SecretKey; value: string }; result: null };
  secret_clear: { args: { key: SecretKey }; result: null };

  // kepustakaan
  library_tracks: { args: Record<string, never>; result: readonly LocalTrack[] };
  library_has: { args: { hash: string }; result: boolean };
  /** Badan mentah, bukan JSON. */
  library_blob: { args: { hash: string }; result: ArrayBuffer };
  /**
   * Badan mentah = byte lagu; metadata lewat header `x-hash` dan `x-ext`
   * (`mp3` | `ogg` | `wav` | `flac`). Menulis `tracks/<hash>.<ext>.part` lalu
   * rename. TIDAK menulis baris `track` — itu `library_commit`.
   */
  library_put_bytes: { args: { hash: string; ext: string }; result: null };
  /** Jalur cepat drop Finder: hash + salin di Rust. `existed` kalau sudah ada. */
  library_import_path: { args: { path: string }; result: ImportedTrack };
  library_commit: { args: TrackMetaInput; result: null };
  /** `IN_USE` menyebut project pemakainya. */
  library_delete_track: { args: { hash: string }; result: null };
  library_put_marks: { args: { hash: string; marks: unknown }; result: null };

  library_projects: { args: Record<string, never>; result: readonly LocalProjectSummary[] };
  library_project: { args: { id: string }; result: LocalProjectBody };
  library_project_create: {
    args: { name: string; json: unknown; tracks: readonly string[] };
    result: { id: string; version: number };
  };
  /** `VERSION_CONFLICT` kalau `expectedVersion` bukan versi tersimpan. Hasil = versi baru. */
  library_project_update: {
    args: { id: string; name: string; json: unknown; expectedVersion: number };
    result: number;
  };
  library_project_delete: { args: { id: string }; result: null };
  library_project_add_track: { args: { projectId: string; hash: string }; result: null };
  /** `true` kalau lagunya ikut hilang karena tidak dipakai project lain. */
  library_project_remove_track: { args: { projectId: string; hash: string }; result: boolean };

  // roblox — taksonomi
  roblox_taxonomy_list: { args: Record<string, never>; result: RobloxTaxonomy };
  roblox_category_upsert: { args: { id?: string; name: string; sort?: number }; result: RobloxCategory };
  /** `IN_USE` dengan `count` kalau masih ada genre/unggahan di bawahnya. */
  roblox_category_delete: { args: { id: string }; result: null };
  roblox_genre_upsert: {
    args: { id?: string; categoryId: string; name: string; sort?: number };
    result: RobloxGenre;
  };
  roblox_genre_delete: { args: { id: string }; result: null };

  // roblox — antrean & katalog
  /** Semua baris yang status-nya bukan `done`/`failed`. */
  roblox_queue_list: { args: Record<string, never>; result: readonly RobloxUploadRow[] };
  /** Upsert satu baris (id kosong = baris baru; Rust mengisi id & waktu). */
  roblox_queue_put: { args: { row: Omit<RobloxUploadRow, 'createdAt' | 'updatedAt'> }; result: RobloxUploadRow };
  roblox_queue_remove: { args: { id: string }; result: null };
  /**
   * Baca `tracks/<hash>`, kirim ke Open Cloud, simpan `operationId`.
   * Event `daw://roblox-progress` `{ id, sent, total }` selama mengirim.
   * API key dibaca dari keychain (`roblox.api_key`); tidak pernah lewat IPC.
   */
  roblox_upload_start: { args: { id: string }; result: RobloxOperationState & { operationId: string } };
  /** Poll operasi & perbarui baris. */
  roblox_operation_poll: { args: { id: string }; result: RobloxOperationState };
  roblox_catalog_list: {
    args: { categoryId?: string; genreId?: string; query?: string };
    result: readonly RobloxUploadRow[];
  };
  roblox_target_get: { args: Record<string, never>; result: RobloxTargetSettings };
  roblox_target_set: { args: RobloxTargetSettings; result: null };

  // roblox — grant (docs/21 §3f): port rute `/roblox/*` Worker kepustakaan
  roblox_grant_settings_get: { args: Record<string, never>; result: RobloxGrantSettings };
  /** Simpan cookie `.ROBLOSECURITY` ke keychain (`roblox.cookie`). Kosong ditolak `INVALID`. */
  roblox_grant_cookie_set: { args: { cookie: string }; result: null };
  roblox_grant_cookie_clear: { args: Record<string, never>; result: null };
  /**
   * `itemconfiguration` `get-assets` dengan cookie dari keychain → upsert ke
   * `roblox_catalog_asset`. Hasil = jumlah baris yang disinkronkan. Tanpa
   * cookie: `INVALID` yang kalimatnya meminta cookie.
   */
  roblox_assets_sync: { args: Record<string, never>; result: number };
  roblox_assets_list: { args: { query?: string }; result: readonly RobloxCatalogAsset[] };
  /** Maksimum 1000 sekali panggil; baris yang id-nya bukan angka dilewati (seperti Worker). Hasil = jumlah yang masuk. */
  roblox_assets_import: { args: { assets: readonly RobloxCatalogAssetInput[] }; result: number };
  roblox_assets_record: { args: { asset: RobloxCatalogAssetInput }; result: null };
  roblox_experiences: {
    args: { ownerType: 'user' | 'group'; ownerId: string };
    result: readonly RobloxExperience[];
  };
  /** Hasil = Universe ID. */
  roblox_resolve_place: { args: { placeId: string }; result: string };
  /**
   * PATCH Asset Permissions API. API key dibaca dari keychain (`roblox.api_key`)
   * — TIDAK ada di argumen. Hasil = jumlah asset yang diberi izin.
   */
  roblox_grant: {
    args: { assetIds: readonly string[]; subjectType: RobloxGrantSubjectType; subjectId: string };
    result: number;
  };
}

export type LocalCommandName = keyof LocalCommands;

/** Daftar nama — dipakai tes bentuk di kedua sisi. Jaga tetap sinkron dengan `LocalCommands`. */
export const LOCAL_COMMAND_NAMES: readonly LocalCommandName[] = [
  'store_info',
  'store_relocate',
  'secret_get',
  'secret_set',
  'secret_clear',
  'library_tracks',
  'library_has',
  'library_blob',
  'library_put_bytes',
  'library_import_path',
  'library_commit',
  'library_delete_track',
  'library_put_marks',
  'library_projects',
  'library_project',
  'library_project_create',
  'library_project_update',
  'library_project_delete',
  'library_project_add_track',
  'library_project_remove_track',
  'roblox_taxonomy_list',
  'roblox_category_upsert',
  'roblox_category_delete',
  'roblox_genre_upsert',
  'roblox_genre_delete',
  'roblox_queue_list',
  'roblox_queue_put',
  'roblox_queue_remove',
  'roblox_upload_start',
  'roblox_operation_poll',
  'roblox_catalog_list',
  'roblox_target_get',
  'roblox_target_set',
  'roblox_grant_settings_get',
  'roblox_grant_cookie_set',
  'roblox_grant_cookie_clear',
  'roblox_assets_sync',
  'roblox_assets_list',
  'roblox_assets_import',
  'roblox_assets_record',
  'roblox_experiences',
  'roblox_resolve_place',
  'roblox_grant',
];

/** Nama event Tauri yang dipancarkan sisi Rust untuk kontrak ini. */
export const LOCAL_EVENTS = {
  storeRelocate: 'daw://store-relocate',
  robloxProgress: 'daw://roblox-progress',
} as const;
