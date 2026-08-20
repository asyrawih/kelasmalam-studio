-- Skema kepustakaan. Bentuknya dari docs/16 §3, dengan SATU tambahan yang
-- dicatat di bawah.
--
-- Jalankan:  npx wrangler d1 migrations apply dawonweb-library --remote

CREATE TABLE IF NOT EXISTS user (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- TAMBAHAN terhadap §3: tabel sesi.
--
-- §4 memasukkan `POST /auth/logout` yang "mencabut sesi", dan sesi yang bisa
-- dicabut harus punya tempat tinggal — cookie bertanda tangan tanpa penyimpanan
-- tidak bisa dibatalkan sebelum kedaluwarsa. Yang disimpan adalah SHA-256 dari
-- tokennya, bukan tokennya: bocornya isi tabel ini tidak memberi siapa pun sesi
-- yang bisa dipakai.
CREATE TABLE IF NOT EXISTS session (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS session_expiry ON session(expires_at);

-- PK gabungan: baris ini adalah "user ini punya lagu ini", bukan "lagu ini
-- ada". Objek R2-nya satu, klaimnya sebanyak user-nya (§3).
CREATE TABLE IF NOT EXISTS track (
  hash        TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES user(id),
  name        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  frames      INTEGER NOT NULL,
  sample_rate INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (hash, user_id)
);
CREATE INDEX IF NOT EXISTS track_user ON track(user_id, created_at DESC);

-- Terpisah dari `track` karena umurnya berbeda: cue berubah puluhan kali per
-- sesi, metadata lagu tidak pernah berubah (§3).
CREATE TABLE IF NOT EXISTS marks (
  hash       TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id),
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (hash, user_id)
);

-- `json` sebagai TEXT, bukan tabel ternormalisasi: bentuknya sudah dijaga
-- `serialize`/`deserialize` di sisi web lengkap dengan SCHEMA_VERSION-nya, dan
-- menjaganya di dua tempat berarti yang satu pasti tertinggal (§3).
CREATE TABLE IF NOT EXISTS project (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id),
  name       TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_user ON project(user_id, updated_at DESC);
