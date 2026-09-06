-- Code sekali pakai untuk login desktop (docs/16 §9, docs/20 §1d).
--
-- Aplikasi Tauri tidak bisa menerima cookie `__Host-lib_session`: origin-nya
-- `tauri://localhost`, bukan satu site dengan API. Jalur penggantinya: browser
-- sistem menjalani OAuth seperti biasa, lalu callback mengembalikan user ke
-- aplikasi lewat deep link `kelasmalam://auth?code=…`. Yang dibawa deep link
-- itu BUKAN token sesi — URL deep link tercatat di log OS, riwayat browser,
-- dan bisa ditangkap aplikasi lain yang mendaftarkan skema yang sama. Yang
-- dibawa adalah code ini: berumur 60 detik, sekali pakai, dan baru berguna
-- sesudah ditukar lewat `POST /auth/desktop/exchange`.
--
-- Yang disimpan SHA-256 dari code-nya, seperti `session.token_hash`: bocornya
-- isi tabel ini tidak memberi siapa pun code yang bisa ditukar.
--
-- Terikat ke `user_id`, bukan ke baris `session`. Sesinya SENGAJA baru dibuat
-- saat code ditukar: kalau sesi dibuat di callback, tabel ini harus menyimpan
-- token sesi mentah supaya bisa dikembalikan saat penukaran — dan itu
-- membatalkan seluruh alasan token disimpan sebagai hash. Deep link yang tidak
-- pernah ditangkap aplikasi (browser ditutup, skema belum terdaftar) dengan
-- begitu juga tidak meninggalkan sesi 30 hari yang tidak dipegang siapa pun.
CREATE TABLE IF NOT EXISTS desktop_auth_code (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_auth_code_expiry ON desktop_auth_code(expires_at);
