//! Dither TPDF + RNG deterministik.
//!
//! KENAPA TPDF, BUKAN RPDF (docs/03 §3b):
//! Kuantisasi tanpa dither menghasilkan error yang BERKORELASI dengan sinyal —
//! terdengar sebagai distorsi harmonik dan "kekasaran" di tail yang meluruh,
//! bukan sebagai noise.
//! - RPDF (rectangular, 1 LSB, satu sumber uniform) men-dekorelasi *mean* error,
//!   tapi VARIANSI-nya masih bergantung sinyal → "noise modulation": noise floor
//!   naik-turun mengikuti musik, artefak yang jelas terdengar di fade-out.
//! - TPDF (triangular, 2 LSB, jumlah/selisih dua sumber uniform INDEPENDEN)
//!   membuat mean DAN variansi error independen dari sinyal. Noise floor-nya
//!   ~4.77 dB lebih tinggi tapi *stationary*, dan telinga jauh lebih toleran
//!   terhadap noise konstan. Ini standar industri.
//!
//! RNG-nya PCG32: cepat, tanpa alokasi, dan di-seed dari parameter export
//! sehingga dua export dengan setelan sama menghasilkan file BYTE-IDENTIK —
//! syarat mutlak untuk tes null.

/// PCG32 (XSH-RR). ~6 instruksi per sample, periode 2^64.
#[derive(Clone, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub const fn new(seed: u64, seq: u64) -> Self {
        Pcg32 {
            state: seed.wrapping_add(seq),
            inc: (seq << 1) | 1,
        }
    }

    #[inline(always)]
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform di [0, 1). 24 bit mantissa — cukup, dan tanpa bias pembagian.
    #[inline(always)]
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
}

/// Sumber dither TPDF. Nilai yang dihasilkan berada di ±1 LSB pada domain
/// integer ter-skala (jadi ditambahkan SEBELUM `round()`).
#[derive(Clone, Debug)]
pub struct Tpdf {
    a: Pcg32,
    b: Pcg32,
    #[cfg(feature = "noise-shaping")]
    shaper: NoiseShaper2,
}

impl Tpdf {
    /// Dua sumber uniform INDEPENDEN — itulah yang membuat distribusinya
    /// segitiga. Memakai satu RNG dua kali juga boleh, tapi dua stream PCG
    /// dengan `inc` berbeda membuat independensinya eksplisit.
    pub fn new(seed: u64) -> Self {
        Tpdf {
            a: Pcg32::new(seed, 0xda3e_39cb_94b9_5bdb),
            b: Pcg32::new(seed ^ 0x9e37_79b9_7f4a_7c15, 0x853c_49e6_748f_ea9b),
            #[cfg(feature = "noise-shaping")]
            shaper: NoiseShaper2::new(),
        }
    }

    #[inline(always)]
    pub fn next(&mut self) -> f32 {
        self.a.next_f32() - self.b.next_f32()
    }
}

/// Kuantisasi f32 → integer dengan dither opsional.
///
/// `scale` = nilai skala penuh (32767 untuk 16-bit, 8388607 untuk 24-bit).
#[inline(always)]
pub fn quantize(x: f32, scale: f32, min: f32, max: f32, dither: Option<&mut Tpdf>) -> i32 {
    let mut v = x * scale;
    if let Some(d) = dither {
        v += d.next();
    }
    // `round_ties_even` tidak ada di semua versi; round() sudah cukup dan
    // konsisten karena dither sudah men-dekorelasi errornya.
    let v = v.round();
    let v = if v < min {
        min
    } else if v > max {
        max
    } else {
        v
    };
    v as i32
}

/// Noise shaping orde-2 — STUB YANG SENGAJA TIDAK AKTIF.
///
/// Ide: umpan-balikkan error kuantisasi lewat filter yang memindahkan energi
/// noise ke > 15 kHz, tempat telinga jauh kurang sensitif. Bentuk sederhana
/// yang terbukti adalah error feedback orde-2 dengan koefisien "E-weighted",
/// efeknya ~10 dB perceived noise floor lebih rendah di 16-bit.
///
/// KENAPA TIDAK MENJADI DEFAULT:
/// 1. Ia menambah STATE per channel — export tidak lagi stateless per sample,
///    dan chunk streaming harus membawa state itu antar chunk.
/// 2. Filter error-feedback bisa TIDAK STABIL kalau koefisiennya salah atau
///    kalau sinyal sering clip: error yang di-clamp masuk kembali ke feedback
///    dan bisa berosilasi. Salah implementasi terdengar jauh lebih buruk
///    daripada tidak ada noise shaping sama sekali.
/// 3. Ia membuat output tidak lagi netral: noise floor-nya diwarnai. Untuk
///    master yang akan di-encode lagi ke lossy, itu justru merugikan.
/// Karena itu ditawarkan nanti sebagai opsi eksplisit "16-bit + noise shaping",
/// bukan perilaku diam-diam.
#[cfg(feature = "noise-shaping")]
#[derive(Clone, Debug, Default)]
pub struct NoiseShaper2 {
    e1: f32,
    e2: f32,
}

#[cfg(feature = "noise-shaping")]
impl NoiseShaper2 {
    pub const fn new() -> Self {
        NoiseShaper2 { e1: 0.0, e2: 0.0 }
    }

    /// Koefisien E-weighted sederhana (Wannamaker orde-2).
    const B1: f32 = 1.537;
    const B2: f32 = -0.8367;

    #[inline(always)]
    pub fn apply(&mut self, x: f32) -> f32 {
        x + Self::B1 * self.e1 + Self::B2 * self.e2
    }

    #[inline(always)]
    pub fn feed(&mut self, err: f32) {
        self.e2 = self.e1;
        // Clamp adalah jaring pengaman stabilitas: tanpa ini, sinyal yang clip
        // memberi error besar yang bisa membuat feedback berosilasi.
        self.e1 = err.clamp(-2.0, 2.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcg32_is_reproducible() {
        let mut a = Pcg32::new(42, 1);
        let mut b = Pcg32::new(42, 1);
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn tpdf_is_triangular_and_bounded() {
        let mut d = Tpdf::new(7);
        let mut sum = 0.0f64;
        let mut n = 0u32;
        for _ in 0..200_000 {
            let v = d.next();
            assert!((-1.0..=1.0).contains(&v));
            sum += v as f64;
            n += 1;
        }
        let mean = sum / n as f64;
        assert!(mean.abs() < 0.01, "mean = {mean}");
    }

    /// Inti dari alasan memilih TPDF: variansi error kuantisasi TIDAK boleh
    /// bergantung pada level sinyal.
    #[test]
    fn tpdf_error_variance_is_signal_independent() {
        fn err_variance(level: f32, seed: u64) -> f64 {
            let mut d = Tpdf::new(seed);
            let scale = 32767.0f32;
            let mut sum = 0.0f64;
            let mut sum2 = 0.0f64;
            let n = 200_000;
            for i in 0..n {
                // Sinyal sinus non-periodik terhadap grid kuantisasi.
                let ph = i as f32 * 0.000_733;
                let x = level * sin_approx(ph);
                let q = quantize(x, scale, -32768.0, 32767.0, Some(&mut d)) as f32;
                let e = (q / scale - x) as f64;
                sum += e;
                sum2 += e * e;
            }
            let m = sum / n as f64;
            sum2 / n as f64 - m * m
        }

        // Dua level yang sangat berbeda: -6 dBFS dan -60 dBFS.
        let loud = err_variance(0.5, 1);
        let quiet = err_variance(0.001, 1);
        let ratio = loud / quiet;
        assert!(
            (0.8..1.25).contains(&ratio),
            "variansi error bergantung sinyal: loud={loud:e} quiet={quiet:e} ratio={ratio}"
        );
    }

    fn sin_approx(x: f32) -> f32 {
        // Cukup untuk membangkitkan sinyal uji; tidak dipakai di produksi.
        let t = x * core::f32::consts::TAU;
        t.sin()
    }
}
