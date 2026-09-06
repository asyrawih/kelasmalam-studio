//! Satu tipe error untuk seluruh crate.
//!
//! Crate `daw-desktop` mengubahnya jadi string untuk IPC Tauri (command hanya
//! bisa mengembalikan error yang `Serialize`), jadi yang penting di sini
//! adalah `Display` yang jelas dan varian yang bisa dicabangkan oleh tes —
//! khususnya `SizeMismatch`/`HashMismatch`, yang membedakan "unduhan rusak"
//! dari "jaringan putus".

use std::fmt;

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
        }
    }
}

impl std::error::Error for HostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Http(e) => Some(e),
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
