-- Katalog asset audio Roblox untuk Grant Access (docs/21 §3f, fase R5) —
-- cermin `roblox_asset` D1 (backend/migrations/0003_roblox_assets.sql) tanpa
-- `user_id`: satu mesin, satu pemilik.
--
-- Kenapa tabel terpisah dari `roblox_upload`: yang di sana adalah UNGGAHAN
-- dari mesin ini (dan ikut hilang bersama lagunya, docs/21 §5); yang di sini
-- adalah "asset audio yang ada di akun Roblox user" — hasil sync dari
-- Creator Hub, impor CSV, atau unggahan yang sudah disetujui. Grant Access
-- memberi izin ke asset yang mungkin diunggah bertahun-tahun sebelum aplikasi
-- ini ada, jadi ia tidak boleh bergantung pada tabel unggahan.
--
-- Nomor migrasi 3: berkas 0002 disisakan untuk migrasi paralel fase lain;
-- `store.rs` menjalankan migrasi berdasarkan NOMOR, bukan urutan berkas.
CREATE TABLE roblox_catalog_asset (
  asset_id         TEXT PRIMARY KEY,
  creator_kind     TEXT NOT NULL CHECK (creator_kind IN ('user', 'group')),
  creator_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  moderation_state TEXT,
  source           TEXT NOT NULL CHECK (source IN ('upload', 'import')),
  updated_at       INTEGER NOT NULL
);
CREATE INDEX roblox_catalog_asset_owner ON roblox_catalog_asset(creator_kind, creator_id, name);
CREATE INDEX roblox_catalog_asset_updated ON roblox_catalog_asset(updated_at DESC);
