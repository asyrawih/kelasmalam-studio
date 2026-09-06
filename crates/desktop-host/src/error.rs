//! Satu tipe error untuk seluruh crate.
//!
//! Crate `daw-desktop` mengubahnya jadi [`LocalError`] untuk IPC Tauri
//! (command hanya bisa mengembalikan error yang `Serialize`), jadi yang
//! penting di sini adalah dua hal: `Display` yang ditulis untuk DIBACA USER
//! (pesannya sampai ke UI apa adanya, seperti pesan Worker), dan varian yang
//! bisa dicabangkan oleh tes — `InUse`/`VersionConflict`/`DiskFull` membawa
//! angka yang dijanjikan kontrak `local-commands.ts` (`count`,
//! `currentVersion`), bukan hanya teks.
//!
//! Pemetaan ke kode kontrak ada di [`HostError::code`]; itu satu-satunya
//! tempat yang tahu nama kode TS, supaya menambah varian di sini memaksa
//! keputusan "kode apa yang dilihat UI".

use std::fmt;

use serde::Serialize;

/// Error dari crate ini. `#[non_exhaustive]` supaya menambah varian (mis.
/// resume `Range`) bukan perubahan API yang merusak crate Tauri.
#[derive(Debug)]
#[non_exhaustive]
pub enum HostError {
    /// Berkas/direktori di `data_dir`.
    Io(std::io::Error),
    /// Transport HTTP (DNS, TLS, koneksi putus di tengah body).
    Http(reqwest::Error),
    /// Server menjawab tapi bukan 2xx.
    HttpStatus { status: u16, url: String },
    /// Jumlah byte tidak sama dengan yang dijanjikan spesifikasi model — cermin
    /// `assertModelSize` di `scnet-model.ts`.
    SizeMismatch { expected: u64, actual: u64 },
    /// Ukuran cocok tapi SHA-256 tidak: berkas diganti/korup, bukan terpotong.
    HashMismatch,
    /// Id model bukan `base`/`large`.
    UnknownModel(String),

    // --- penyimpanan lokal (docs/21) ---
    /// SQLite menolak atau gagal. Pelanggaran aturan yang KITA tahu (hash
    /// belum ada, nama kembar) dipetakan ke varian lain sebelum sampai sini.
    Sqlite(rusqlite::Error),
    /// Baris/berkas yang diminta tidak ada. Isinya kalimat untuk user.
    NotFound(String),
    /// Hapus ditolak karena masih dipakai; `message` menyebut pemakainya,
    /// `count` jumlahnya (docs/16 §8d).
    InUse { message: String, count: u64 },
    /// Simpan project dengan versi basi (docs/16 §8c). `current` = versi yang
    /// sekarang tersimpan, supaya UI bisa menawarkan muat ulang.
    VersionConflict { current: i64 },
    /// Ruang disk sisa lebih kecil dari berkas yang mau disalin; diperiksa
    /// SEBELUM menyalin, bukan sesudah ENOSPC di tengah.
    DiskFull { needed: u64, available: u64 },
    /// Argumen yang tidak masuk akal (hash bukan hex, ext asing, kunci rahasia
    /// tidak terdaftar, genre bukan milik kategorinya).
    Invalid(String),
    /// Keychain OS menolak atau gagal (bukan "entri tidak ada" — itu `Ok(None)`).
    Keyring(keyring_core::Error),
    /// Store keychain native tidak bisa dibuat di proses ini.
    KeyringUnavailable(String),
}

impl HostError {
    /// Kode galat kontrak `LocalError.code` di `web/src/platform/local-commands.ts`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) | Self::SizeMismatch { .. } | Self::HashMismatch => "IO",
            Self::Http(_) | Self::HttpStatus { .. } => "HTTP",
            Self::UnknownModel(_) | Self::Invalid(_) => "INVALID",
            Self::Sqlite(_) => "IO",
            Self::NotFound(_) => "NOT_FOUND",
            Self::InUse { .. } => "IN_USE",
            Self::VersionConflict { .. } => "VERSION_CONFLICT",
            Self::DiskFull { .. } => "DISK_FULL",
            Self::Keyring(_) | Self::KeyringUnavailable(_) => "SECRET_UNAVAILABLE",
        }
    }

    /// Bentuk yang menyeberang IPC. Dipisah dari `Display` supaya angka
    /// (`count`, `currentVersion`, `status`) tetap angka, bukan disisipkan ke
    /// teks yang lalu harus di-parse lagi oleh TS.
    pub fn to_local(&self) -> LocalError {
        let (count, current_version, status) = match self {
            Self::InUse { count, .. } => (Some(*count), None, None),
            Self::VersionConflict { current } => (None, Some(*current), None),
            Self::HttpStatus { status, .. } => (None, None, Some(*status)),
            _ => (None, None, None),
        };
        LocalError {
            code: self.code(),
            message: self.to_string(),
            count,
            current_version,
            status,
        }
    }
}

/// Cermin `LocalError` di `local-commands.ts`. Kunci opsional dihilangkan
/// saat `None` supaya `{ code, message }` polos tetap polos.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O: {e}"),
            Self::Http(e) => write!(f, "HTTP: {e}"),
            Self::HttpStatus { status, url } => write!(f, "HTTP {status} untuk {url}"),
            Self::SizeMismatch { expected, actual } => {
                write!(f, "model tidak lengkap: {actual} / {expected} byte")
            }
            Self::HashMismatch => write!(f, "SHA-256 model tidak cocok dengan spesifikasi"),
            Self::UnknownModel(id) => write!(f, "id model tidak dikenal: {id:?}"),
            Self::Sqlite(e) => write!(f, "basis data kepustakaan: {e}"),
            Self::NotFound(what) => f.write_str(what),
            Self::InUse { message, .. } => f.write_str(message),
            Self::VersionConflict { current } => write!(
                f,
                "project ini sudah disimpan di tempat lain (versi {current}); muat ulang dulu"
            ),
            Self::DiskFull { needed, available } => write!(
                f,
                "ruang disk tidak cukup: butuh {} MB, tersisa {} MB",
                needed.div_ceil(1_000_000),
                available / 1_000_000
            ),
            Self::Invalid(why) => f.write_str(why),
            Self::Keyring(e) => write!(f, "keychain OS: {e}"),
            Self::KeyringUnavailable(why) => write!(f, "keychain OS tidak tersedia: {why}"),
        }
    }
}

impl std::error::Error for HostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Http(e) => Some(e),
            Self::Sqlite(e) => Some(e),
            Self::Keyring(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for HostError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<reqwest::Error> for HostError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}

impl From<rusqlite::Error> for HostError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}
