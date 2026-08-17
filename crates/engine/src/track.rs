//! Parameter per unit (track/bus): fader + pan, keduanya di-smooth PER SAMPLE.
//!
//! Kenapa per sample (docs/02 §2a): perubahan gain step-wise di batas blok =
//! diskontinuitas = klik ("zipper noise"). Per-blok hanya memindahkan step ke
//! 375 Hz, masih terdengar untuk perubahan besar. Biayanya 1 add + 1 mul per
//! sample — nol dibanding biaya lain.
//!
//! Pan equal-power TIDAK dihitung dengan cos/sin per sample. Yang di-smooth
//! adalah DUA gain hasilnya (gl, gr); trig/akar hanya dijalankan sekali saat
//! nilai pan berubah, di luar jalur render.

use alloc::boxed::Box;
use alloc::vec::Vec;

use daw_dsp::{db_to_lin, Smoother};

use crate::util::sqrt;

/// Waktu ramp gain/pan. 15 ms di 48 kHz = 720 sample ≈ 5.6 blok.
pub const SMOOTH_TAU_MS: f32 = 5.0; // tau = 15ms/3 → 99% dalam ~15 ms

/// Hukum pan equal-power akar-kuadrat: -3.01 dB di tengah, sum daya konstan.
/// Dipakai daripada cos/sin karena akar bisa dihitung tanpa `std` dan tanpa
/// tabel, dan kurvanya identik secara perseptual.
#[inline]
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let p = ((pan + 1.0) * 0.5).clamp(0.0, 1.0);
    (sqrt(1.0 - p), sqrt(p))
}

pub struct UnitParams {
    pub gain: Smoother,
    pub pan_l: Smoother,
    pub pan_r: Smoother,
    pub pan: f32,
    pub muted: bool,
    /// Kontrak daw-dsp tidak mengekspos `Smoother::target()`, jadi kita simpan
    /// sendiri (dibutuhkan `snap()` saat load project / seek).
    gain_target: f32,
}

impl UnitParams {
    fn new(sample_rate: f32) -> Self {
        UnitParams {
            gain: Smoother::new(sample_rate, SMOOTH_TAU_MS, 1.0),
            pan_l: Smoother::new(sample_rate, SMOOTH_TAU_MS, core::f32::consts::FRAC_1_SQRT_2),
            pan_r: Smoother::new(sample_rate, SMOOTH_TAU_MS, core::f32::consts::FRAC_1_SQRT_2),
            pan: 0.0,
            muted: false,
            gain_target: 1.0,
        }
    }

    pub fn set_gain_db(&mut self, db: f32) {
        self.set_gain_lin(db_to_lin(db));
    }

    pub fn set_gain_lin(&mut self, g: f32) {
        self.gain_target = g;
        self.gain.set_target(g);
    }

    pub fn set_pan(&mut self, pan: f32) {
        self.pan = pan;
        let (l, r) = pan_gains(pan);
        self.pan_l.set_target(l);
        self.pan_r.set_target(r);
    }

    /// Dipakai saat memuat project / seek: langsung ke nilai target, tanpa ramp.
    pub fn snap(&mut self) {
        self.gain.set_immediate(self.gain_target);
        let (l, r) = pan_gains(self.pan);
        self.pan_l.set_immediate(l);
        self.pan_r.set_immediate(r);
    }

    #[inline]
    pub fn flush_denormals(&mut self) {
        self.gain.flush_denormal();
        self.pan_l.flush_denormal();
        self.pan_r.flush_denormal();
    }
}

/// Tabel parameter datar untuk semua unit (track lalu bus) + semua send.
pub struct Mixer {
    pub units: Box<[UnitParams]>,
    pub sends: Box<[Smoother]>,
}

impl Mixer {
    pub fn new(units: usize, send_slots: usize, sample_rate: f32) -> Self {
        let mut u = Vec::with_capacity(units);
        for _ in 0..units {
            u.push(UnitParams::new(sample_rate));
        }
        let mut s = Vec::with_capacity(send_slots);
        for _ in 0..send_slots {
            s.push(Smoother::new(sample_rate, SMOOTH_TAU_MS, 0.0));
        }
        Mixer {
            units: u.into_boxed_slice(),
            sends: s.into_boxed_slice(),
        }
    }

    #[inline]
    pub fn unit_mut(&mut self, i: u16) -> Option<&mut UnitParams> {
        self.units.get_mut(i as usize)
    }

    #[inline]
    pub fn send_mut(&mut self, i: u16) -> Option<&mut Smoother> {
        self.sends.get_mut(i as usize)
    }

    /// Sekali per blok, bukan per sample (docs/02 §2b pattern 3).
    pub fn flush_denormals(&mut self) {
        for u in self.units.iter_mut() {
            u.flush_denormals();
        }
        for s in self.sends.iter_mut() {
            s.flush_denormal();
        }
    }
}

/// Fader in-place dengan gain ter-smooth per sample.
#[inline]
pub fn apply_fader(g: &mut Smoother, l: &mut [f32], r: &mut [f32]) {
    let n = l.len().min(r.len());
    for i in 0..n {
        let v = g.next();
        l[i] *= v;
        r[i] *= v;
    }
}

/// Pan equal-power lalu SUM ke tujuan. `src` tidak dimodifikasi (send post-fader
/// membacanya lagi setelah ini).
#[inline]
pub fn pan_add(
    pl: &mut Smoother,
    pr: &mut Smoother,
    src_l: &[f32],
    src_r: &[f32],
    dst_l: &mut [f32],
    dst_r: &mut [f32],
) {
    let n = src_l
        .len()
        .min(src_r.len())
        .min(dst_l.len())
        .min(dst_r.len());
    for i in 0..n {
        let gl = pl.next();
        let gr = pr.next();
        dst_l[i] += src_l[i] * gl;
        dst_r[i] += src_r[i] * gr;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn center_pan_is_minus_three_db() {
        let (l, r) = pan_gains(0.0);
        assert!((l - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-4);
        assert!((r - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-4);
        // Daya total konstan di seluruh rentang.
        for i in 0..=20 {
            let p = -1.0 + i as f32 / 10.0;
            let (a, b) = pan_gains(p);
            assert!((a * a + b * b - 1.0).abs() < 1e-4, "pan {p}");
        }
    }
}
