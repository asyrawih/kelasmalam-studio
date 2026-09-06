//! Tabel Roblox di `library.sqlite` (docs/21 §1d, §3b, §3e): taksonomi,
//! antrean/katalog unggahan, target creator.
//!
//! Yang TIDAK ada di sini: bicara dengan Open Cloud. Klien HTTP-nya
//! (`open_cloud.rs`) dan command `roblox_upload_start`/`roblox_operation_poll`
//! dikawinkan di fase R3; modul ini hanya menyediakan transisi status yang
//! akan dipakainya (`mark_uploading` → `mark_processing` → `mark_done` /
//! `mark_failed`) supaya aturan "siapa boleh mengubah kolom apa" tetap satu.
//!
//! Hapus kategori/genre yang masih dipakai ditolak dengan `IN_USE` + `count`,
//! pola yang sama dengan hapus lagu (docs/16 §8d): katalog yang separuh
//! isinya menunjuk genre yang sudah tidak ada tidak menjawab apa-apa.

use rusqlite::{params, OptionalExtension, Row};

use crate::store::Store;
use crate::types::{
    CatalogFilter, Category, CreatorKind, Genre, ModerationState, TargetSettings, Taxonomy,
    UploadInput, UploadRow, UploadStatus,
};
use crate::HostError;

const SETTING_CREATOR_KIND: &str = "roblox.creator_kind";
const SETTING_CREATOR_ID: &str = "roblox.creator_id";
const SETTING_GENRE_TO_DESCRIPTION: &str = "roblox.genre_to_description";

const UPLOAD_COLUMNS: &str = "u.id, u.hash, u.file_name, t.bytes, u.seconds, u.name, u.description,
    u.category_id, u.genre_id, u.creator_kind, u.creator_id, u.status, u.operation_id,
    u.asset_id, u.moderation_state, u.error, u.created_at, u.updated_at, u.uploaded_at,
    u.approved_at";

impl Store {
    // ── taksonomi ────────────────────────────────────────────────────────

    /// `roblox_taxonomy_list`: kategori urut `sort`, genre urut kategori lalu `sort`.
    pub fn taxonomy(&self) -> Result<Taxonomy, HostError> {
        let mut cat = self
            .conn()
            .prepare("SELECT id, name, sort FROM roblox_category ORDER BY sort, name")?;
        let categories = cat
            .query_map([], |r| {
                Ok(Category {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sort: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut gen = self.conn().prepare(
            "SELECT g.id, g.category_id, g.name, g.sort FROM roblox_genre g
               JOIN roblox_category c ON c.id = g.category_id
              ORDER BY c.sort, c.name, g.sort, g.name",
        )?;
        let genres = gen
            .query_map([], |r| {
                Ok(Genre {
                    id: r.get(0)?,
                    category_id: r.get(1)?,
                    name: r.get(2)?,
                    sort: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Taxonomy { categories, genres })
    }

    /// `roblox_category_upsert`: `id` `None` = baru (UUID, `sort` = paling
    /// akhir). Nama kembar ditolak `INVALID` — UNIQUE-nya ada di skema, tapi
    /// pesannya harus menyebut nama, bukan "constraint failed"; dan
    /// pemeriksaan di sini tidak peduli huruf besar-kecil ("lo-fi" dan
    /// "Lo-fi" adalah genre yang sama bagi manusia).
    pub fn upsert_category(
        &self,
        id: Option<&str>,
        name: &str,
        sort: Option<i64>,
    ) -> Result<Category, HostError> {
        let name = clean_name(name)?;
        let conn = self.conn();
        let id = match id.filter(|s| !s.is_empty()) {
            Some(id) => {
                let exists = conn
                    .query_row("SELECT 1 FROM roblox_category WHERE id = ?1", [id], |_| {
                        Ok(())
                    })
                    .optional()?
                    .is_some();
                if !exists {
                    return Err(HostError::NotFound("kategori tidak ditemukan".into()));
                }
                id.to_owned()
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let taken: Option<String> = conn
            .query_row(
                "SELECT id FROM roblox_category WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
                params![name, id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Err(HostError::Invalid(format!("kategori {name:?} sudah ada")));
        }
        let sort = match sort {
            Some(s) => s,
            None => conn.query_row(
                "SELECT COALESCE(sort, -1) FROM roblox_category WHERE id = ?1
                     UNION ALL SELECT COALESCE(MAX(sort), -1) + 1 FROM roblox_category LIMIT 1",
                [&id],
                |r| r.get(0),
            )?,
        };
        conn.execute(
            "INSERT INTO roblox_category (id, name, sort) VALUES (?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, sort = excluded.sort",
            params![id, name, sort],
        )?;
        Ok(Category { id, name, sort })
    }

    /// `roblox_category_delete`: `IN_USE` kalau masih ada unggahan (count =
    /// lagu) atau genre (count = genre) di bawahnya.
    pub fn delete_category(&self, id: &str) -> Result<(), HostError> {
        let conn = self.conn();
        let name: String = conn
            .query_row(
                "SELECT name FROM roblox_category WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| HostError::NotFound("kategori tidak ditemukan".into()))?;
        let uploads = count(
            conn,
            "SELECT COUNT(*) FROM roblox_upload u
              WHERE u.category_id = ?1
                 OR u.genre_id IN (SELECT id FROM roblox_genre WHERE category_id = ?1)",
            id,
        )?;
        if uploads > 0 {
            return Err(HostError::InUse {
                message: format!("kategori {name:?} masih dipakai {uploads} lagu"),
                count: uploads,
            });
        }
        let genres = count(
            conn,
            "SELECT COUNT(*) FROM roblox_genre WHERE category_id = ?1",
            id,
        )?;
        if genres > 0 {
            return Err(HostError::InUse {
                message: format!(
                    "kategori {name:?} masih punya {genres} genre — hapus atau pindahkan genre-nya dulu"
                ),
                count: genres,
            });
        }
        conn.execute("DELETE FROM roblox_category WHERE id = ?1", [id])?;
        Ok(())
    }

    /// `roblox_genre_upsert`: buat/ganti nama/pindah kategori.
    pub fn upsert_genre(
        &self,
        id: Option<&str>,
        category_id: &str,
        name: &str,
        sort: Option<i64>,
    ) -> Result<Genre, HostError> {
        let name = clean_name(name)?;
        let conn = self.conn();
        let category_ok = conn
            .query_row(
                "SELECT 1 FROM roblox_category WHERE id = ?1",
                [category_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !category_ok {
            return Err(HostError::NotFound("kategori tidak ditemukan".into()));
        }
        let id = match id.filter(|s| !s.is_empty()) {
            Some(id) => {
                let exists = conn
                    .query_row("SELECT 1 FROM roblox_genre WHERE id = ?1", [id], |_| Ok(()))
                    .optional()?
                    .is_some();
                if !exists {
                    return Err(HostError::NotFound("genre tidak ditemukan".into()));
                }
                id.to_owned()
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let taken: Option<String> = conn
            .query_row(
                "SELECT id FROM roblox_genre WHERE category_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3",
                params![category_id, name, id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Err(HostError::Invalid(format!(
                "genre {name:?} sudah ada di kategori ini"
            )));
        }
        let sort = match sort {
            Some(s) => s,
            None => conn.query_row(
                "SELECT COALESCE((SELECT sort FROM roblox_genre WHERE id = ?1),
                        (SELECT COALESCE(MAX(sort), -1) + 1 FROM roblox_genre WHERE category_id = ?2))",
                params![id, category_id],
                |r| r.get(0),
            )?,
        };
        conn.execute(
            "INSERT INTO roblox_genre (id, category_id, name, sort) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET category_id = excluded.category_id,
               name = excluded.name, sort = excluded.sort",
            params![id, category_id, name, sort],
        )?;
        // Unggahan yang memakai genre ini mengikuti kategori barunya: pasangan
        // (kategori, genre) di satu baris tidak boleh saling bertentangan.
        conn.execute(
            "UPDATE roblox_upload SET category_id = ?1 WHERE genre_id = ?2 AND category_id IS NOT ?1",
            params![category_id, id],
        )?;
        Ok(Genre {
            id,
            category_id: category_id.to_owned(),
            name,
            sort,
        })
    }

    /// `roblox_genre_delete`: `IN_USE` + jumlah lagu kalau masih dipakai.
    pub fn delete_genre(&self, id: &str) -> Result<(), HostError> {
        let conn = self.conn();
        let name: String = conn
            .query_row("SELECT name FROM roblox_genre WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| HostError::NotFound("genre tidak ditemukan".into()))?;
        let uploads = count(
            conn,
            "SELECT COUNT(*) FROM roblox_upload WHERE genre_id = ?1",
            id,
        )?;
        if uploads > 0 {
            return Err(HostError::InUse {
                message: format!("genre {name:?} masih dipakai {uploads} lagu"),
                count: uploads,
            });
        }
        conn.execute("DELETE FROM roblox_genre WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── antrean & katalog ────────────────────────────────────────────────

    /// `roblox_queue_list`: semua baris yang belum `done`/`failed`, urut
    /// masuk (antrean adalah antrean).
    pub fn queue_list(&self) -> Result<Vec<UploadRow>, HostError> {
        self.uploads(
            "WHERE u.status NOT IN ('done', 'failed') ORDER BY u.created_at, u.id",
            &[],
        )
    }

    /// `roblox_queue_put`: upsert. `id` kosong = baris baru (id + waktu dari
    /// sini). `bytes` diabaikan — selalu dari `track`.
    pub fn queue_put(&self, input: &UploadInput) -> Result<UploadRow, HostError> {
        if !self.has_track(&input.hash)? {
            return Err(HostError::NotFound(
                "lagu untuk unggahan ini tidak ada di kepustakaan".into(),
            ));
        }
        self.ensure_taxonomy_pair(input.category_id.as_deref(), input.genre_id.as_deref())?;
        let conn = self.conn();
        let now = self.now();
        let (id, created_at) = if input.id.is_empty() {
            (uuid::Uuid::new_v4().to_string(), now)
        } else {
            let created: Option<i64> = conn
                .query_row(
                    "SELECT created_at FROM roblox_upload WHERE id = ?1",
                    [&input.id],
                    |r| r.get(0),
                )
                .optional()?;
            (input.id.clone(), created.unwrap_or(now))
        };
        conn.execute(
            "INSERT INTO roblox_upload (id, hash, file_name, seconds, name, description,
                category_id, genre_id, creator_kind, creator_id, status, operation_id,
                asset_id, moderation_state, error, created_at, updated_at, uploaded_at, approved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT (id) DO UPDATE SET
               hash = excluded.hash, file_name = excluded.file_name, seconds = excluded.seconds,
               name = excluded.name, description = excluded.description,
               category_id = excluded.category_id, genre_id = excluded.genre_id,
               creator_kind = excluded.creator_kind, creator_id = excluded.creator_id,
               status = excluded.status, operation_id = excluded.operation_id,
               asset_id = excluded.asset_id, moderation_state = excluded.moderation_state,
               error = excluded.error, updated_at = excluded.updated_at,
               uploaded_at = excluded.uploaded_at, approved_at = excluded.approved_at",
            params![
                id,
                input.hash,
                input.file_name,
                input.seconds,
                input.name,
                input.description,
                input.category_id,
                input.genre_id,
                input.creator_kind.as_str(),
                input.creator_id,
                input.status.as_str(),
                input.operation_id,
                input.asset_id,
                input.moderation_state.map(ModerationState::as_str),
                input.error,
                created_at,
                now,
                input.uploaded_at,
                input.approved_at,
            ],
        )?;
        self.upload(&id)
    }

    /// `roblox_queue_remove`.
    pub fn queue_remove(&self, id: &str) -> Result<(), HostError> {
        let changed = self
            .conn()
            .execute("DELETE FROM roblox_upload WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(HostError::NotFound("baris unggahan tidak ditemukan".into()));
        }
        Ok(())
    }

    /// `roblox_catalog_list`: `done`/`failed`, terbaru dulu, dengan filter
    /// kategori/genre/teks (nama, nama berkas, assetId).
    pub fn catalog_list(&self, filter: &CatalogFilter) -> Result<Vec<UploadRow>, HostError> {
        let mut clauses = vec!["u.status IN ('done', 'failed')".to_owned()];
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(c) = filter.category_id.as_deref().filter(|s| !s.is_empty()) {
            args.push(Box::new(c.to_owned()));
            clauses.push(format!("u.category_id = ?{}", args.len()));
        }
        if let Some(g) = filter.genre_id.as_deref().filter(|s| !s.is_empty()) {
            args.push(Box::new(g.to_owned()));
            clauses.push(format!("u.genre_id = ?{}", args.len()));
        }
        if let Some(q) = filter
            .query
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            args.push(Box::new(escape_like(q)));
            let n = args.len();
            clauses.push(format!(
                "(u.name LIKE ?{n} ESCAPE '\\' OR u.file_name LIKE ?{n} ESCAPE '\\' OR u.asset_id LIKE ?{n} ESCAPE '\\')"
            ));
        }
        let sql = format!(
            "WHERE {} ORDER BY COALESCE(u.approved_at, u.uploaded_at, u.updated_at) DESC, u.id",
            clauses.join(" AND ")
        );
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        self.uploads(&sql, &refs)
    }

    /// Satu baris, `NOT_FOUND` kalau tidak ada.
    pub fn upload(&self, id: &str) -> Result<UploadRow, HostError> {
        self.uploads("WHERE u.id = ?1", &[&id])?
            .into_iter()
            .next()
            .ok_or_else(|| HostError::NotFound("baris unggahan tidak ditemukan".into()))
    }

    fn uploads(
        &self,
        tail: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<UploadRow>, HostError> {
        let sql = format!(
            "SELECT {UPLOAD_COLUMNS} FROM roblox_upload u JOIN track t ON t.hash = u.hash {tail}"
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let rows = stmt.query_map(args, row_to_upload)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Kategori/genre yang dirujuk harus ada, dan genre harus milik
    /// kategorinya — kalau tidak, katalog per kategori akan menghitung lagu
    /// yang sama di dua tempat.
    fn ensure_taxonomy_pair(
        &self,
        category_id: Option<&str>,
        genre_id: Option<&str>,
    ) -> Result<(), HostError> {
        let conn = self.conn();
        if let Some(c) = category_id {
            let ok = conn
                .query_row("SELECT 1 FROM roblox_category WHERE id = ?1", [c], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if !ok {
                return Err(HostError::NotFound("kategori tidak ditemukan".into()));
            }
        }
        if let Some(g) = genre_id {
            let owner: Option<String> = conn
                .query_row(
                    "SELECT category_id FROM roblox_genre WHERE id = ?1",
                    [g],
                    |r| r.get(0),
                )
                .optional()?;
            match owner {
                None => return Err(HostError::NotFound("genre tidak ditemukan".into())),
                Some(owner) => {
                    if let Some(c) = category_id {
                        if owner != c {
                            return Err(HostError::Invalid(
                                "genre ini bukan milik kategori yang dipilih".into(),
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    // ── transisi status (dipakai command unggah, fase R3) ────────────────

    /// Mulai mengirim byte.
    pub fn mark_uploading(&self, id: &str) -> Result<UploadRow, HostError> {
        self.set_status(id, "status = 'uploading', error = NULL", &[])
    }

    /// Byte terkirim, Open Cloud memberi `operation_id`; moderasi berjalan.
    pub fn mark_processing(&self, id: &str, operation_id: &str) -> Result<UploadRow, HostError> {
        self.set_status(
            id,
            "status = 'processing', operation_id = ?2, moderation_state = 'reviewing', uploaded_at = ?3, error = NULL",
            &[&operation_id, &self.now()],
        )
    }

    /// Operasi selesai: `asset_id` (kalau ada) dan keadaan moderasi akhir.
    /// `approved_at` hanya terisi kalau disetujui.
    pub fn mark_done(
        &self,
        id: &str,
        asset_id: Option<&str>,
        moderation: ModerationState,
    ) -> Result<UploadRow, HostError> {
        let approved_at = (moderation == ModerationState::Approved).then(|| self.now());
        self.set_status(
            id,
            "status = 'done', asset_id = COALESCE(?2, asset_id), moderation_state = ?3, approved_at = COALESCE(?4, approved_at), error = NULL",
            &[&asset_id, &moderation.as_str(), &approved_at],
        )
    }

    /// Gagal (jaringan, HTTP, ditolak). Pesan disimpan untuk "coba lagi".
    pub fn mark_failed(&self, id: &str, error: &str) -> Result<UploadRow, HostError> {
        self.set_status(id, "status = 'failed', error = ?2", &[&error])
    }

    fn set_status(
        &self,
        id: &str,
        assignments: &str,
        extra: &[&dyn rusqlite::ToSql],
    ) -> Result<UploadRow, HostError> {
        let sql = format!(
            "UPDATE roblox_upload SET {assignments}, updated_at = ?{} WHERE id = ?1",
            extra.len() + 2
        );
        let now = self.now();
        let mut args: Vec<&dyn rusqlite::ToSql> = vec![&id];
        args.extend_from_slice(extra);
        args.push(&now);
        let changed = self.conn().execute(&sql, args.as_slice())?;
        if changed == 0 {
            return Err(HostError::NotFound("baris unggahan tidak ditemukan".into()));
        }
        self.upload(id)
    }

    // ── target ───────────────────────────────────────────────────────────

    /// `roblox_target_get`: bawaan `user` / kosong / genre ke deskripsi hidup.
    pub fn target(&self) -> Result<TargetSettings, HostError> {
        let default = TargetSettings::default();
        let creator_kind = self
            .setting(SETTING_CREATOR_KIND)?
            .and_then(|s| s.parse::<CreatorKind>().ok())
            .unwrap_or(default.creator_kind);
        let creator_id = self
            .setting(SETTING_CREATOR_ID)?
            .unwrap_or(default.creator_id);
        let genre_to_description = self
            .setting(SETTING_GENRE_TO_DESCRIPTION)?
            .map(|s| s == "1")
            .unwrap_or(default.genre_to_description);
        Ok(TargetSettings {
            creator_kind,
            creator_id,
            genre_to_description,
        })
    }

    /// `roblox_target_set`.
    pub fn set_target(&self, target: &TargetSettings) -> Result<(), HostError> {
        self.set_setting(SETTING_CREATOR_KIND, target.creator_kind.as_str())?;
        self.set_setting(SETTING_CREATOR_ID, target.creator_id.trim())?;
        self.set_setting(
            SETTING_GENRE_TO_DESCRIPTION,
            if target.genre_to_description {
                "1"
            } else {
                "0"
            },
        )
    }
}

fn count(conn: &rusqlite::Connection, sql: &str, arg: &str) -> Result<u64, HostError> {
    let n: i64 = conn.query_row(sql, [arg], |r| r.get(0))?;
    Ok(n as u64)
}

fn clean_name(name: &str) -> Result<String, HostError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(HostError::Invalid("nama tidak boleh kosong".into()));
    }
    Ok(name.to_owned())
}

/// Pola `LIKE` dengan `%`, `_`, `\` di-escape — `q` adalah teks user, bukan
/// pola (cermin `listRobloxAssets` Worker).
fn escape_like(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('%');
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

fn row_to_upload(r: &Row<'_>) -> rusqlite::Result<UploadRow> {
    // Kolom enum ber-CHECK di skema, jadi gagal parse di sini berarti skema
    // dan `types.rs` tidak sinkron — dilaporkan sebagai galat konversi, bukan
    // disembunyikan jadi nilai bawaan.
    let creator_kind = r
        .get::<_, String>(9)?
        .parse::<CreatorKind>()
        .map_err(|e| conversion_error(9, e))?;
    let status = r
        .get::<_, String>(11)?
        .parse::<UploadStatus>()
        .map_err(|e| conversion_error(11, e))?;
    let moderation_state = r
        .get::<_, Option<String>>(14)?
        .map(|s| s.parse::<ModerationState>())
        .transpose()
        .map_err(|e| conversion_error(14, e))?;
    Ok(UploadRow {
        id: r.get(0)?,
        hash: r.get(1)?,
        file_name: r.get(2)?,
        bytes: r.get::<_, i64>(3)? as u64,
        seconds: r.get(4)?,
        name: r.get(5)?,
        description: r.get(6)?,
        category_id: r.get(7)?,
        genre_id: r.get(8)?,
        creator_kind,
        creator_id: r.get(10)?,
        status,
        operation_id: r.get(12)?,
        asset_id: r.get(13)?,
        moderation_state,
        error: r.get(15)?,
        created_at: r.get(16)?,
        updated_at: r.get(17)?,
        uploaded_at: r.get(18)?,
        approved_at: r.get(19)?,
    })
}

fn conversion_error(column: usize, why: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, why.into())
}
