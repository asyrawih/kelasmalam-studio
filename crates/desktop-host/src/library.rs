//! Command `library_*` (docs/21 §2c) di atas [`Store`] — cermin
//! `backend/src/library/store.ts` + handler-nya, tanpa `user_id`.
//!
//! Aturan yang dijaga di sini, bukan di TS (docs/21 §1a):
//!
//! - **dedup**: `hash` adalah PK; commit ulang memperbarui nama, tidak
//!   menggandakan baris (`claimTrack` Worker).
//! - **hapus ditolak kalau masih dipakai** (docs/16 §8d): oleh folder
//!   project (`project_track`) ATAU oleh unggahan Roblox yang belum
//!   `done`/`failed` — pesannya menyebut nama project-nya, `count` jumlahnya.
//! - **versi project** (docs/16 §8c): perbandingan versi ada DI DALAM
//!   `WHERE`, bukan SELECT lalu UPDATE; yang kalah dapat `VersionConflict`
//!   dengan versi yang sekarang tersimpan.
//! - **refcount saat lepas dari folder**: `remove_project_track` menghapus
//!   lagunya kalau tidak ada project lain (dan tidak ada unggahan aktif) yang
//!   memakainya — persis `deletedFromLibrary` di Worker.

use std::path::Path;

use rusqlite::{params, OptionalExtension};

use crate::store::Store;
use crate::tracks::{self, validate_hash};
use crate::types::{
    ImportedTrack, LocalTrack, ProjectBody, ProjectCreated, ProjectSummary, TrackMetaInput,
};
use crate::HostError;

impl Store {
    // ── lagu ─────────────────────────────────────────────────────────────

    /// `library_tracks`: metadata + marks, satu query, terbaru dulu.
    pub fn tracks(&self) -> Result<Vec<LocalTrack>, HostError> {
        let mut stmt = self.conn().prepare(
            "SELECT t.hash, t.name, t.bytes, t.mime, t.frames, t.sample_rate, t.created_at, m.json
               FROM track t LEFT JOIN marks m ON m.hash = t.hash
              ORDER BY t.created_at DESC, t.hash",
        )?;
        let rows = stmt.query_map([], row_to_track)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// `library_has`: `true` kalau ada baris `track`.
    pub fn has_track(&self, hash: &str) -> Result<bool, HostError> {
        Ok(self
            .conn()
            .query_row("SELECT 1 FROM track WHERE hash = ?1", [hash], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn track(&self, hash: &str) -> Result<Option<LocalTrack>, HostError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT t.hash, t.name, t.bytes, t.mime, t.frames, t.sample_rate, t.created_at, m.json
                   FROM track t LEFT JOIN marks m ON m.hash = t.hash WHERE t.hash = ?1",
                [hash],
                row_to_track,
            )
            .optional()?)
    }

    /// `library_blob`: byte mentah lagu.
    pub fn blob(&self, hash: &str) -> Result<Vec<u8>, HostError> {
        tracks::read_track(&self.tracks_dir(), hash)
    }

    /// `library_put_bytes`: tulis `tracks/<hash>.<ext>`; TIDAK menulis baris
    /// `track` — itu `library_commit`, sama dengan `putUpload` → `commitTrack`.
    pub fn put_bytes(&self, hash: &str, ext: &str, bytes: &[u8]) -> Result<(), HostError> {
        tracks::put_bytes(&self.tracks_dir(), hash, ext, bytes).map(|_| ())
    }

    /// `library_import_path`: jalur cepat drop Finder. Salin + hash di Rust,
    /// baca header, tulis baris `track`. `existed` = barisnya sudah ada.
    pub fn import_path(&self, path: &Path) -> Result<ImportedTrack, HostError> {
        let file = tracks::import_file(&self.tracks_dir(), path)?;
        if let Some(track) = self.track(&file.hash)? {
            return Ok(ImportedTrack {
                track,
                existed: true,
            });
        }
        let probe = tracks::probe_header(&file.path);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| file.hash.clone());
        let meta = TrackMetaInput {
            hash: file.hash.clone(),
            name,
            bytes: file.bytes,
            mime: tracks::mime_for(file.ext).to_owned(),
            frames: probe.frames,
            sample_rate: probe.sample_rate,
        };
        self.commit_track(&meta)?;
        let track = self
            .track(&file.hash)?
            .expect("baris track baru saja ditulis");
        Ok(ImportedTrack {
            track,
            existed: false,
        })
    }

    /// `library_commit`: tulis baris `track` untuk byte yang sudah ada di
    /// `tracks/`. UPSERT, bukan hanya idempoten seperti `claimTrack` Worker:
    /// TS memanggilnya lagi sesudah `library_import_path` untuk mengisi
    /// `frames`/`sampleRate` yang tidak terbaca di Rust (probe `<audio>`).
    /// Nilai 0 tidak pernah menimpa nilai yang sudah diketahui — commit
    /// ulang dari jalur yang tidak tahu durasi tidak boleh menghapusnya.
    /// Menolak kalau byte-nya belum ada atau ukurannya tidak sama dengan yang
    /// di disk — cermin `BELUM_TERUNGGAH` / `UKURAN_TIDAK_COCOK`.
    pub fn commit_track(&self, meta: &TrackMetaInput) -> Result<(), HostError> {
        validate_hash(&meta.hash)?;
        let file = tracks::find_track_file(&self.tracks_dir(), &meta.hash).ok_or_else(|| {
            HostError::Invalid(
                "byte lagu belum ditulis; panggil library_put_bytes atau library_import_path dulu"
                    .into(),
            )
        })?;
        let on_disk = std::fs::metadata(&file)?.len();
        if on_disk != meta.bytes {
            return Err(HostError::Invalid(format!(
                "ukuran tidak cocok: {} byte diklaim, {on_disk} byte di disk",
                meta.bytes
            )));
        }
        if meta.name.trim().is_empty() {
            return Err(HostError::Invalid("nama lagu kosong".into()));
        }
        self.conn().execute(
            "INSERT INTO track (hash, name, bytes, mime, frames, sample_rate, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (hash) DO UPDATE SET
               name = excluded.name,
               mime = excluded.mime,
               frames = CASE WHEN excluded.frames > 0 THEN excluded.frames ELSE track.frames END,
               sample_rate = CASE WHEN excluded.sample_rate > 0 THEN excluded.sample_rate ELSE track.sample_rate END",
            params![
                meta.hash,
                meta.name,
                meta.bytes as i64,
                meta.mime,
                meta.frames as i64,
                meta.sample_rate,
                self.now()
            ],
        )?;
        Ok(())
    }

    /// `library_delete_track`: tolak kalau masih dipakai (menyebut nama),
    /// lalu hapus marks + baris + berkas.
    pub fn delete_track(&self, hash: &str) -> Result<(), HostError> {
        validate_hash(hash)?;
        if !self.has_track(hash)? {
            return Err(HostError::NotFound(
                "lagu ini tidak ada di kepustakaan".into(),
            ));
        }
        self.ensure_track_unused(hash)?;
        self.release_track(hash)
    }

    /// `InUse` kalau ada folder project atau unggahan Roblox aktif yang
    /// memakai `hash`. Project disebut namanya — user harus tahu folder mana
    /// yang perlu dibersihkan lebih dulu.
    fn ensure_track_unused(&self, hash: &str) -> Result<(), HostError> {
        let projects = self.projects_referencing(hash)?;
        if !projects.is_empty() {
            let names: Vec<&str> = projects.iter().map(|(_, n)| n.as_str()).collect();
            return Err(HostError::InUse {
                message: format!(
                    "lagu ini masih ada di {} folder project: {} — keluarkan dari folder itu dulu",
                    projects.len(),
                    names.join(", ")
                ),
                count: projects.len() as u64,
            });
        }
        let uploads = self.active_uploads_referencing(hash)?;
        if uploads > 0 {
            return Err(HostError::InUse {
                message: format!(
                    "lagu ini masih ada di antrean unggah Roblox ({uploads} baris) — hapus dari antrean dulu"
                ),
                count: uploads,
            });
        }
        Ok(())
    }

    /// Hapus tanpa memeriksa pemakai. Marks ikut lewat `ON DELETE CASCADE`.
    fn release_track(&self, hash: &str) -> Result<(), HostError> {
        self.conn()
            .execute("DELETE FROM track WHERE hash = ?1", [hash])?;
        tracks::remove_track_file(&self.tracks_dir(), hash)
    }

    /// `library_put_marks`: keadaan LENGKAP cue/grid satu lagu.
    pub fn put_marks(&self, hash: &str, marks: &serde_json::Value) -> Result<(), HostError> {
        if !self.has_track(hash)? {
            return Err(HostError::NotFound(
                "lagu ini tidak ada di kepustakaan".into(),
            ));
        }
        self.conn().execute(
            "INSERT INTO marks (hash, json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (hash) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
            params![hash, marks.to_string(), self.now()],
        )?;
        Ok(())
    }

    /// Project yang memakai `hash`: `(id, name)`.
    pub fn projects_referencing(&self, hash: &str) -> Result<Vec<(String, String)>, HostError> {
        let mut stmt = self.conn().prepare(
            "SELECT p.id, p.name FROM project_track t JOIN project p ON p.id = t.project_id
              WHERE t.hash = ?1 ORDER BY p.name",
        )?;
        let rows = stmt.query_map([hash], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Unggahan Roblox yang belum `done`/`failed` dan memakai `hash`.
    pub fn active_uploads_referencing(&self, hash: &str) -> Result<u64, HostError> {
        let n: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM roblox_upload WHERE hash = ?1 AND status NOT IN ('done', 'failed')",
            [hash],
            |r| r.get(0),
        )?;
        Ok(n as u64)
    }

    // ── project ──────────────────────────────────────────────────────────

    /// `library_projects`: ringkasan, terbaru dulu.
    pub fn projects(&self) -> Result<Vec<ProjectSummary>, HostError> {
        let mut stmt = self.conn().prepare(
            "SELECT id, name, updated_at, version FROM project ORDER BY updated_at DESC, id",
        )?;
        let rows = stmt.query_map([], row_to_summary)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// `library_project`: isi + daftar lagu folder.
    pub fn project(&self, id: &str) -> Result<ProjectBody, HostError> {
        let (summary, json): (ProjectSummary, String) = self
            .conn()
            .query_row(
                "SELECT id, name, updated_at, version, json FROM project WHERE id = ?1",
                [id],
                |r| Ok((row_to_summary(r)?, r.get(4)?)),
            )
            .optional()?
            .ok_or_else(|| HostError::NotFound("project tidak ditemukan".into()))?;
        Ok(ProjectBody {
            summary,
            json: parse_json(&json),
            tracks: self.project_tracks(id)?,
        })
    }

    fn project_tracks(&self, id: &str) -> Result<Vec<String>, HostError> {
        let mut stmt = self
            .conn()
            .prepare("SELECT hash FROM project_track WHERE project_id = ?1 ORDER BY rowid")?;
        let rows = stmt.query_map([id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// `library_project_create`. Semua `tracks` harus ada di kepustakaan —
    /// cermin `ASSET_BELUM_TERSIMPAN`.
    pub fn create_project(
        &mut self,
        name: &str,
        json: &serde_json::Value,
        tracks: &[String],
    ) -> Result<ProjectCreated, HostError> {
        if name.trim().is_empty() {
            return Err(HostError::Invalid("nama project kosong".into()));
        }
        self.ensure_tracks_exist(tracks)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = self.now();
        let tx = self.conn_mut().transaction()?;
        tx.execute(
            "INSERT INTO project (id, name, json, updated_at, version) VALUES (?1, ?2, ?3, ?4, 1)",
            params![id, name, json.to_string(), now],
        )?;
        for hash in tracks {
            tx.execute(
                "INSERT OR IGNORE INTO project_track (project_id, hash) VALUES (?1, ?2)",
                params![id, hash],
            )?;
        }
        tx.commit()?;
        Ok(ProjectCreated { id, version: 1 })
    }

    fn ensure_tracks_exist(&self, hashes: &[String]) -> Result<(), HostError> {
        let mut missing = Vec::new();
        for hash in hashes {
            if !self.has_track(hash)? {
                missing.push(hash.as_str());
            }
        }
        if missing.is_empty() {
            Ok(())
        } else {
            Err(HostError::NotFound(format!(
                "{} lagu belum ada di kepustakaan: {}",
                missing.len(),
                missing.join(", ")
            )))
        }
    }

    /// `library_project_update`: simpan kalau versinya masih `expected`.
    /// Hasil = versi baru. Keanggotaan folder TIDAK diubah — project adalah
    /// folder, mengganti timeline bukan berarti mengeluarkan lagunya.
    pub fn update_project(
        &self,
        id: &str,
        name: &str,
        json: &serde_json::Value,
        expected: i64,
    ) -> Result<i64, HostError> {
        if name.trim().is_empty() {
            return Err(HostError::Invalid("nama project kosong".into()));
        }
        let next = expected + 1;
        let changed = self.conn().execute(
            "UPDATE project SET name = ?1, json = ?2, updated_at = ?3, version = ?4
              WHERE id = ?5 AND version = ?6",
            params![name, json.to_string(), self.now(), next, id, expected],
        )?;
        if changed > 0 {
            return Ok(next);
        }
        let current: Option<i64> = self
            .conn()
            .query_row("SELECT version FROM project WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        match current {
            Some(current) => Err(HostError::VersionConflict { current }),
            None => Err(HostError::NotFound("project tidak ditemukan".into())),
        }
    }

    /// `library_project_delete`. Keanggotaan folder ikut (CASCADE); lagunya
    /// TIDAK — hapus project bukan hapus lagu.
    pub fn delete_project(&self, id: &str) -> Result<(), HostError> {
        let changed = self
            .conn()
            .execute("DELETE FROM project WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(HostError::NotFound("project tidak ditemukan".into()));
        }
        Ok(())
    }

    /// `library_project_add_track`: tambah ke folder tanpa mengubah timeline.
    pub fn add_project_track(&self, project_id: &str, hash: &str) -> Result<(), HostError> {
        self.ensure_project_exists(project_id)?;
        if !self.has_track(hash)? {
            return Err(HostError::NotFound(
                "lagu ini tidak ada di kepustakaan".into(),
            ));
        }
        self.conn().execute(
            "INSERT OR IGNORE INTO project_track (project_id, hash) VALUES (?1, ?2)",
            params![project_id, hash],
        )?;
        Ok(())
    }

    /// `library_project_remove_track`: lepas dari folder; `true` kalau lagunya
    /// ikut hilang karena tidak ada project lain (dan tidak ada unggahan
    /// Roblox aktif) yang memakainya.
    pub fn remove_project_track(&self, project_id: &str, hash: &str) -> Result<bool, HostError> {
        self.ensure_project_exists(project_id)?;
        let removed = self.conn().execute(
            "DELETE FROM project_track WHERE project_id = ?1 AND hash = ?2",
            params![project_id, hash],
        )?;
        if removed == 0 {
            return Ok(false);
        }
        if !self.projects_referencing(hash)?.is_empty()
            || self.active_uploads_referencing(hash)? > 0
        {
            return Ok(false);
        }
        self.release_track(hash)?;
        Ok(true)
    }

    fn ensure_project_exists(&self, id: &str) -> Result<(), HostError> {
        let found = self
            .conn()
            .query_row("SELECT 1 FROM project WHERE id = ?1", [id], |_| Ok(()))
            .optional()?;
        found.ok_or_else(|| HostError::NotFound("project tidak ditemukan".into()))
    }
}

fn row_to_track(r: &rusqlite::Row<'_>) -> rusqlite::Result<LocalTrack> {
    let marks: Option<String> = r.get(7)?;
    Ok(LocalTrack {
        hash: r.get(0)?,
        name: r.get(1)?,
        // SQLite hanya punya INTEGER 64-bit bertanda; nilai kita tidak pernah
        // negatif, jadi cast-nya aman.
        bytes: r.get::<_, i64>(2)? as u64,
        mime: r.get(3)?,
        frames: r.get::<_, i64>(4)? as u64,
        sample_rate: r.get(5)?,
        created_at: r.get(6)?,
        marks: marks.map(|s| parse_json(&s)),
    })
}

fn row_to_summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectSummary> {
    Ok(ProjectSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        updated_at: r.get(2)?,
        version: r.get(3)?,
    })
}

/// JSON di kolom TEXT selalu ditulis oleh kita lewat `Value::to_string`,
/// jadi gagal parse hanya mungkin kalau berkasnya diedit tangan. Dalam kasus
/// itu `null` lebih berguna daripada seluruh daftar yang gagal dimuat.
fn parse_json(s: &str) -> serde_json::Value {
    serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
}
