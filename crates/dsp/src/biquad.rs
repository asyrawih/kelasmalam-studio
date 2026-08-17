//! Biquad transposed direct form II (TDF-II) + desain koefisien RBJ cookbook.
//!
//! Kenapa TDF-II dan bukan DF-I (ringkasan docs/02 §2b):
//! - DF-I menyimpan 4 state (`x[n-1..2]`, `y[n-1..2]`) dan menjumlahkan
//!   nilai-nilai yang sudah dikali koefisien besar. Di f32, untuk filter Q
//!   tinggi di frekuensi rendah (low shelf 40 Hz @ 48 kHz), koefisien mendekati
//!   ±2/±1 dan error pembulatan terakumulasi di jalur feedback.
//! - TDF-II menyimpan 2 state yang berperan sebagai **akumulator** berskala
//!   kecil, dan hanya satu penjumlahan yang menyentuh output per sample →
//!   noise floor lebih rendah di f32 dan sensitivitas koefisien lebih baik.
//! - Bonus: 2 register state per instance, bukan 4. Dengan 32 track × 4 band ×
//!   2 channel = 256 instance, itu selisih 2 KiB state — muat di L1.
//!
//! Harga yang dibayar: TDF-II **tidak suka koefisien berubah tiap sample**,
//! karena state-nya punya arti fisik yang bergantung koefisien. Karena itu
//! [`Coeffs::design`] dipanggil per **blok** (atau per sub-blok di batas event),
//! tidak pernah di dalam inner loop.

use crate::{clampf, flush_denorm};
use core::f32::consts::PI;

/// Koefisien biquad yang **sudah dinormalisasi dengan `a0`**.
///
/// Normalisasi dilakukan sekali saat desain supaya inner loop tidak pernah
/// membagi — pembagian f32 ~10× lebih mahal dari perkalian dan tidak bisa
/// di-pipeline sebaik FMA.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coeffs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl Default for Coeffs {
    /// Identitas (pass-through).
    fn default() -> Self {
        Coeffs::identity()
    }
}

/// Jenis filter yang didukung (semua dari RBJ Audio EQ Cookbook).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterKind {
    LowPass,
    HighPass,
    LowShelf,
    HighShelf,
    Peaking,
    Notch,
    AllPass,
    BandPass,
}

impl Coeffs {
    /// Filter identitas: `y[n] = x[n]`.
    pub const fn identity() -> Self {
        Coeffs {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }

    /// Desain koefisien RBJ. **Bukan** fungsi RT-path per sample — panggil saat
    /// parameter berubah atau sekali per blok.
    ///
    /// `gain_db` hanya dipakai oleh `LowShelf`/`HighShelf`/`Peaking`.
    ///
    /// Semua input di-clamp ke rentang yang waras (frekuensi ke
    /// `[1 Hz, 0.49 * sr]`, Q ke `[0.05, 40]`) supaya tidak ada jalur yang bisa
    /// menghasilkan NaN dan meracuni state filter selamanya.
    pub fn design(
        kind: FilterKind,
        sample_rate: f32,
        freq_hz: f32,
        q: f32,
        gain_db: f32,
    ) -> Coeffs {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        // 0.49 * sr, bukan 0.5: tepat di Nyquist, tan(w/2) → inf.
        let f = clampf(freq_hz, 1.0, 0.49 * sr);
        let q = clampf(q, 0.05, 40.0);
        let gain_db = clampf(gain_db, -60.0, 60.0);

        let w0 = 2.0 * PI * f / sr;
        let cos_w0 = libm::cosf(w0);
        let sin_w0 = libm::sinf(w0);
        let alpha = sin_w0 / (2.0 * q);

        // A = 10^(gain_db/40) — amplitudo akar, konvensi RBJ untuk shelf/peak.
        let a = libm::powf(10.0, gain_db / 40.0);

        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::LowPass => {
                let b1 = 1.0 - cos_w0;
                (
                    b1 * 0.5,
                    b1,
                    b1 * 0.5,
                    1.0 + alpha,
                    -2.0 * cos_w0,
                    1.0 - alpha,
                )
            }
            FilterKind::HighPass => {
                let b1 = -(1.0 + cos_w0);
                (
                    -b1 * 0.5,
                    b1,
                    -b1 * 0.5,
                    1.0 + alpha,
                    -2.0 * cos_w0,
                    1.0 - alpha,
                )
            }
            FilterKind::BandPass => {
                // Constant 0 dB peak gain (varian kedua RBJ).
                (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha)
            }
            FilterKind::Notch => (
                1.0,
                -2.0 * cos_w0,
                1.0,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
            FilterKind::AllPass => (
                1.0 - alpha,
                -2.0 * cos_w0,
                1.0 + alpha,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
            FilterKind::Peaking => (
                1.0 + alpha * a,
                -2.0 * cos_w0,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos_w0,
                1.0 - alpha / a,
            ),
            FilterKind::LowShelf => {
                // Untuk shelf, RBJ memakai 2*sqrt(A)*alpha sebagai suku silang.
                let sq = 2.0 * libm::sqrtf(a) * alpha;
                let ap1 = a + 1.0;
                let am1 = a - 1.0;
                (
                    a * (ap1 - am1 * cos_w0 + sq),
                    2.0 * a * (am1 - ap1 * cos_w0),
                    a * (ap1 - am1 * cos_w0 - sq),
                    ap1 + am1 * cos_w0 + sq,
                    -2.0 * (am1 + ap1 * cos_w0),
                    ap1 + am1 * cos_w0 - sq,
                )
            }
            FilterKind::HighShelf => {
                let sq = 2.0 * libm::sqrtf(a) * alpha;
                let ap1 = a + 1.0;
                let am1 = a - 1.0;
                (
                    a * (ap1 + am1 * cos_w0 + sq),
                    -2.0 * a * (am1 + ap1 * cos_w0),
                    a * (ap1 + am1 * cos_w0 - sq),
                    ap1 - am1 * cos_w0 + sq,
                    2.0 * (am1 - ap1 * cos_w0),
                    ap1 - am1 * cos_w0 - sq,
                )
            }
        };

        // Normalisasi a0 sekali di sini. Kalau a0 entah bagaimana nol/NaN,
        // kembalikan identitas — lebih baik filter tidak bekerja daripada
        // NaN masuk ke buffer output dan menyebar ke seluruh mixer.
        // `is_nan()` dicek eksplisit, bukan lewat `!(x > eps)`: a0 bisa NaN
        // kalau input-nya sudah NaN, dan pembagian dengan NaN akan menyebarkan
        // NaN ke seluruh mixer.
        if a0.is_nan() || libm::fabsf(a0) <= 1.0e-20 {
            return Coeffs::identity();
        }
        let inv = 1.0 / a0;
        let c = Coeffs {
            b0: b0 * inv,
            b1: b1 * inv,
            b2: b2 * inv,
            a1: a1 * inv,
            a2: a2 * inv,
        };
        if c.b0.is_finite()
            && c.b1.is_finite()
            && c.b2.is_finite()
            && c.a1.is_finite()
            && c.a2.is_finite()
        {
            c
        } else {
            Coeffs::identity()
        }
    }

    /// Magnitudo respons frekuensi pada `freq_hz` (linear, bukan dB).
    ///
    /// Hanya dipakai untuk tes dan untuk menggambar kurva EQ di UI — bukan
    /// jalur RT (ada `sqrt` dan trig di dalamnya).
    pub fn magnitude_at(&self, sample_rate: f32, freq_hz: f32) -> f32 {
        let w = 2.0 * PI * freq_hz / sample_rate;
        let (c1, s1) = (libm::cosf(w), libm::sinf(w));
        let (c2, s2) = (libm::cosf(2.0 * w), libm::sinf(2.0 * w));
        // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
        let nr = self.b0 + self.b1 * c1 + self.b2 * c2;
        let ni = -(self.b1 * s1 + self.b2 * s2);
        let dr = 1.0 + self.a1 * c1 + self.a2 * c2;
        let di = -(self.a1 * s1 + self.a2 * s2);
        let num = libm::sqrtf(nr * nr + ni * ni);
        let den = libm::sqrtf(dr * dr + di * di);
        if den > 1.0e-20 {
            num / den
        } else {
            0.0
        }
    }
}

/// State biquad TDF-II. Hanya dua akumulator — koefisien disimpan terpisah
/// supaya satu set `Coeffs` bisa dipakai bersama oleh channel L dan R.
#[derive(Clone, Copy, Debug, Default)]
pub struct Biquad {
    s1: f32,
    s2: f32,
}

impl Biquad {
    pub const fn new() -> Self {
        Biquad { s1: 0.0, s2: 0.0 }
    }

    /// Nolkan state. Dipakai saat seek/stop supaya tail filter dari posisi lama
    /// tidak bocor ke posisi baru.
    #[inline]
    pub fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }

    /// Satu sample.
    ///
    /// Struktur TDF-II:
    /// ```text
    /// y  = b0*x + s1
    /// s1 = b1*x - a1*y + s2
    /// s2 = b2*x - a2*y
    /// ```
    #[inline(always)]
    pub fn tick(&mut self, x: f32, c: &Coeffs) -> f32 {
        let y = c.b0 * x + self.s1;
        self.s1 = c.b1 * x - c.a1 * y + self.s2;
        self.s2 = c.b2 * x - c.a2 * y;
        y
    }

    /// Proses satu blok in-place, lalu flush denormal **sekali** di akhir.
    ///
    /// Sekali per blok cukup: state IIR butuh ratusan sample untuk meluruh ke
    /// wilayah denormal setelah input jadi senyap, jadi tidak mungkin ia
    /// sempat "mencemari" satu blok penuh (docs/02 §2b).
    pub fn process(&mut self, buf: &mut [f32], c: &Coeffs) {
        for x in buf.iter_mut() {
            *x = self.tick(*x, c);
        }
        self.flush_denormal();
    }

    /// Flush state ke nol kalau sudah denormal. Panggil 1× per blok.
    #[inline]
    pub fn flush_denormal(&mut self) {
        self.s1 = flush_denorm(self.s1);
        self.s2 = flush_denorm(self.s2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    /// Magnitudo yang diukur dengan menjalankan sinyal sinus lewat filter,
    /// dipakai untuk memverifikasi bahwa implementasi TDF-II benar-benar
    /// mewujudkan `Coeffs::magnitude_at` (bukan cuma aljabar di atas kertas).
    fn measured_magnitude(c: &Coeffs, freq: f32) -> f32 {
        let mut bq = Biquad::new();
        let n = 48_000usize;
        let mut peak = 0.0f32;
        for i in 0..n {
            let x = (2.0 * core::f32::consts::PI * freq * i as f32 / SR).sin();
            let y = bq.tick(x, c);
            // buang 10k sample pertama (transien)
            if i > 10_000 && y.abs() > peak {
                peak = y.abs();
            }
        }
        peak
    }

    #[test]
    fn lowpass_dc_and_nyquist() {
        let c = Coeffs::design(FilterKind::LowPass, SR, 1_000.0, 0.707, 0.0);
        // DC harus lewat utuh (0 dB), Nyquist harus habis.
        assert!((c.magnitude_at(SR, 0.0) - 1.0).abs() < 1e-3);
        assert!(c.magnitude_at(SR, SR / 2.0) < 1e-3);
        // -3 dB di cutoff untuk Q = 1/sqrt(2)
        let m = c.magnitude_at(SR, 1_000.0);
        assert!(
            (m - core::f32::consts::FRAC_1_SQRT_2).abs() < 0.02,
            "m = {m}"
        );
    }

    #[test]
    fn highpass_dc_and_nyquist() {
        let c = Coeffs::design(FilterKind::HighPass, SR, 1_000.0, 0.707, 0.0);
        assert!(c.magnitude_at(SR, 0.0) < 1e-3);
        assert!((c.magnitude_at(SR, SR / 2.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn notch_kills_center() {
        let c = Coeffs::design(FilterKind::Notch, SR, 1_000.0, 4.0, 0.0);
        assert!(c.magnitude_at(SR, 1_000.0) < 1e-3);
        assert!((c.magnitude_at(SR, 0.0) - 1.0).abs() < 1e-3);
        assert!((c.magnitude_at(SR, SR / 2.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn allpass_is_flat() {
        let c = Coeffs::design(FilterKind::AllPass, SR, 1_000.0, 0.707, 0.0);
        for f in [0.0, 100.0, 1_000.0, 10_000.0, SR / 2.0] {
            assert!((c.magnitude_at(SR, f) - 1.0).abs() < 1e-3, "f = {f}");
        }
    }

    #[test]
    fn bandpass_dc_and_nyquist_are_zero() {
        let c = Coeffs::design(FilterKind::BandPass, SR, 1_000.0, 2.0, 0.0);
        assert!(c.magnitude_at(SR, 0.0) < 1e-3);
        assert!(c.magnitude_at(SR, SR / 2.0) < 1e-3);
        assert!((c.magnitude_at(SR, 1_000.0) - 1.0).abs() < 1e-2);
    }

    #[test]
    fn peaking_hits_target_gain() {
        for g in [-12.0f32, -6.0, 6.0, 12.0] {
            let c = Coeffs::design(FilterKind::Peaking, SR, 1_000.0, 1.0, g);
            let m_db = 20.0 * c.magnitude_at(SR, 1_000.0).log10();
            assert!((m_db - g).abs() < 0.05, "g = {g}, got {m_db}");
            // Jauh dari center harus ~0 dB.
            assert!(c.magnitude_at(SR, 0.0).log10().abs() * 20.0 < 0.5);
        }
    }

    #[test]
    fn shelves_hit_target_gain() {
        for g in [-12.0f32, 12.0] {
            let ls = Coeffs::design(FilterKind::LowShelf, SR, 1_000.0, 0.707, g);
            let dc_db = 20.0 * ls.magnitude_at(SR, 0.0).log10();
            assert!((dc_db - g).abs() < 0.1, "lowshelf dc {dc_db} vs {g}");
            assert!(20.0 * ls.magnitude_at(SR, SR / 2.0).log10() < 0.1);

            let hs = Coeffs::design(FilterKind::HighShelf, SR, 1_000.0, 0.707, g);
            let ny_db = 20.0 * hs.magnitude_at(SR, SR / 2.0).log10();
            assert!((ny_db - g).abs() < 0.1, "highshelf nyq {ny_db} vs {g}");
            assert!(20.0 * hs.magnitude_at(SR, 0.0).log10() < 0.1);
        }
    }

    #[test]
    fn measured_matches_analytic() {
        let c = Coeffs::design(FilterKind::LowPass, SR, 2_000.0, 0.707, 0.0);
        // Frekuensi sengaja bukan pembagi bulat SR: kalau periodenya membagi
        // habis, sample bisa tidak pernah jatuh tepat di puncak sinus dan
        // pengukuran peak akan under-estimate.
        for f in [137.0f32, 971.0, 2_311.0] {
            let a = c.magnitude_at(SR, f);
            let m = measured_magnitude(&c, f);
            assert!((a - m).abs() < 0.02, "f={f} analytic={a} measured={m}");
        }
    }

    #[test]
    fn process_flushes_denormals() {
        let c = Coeffs::design(FilterKind::LowPass, SR, 100.0, 0.707, 0.0);
        let mut bq = Biquad::new();
        let mut buf = [1.0f32; 128];
        bq.process(&mut buf, &c);
        // Setelah input senyap panjang, state harus benar-benar nol (bukan
        // denormal yang menetes).
        for _ in 0..2_000 {
            let mut z = [0.0f32; 128];
            bq.process(&mut z, &c);
        }
        assert_eq!(bq.s1, 0.0);
        assert_eq!(bq.s2, 0.0);
    }

    #[test]
    fn insane_params_fall_back_to_identity_not_nan() {
        for kind in [
            FilterKind::LowPass,
            FilterKind::HighPass,
            FilterKind::LowShelf,
            FilterKind::HighShelf,
            FilterKind::Peaking,
            FilterKind::Notch,
            FilterKind::AllPass,
            FilterKind::BandPass,
        ] {
            for &(f, q) in &[(0.0f32, 0.0f32), (1e9, 1e9), (-100.0, -1.0)] {
                let c = Coeffs::design(kind, SR, f, q, 200.0);
                assert!(c.b0.is_finite() && c.a2.is_finite(), "{kind:?} {f} {q}");
            }
        }
    }
}
