-- Katalog Roblox bertahan tanpa lagunya (menutup utang docs/21 §5 "Katalog
-- Roblox ikut hilang bersama lagunya").
--
-- Di 0001 `roblox_upload.hash REFERENCES track ON DELETE CASCADE`: hapus lagu
-- yang unggahannya masih aktif memang ditolak di `library.rs`, tapi baris yang
-- SUDAH `done`/`failed` ikut lenyap — padahal assetId-nya tetap hidup di
-- Creator Hub, dan seluruh guna katalog (§3a) adalah menjawab "lagu ini sudah
-- jadi asset apa". Maka FK-nya dilepas: `hash` boleh menunjuk lagu yang sudah
-- tidak ada. Konsekuensinya `bytes` tidak bisa lagi dibaca dari `track` lewat
-- JOIN, jadi disalin ke kolom sendiri (`file_name` sudah ada sejak 0001).
--
-- SQLite tidak bisa ALTER FK, jadi: tabel baru → salin → drop lama → ganti nama
-- → indeks dibuat ulang (DROP TABLE membuang indeks lama). Semuanya dalam satu
-- transaksi milik `store.rs`; gagal di tengah = tidak ada yang berubah.
-- DROP TABLE dengan `foreign_keys` ON melakukan DELETE implisit yang hanya
-- memeriksa tabel ANAK dari yang dihapus — `roblox_upload` tidak punya anak.
--
-- Yang TIDAK berubah: aturan hapus lagu di `library.rs` masih menolak selama
-- ada unggahan aktif (belum `done`/`failed`) — baris antrean tanpa byte-nya
-- tidak bisa dikirim, dan itu bukan hal yang boleh terjadi diam-diam.

CREATE TABLE roblox_upload_v2 (
  id               TEXT PRIMARY KEY,
  hash             TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  bytes            INTEGER NOT NULL DEFAULT 0,
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

-- LEFT JOIN: baris yang lagunya sudah hilang tidak mungkin ada di 0001 (CASCADE),
-- tapi COALESCE membuat migrasi ini tidak bergantung pada asumsi itu.
INSERT INTO roblox_upload_v2 (
  id, hash, file_name, bytes, seconds, name, description, category_id, genre_id,
  creator_kind, creator_id, status, operation_id, asset_id, moderation_state, error,
  created_at, updated_at, uploaded_at, approved_at)
SELECT
  u.id, u.hash, u.file_name, COALESCE(t.bytes, 0), u.seconds, u.name, u.description,
  u.category_id, u.genre_id, u.creator_kind, u.creator_id, u.status, u.operation_id,
  u.asset_id, u.moderation_state, u.error, u.created_at, u.updated_at, u.uploaded_at,
  u.approved_at
FROM roblox_upload u LEFT JOIN track t ON t.hash = u.hash;

DROP TABLE roblox_upload;
ALTER TABLE roblox_upload_v2 RENAME TO roblox_upload;

CREATE INDEX roblox_upload_status ON roblox_upload(status, updated_at DESC);
CREATE INDEX roblox_upload_hash ON roblox_upload(hash);
CREATE INDEX roblox_upload_genre ON roblox_upload(genre_id);
CREATE INDEX roblox_upload_category ON roblox_upload(category_id);
