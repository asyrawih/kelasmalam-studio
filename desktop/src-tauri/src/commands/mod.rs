//! Command Tauri untuk penyimpanan lokal (docs/21 §2a) — pembungkus tipis
//! di atas `daw-desktop-host`.
//!
//! Kontraknya `web/src/platform/local-commands.ts`: nama command, argumen
//! `camelCase`, bentuk hasil, kode galat `LocalError`, nama event. Tes bentuk
//! di `crates/desktop-host/src/contract_tests.rs` membaca daftar
//! `generate_handler!` di bawah dan memastikan tiap nama kontrak ada di sana
//! — jadi menambah command berarti menambahkannya di TS dulu.
//!
//! Aturan di modul ini:
//!
//! - Tidak ada logika: tiap command memanggil satu fungsi `Store`/
//!   `SecretStore` dan memetakan `HostError` → `LocalError`. Aturan
//!   (dedup, refcount, versi) diuji di crate host.
//! - Semua command `async` dan menjalankan kerja SQLite/disk lewat
//!   `spawn_blocking`: command sinkron dijalankan Tauri di main thread, dan
//!   impor lagu 200 MB atau relokasi folder di main thread berarti UI beku.
//! - Byte besar tidak lewat JSON: `library_blob` mengembalikan
//!   `tauri::ipc::Response`, `library_put_bytes` membaca `tauri::ipc::Request`
//!   mentah dengan header `x-hash`/`x-ext`.

mod grant;
mod library;
mod model;
mod roblox;
mod soundcloud;
mod store;

use std::sync::{Arc, Mutex};

use daw_desktop_host::{HostError, LocalError, SecretStore, Store};
use serde::Serialize;
use tauri::ipc::Invoke;

/// Event progres `store_relocate`: `{ done, total }` byte.
pub const STORE_RELOCATE_EVENT: &str = "daw://store-relocate";
/// Event progres unggah Roblox: `{ id, sent, total }` — dipancarkan oleh
/// command unggah yang dikawinkan di R3; namanya dipesan di sini supaya tes
/// kontrak melihatnya. Belum ada pemakainya sampai R3, maka `allow`.
#[allow(dead_code)]
pub const ROBLOX_PROGRESS_EVENT: &str = "daw://roblox-progress";
/// Event progres unduh model: `{ id, done, total }` (docs/20 kontrak wave 1).
pub const MODEL_PROGRESS_EVENT: &str = "daw://model-progress";

/// Origin web yang menyajikan model untuk browser; desktop mengunduh dari
/// tempat yang sama (docs/20 §1g).
pub const MODEL_BASE_URL: &str = "https://studio.kelasmalam.app";

/// State aplikasi yang dipegang `tauri::State`. `Store` di balik `Mutex`
/// (SQLite serial per koneksi) dan `Arc` supaya bisa dipinjam ke
/// `spawn_blocking`.
pub struct AppState {
    pub store: Arc<Mutex<Store>>,
    pub secrets: SecretStore,
    /// Discovery SoundCloud in-process (pustaka `soundclaude`); cache
    /// `client_id`-nya di folder data aplikasi.
    pub discovery: Arc<daw_desktop_host::soundcloud::Discovery>,
    /// Ditulis `store_relocate` supaya peluncuran berikutnya membuka folder
    /// yang baru (lihat `lib.rs`).
    pub location_file: std::path::PathBuf,
}

/// Galat yang menyeberang IPC — `LocalError` kontrak, dibungkus karena aturan
/// orphan tidak mengizinkan `From<HostError>` untuk tipe dari crate lain.
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct CmdError(pub LocalError);

impl From<HostError> for CmdError {
    fn from(e: HostError) -> Self {
        CmdError(e.to_local())
    }
}

impl CmdError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        CmdError(LocalError {
            code,
            message: message.into(),
            count: None,
            current_version: None,
            status: None,
        })
    }
}

pub type CmdResult<T> = Result<T, CmdError>;

/// Jalankan `f` di thread blocking dengan store terkunci. Panik di dalam
/// (bug) dilaporkan sebagai `IO`, bukan menjatuhkan runtime.
pub async fn with_store<T: Send + 'static>(
    store: &Arc<Mutex<Store>>,
    f: impl FnOnce(&mut Store) -> Result<T, HostError> + Send + 'static,
) -> CmdResult<T> {
    let store = Arc::clone(store);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut guard)
    })
    .await
    .map_err(|e| CmdError::new("IO", format!("thread kerja gagal: {e}")))?
    .map_err(CmdError::from)
}

/// Satu-satunya daftar command. Nama di sini = nama yang dipanggil TS.
pub fn invoke_handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::ping,
        // folder & rahasia
        store::store_info,
        store::store_relocate,
        store::secret_get,
        store::secret_set,
        store::secret_clear,
        // kepustakaan
        library::library_tracks,
        library::library_has,
        library::library_blob,
        library::library_put_bytes,
        library::library_import_path,
        library::library_commit,
        library::library_delete_track,
        library::library_put_marks,
        library::library_projects,
        library::library_project,
        library::library_project_create,
        library::library_project_update,
        library::library_project_delete,
        library::library_project_add_track,
        library::library_project_remove_track,
        // roblox
        roblox::roblox_taxonomy_list,
        roblox::roblox_category_upsert,
        roblox::roblox_category_delete,
        roblox::roblox_genre_upsert,
        roblox::roblox_genre_delete,
        roblox::roblox_queue_list,
        roblox::roblox_queue_put,
        roblox::roblox_queue_remove,
        roblox::roblox_upload_start,
        roblox::roblox_operation_poll,
        roblox::roblox_catalog_list,
        roblox::roblox_target_get,
        roblox::roblox_target_set,
        // roblox — grant access (docs/21 §3f, R5)
        grant::roblox_grant_settings_get,
        grant::roblox_grant_cookie_set,
        grant::roblox_grant_cookie_clear,
        grant::roblox_assets_sync,
        grant::roblox_assets_list,
        grant::roblox_assets_import,
        grant::roblox_assets_record,
        grant::roblox_experiences,
        grant::roblox_resolve_place,
        grant::roblox_grant,
        // soundcloud — proxy lewat Rust (CORS)
        soundcloud::soundcloud_json,
        soundcloud::soundcloud_bytes,
        // model (docs/20 wave 1)
        model::model_download,
        model::model_read,
    ]
}
