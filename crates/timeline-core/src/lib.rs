//! `daw-timeline` — inti timeline DawOnWeb.
//!
//! Crate ini memuat empat hal yang saling bergantung dan sengaja ditaruh
//! bersama supaya invariant-nya bisa dijaga oleh compiler:
//!
//! | Modul      | Isi                                                                 |
//! |------------|---------------------------------------------------------------------|
//! | [`coords`] | Dua koordinat space (`SourceSample` / `TimelineSample`) + viewport   |
//! | [`tempo`]  | Tempo map integer (PPQ 960), tick↔sample, grid & snap                |
//! | [`model`]  | `Clip` / `Track` / `Bus` / `Project` (serde) + hook migrasi versi    |
//! | [`edit`]   | Operasi edit non-destruktif sebagai command dengan inverse (undo)    |
//! | [`peaks`]  | Peak pyramid multi-resolusi untuk waveform                          |
//!
//! ## Aturan yang mengikat (lihat `docs/00-api-contract.md`)
//!
//! 1. `no_std`-compatible. Tidak ada `wasm-bindgen`/`web-sys`/`js-sys`.
//! 2. Posisi selalu integer sample (`u64`), tidak pernah detik float.
//! 3. Tidak ada `unsafe` (di-`forbid` lewat `Cargo.toml`).
//! 4. Sample data asli **tidak pernah** dimutasi. Semua edit hanya menyentuh
//!    metadata clip. Itu definisi "non-destructive" di sini.
//!
//! ## Kenapa `no_std`
//!
//! Crate ini di-*link* ke dalam modul WASM yang di-instantiate di AudioWorklet.
//! Meski `edit`/`peaks` tidak pernah dipanggil dari audio thread, mereka ikut
//! masuk binary. `no_std` + `alloc` memangkas `std::fmt`/panic machinery yang
//! ukurannya puluhan KB di WASM.

#![cfg_attr(not(test), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod coords;
pub mod edit;
pub mod model;
pub mod peaks;
pub mod tempo;

pub use coords::{
    px_to_sample, sample_to_px, source_to_timeline, timeline_to_source, timeline_to_source_frac,
    ClipGeometry, SourceSample, TimelineSample, Viewport,
};
pub use edit::{EditCmd, EditError, FadeSide, History, OverlapPolicy};
// CATATAN: `model::Send` sengaja TIDAK di-re-export di root. Namanya bertabrakan
// dengan `core::marker::Send` di namespace tipe, dan `use daw_timeline::*` akan
// diam-diam mem-*shadow* trait auto itu. Pakai `daw_timeline::model::Send`.
pub use model::{
    lin_to_db, AssetId, AssetRef, Automation, AutomationPoint, Bus, BusId, Clip, ClipId, CurveKind,
    FadeCurve, FadeSpec, FxId, MigrationError, ParamTarget, Project, SendId, Track, TrackId,
    PROJECT_VERSION,
};
pub use peaks::{MinMax, Pyramid, LEVEL_STRIDES};
pub use tempo::{Grid, TempoMap, TempoSegment, TimeSigSegment, PPQ};

/// Micro-fade otomatis di setiap tepi clip (lihat `docs/06-timeline-clips.md` §6d).
///
/// Nilainya 3 ms — tengah-tengah rentang 2–5 ms. Di 48 kHz = 144 sample.
/// Ini **bukan** properti clip: engine yang menerapkannya di setiap boundary,
/// UI tidak pernah melihatnya. Konstanta ada di sini supaya `edit` bisa
/// memakainya sebagai batas bawah saat memotong fade (fade eksplisit yang
/// lebih pendek dari micro-fade tidak ada gunanya).
pub const MICRO_FADE_MS: f32 = 3.0;

/// Panjang micro-fade dalam sample untuk sample rate tertentu.
#[inline]
pub fn micro_fade_samples(sample_rate: u32) -> u64 {
    // Integer, dibulatkan ke bawah; 1 sample minimum supaya tidak pernah 0.
    let n = (MICRO_FADE_MS as f64 * sample_rate as f64 / 1000.0) as u64;
    if n == 0 {
        1
    } else {
        n
    }
}
