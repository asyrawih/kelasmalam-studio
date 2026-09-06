//! Rahasia Roblox dalam SATU berkas lokal (docs/21 §1f): API key Open Cloud
//! dan cookie `.ROBLOSECURITY`.
//!
//! ## Kenapa berkas, bukan keychain OS
//!
//! Sebelumnya dua rahasia ini duduk di Keychain macOS / Credential Manager
//! Windows lewat `keyring-core`. Keychain mengikat entri ke code signature
//! aplikasi, dan build kita adhoc-signed: setiap `cargo tauri dev` dan setiap
//! rilis baru memunculkan prompt "ingin memakai informasi rahasia di
//! keychain" — gangguan, bukan keamanan, untuk aplikasi satu-pengguna di
//! mesin pengguna sendiri. Tiga crate, fallback in-memory untuk CI Linux, dan
//! jalur galat khusus, semuanya untuk dua string.
//!
//! Yang tetap dijaga dari rancangan lama:
//!
//! - hanya kunci yang terdaftar di [`SecretKey`] yang diterima; kunci lain
//!   ditolak `INVALID` — "apa saja yang pernah kita simpan" dijawab dari kode;
//! - nilainya tidak pernah masuk `library.sqlite`, log, maupun event; satu-
//!   satunya jalan keluarnya adalah `get`, dan `Debug` tidak menampilkannya;
//! - berkasnya BUKAN di folder kepustakaan: folder itu bisa dipindah user
//!   (`store_relocate`) ke iCloud Drive atau Dropbox dan ikut backup, sedangkan
//!   cookie `.ROBLOSECURITY` adalah sesi akun penuh. Tempatnya
//!   `app_config_dir()`, dan relokasi kepustakaan tidak menyentuhnya
//!   (`store.rs`: hanya `library.sqlite` + `tracks/` yang dipindah).
//!
//! Berkasnya JSON `{ "roblox.api_key": "…", "roblox.cookie": "…" }`, dibuat
//! dengan mode `0600` di Unix (di Windows folder profil user sudah ber-ACL
//! per-user), ditulis atomik lewat `.part` + rename, dan dihapus begitu isinya
//! kosong supaya tidak ada berkas rahasia kosong yang tertinggal. Dibaca tiap
//! `get`: isinya dua string yang jarang diminta, dan berkas sebagai satu-
//! satunya sumber kebenaran lebih sederhana daripada cache yang harus dijaga.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;

use crate::HostError;

/// Nama berkas di `app_config_dir()`.
pub const SECRETS_FILE: &str = "roblox-secrets.json";

/// Kunci yang terdaftar — cermin `SecretKey` di `local-commands.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SecretKey {
    /// API key Open Cloud (`x-api-key`).
    RobloxApiKey,
    /// Cookie `.ROBLOSECURITY` untuk Grant Access (fase R5).
    RobloxCookie,
}

impl SecretKey {
    pub const ALL: [SecretKey; 2] = [SecretKey::RobloxApiKey, SecretKey::RobloxCookie];

    /// Nama seperti di TS, dipakai juga sebagai kunci di berkas JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            SecretKey::RobloxApiKey => "roblox.api_key",
            SecretKey::RobloxCookie => "roblox.cookie",
        }
    }
}

impl fmt::Display for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SecretKey {
    type Err = HostError;

    fn from_str(s: &str) -> Result<Self, HostError> {
        Self::ALL
            .into_iter()
            .find(|k| k.as_str() == s)
            .ok_or_else(|| HostError::Invalid(format!("kunci rahasia tidak terdaftar: {s:?}")))
    }
}

/// Isi berkas: kunci → nilai. Kunci yang tidak terdaftar (dari versi app yang
/// lebih baru) dibiarkan apa adanya supaya tidak hilang saat kita menulis.
type Contents = BTreeMap<String, String>;

enum Backend {
    /// Berkas di disk; dibaca tiap `get`, ditulis tiap `set`/`clear`.
    File(PathBuf),
    /// Proses ini saja — tes dan pemakaian tanpa folder config.
    Memory(Mutex<Contents>),
}

/// Penyimpan rahasia terdaftar.
pub struct SecretStore {
    backend: Backend,
}

impl fmt::Debug for SecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut d = f.debug_struct("SecretStore");
        match &self.backend {
            Backend::File(path) => d.field("path", path),
            Backend::Memory(_) => d.field("path", &"<memory>"),
        };
        d.finish_non_exhaustive()
    }
}

impl SecretStore {
    /// Store produksi di `path` (biasanya `app_config_dir()/roblox-secrets.json`).
    /// Berkas dan folder induknya baru dibuat saat `set` pertama.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            backend: Backend::File(path.into()),
        }
    }

    /// Store in-memory (proses ini saja). Tiap instance punya isi sendiri.
    pub fn in_memory() -> Self {
        Self {
            backend: Backend::Memory(Mutex::new(Contents::new())),
        }
    }

    /// `true` kalau isinya bertahan melewati restart proses (backend berkas).
    pub fn is_persistent(&self) -> bool {
        matches!(self.backend, Backend::File(_))
    }

    /// Path berkasnya; `None` untuk store in-memory.
    pub fn path(&self) -> Option<&Path> {
        match &self.backend {
            Backend::File(path) => Some(path),
            Backend::Memory(_) => None,
        }
    }

    /// Nilai tersimpan, atau `None` kalau belum pernah di-`set` / sudah
    /// di-`clear`. "Tidak ada entri" bukan error: itu keadaan normal sebelum
    /// user menempel API key-nya.
    pub fn get(&self, key: SecretKey) -> Result<Option<String>, HostError> {
        match &self.backend {
            Backend::File(path) => Ok(read_file(path)?.remove(key.as_str())),
            Backend::Memory(m) => Ok(lock(m).get(key.as_str()).cloned()),
        }
    }

    /// Simpan (atau timpa). Nilai kosong ditolak — itu `clear`, dan
    /// menyimpan string kosong hanya membuat badge `SIAP` berbohong.
    pub fn set(&self, key: SecretKey, value: &str) -> Result<(), HostError> {
        if value.trim().is_empty() {
            return Err(HostError::Invalid(format!(
                "nilai {key} kosong; pakai secret_clear untuk menghapus"
            )));
        }
        match &self.backend {
            Backend::File(path) => {
                let mut contents = read_file(path)?;
                contents.insert(key.as_str().to_owned(), value.to_owned());
                write_file(path, &contents)
            }
            Backend::Memory(m) => {
                lock(m).insert(key.as_str().to_owned(), value.to_owned());
                Ok(())
            }
        }
    }

    /// Hapus. Idempoten: menghapus yang sudah tidak ada bukan error.
    pub fn clear(&self, key: SecretKey) -> Result<(), HostError> {
        match &self.backend {
            Backend::File(path) => {
                let mut contents = read_file(path)?;
                if contents.remove(key.as_str()).is_none() {
                    return Ok(());
                }
                write_file(path, &contents)
            }
            Backend::Memory(m) => {
                lock(m).remove(key.as_str());
                Ok(())
            }
        }
    }
}

fn lock(m: &Mutex<Contents>) -> std::sync::MutexGuard<'_, Contents> {
    // Isinya dua string; panic di tengah `insert` tidak meninggalkan keadaan
    // setengah jadi yang perlu dilindungi.
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unavailable(path: &Path, why: impl fmt::Display) -> HostError {
    HostError::SecretUnavailable(format!("{}: {why}", path.display()))
}

/// Berkas yang belum ada = kosong. Berkas yang ada tapi bukan JSON objek
/// string→string = `SECRET_UNAVAILABLE`, bukan "kosong": menganggapnya kosong
/// lalu menimpanya saat `set` berikutnya akan membuang nilai yang mungkin
/// masih bisa diselamatkan user.
fn read_file(path: &Path) -> Result<Contents, HostError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Contents>(&bytes)
            .map_err(|e| unavailable(path, format!("bukan JSON yang dikenal ({e})"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Contents::new()),
        Err(e) => Err(unavailable(path, e)),
    }
}

/// Tulis atomik (`.part` + rename) dengan mode `0600`; isi kosong = hapus berkas.
fn write_file(path: &Path, contents: &Contents) -> Result<(), HostError> {
    if contents.is_empty() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(unavailable(path, e)),
        };
    }
    let parent = path
        .parent()
        .ok_or_else(|| unavailable(path, "tidak punya folder induk"))?;
    fs::create_dir_all(parent).map_err(|e| unavailable(path, e))?;
    let part = path.with_extension("json.part");
    let bytes = serde_json::to_vec_pretty(contents).map_err(|e| unavailable(path, e))?;
    write_private(&part, &bytes)
        .and_then(|()| fs::rename(&part, path))
        .map_err(|e| {
            let _ = fs::remove_file(&part);
            unavailable(path, e)
        })
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut f = fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}
