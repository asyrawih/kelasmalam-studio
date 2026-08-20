/**
 * D1 di atas `node:sqlite` — SQLite SUNGGUHAN, bukan tiruan.
 *
 * Ini keputusan yang menentukan nilai seluruh tes kepustakaan. D1 palsu yang
 * "mengerti" query kami akan mengerti persis apa yang kami kira kami tulis;
 * yang salah ketik, yang salah `JOIN`, yang lupa `WHERE user_id = ?` — semuanya
 * lolos, karena palsuannya menjawab dari asumsi yang sama yang membuat bug-nya.
 *
 * Dengan SQLite betulan, SQL-nya diuji oleh mesin yang punya pendapat sendiri:
 * `ON CONFLICT` benar-benar harus cocok dengan PK, `LEFT JOIN` benar-benar
 * mengembalikan `NULL`, dan `UPDATE … WHERE version = ?` benar-benar
 * mengembalikan nol perubahan saat versinya meleset.
 *
 * D1 memakai dialek SQLite, jadi yang lolos di sini punya alasan kuat untuk
 * lolos di sana. Yang TIDAK ditiru: `batch()`, transaksi, dan batas ukuran D1 —
 * tidak satu pun dipakai kode ini (lihat `bindings.ts`).
 *
 * Butuh Node ≥ 22.5 (`node:sqlite`). Import-nya statis dengan sengaja: kalau
 * runtime-nya terlalu tua, tesnya GAGAL dengan jelas alih-alih dilewati
 * diam-diam — dan tes SQL yang dilewati diam-diam sama saja tidak ada.
 */

import type { D1Database, D1PreparedStatement } from '../library/bindings';

/*
 * Diambil dari RUNTIME, bukan lewat `import`.
 *
 * Vite (dan karenanya vitest) memakai daftar modul bawaan Node yang statis, dan
 * `node:sqlite` belum ada di sana: import biasa berakhir sebagai "Failed to load
 * url sqlite". `process.getBuiltinModule` melewati resolver bundler sepenuhnya.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

type Value = string | number | bigint | null | Uint8Array;

/** Nilai yang tidak dikenal SQLite dipaksa jadi bentuk yang setara. */
function coerce(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

class SqliteStatement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: readonly Value[] = [],
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.db, this.sql, values.map(coerce));
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values);
    return (row as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: readonly T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const res = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(res.changes) } };
  }
}

export interface TestDb extends D1Database {
  /** Jalankan SQL mentah — dipakai untuk memuat migrasi. */
  exec(sql: string): void;
  close(): void;
}

export function openTestDb(schemaSql: string): TestDb {
  const db = new DatabaseSync(':memory:');
  // Foreign key TIDAK otomatis aktif di SQLite. Tanpa baris ini, referensi
  // `user_id` di skema hanyalah dokumentasi — dan tes tidak akan pernah
  // menangkap baris yatim.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql);

  return {
    prepare: (sql: string) => new SqliteStatement(db, sql),
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  };
}
