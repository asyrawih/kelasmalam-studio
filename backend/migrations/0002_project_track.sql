-- Peta "project ini memakai lagu itu", menggantikan pemindaian `LIKE` atas
-- seluruh JSON project.
--
-- KENAPA: `json LIKE '%<hash>%'` bekerja sampai project mulai besar, lalu D1
-- menolak dengan `LIKE or GLOB pattern too complex` — dan yang terlihat user
-- adalah lagu yang tidak bisa dihapus, tanpa satu pun petunjuk soal SQL.
-- Pola pencariannya sendiri cuma 66 karakter; yang membuatnya jatuh adalah
-- ukuran TEKS yang dipindai, dan itu tumbuh mengikuti isi project.
--
-- Tabel ini juga menjawab pertanyaan yang sama dengan satu indeks alih-alih
-- pemindaian penuh, jadi ia lebih murah bahkan sebelum batas itu tersentuh.

CREATE TABLE IF NOT EXISTS project_track (
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES user(id),
  hash       TEXT NOT NULL,
  PRIMARY KEY (project_id, hash)
);

-- Pertanyaannya selalu "project mana milik user ini yang memakai hash ini".
CREATE INDEX IF NOT EXISTS project_track_lookup ON project_track(user_id, hash);

-- Project yang ditulis SEBELUM tabel ini ada belum punya barisnya, dan isinya
-- hanya bisa diurai di Worker (hash-nya bersarang di dalam JSON, bukan di kolom
-- tersendiri). Penanda ini yang membuat pengisian susulannya terjadi sekali per
-- project, bukan tiap kali ada yang menghapus lagu.
ALTER TABLE project ADD COLUMN tracks_indexed INTEGER NOT NULL DEFAULT 0;
