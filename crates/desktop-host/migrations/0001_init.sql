-- Skema kepustakaan lokal desktop (docs/21 §2b): cermin docs/16 §3 tanpa
-- `user_id` — satu mesin, satu pemilik — ditambah tabel Roblox (§3b).
--
-- Dijalankan oleh `store.rs` di dalam SATU transaksi bersama pencatatan
-- `schema_version`; migrasi yang gagal di tengah tidak meninggalkan skema
-- setengah jadi. `PRAGMA foreign_keys` dinyalakan per koneksi oleh Rust
-- (pragma itu tidak bisa disimpan di berkas), jadi `REFERENCES` di sini
-- SUNGGUH ditegakkan — berbeda dengan D1, tempat Worker menghapus anak
-- secara eksplisit karena tidak bisa mengandalkannya.

CREATE TABLE track (
  hash        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  frames      INTEGER NOT NULL,
  sample_rate INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX track_created ON track(created_at DESC);

-- Terpisah dari `track` karena umurnya berbeda: cue berubah puluhan kali per
-- sesi, metadata lagu tidak pernah berubah (docs/16 §3).
CREATE TABLE marks (
  hash       TEXT PRIMARY KEY REFERENCES track(hash) ON DELETE CASCADE,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- `json` sebagai TEXT: bentuknya dijaga `serialize`/`deserialize` di web
-- lengkap dengan SCHEMA_VERSION-nya (docs/16 §3).
CREATE TABLE project (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version    INTEGER NOT NULL
);
CREATE INDEX project_updated ON project(updated_at DESC);

-- "Project ini memakai lagu itu" — folder project (docs/16 migrasi 0002).
-- Tanpa `REFERENCES track` ON DELETE: hapus lagu yang masih dipakai HARUS
-- ditolak dengan menyebut nama project-nya (§8d), bukan diam-diam melepas
-- keanggotaannya. Penegakannya di `library.rs`, sebelum DELETE.
CREATE TABLE project_track (
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL REFERENCES track(hash),
  PRIMARY KEY (project_id, hash)
);
CREATE INDEX project_track_hash ON project_track(hash);

-- Taksonomi milik user, dua tingkat (docs/21 §1d). Baris bawaan disemai di
-- bawah — hanya baris biasa, bukan enum di kode.
CREATE TABLE roblox_category (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL
);

CREATE TABLE roblox_genre (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES roblox_category(id),
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL,
  UNIQUE (category_id, name)
);
CREATE INDEX roblox_genre_category ON roblox_genre(category_id, sort);

-- Antrean + katalog unggahan Roblox dalam satu tabel; yang membedakan
-- keduanya hanya `status` (antrean = belum `done`/`failed`).
--
-- `hash REFERENCES track`: byte draft Roblox ADALAH lagu kepustakaan — dedup
-- gratis, dan lagu yang diunggah ke Roblox otomatis ada di kepustakaan
-- (docs/21 §2b). Hapus lagu yang masih punya unggahan belum `done`/`failed`
-- ditolak di `library.rs` SEBELUM DELETE; yang sudah selesai ikut terhapus
-- lewat CASCADE — baris katalog tanpa lagunya tidak bisa "coba lagi", dan
-- assetId-nya tetap ada di Creator Hub. (Utang: docs/21 §5.)
--
-- `seconds` TIDAK ada di daftar kolom docs/21 §2b — ditambah karena durasi
-- yang diukur `<audio>` di TS (saat header tidak terbaca di Rust, `frames`=0)
-- tetap harus punya tempat; kontrak `RobloxUploadRow.seconds` membedakan
-- "belum diukur" (`null`) dari nol.
CREATE TABLE roblox_upload (
  id               TEXT PRIMARY KEY,
  hash             TEXT NOT NULL REFERENCES track(hash) ON DELETE CASCADE,
  file_name        TEXT NOT NULL,
  seconds          REAL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  category_id      TEXT REFERENCES roblox_category(id),
  genre_id         TEXT REFERENCES roblox_genre(id),
  creator_kind     TEXT NOT NULL CHECK (creator_kind IN ('user', 'group')),
  creator_id       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'uploading', 'processing', 'done', 'failed')),
  operation_id     TEXT,
  asset_id         TEXT,
  moderation_state TEXT CHECK (moderation_state IN ('reviewing', 'approved', 'rejected')),
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  uploaded_at      INTEGER,
  approved_at      INTEGER
);
CREATE INDEX roblox_upload_status ON roblox_upload(status, updated_at DESC);
CREATE INDEX roblox_upload_hash ON roblox_upload(hash);
CREATE INDEX roblox_upload_genre ON roblox_upload(genre_id);
CREATE INDEX roblox_upload_category ON roblox_upload(category_id);

-- creator aktif, opsi "genre ke deskripsi", dan pengaturan kecil lain.
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Taksonomi bawaan docs/21 §1d. Id-nya slug yang stabil (bukan UUID) supaya
-- terbaca di tes dan di berkas cadangan; yang dibuat user memakai UUID.
-- HANYA kalau tabel kosong: migrasi ini idempoten terhadap folder yang sudah
-- pernah dibuka versi pra-rilis.
INSERT INTO roblox_category (id, name, sort)
SELECT * FROM (
  SELECT 'musik' AS id, 'Musik' AS name, 0 AS sort UNION ALL
  SELECT 'efek-suara', 'Efek suara', 1 UNION ALL
  SELECT 'suara', 'Suara', 2
) WHERE NOT EXISTS (SELECT 1 FROM roblox_category);

INSERT INTO roblox_genre (id, category_id, name, sort)
SELECT * FROM (
  SELECT 'musik.lo-fi' AS id, 'musik' AS category_id, 'Lo-fi' AS name, 0 AS sort UNION ALL
  SELECT 'musik.hip-hop',   'musik', 'Hip-hop',  1 UNION ALL
  SELECT 'musik.edm',       'musik', 'EDM',      2 UNION ALL
  SELECT 'musik.pop',       'musik', 'Pop',      3 UNION ALL
  SELECT 'musik.rock',      'musik', 'Rock',     4 UNION ALL
  SELECT 'musik.ambient',   'musik', 'Ambient',  5 UNION ALL
  SELECT 'musik.orkestra',  'musik', 'Orkestra', 6 UNION ALL
  SELECT 'musik.jazz',      'musik', 'Jazz',     7 UNION ALL
  SELECT 'musik.chiptune',  'musik', 'Chiptune', 8 UNION ALL
  SELECT 'efek-suara.ui',       'efek-suara', 'UI',       0 UNION ALL
  SELECT 'efek-suara.ambience', 'efek-suara', 'Ambience', 1 UNION ALL
  SELECT 'efek-suara.foley',    'efek-suara', 'Foley',    2 UNION ALL
  SELECT 'efek-suara.stinger',  'efek-suara', 'Stinger',  3 UNION ALL
  SELECT 'efek-suara.senjata',  'efek-suara', 'Senjata',  4 UNION ALL
  SELECT 'suara.jingle',  'suara', 'Jingle',  0 UNION ALL
  SELECT 'suara.narasi',  'suara', 'Narasi',  1 UNION ALL
  SELECT 'suara.vokal',   'suara', 'Vokal',   2
) WHERE NOT EXISTS (SELECT 1 FROM roblox_genre);
