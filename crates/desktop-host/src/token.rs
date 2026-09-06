//! Bearer token sesi kepustakaan di keychain OS (docs/20 §1d).
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

use std::sync::Arc;

use keyring_core::{CredentialStore, Error as KeyringError};

use crate::HostError;

/// Nama akun di dalam entri keychain. Satu service hanya menyimpan satu
/// token, jadi nilainya konstan; yang membedakan aplikasi adalah `service`.
const TOKEN_USER: &str = "session-token";

/// Penyimpan satu bearer token untuk satu nama service.
pub struct TokenStore {
    service: String,
    /// `Err` kalau store native gagal dibuat — disimpan, bukan dipanic-kan,
    /// supaya `new` tetap infallible seperti kontraknya dan kegagalannya
    /// muncul sebagai `HostError::KeyringUnavailable` saat dipakai.
    store: Result<Arc<CredentialStore>, String>,
    persistent: bool,
}

impl std::fmt::Debug for TokenStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenStore")
            .field("service", &self.service)
            .field("persistent", &self.persistent)
            .finish_non_exhaustive()
    }
}

impl TokenStore {
    /// Store produksi untuk `service` (mis. `"app.kelasmalam.studio"`).
    ///
    /// Di macOS/Windows memakai keychain OS. Di OS lain jatuh ke store
    /// in-memory — token hilang saat proses berhenti, dan itu memang bukan
    /// untuk produksi; periksa [`TokenStore::is_persistent`] kalau UI perlu
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

    /// `true` kalau token bertahan melewati restart proses (keychain OS).
    pub fn is_persistent(&self) -> bool {
        self.persistent
    }

    /// Nama service yang dipakai sebagai kunci di keychain.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// Token tersimpan, atau `None` kalau belum pernah di-`set` / sudah
    /// di-`clear`. "Tidak ada entri" bukan error: itu keadaan normal sebelum
    /// login.
    pub fn get(&self) -> Result<Option<String>, HostError> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(HostError::Keyring(e)),
        }
    }

    /// Simpan (atau timpa) token.
    pub fn set(&self, token: &str) -> Result<(), HostError> {
        self.entry()?
            .set_password(token)
            .map_err(HostError::Keyring)
    }

    /// Hapus token. Idempoten: menghapus yang sudah tidak ada bukan error,
    /// karena logout harus selalu bisa "berhasil".
    pub fn clear(&self) -> Result<(), HostError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(HostError::Keyring(e)),
        }
    }

    fn entry(&self) -> Result<keyring_core::Entry, HostError> {
        let store = self
            .store
            .as_ref()
            .map_err(|why| HostError::KeyringUnavailable(why.clone()))?;
        store
            .build(&self.service, TOKEN_USER, None)
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
