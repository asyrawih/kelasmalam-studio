//! Folder kepustakaan + `library.sqlite` (docs/21 §1a–b, §2).
//!
//! Satu [`Store`] = satu folder:
//!
//! ```text
//! <dir>/library.sqlite     semua tabel (migrations/000N_*.sql), WAL
//! <dir>/tracks/<hash>.<ext> byte asli lagu (tracks.rs)
//! <dir>/models/            model ONNX (model.rs)
//! ```
//!
//! Kenapa `rusqlite` dan bukan `tauri-plugin-sql`: aturan kepustakaan (dedup
//! hash, refcount hapus, versi project) hidup dan DIUJI di sini, di atas
//! SQLite sungguhan, dan UI yang tidak tahu SQL tidak bisa merusaknya —
//! alasan yang sama dengan Worker yang memiliki D1-nya (docs/21 §1a).
//!
//! Migrasi numerik tersemat lewat `include_str!`: skema selalu ikut binary,
//! tidak ada berkas .sql yang harus ditemukan di runtime. `schema_version`
//! satu baris; migrasi N hanya dijalankan kalau versi tersimpan < N, di
//! dalam satu transaksi bersama pembaruan versinya.
//!
//! Relokasi folder (§2a) ada di sini juga karena ia satu-satunya operasi
//! yang harus menutup koneksi SQLite: menyalin berkas WAL yang sedang dibuka
//! bisa menghasilkan salinan yang tidak konsisten.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::tracks::TRACKS_SUBDIR;
use crate::types::StoreInfo;
use crate::{HostError, MODELS_SUBDIR};

/// Nama berkas basis data di dalam folder kepustakaan.
pub const DB_FILE: &str = "library.sqlite";

/// Migrasi, urut. Menambah migrasi = menambah satu entri di sini DAN satu
/// berkas di `migrations/`; nomornya harus menaik tanpa lubang.
const MIGRATIONS: &[(u32, &str)] = &[
    (1, include_str!("../migrations/0001_init.sql")),
    // Nomor 2 disisakan untuk migrasi fase lain yang digarap paralel; yang
    // penting bagi migrator hanya nomornya menaik.
    (
        3,
        include_str!("../migrations/0003_roblox_catalog_asset.sql"),
    ),
];

/// Versi skema yang dihasilkan [`Store::open`] pada folder baru = nomor
/// migrasi terakhir. Tes membandingkan dengan ini, bukan angka literal, supaya
/// menambah migrasi tidak berarti mengubah belasan assert.
pub const SCHEMA_VERSION: u32 = MIGRATIONS[MIGRATIONS.len() - 1].0;

/// Sumber waktu yang bisa diganti tes. Milidetik epoch, seperti Worker.
pub type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

/// Folder kepustakaan yang sedang dibuka. Satu per proses; crate Tauri
/// menaruhnya di `Mutex` — SQLite sendiri serial per koneksi, dan
/// operasinya milidetik, jadi satu koneksi cukup.
pub struct Store {
    dir: PathBuf,
    conn: Connection,
    clock: Clock,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

impl Store {
    /// Buka (atau buat) folder kepustakaan di `dir`: subfolder, basis data,
    /// migrasi. Idempoten — memanggilnya pada folder yang sudah ada hanya
    /// menjalankan migrasi yang belum.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, HostError> {
        Self::open_with_clock(dir, Box::new(now_ms))
    }

    /// Seperti [`Store::open`] dengan jam yang ditentukan pemanggil —
    /// untuk tes yang perlu `updated_at` deterministik.
    pub fn open_with_clock(dir: impl Into<PathBuf>, clock: Clock) -> Result<Self, HostError> {
        let dir = dir.into();
        fs::create_dir_all(dir.join(TRACKS_SUBDIR))?;
        fs::create_dir_all(dir.join(MODELS_SUBDIR))?;
        let conn = open_connection(&dir.join(DB_FILE))?;
        let mut store = Self { dir, conn, clock };
        store.migrate()?;
        Ok(store)
    }

    /// Folder kepustakaan.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Path `tracks/`.
    pub fn tracks_dir(&self) -> PathBuf {
        self.dir.join(TRACKS_SUBDIR)
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Waktu sekarang menurut jam store (ms epoch).
    pub(crate) fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Versi skema yang tersimpan (0 = belum ada tabel `schema_version`).
    pub fn schema_version(&self) -> Result<u32, HostError> {
        schema_version(&self.conn)
    }

    fn migrate(&mut self) -> Result<(), HostError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
        )?;
        let current = schema_version(&self.conn)?;
        for &(version, sql) in MIGRATIONS {
            if version <= current {
                continue;
            }
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute("DELETE FROM schema_version", [])?;
            tx.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                [version],
            )?;
            tx.commit()?;
        }
        Ok(())
    }

    /// `store_info()`: path, ukuran folder di disk, jumlah lagu/project,
    /// versi skema. Ukuran dihitung dengan berjalan ke seluruh folder —
    /// termasuk model dan basis data — karena yang ditanya user adalah
    /// "berapa yang dipakai folder ini", bukan jumlah kolom `bytes`.
    pub fn info(&self) -> Result<StoreInfo, HostError> {
        let tracks: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))?;
        let projects: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM project", [], |r| r.get(0))?;
        Ok(StoreInfo {
            dir: self.dir.to_string_lossy().into_owned(),
            bytes: dir_size(&self.dir)?,
            tracks: tracks as u64,
            projects: projects as u64,
            schema_version: self.schema_version()?,
        })
    }

    // ── setting ──────────────────────────────────────────────────────────

    pub fn setting(&self, key: &str) -> Result<Option<String>, HostError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM setting WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), HostError> {
        self.conn.execute(
            "INSERT INTO setting (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ── relokasi ─────────────────────────────────────────────────────────

    /// `store_relocate(newDir)`: salin → verifikasi → tukar → hapus lama.
    ///
    /// Urutannya adalah seluruh jaminannya: folder lama tidak disentuh sampai
    /// salinan di folder baru terbukti lengkap (jumlah berkas DAN ukuran tiap
    /// berkas sama) DAN `commit` — tempat pemanggil menulis penunjuk folder
    /// baru ke config app — berhasil. Gagal di titik mana pun sebelum itu:
    /// salinan setengah jadi dihapus, koneksi dibuka lagi di folder lama,
    /// dan store ini tetap bisa dipakai seperti tidak terjadi apa-apa.
    ///
    /// `progress(done, total)` dalam byte, dipanggil per potongan salinan.
    /// Berkas transien (`.part`, `-wal`, `-shm`, `-journal`) tidak ikut: WAL
    /// sudah di-checkpoint dan koneksi ditutup sebelum menyalin, jadi
    /// `library.sqlite` sendiri sudah lengkap.
    ///
    /// Penghapusan folder lama adalah best-effort: pada titik itu data sudah
    /// hidup di folder baru dan penunjuknya sudah ditulis, jadi sisa folder
    /// lama yang tidak bisa dihapus (mis. Finder sedang membukanya) adalah
    /// sampah, bukan kegagalan — melaporkannya sebagai error hanya akan
    /// membuat UI mengira relokasinya gagal.
    pub fn relocate(
        &mut self,
        new_dir: &Path,
        mut progress: impl FnMut(u64, u64),
        commit: impl FnOnce(&Path) -> Result<(), HostError>,
    ) -> Result<StoreInfo, HostError> {
        let old_dir = self.dir.clone();
        if new_dir == old_dir {
            return Err(HostError::Invalid(
                "folder tujuan sama dengan folder sekarang".into(),
            ));
        }
        if new_dir.starts_with(&old_dir) || old_dir.starts_with(new_dir) {
            return Err(HostError::Invalid(
                "folder tujuan tidak boleh berada di dalam (atau memuat) folder sekarang".into(),
            ));
        }
        fs::create_dir_all(new_dir)?;
        if fs::read_dir(new_dir)?.next().is_some() {
            return Err(HostError::Invalid(
                "folder tujuan harus kosong supaya tidak menimpa milik orang".into(),
            ));
        }

        // Tutup koneksi supaya WAL rata ke berkas utama; setelah ini tidak
        // ada berkas -wal/-shm yang perlu disalin. Koneksi sementara
        // dibutuhkan karena `Connection::close` mengambil kepemilikan.
        let placeholder = Connection::open_in_memory()?;
        let conn = std::mem::replace(&mut self.conn, placeholder);
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        conn.close().map_err(|(_, e)| HostError::Sqlite(e))?;

        let outcome = copy_and_verify(&old_dir, new_dir, &mut progress)
            .and_then(|()| commit(new_dir))
            .and_then(|()| open_connection(&new_dir.join(DB_FILE)));

        match outcome {
            Ok(conn) => {
                self.conn = conn;
                self.dir = new_dir.to_path_buf();
                let _ = fs::remove_dir_all(&old_dir);
                self.info()
            }
            Err(e) => {
                // Bersihkan salinan setengah jadi, lalu kembali ke folder lama.
                let _ = fs::remove_dir_all(new_dir);
                self.conn = open_connection(&old_dir.join(DB_FILE))?;
                Err(e)
            }
        }
    }
}

fn open_connection(path: &Path) -> Result<Connection, HostError> {
    let conn = Connection::open(path)?;
    // WAL: pembaca tidak memblokir penulis (UI membaca daftar sambil impor
    // menulis). `foreign_keys` per koneksi — SQLite tidak menyimpannya.
    // `busy_timeout` untuk jaga-jaga kalau suatu saat ada dua koneksi.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(conn)
}

fn schema_version(conn: &Connection) -> Result<u32, HostError> {
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    Ok(conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |r| {
            r.get::<_, Option<u32>>(0)
        })?
        .unwrap_or(0))
}

/// Milidetik epoch. Jam mundur (NTP) dipotong ke 0, bukan panic.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Berkas yang tidak pernah ikut disalin/dihitung: sisa proses yang sedang
/// berjalan, bukan data.
fn is_transient(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.ends_with(".part")
        || name.ends_with("-wal")
        || name.ends_with("-shm")
        || name.ends_with("-journal")
        || name == ".DS_Store"
}

/// Semua berkas (bukan direktori) di bawah `root`, relatif terhadap `root`,
/// tanpa yang transien. Urut supaya progres dan verifikasi deterministik.
fn list_files(root: &Path) -> Result<Vec<(PathBuf, u64)>, HostError> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() && !is_transient(&path) {
                let rel = path
                    .strip_prefix(root)
                    .expect("entri read_dir selalu di bawah root")
                    .to_path_buf();
                out.push((rel, meta.len()));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Total byte semua berkas di bawah `root` (termasuk transien — yang ditanya
/// adalah ruang disk yang terpakai).
fn dir_size(root: &Path) -> Result<u64, HostError> {
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

fn copy_and_verify(
    from: &Path,
    to: &Path,
    progress: &mut impl FnMut(u64, u64),
) -> Result<(), HostError> {
    let files = list_files(from)?;
    let total: u64 = files.iter().map(|(_, len)| len).sum();
    let mut done = 0u64;
    progress(0, total);

    let mut buf = vec![0u8; 1 << 20];
    for (rel, _) in &files {
        let src_path = from.join(rel);
        let dst_path = to.join(rel);
        if let Some(parent) = dst_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut src = fs::File::open(&src_path)?;
        let mut dst = fs::File::create(&dst_path)?;
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])?;
            done += n as u64;
            progress(done, total);
        }
        dst.sync_all()?;
    }

    // Verifikasi dari daftar tujuan, bukan hanya dari yang baru saja ditulis:
    // jumlah berkas yang sama menangkap berkas yang hilang DAN yang lebih.
    let copied = list_files(to)?;
    if copied.len() != files.len() {
        return Err(HostError::Io(std::io::Error::other(format!(
            "verifikasi salinan gagal: {} berkas di sumber, {} di tujuan",
            files.len(),
            copied.len()
        ))));
    }
    for ((rel, len), (rel2, len2)) in files.iter().zip(&copied) {
        if rel != rel2 || len != len2 {
            return Err(HostError::Io(std::io::Error::other(format!(
                "verifikasi salinan gagal pada {}: {len} byte di sumber, {len2} di tujuan",
                rel.display()
            ))));
        }
    }
    progress(total, total);
    Ok(())
}
