//! Rahasia Roblox di keychain OS (docs/21 §1f) — pemulihan `TokenStore`
//! PR #44 (commit `7f9d34e`) dengan nama yang lebih jujur: yang disimpan
//! bukan sesi, melainkan API key Open Cloud dan cookie `.ROBLOSECURITY`.
//!
//! Hanya kunci yang terdaftar di [`SecretKey`] yang diterima; kunci lain
//! ditolak `INVALID`. Ini sengaja: keychain adalah tempat yang isinya tidak
//! bisa di-`ls`, dan "apa saja yang pernah kita simpan di sana" harus bisa
//! dijawab dari kode, bukan dari mengingat-ingat.
//!
//! Kenapa tidak memakai crate `keyring` langsung: versi 4 hanya facade yang
//! fitur `v1`-nya memilihkan store per-OS TERMASUK Secret Service (zbus) di
//! Linux, dan tanpa `v1` ia `compile_error!`. README-nya sendiri menyarankan
//! aplikasi yang ingin memilih store-nya untuk link `keyring-core` + crate
//! store yang diinginkan. Itu yang dilakukan di sini: Keychain di macOS,
//! Credential Manager di Windows, dan TIDAK ADA store native di OS lain —
//! Linux bukan target rilis, tapi job CI Ubuntu harus tetap bisa
//! mengompilasi dan menguji crate ini tanpa dbus.
//!
//! Store dipegang per-instance (bukan `keyring_core::set_default_store`,
//! yang global proses) supaya tes bisa memakai store in-memory tanpa
//! menyentuh Keychain sungguhan — di runner macOS pun Keychain bisa memunculkan
//! prompt dan menggantung job.
//!
//! Nilai rahasia tidak pernah masuk `library.sqlite`, log, maupun event:
//! satu-satunya jalan keluarnya adalah `get`, dan `Debug` tidak menampilkannya.

use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use keyring_core::{CredentialStore, Error as KeyringError};

use crate::HostError;

/// Kunci yang terdaftar — cermin `SecretKey` di `local-commands.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SecretKey {
    /// API key Open Cloud (`x-api-key`).
    RobloxApiKey,
    /// Cookie `.ROBLOSECURITY` untuk Grant Access (fase R5).
    RobloxCookie,
}

impl SecretKey {
    pub const ALL: [SecretKey; 2] = [SecretKey::RobloxApiKey, SecretKey::RobloxCookie];

    /// Nama seperti di TS, dipakai juga sebagai `user` entri keychain.
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

/// Penyimpan rahasia terdaftar untuk satu nama service.
pub struct SecretStore {
    service: String,
    /// `Err` kalau store native gagal dibuat — disimpan, bukan dipanic-kan,
    /// supaya `new` tetap infallible seperti kontraknya dan kegagalannya
    /// muncul sebagai `SECRET_UNAVAILABLE` saat dipakai.
    store: Result<Arc<CredentialStore>, String>,
    persistent: bool,
}

impl fmt::Debug for SecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretStore")
            .field("service", &self.service)
            .field("persistent", &self.persistent)
            .finish_non_exhaustive()
    }
}

impl SecretStore {
    /// Store produksi untuk `service` (mis. `"app.kelasmalam.studio"`).
    ///
    /// Di macOS/Windows memakai keychain OS. Di OS lain jatuh ke store
    /// in-memory — rahasia hilang saat proses berhenti, dan itu memang bukan
    /// untuk produksi; periksa [`SecretStore::is_persistent`] kalau UI perlu
    /// memberi tahu user.
    pub fn new(service: &str) -> Self {
        match native_store() {
            Some(Ok(store)) => Self::with_store(service, store, true),
            Some(Err(why)) => Self {
                service: service.to_owned(),
                store: Err(why),
                persistent: true,
            },
            None => Self::in_memory(service),
        }
    }

    /// Store in-memory (proses ini saja). Dipakai tes dan sebagai fallback
    /// di OS tanpa store native. Tiap instance punya isi sendiri.
    pub fn in_memory(service: &str) -> Self {
        let store = keyring_core::mock::Store::new()
            .expect("mock store keyring-core tidak pernah gagal dibuat");
        Self::with_store(service, store, false)
    }

    fn with_store(service: &str, store: Arc<CredentialStore>, persistent: bool) -> Self {
        Self {
            service: service.to_owned(),
            store: Ok(store),
            persistent,
        }
    }

    /// `true` kalau isinya bertahan melewati restart proses (keychain OS).
    pub fn is_persistent(&self) -> bool {
        self.persistent
    }

    /// Nama service yang dipakai sebagai kunci di keychain.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// Nilai tersimpan, atau `None` kalau belum pernah di-`set` / sudah
    /// di-`clear`. "Tidak ada entri" bukan error: itu keadaan normal sebelum
    /// user menempel API key-nya.
    pub fn get(&self, key: SecretKey) -> Result<Option<String>, HostError> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(HostError::Keyring(e)),
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
        self.entry(key)?
            .set_password(value)
            .map_err(HostError::Keyring)
    }

    /// Hapus. Idempoten: menghapus yang sudah tidak ada bukan error.
    pub fn clear(&self, key: SecretKey) -> Result<(), HostError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(HostError::Keyring(e)),
        }
    }

    fn entry(&self, key: SecretKey) -> Result<keyring_core::Entry, HostError> {
        let store = self
            .store
            .as_ref()
            .map_err(|why| HostError::KeyringUnavailable(why.clone()))?;
        store
            .build(&self.service, key.as_str(), None)
            .map_err(HostError::Keyring)
    }
}

/// Store native OS ini: `None` kalau OS tidak punya store yang kita dukung,
/// `Some(Err)` kalau ada tapi gagal dibuat.
fn native_store() -> Option<Result<Arc<CredentialStore>, String>> {
    #[cfg(target_os = "macos")]
    {
        Some(
            apple_native_keyring_store::keychain::Store::new()
                .map(|s| s as Arc<CredentialStore>)
                .map_err(|e| e.to_string()),
        )
    }
    #[cfg(target_os = "windows")]
    {
        Some(
            windows_native_keyring_store::Store::new()
                .map(|s| s as Arc<CredentialStore>)
                .map_err(|e| e.to_string()),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}
