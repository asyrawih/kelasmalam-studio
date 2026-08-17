//! `daw-dsp` — blok DSP dasar untuk DawOnWeb.
//!
//! Semua modul di sini berada di jalur render realtime, jadi aturan main-nya:
//! tanpa alokasi, tanpa `panic!`/`unwrap`, tanpa I/O, dan tanpa `dyn Trait`
//! di inner loop (lihat docs/01 §1c).
//!
//! Crate ini `no_std`-compatible; fitur `std` hanya diaktifkan untuk tes dan
//! benchmark. Fungsi transendental diambil dari `libm` supaya jalur no_std dan
//! std menghasilkan angka yang persis sama (determinisme lintas build).

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_op_in_unsafe_fn)]

pub mod biquad;
pub mod comp;
pub mod fastmath;
pub mod mix;
pub mod resample;
pub mod smooth;

pub use biquad::{Biquad, Coeffs, FilterKind};
pub use comp::{CompParams, Compressor, Detector};
pub use fastmath::{db_to_lin, fast_exp2, fast_log2, lin_to_db};
pub use mix::{add_scaled, add_scaled_ramp, clear, copy_scaled, peak, rms};
pub use resample::{hermite4, FracCursor};
pub use smooth::Smoother;

/// Ambang flush denormal. Nilai di bawah ini dianggap nol.
///
/// Kenapa 1e-18 dan bukan `f32::MIN_POSITIVE` (~1.18e-38): kita ingin
/// memotong *sebelum* angka masuk wilayah denormal, bukan sesudahnya. Sinyal
/// audio pada -360 dBFS sudah jauh di bawah batas dengar mana pun, jadi tidak
/// ada informasi yang hilang.
pub const DENORM_EPS: f32 = 1.0e-18;

/// Sinyal DC bolak-balik untuk mencegah state IIR/delay meluruh jadi denormal.
/// Tandanya dibalik tiap sample supaya tidak menghasilkan offset DC audible.
pub const ANTI_DENORM: f32 = 1.0e-20;

/// Flush satu nilai ke nol kalau sudah masuk wilayah denormal.
///
/// Dipanggil sekali per blok pada state IIR — bukan per sample. State butuh
/// ratusan sample untuk meluruh ke denormal, jadi sekali per blok sudah cukup
/// dan biayanya nol di inner loop.
#[inline(always)]
pub fn flush_denorm(x: f32) -> f32 {
    // fabsf dari libm supaya tetap tersedia di no_std.
    if libm::fabsf(x) < DENORM_EPS {
        0.0
    } else {
        x
    }
}

/// Clamp tanpa `panic` (`f32::clamp` panic kalau `min > max`).
#[inline(always)]
pub(crate) fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}
