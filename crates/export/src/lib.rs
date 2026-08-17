//! `daw-export` — render offline + encoder WAV, semuanya client-side.
//!
//! Crate ini BUKAN `no_std` (ia memakai `std::io::Cursor` untuk hound), tapi ia
//! tetap dilarang menyentuh `wasm-bindgen`/`web-sys`/`js-sys` (aturan 1 docs/00):
//! bridge JS ada di crate lain.
//!
//! Format lossy (MP3/OGG) TIDAK ada di sini — lihat docs/03 §3c: tidak ada
//! encoder MP3/Vorbis pure-Rust yang layak produksi, jadi jalurnya adalah
//! encoder JS/WASM di sisi web di balik antarmuka `Encoder`.
//!
//! Yang LOSSLESS di-encode di Rust: WAV (default) dan FLAC. FLAC ada di sini
//! karena `flacenc` pure-Rust dan build untuk wasm32 — jadi ia bisa memakai
//! sample yang sama persis dari `render_block` tanpa menyeberang ke JS.

pub mod dither;
pub mod flac;
pub mod offline;
pub mod wav;

pub use flac::{FlacBits, FlacSpec, FlacStreamWriter};
pub use offline::{OfflineRenderer, DEFAULT_BATCH_BLOCKS};
pub use wav::{DitherSettings, WavFormat, WavSpec, WavStreamWriter, CHUNK_BYTES};

#[cfg(test)]
mod tests;
