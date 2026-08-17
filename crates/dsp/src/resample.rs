//! Resampling untuk pemutaran clip dengan pitch/rate arbitrer.
//!
//! Interpolasi 4-titik **cubic Hermite** dalam bentuk Catmull-Rom (tangen di
//! `y0` diambil dari `(y1 - y_m1)/2`). Kenapa ini dan bukan yang lain:
//!
//! - **Linear** murah tapi aliasing-nya buruk: respons magnitudonya `sinc²`,
//!   yang meredam high-end secara terdengar dan tetap melipat balik.
//! - **Windowed-sinc** (yang "benar") butuh 16–64 tap + tabel fase; itu 10×
//!   lebih mahal dan overkill untuk playback clip yang rate-nya dekat 1.0.
//! - **Cubic Hermite 4-titik** adalah titik tengah klasik: 4 tap, tanpa tabel,
//!   dan yang penting untuk kita — **eksak pada sinyal linear**, jadi tidak ada
//!   distorsi pada ramp/DC (dites di modul ini).
//!
//! Posisi disimpan `f64`, bukan `f32`. Alasannya bukan kualitas suara melainkan
//! **drift**: pada rate 0.5 selama 10 menit, kursor mencapai ~1.4e7; mantissa
//! f32 (24 bit) sudah tidak bisa membedakan sample yang bersebelahan di sana.
//! f64 (53 bit) aman sampai jauh melebihi durasi proyek mana pun.

/// Interpolasi cubic Hermite 4-titik pada `t ∈ [0, 1)` antara `y0` dan `y1`.
///
/// Bentuk Catmull-Rom:
/// ```text
/// c0 = y0
/// c1 = (y1 - y_m1) / 2
/// c2 = y_m1 - 2.5*y0 + 2*y1 - 0.5*y2
/// c3 = 0.5*(y2 - y_m1) + 1.5*(y0 - y1)
/// out = ((c3*t + c2)*t + c1)*t + c0
/// ```
/// Horner: 3 mul + 3 add setelah koefisien — cukup murah untuk inner loop.
#[inline(always)]
pub fn hermite4(y_m1: f32, y0: f32, y1: f32, y2: f32, t: f32) -> f32 {
    let c0 = y0;
    let c1 = 0.5 * (y1 - y_m1);
    let c2 = y_m1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    let c3 = 0.5 * (y2 - y_m1) + 1.5 * (y0 - y1);
    ((c3 * t + c2) * t + c1) * t + c0
}

/// Kursor posisi pecahan untuk membaca sample source.
///
/// `pos` dalam satuan **sample source**, `ratio` = berapa sample source yang
/// dikonsumsi per sample output (`ratio = src_rate / dst_rate * speed`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FracCursor {
    pub pos: f64,
    pub ratio: f64,
}

impl FracCursor {
    #[inline]
    pub const fn new(pos: f64, ratio: f64) -> Self {
        FracCursor { pos, ratio }
    }

    /// Indeks sample integer di kiri posisi sekarang.
    #[inline(always)]
    pub fn index(&self) -> i64 {
        // `floor` bukan `as i64` (yang memotong ke arah nol) — untuk pos
        // negatif keduanya berbeda dan kesalahannya menghasilkan lompatan
        // satu sample tepat di batas 0.
        libm::floor(self.pos) as i64
    }

    /// Bagian pecahan `t ∈ [0, 1)`.
    #[inline(always)]
    pub fn frac(&self) -> f32 {
        (self.pos - libm::floor(self.pos)) as f32
    }

    /// Maju satu sample output.
    #[inline(always)]
    pub fn advance(&mut self) {
        self.pos += self.ratio;
    }

    /// Maju `n` sample output sekaligus (dipakai saat melewati sub-blok yang
    /// tidak menghasilkan output, mis. clip belum mulai).
    #[inline]
    pub fn advance_by(&mut self, n: usize) {
        self.pos += self.ratio * n as f64;
    }

    /// Baca `src` terinterpolasi pada `pos` (satuan sample source).
    ///
    /// Penanganan tepi: indeks di luar `src` di-*clamp* ke sample terdekat
    /// (zero-order hold di tepi). Alternatifnya zero-padding, tapi itu
    /// menghasilkan step DC di ujung clip yang terdengar sebagai klik; clamp
    /// menghasilkan tepi yang datar dan clip toh sudah di-fade oleh engine.
    ///
    /// Di luar rentang `src` sepenuhnya (atau `src` kosong) → `0.0`.
    /// Tidak pernah `panic` — ini jalur RT.
    #[inline]
    pub fn read_hermite(&self, src: &[f32], pos: f64) -> f32 {
        let n = src.len();
        if n == 0 {
            return 0.0;
        }
        let i = libm::floor(pos) as i64;
        // Sepenuhnya di luar: kembalikan silence, bukan sample tepi, supaya
        // clip yang sudah lewat tidak menghasilkan DC.
        if i < -1 || i >= n as i64 {
            return 0.0;
        }
        let t = (pos - libm::floor(pos)) as f32;

        let at = |k: i64| -> f32 {
            let k = if k < 0 {
                0
            } else if k >= n as i64 {
                n as i64 - 1
            } else {
                k
            };
            // SAFETY-free: k sudah di-clamp ke [0, n-1], `get` tetap dipakai
            // supaya tidak ada jalur panic sama sekali.
            match src.get(k as usize) {
                Some(v) => *v,
                None => 0.0,
            }
        };

        hermite4(at(i - 1), at(i), at(i + 1), at(i + 2), t)
    }

    /// Baca pada posisi kursor sekarang.
    #[inline(always)]
    pub fn read(&self, src: &[f32]) -> f32 {
        self.read_hermite(src, self.pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermite_is_exact_on_linear_ramp() {
        // Catmull-Rom mereproduksi polinomial derajat 1 secara eksak.
        // Ramp y = a*x + b, sample di x = -1, 0, 1, 2.
        let (a, b) = (0.375f32, -1.25f32);
        let (ym1, y0, y1, y2) = (-a + b, b, a + b, 2.0 * a + b);
        let mut t = 0.0f32;
        while t < 1.0 {
            let want = a * t + b;
            let got = hermite4(ym1, y0, y1, y2, t);
            assert!((got - want).abs() < 1e-6, "t={t} got={got} want={want}");
            t += 0.01;
        }
    }

    #[test]
    fn hermite_passes_through_knots() {
        let (ym1, y0, y1, y2) = (0.3f32, -0.7, 1.1, 0.2);
        assert!((hermite4(ym1, y0, y1, y2, 0.0) - y0).abs() < 1e-6);
        assert!((hermite4(ym1, y0, y1, y2, 1.0) - y1).abs() < 1e-6);
    }

    #[test]
    fn hermite_is_exact_on_quadratic() {
        // Catmull-Rom juga eksak untuk derajat 2 (properti standar).
        let f = |x: f32| 0.5 * x * x - 0.25 * x + 2.0;
        let (ym1, y0, y1, y2) = (f(-1.0), f(0.0), f(1.0), f(2.0));
        for k in 0..=100 {
            let t = k as f32 / 100.0;
            assert!((hermite4(ym1, y0, y1, y2, t) - f(t)).abs() < 1e-5, "t={t}");
        }
    }

    #[test]
    fn read_hermite_on_linear_source() {
        let src: Vec<f32> = (0..64).map(|i| i as f32 * 2.0 + 1.0).collect();
        let c = FracCursor::new(0.0, 1.0);
        // Jauh dari tepi, hasilnya harus eksak mengikuti garisnya.
        let mut p = 4.0f64;
        while p < 58.0 {
            let want = (p * 2.0 + 1.0) as f32;
            let got = c.read_hermite(&src, p);
            assert!((got - want).abs() < 1e-3, "p={p} got={got} want={want}");
            p += 0.125;
        }
    }

    #[test]
    fn read_hermite_hits_exact_samples() {
        let src: Vec<f32> = (0..16).map(|i| (i as f32 * 0.7).sin()).collect();
        let c = FracCursor::new(0.0, 1.0);
        for i in 2..13 {
            let got = c.read_hermite(&src, i as f64);
            assert!((got - src[i]).abs() < 1e-6, "i={i}");
        }
    }

    #[test]
    fn out_of_range_is_silence_not_panic() {
        let src = [1.0f32, 2.0, 3.0];
        let c = FracCursor::new(0.0, 1.0);
        assert_eq!(c.read_hermite(&src, -5.0), 0.0);
        assert_eq!(c.read_hermite(&src, 3.0), 0.0);
        assert_eq!(c.read_hermite(&src, 1e18), 0.0);
        assert_eq!(c.read_hermite(&[], 0.0), 0.0);
        // Tepat di tepi kiri masih boleh berbunyi (i = -1 → t interpolasi
        // menuju sample 0).
        assert!(c.read_hermite(&src, -0.5).is_finite());
    }

    #[test]
    fn cursor_index_and_frac_are_consistent_for_negative_pos() {
        let c = FracCursor::new(-1.25, 1.0);
        assert_eq!(c.index(), -2);
        assert!((c.frac() - 0.75).abs() < 1e-6);
    }

    #[test]
    fn advance_tracks_ratio() {
        let mut c = FracCursor::new(0.0, 0.5);
        c.advance_by(100);
        assert!((c.pos - 50.0).abs() < 1e-12);
        c.advance();
        assert!((c.pos - 50.5).abs() < 1e-12);
    }
}
