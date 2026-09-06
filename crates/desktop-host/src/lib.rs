//! `daw-desktop-host` — sisi Rust aplikasi desktop yang TIDAK tahu-menahu
//! soal Tauri (docs/20 §1g, §2d).
//!
//! Crate ini ada supaya logika yang bisa diuji (unduh, verifikasi, dan baca
//! model ONNX) hidup di luar crate `daw-desktop`: crate Tauri menyeret
//! WebKit/WebView2 dan dikecualikan dari job CI Ubuntu, sedangkan crate ini
//! ikut `cargo test --workspace` di sana. Aturannya sama dengan crate inti:
//! tanpa `wasm-bindgen`, tanpa `unsafe`, tanpa dependensi Tauri. Crate
//! `daw-desktop` hanya membungkus fungsi-fungsi di sini sebagai
//! `#[tauri::command]` dan meneruskan progress sebagai event.
//!
//! Isinya hanya model: `model_*` / [`download_model`] / [`read_model`] —
//! model SCNet yang tidak ikut bundel dan diunduh sekali ke
//! `appDataDir()/models/` (docs/20 §1g). Ukuran dan hash mencerminkan
//! `web/src/proof-stem/scnet-model.ts`.
//!
//! Penyimpanan token (docs/20 §1d) sengaja BELUM ada: versi desktop untuk
//! sekarang tidak punya login, dan alur login desktop belum diputuskan.
//! Versi lengkap `TokenStore` (keyring-core + Keychain/Credential Manager,
//! fallback in-memory di Linux) ada di riwayat git, commit
//! 7f9d34e7d135db332c8177fcee0b149a46433f3d (`crates/desktop-host/src/token.rs`).

mod error;
mod model;

pub use error::HostError;
pub use model::{
    download_model, model_is_ready, model_path, model_specs, read_model, ModelId, ModelSpec,
    MODELS_SUBDIR,
};

#[cfg(test)]
mod tests;

pub mod open_cloud;
