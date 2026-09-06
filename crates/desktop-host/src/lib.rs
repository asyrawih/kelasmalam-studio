//! `daw-desktop-host` — sisi Rust aplikasi desktop yang TIDAK tahu-menahu
//! soal Tauri (docs/20 §1d, §1g, §2d).
//!
//! Crate ini ada supaya logika yang bisa diuji (token di keychain, unduh dan
//! verifikasi model ONNX) hidup di luar crate `daw-desktop`: crate Tauri
//! menyeret WebKit/WebView2 dan dikecualikan dari job CI Ubuntu, sedangkan
//! crate ini ikut `cargo test --workspace` di sana. Aturannya sama dengan
//! crate inti: tanpa `wasm-bindgen`, tanpa `unsafe`, tanpa dependensi Tauri.
//! Crate `daw-desktop` hanya membungkus fungsi-fungsi di sini sebagai
//! `#[tauri::command]` dan meneruskan progress sebagai event.
//!
//! Dua bagian:
//!
//! - [`TokenStore`] — bearer token sesi kepustakaan, disimpan di Keychain
//!   (macOS) / Credential Manager (Windows). Token sengaja tidak pernah
//!   menyentuh `localStorage` WebView (docs/20 §1d).
//! - `model_*` / [`download_model`] / [`read_model`] — model SCNet yang tidak
//!   ikut bundel dan diunduh sekali ke `appDataDir()/models/` (docs/20 §1g).
//!   Ukuran dan hash mencerminkan `web/src/proof-stem/scnet-model.ts`.

mod error;
mod model;
mod token;

pub use error::HostError;
pub use model::{
    download_model, model_is_ready, model_path, model_specs, read_model, ModelId, ModelSpec,
    MODELS_SUBDIR,
};
pub use token::TokenStore;

#[cfg(test)]
mod tests;
