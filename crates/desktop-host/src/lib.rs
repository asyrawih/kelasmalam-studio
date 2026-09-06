//! `daw-desktop-host` — sisi Rust aplikasi desktop yang TIDAK tahu-menahu
//! soal Tauri (docs/20 §1g, §2d; docs/21 §1a).
//!
//! Crate ini ada supaya logika yang bisa diuji hidup di luar crate
//! `daw-desktop`: crate Tauri menyeret WebKit/WebView2 dan dikecualikan dari
//! job CI Ubuntu, sedangkan crate ini ikut `cargo test --workspace` di sana.
//! Aturannya sama dengan crate inti: tanpa `wasm-bindgen`, tanpa `unsafe`,
//! tanpa dependensi Tauri. Crate `daw-desktop` hanya membungkus fungsi-fungsi
//! di sini sebagai `#[tauri::command]` dan meneruskan progress sebagai event.
//!
//! Isinya:
//!
//! - **Model** (`model.rs`): `download_model` / `read_model` — model SCNet
//!   yang tidak ikut bundel, diunduh sekali ke `<dir>/models/`.
//! - **Penyimpanan lokal** (docs/21): [`Store`] membuka satu folder
//!   kepustakaan (`library.sqlite` + `tracks/`), dengan command
//!   `library_*` di `library.rs`, tabel Roblox di `roblox_db.rs`, berkas
//!   lagu di `tracks.rs`, dan relokasi folder di `store.rs`. Bentuk data
//!   yang menyeberang IPC ada di [`types`] — cermin
//!   `web/src/platform/local-commands.ts`, dijaga tes `contract_tests.rs`.
//! - **Rahasia** (`secret.rs`): [`SecretStore`] untuk API key/cookie Roblox
//!   dalam satu berkas lokal di `app_config_dir()`, di luar folder kepustakaan.

mod error;
mod library;
mod model;
mod roblox_db;
mod secret;
mod store;
mod tracks;
pub mod types;

#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod store_tests;

pub use error::{HostError, LocalError};
pub use secret::{SecretKey, SecretStore, SECRETS_FILE};
pub use store::{Store, DB_FILE, SCHEMA_VERSION};
pub use tracks::{Probe, TRACKS_SUBDIR};

// Model (docs/20 §1g) — grup sendiri supaya tetap di bawah.
pub use model::{
    download_model, model_is_ready, model_path, model_specs, read_model, ModelId, ModelSpec,
    MODELS_SUBDIR,
};

#[cfg(test)]
mod tests;

pub mod open_cloud;
pub mod roblox_upload;
pub mod soundcloud;

/// Grant Access lokal (docs/21 §3f): port rute `/roblox/*` Worker kepustakaan
/// — sync katalog dengan cookie, experience, resolve place, grant izin Use.
pub mod roblox_grant;
