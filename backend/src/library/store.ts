/**
 * Seluruh SQL kepustakaan, di satu tempat.
 *
 * Handler tidak menulis SQL sendiri. Bukan demi lapisan tambahan: pertanyaan
 * "apakah user ini boleh menyentuh baris ini" dijawab di SETIAP query lewat
 * `user_id`, dan menyebarkannya ke tujuh berkas handler berarti satu di antara
 * mereka suatu saat lupa — dan bentuk lupanya adalah kepustakaan orang lain
 * yang terbaca.
 *
 * Waktu selalu **milidetik epoch** (`INTEGER`). SQLite tidak punya tipe tanggal,
 * dan menyimpan string ISO membuat pengurutan bergantung pada format.
 */

import type { D1Database } from './bindings';

export interface UserRow {
  readonly id: string;
  readonly google_sub: string;
  readonly email: string;
  readonly name: string;
}

export interface TrackRow {
  readonly hash: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  readonly frames: number;
  readonly sample_rate: number;
  readonly created_at: number;
  /** Dari LEFT JOIN ke `marks`. `null` kalau lagu ini belum punya cue. */
  readonly marks: string | null;
}

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly updated_at: number;
  readonly version: number;
}

export interface TrackInput {
  readonly hash: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  readonly frames: number;
  readonly sampleRate: number;
}

export class Store {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ── User & sesi ───────────────────────────────────────────────────────────

  /**
   * Cari user berdasarkan `sub` Google, buat kalau belum ada.
   *
   * `sub` yang jadi kunci, BUKAN email: email Google bisa berganti, dan user
   * yang berganti alamat kemudian akan mendapati kepustakaannya kosong.
   * Email tetap disimpan, tapi hanya untuk ditampilkan.
   */
  async upsertUser(profile: {
    sub: string;
    email: string;
    name: string;
  }): Promise<UserRow> {
    const found = await this.db
      .prepare('SELECT id, google_sub, email, name FROM user WHERE google_sub = ?')
      .bind(profile.sub)
      .first<UserRow>();

    if (found !== null) {
      // Nama/email disegarkan tiap login supaya yang tampil tidak membeku di
      // keadaan saat pertama kali mendaftar.
      await this.db
        .prepare('UPDATE user SET email = ?, name = ? WHERE id = ?')
        .bind(profile.email, profile.name, found.id)
        .run();
      return { ...found, email: profile.email, name: profile.name };
    }

    const id = crypto.randomUUID();
    await this.db
      .prepare('INSERT INTO user (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, profile.sub, profile.email, profile.name, this.now())
      .run();
    return { id, google_sub: profile.sub, email: profile.email, name: profile.name };
  }

  async createSession(tokenHash: string, userId: string, ttlMs: number): Promise<void> {
    const t = this.now();
    await this.db
      .prepare(
        'INSERT INTO session (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .bind(tokenHash, userId, t, t + ttlMs)
      .run();
  }

  /** User pemilik sesi, atau `null` kalau tidak ada / sudah kedaluwarsa. */
  async userForSession(tokenHash: string): Promise<UserRow | null> {
    return await this.db
      .prepare(
        `SELECT u.id, u.google_sub, u.email, u.name
           FROM session s JOIN user u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .bind(tokenHash, this.now())
      .first<UserRow>();
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db.prepare('DELETE FROM session WHERE token_hash = ?').bind(tokenHash).run();
  }

  // ── Tracks ────────────────────────────────────────────────────────────────

  async listTracks(userId: string): Promise<readonly TrackRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT t.hash, t.name, t.bytes, t.mime, t.frames, t.sample_rate, t.created_at,
                m.json AS marks
           FROM track t
           LEFT JOIN marks m ON m.hash = t.hash AND m.user_id = t.user_id
          WHERE t.user_id = ?
          ORDER BY t.created_at DESC`,
      )
      .bind(userId)
      .all<TrackRow>();
    return results;
  }

  async hasClaim(userId: string, hash: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS ok FROM track WHERE user_id = ? AND hash = ?')
      .bind(userId, hash)
      .first<{ ok: number }>();
    return row !== null;
  }

  /**
   * Catat klaim. Idempoten: commit yang diulang (jaringan putus di antara PUT
   * dan commit) tidak boleh gagal, dan tidak boleh menggandakan barisnya.
   */
  async claimTrack(userId: string, t: TrackInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO track (hash, user_id, name, bytes, mime, frames, sample_rate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hash, user_id) DO UPDATE SET name = excluded.name`,
      )
      .bind(t.hash, userId, t.name, t.bytes, t.mime, t.frames, t.sampleRate, this.now())
      .run();
  }

  /** Total byte yang diklaim user — dasar penegakan kuota di `/tracks/init`. */
  async bytesUsed(userId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM track WHERE user_id = ?')
      .bind(userId)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async putMarks(userId: string, hash: string, json: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO marks (hash, user_id, json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (hash, user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .bind(hash, userId, json, this.now())
      .run();
  }

  /**
   * Lepas klaim user ini. Objek R2-nya TIDAK disentuh (§8d): ia bisa dipakai
   * user lain, dan pembersih yatim yang menghitungnya dengan benar belum ada.
   * Membayar penyimpanan lebih murah daripada menghapus milik orang.
   */
  async releaseTrack(userId: string, hash: string): Promise<boolean> {
    await this.db
      .prepare('DELETE FROM marks WHERE user_id = ? AND hash = ?')
      .bind(userId, hash)
      .run();
    const res = await this.db
      .prepare('DELETE FROM track WHERE user_id = ? AND hash = ?')
      .bind(userId, hash)
      .run();
    return res.meta.changes > 0;
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(userId: string): Promise<readonly ProjectRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, name, updated_at, version FROM project
          WHERE user_id = ? ORDER BY updated_at DESC`,
      )
      .bind(userId)
      .all<ProjectRow>();
    return results;
  }

  async getProject(
    userId: string,
    id: string,
  ): Promise<{ id: string; name: string; json: string; version: number } | null> {
    return await this.db
      .prepare('SELECT id, name, json, version FROM project WHERE user_id = ? AND id = ?')
      .bind(userId, id)
      .first<{ id: string; name: string; json: string; version: number }>();
  }

  async createProject(
    userId: string,
    name: string,
    json: string,
    hashes: readonly string[],
  ): Promise<{ id: string; version: number }> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO project (id, user_id, name, json, updated_at, version, tracks_indexed)
         VALUES (?, ?, ?, ?, ?, 1, 1)`,
      )
      .bind(id, userId, name, json, this.now())
      .run();
    await this.replaceProjectTracks(id, userId, hashes);
    return { id, version: 1 };
  }

  /** Ganti seluruh daftar lagu satu project. Dipanggil tiap kali ia disimpan. */
  async replaceProjectTracks(
    projectId: string,
    userId: string,
    hashes: readonly string[],
  ): Promise<void> {
    await this.db.prepare('DELETE FROM project_track WHERE project_id = ?').bind(projectId).run();
    for (const hash of hashes) {
      await this.db
        .prepare(
          'INSERT OR IGNORE INTO project_track (project_id, user_id, hash) VALUES (?, ?, ?)',
        )
        .bind(projectId, userId, hash)
        .run();
    }
  }

  /** Tambahkan lagu ke folder project tanpa mengubah isi timeline project. */
  async addProjectTrack(userId: string, projectId: string, hash: string): Promise<void> {
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO project_track (project_id, user_id, hash) VALUES (?, ?, ?)',
      )
      .bind(projectId, userId, hash)
      .run();
  }

  /** Lepaskan lagu dari folder project, bukan dari kepustakaan user. */
  async removeProjectTrack(userId: string, projectId: string, hash: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM project_track WHERE project_id = ? AND user_id = ? AND hash = ?')
      .bind(projectId, userId, hash)
      .run();
    return res.meta.changes > 0;
  }

  async listProjectTracks(userId: string, projectId: string): Promise<readonly string[]> {
    const { results } = await this.db
      .prepare('SELECT hash FROM project_track WHERE project_id = ? AND user_id = ? ORDER BY rowid')
      .bind(projectId, userId)
      .all<{ hash: string }>();
    return results.map((row) => row.hash);
  }

  /** Project milik user ini yang belum punya baris `project_track`. */
  async unindexedProjects(userId: string): Promise<readonly { id: string; json: string }[]> {
    const { results } = await this.db
      .prepare('SELECT id, json FROM project WHERE user_id = ? AND tracks_indexed = 0')
      .bind(userId)
      .all<{ id: string; json: string }>();
    return results;
  }

  async markIndexed(projectId: string): Promise<void> {
    await this.db.prepare('UPDATE project SET tracks_indexed = 1 WHERE id = ?').bind(projectId).run();
  }

  /**
   * Simpan kalau versinya masih yang diharapkan.
   *
   * Perbandingan versi ada DI DALAM `WHERE`, bukan sebagai SELECT lalu UPDATE:
   * dua tab yang menyimpan bersamaan akan sama-sama lolos pemeriksaan terpisah
   * dan yang belakangan menimpa yang duluan tanpa jejak. Di sini yang kalah
   * mendapat `changes = 0`, dan itu jawaban yang bisa diberitahukan ke user
   * (§8c) alih-alih tulisan yang hilang diam-diam.
   */
  async updateProject(
    userId: string,
    id: string,
    name: string,
    json: string,
    expectedVersion: number,
    hashes: readonly string[],
  ): Promise<{ ok: true; version: number } | { ok: false; current: number | null }> {
    const next = expectedVersion + 1;
    const res = await this.db
      .prepare(
        `UPDATE project SET name = ?, json = ?, updated_at = ?, version = ?, tracks_indexed = 1
          WHERE id = ? AND user_id = ? AND version = ?`,
      )
      .bind(name, json, this.now(), next, id, userId, expectedVersion)
      .run();

    if (res.meta.changes > 0) {
      // Project adalah folder lagu. Menyimpan timeline memastikan lagu yang
      // dipakai masuk folder, tetapi tidak membuang lagu anggota yang belum
      // dipasang sebagai clip.
      for (const hash of hashes) await this.addProjectTrack(userId, id, hash);
      return { ok: true, version: next };
    }

    const row = await this.db
      .prepare('SELECT version FROM project WHERE id = ? AND user_id = ?')
      .bind(id, userId)
      .first<{ version: number }>();
    return { ok: false, current: row?.version ?? null };
  }

  async deleteProject(userId: string, id: string): Promise<boolean> {
    // Dihapus eksplisit: `ON DELETE CASCADE` hanya berlaku kalau
    // `PRAGMA foreign_keys` menyala, dan itu bukan sesuatu yang boleh
    // diandalkan dari sisi kode ini.
    await this.db.prepare('DELETE FROM project_track WHERE project_id = ?').bind(id).run();
    const res = await this.db
      .prepare('DELETE FROM project WHERE id = ? AND user_id = ?')
      .bind(id, userId)
      .run();
    return res.meta.changes > 0;
  }

  /**
   * Project milik user ini yang memakai hash tertentu.
   *
   * Dulu `json LIKE '%hash%'`. Itu bekerja sampai project mulai besar, lalu D1
   * menolak dengan `LIKE or GLOB pattern too complex` — dan yang terlihat user
   * adalah lagu yang tidak bisa dihapus, tanpa satu pun petunjuk soal SQL.
   * Polanya sendiri cuma 66 karakter; yang membuatnya jatuh adalah ukuran TEKS
   * yang dipindai, dan itu tumbuh mengikuti isi project.
   *
   * Sekarang lewat `project_track`, yang punya indeks untuk persis pertanyaan
   * ini — lebih murah bahkan sebelum batas itu tersentuh.
   */
  async projectsReferencing(
    userId: string,
    hash: string,
  ): Promise<readonly { id: string; name: string }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.id, p.name FROM project_track t
           JOIN project p ON p.id = t.project_id
          WHERE t.user_id = ? AND t.hash = ?`,
      )
      .bind(userId, hash)
      .all<{ id: string; name: string }>();
    return results;
  }
}
