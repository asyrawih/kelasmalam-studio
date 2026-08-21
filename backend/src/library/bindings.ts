/**
 * Binding Cloudflare yang dipakai Worker kepustakaan, ditulis SESEMPIT
 * pemakaiannya.
 *
 * `@cloudflare/workers-types` sengaja tidak dipasang. Dua alasan, dan yang
 * kedua yang sebenarnya menentukan:
 *
 *  1. Paket itu mengganti global `Request`/`Response` dengan versinya sendiri,
 *     dan bertabrakan dengan `lib: WebWorker` yang sudah dipakai Worker Roblox
 *     di paket yang sama.
 *  2. **Antarmuka sempit ini merangkap kontrak untuk palsuannya.** Tes memakai
 *     D1 sungguhan di atas `node:sqlite` dan R2 palsu di memori; keduanya cukup
 *     mengimplementasikan yang tertulis di sini. Dengan tipe lengkap Cloudflare,
 *     palsuan harus mengaku bisa melakukan lusinan hal yang tidak pernah
 *     dipanggil — dan setiap satu di antaranya adalah tempat kebohongan bisa
 *     bersembunyi.
 *
 * Kalau suatu saat butuh metode D1/R2 yang tidak ada di sini, tambahkan di sini
 * dulu; itu memaksa palsuannya ikut tumbuh, bukan tertinggal diam-diam.
 */

export interface D1Meta {
  /** Baris yang benar-benar berubah. Dipakai untuk membedakan 404 dari sukses. */
  readonly changes: number;
}

export interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ readonly results: readonly T[] }>;
  run(): Promise<{ readonly meta: D1Meta }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export interface R2Object {
  readonly size: number;
  readonly etag?: string;
}

export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream | null;
}

/**
 * Hanya baca. Upload TIDAK lewat Worker (docs/16 §5c) — ia langsung ke R2
 * dengan presigned PUT — dan penghapusan objek ditunda sampai ada pembersih
 * yatim yang teruji (§8d). Keduanya sengaja tidak punya jalan masuk di sini.
 */
export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
}

export interface Env {
  readonly DB: D1Database;
  readonly TRACKS: R2Bucket;

  /** Origin aplikasi. Tujuan redirect sesudah login, dan asal yang diizinkan. */
  readonly APP_ORIGIN: string;
  /** Origin Worker ini sendiri — dipakai menyusun `redirect_uri` OAuth. */
  readonly API_ORIGIN: string;
  /** Kalau kosong, jatuh ke `APP_ORIGIN` saja. */
  readonly ALLOWED_ORIGINS?: string;

  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;

  /** Kredensial S3 R2 — HANYA untuk menandatangani upload. Lihat presign.ts. */
  readonly R2_ACCOUNT_ID: string;
  readonly R2_BUCKET: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;

  /** Batas satu berkas. Di atas ini butuh multipart, yang belum ada (§5c). */
  readonly MAX_TRACK_BYTES?: string;
  /** Total per user. Kosong = tanpa batas (§8f). */
  readonly MAX_USER_BYTES?: string;
  readonly SESSION_TTL_DAYS?: string;
  /** Secret Cloudflare untuk mengenkripsi API key Roblox sebelum masuk D1. */
  readonly CREDENTIAL_ENCRYPTION_KEY?: string;
}
