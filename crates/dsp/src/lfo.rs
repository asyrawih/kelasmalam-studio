//! Osilator kontrol rendah-frekuensi — dipakai FLANGER (sapuan delay),
//! REVERB (modulasi line), dan PITCH (fase window sawtooth).
//!
//! ## Kenapa akumulator fase u32, bukan osilator kuadratur
//!
//! Osilator "magic circle" (`s += k*c; c -= k*s`) cuma 4 flop dan memberi sin
//! DAN cos gratis, jadi kelihatan lebih menarik. Ditolak karena dua hal yang
//! keduanya penting di sini:
//!
//! - **Amplitudonya melayang** di f32 dan butuh renormalisasi tiap blok.
//!   Renormalisasi per blok berarti hasilnya bergantung ukuran blok, yang
//!   mematahkan `null_test_block_size_invariance`.
//! - **Tidak punya reset fase yang eksak.** Beat-sync dan `seek()` keduanya
//!   butuh "mulai tepat dari nol", dan itu tidak bisa dinyatakan sebagai state
//!   dua-float tanpa perhitungan ulang.
//!
//! Akumulator fase punya frekuensi yang **eksak dan tanpa drift** (aritmetika
//! integer wrapping, tidak ada pembulatan yang menumpuk), reset yang eksak, dan
//! offset stereo gratis: `phase + 0x4000_0000` tepat 90°.
//!
//! ## Kenapa aproksimasi parabola, bukan `libm::sinf` atau tabel
//!
//! Tabel butuh memori statis dan interpolasi (yang punya ripple sendiri).
//! `sinf` akurat tapi jauh lebih mahal dari yang dibutuhkan LFO. Parabola
//! `4/π·x − 4/π²·x|x|` dengan satu langkah penghalusan memberi THD ~0.06% dan
//! galat puncak ~1.1e-3 — 60 dB lebih baik dari yang bisa didengar pada sinyal
//! kontrol — dengan ~8 flop, tanpa tabel, dan tanpa cabang.

use crate::clampf;

/// Seperempat putaran. Offset stereo 90° = `phase + QUARTER_TURN`.
pub const QUARTER_TURN: u32 = 0x4000_0000;

/// Bentuk gelombang. Semua bernilai 0 pada fase 0 kecuali `Square`, dan semua
/// berayun di `[-1, 1]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LfoShape {
    Sine,
    Triangle,
    Saw,
    Square,
}

/// Sinus dari fase putaran-penuh-u32, hasil di `[-1, 1]`.
///
/// Fase 0 → 0, `QUARTER_TURN` → +1, setengah putaran → 0, tiga perempat → −1.
#[inline(always)]
pub fn fast_sin_norm(phase: u32) -> f32 {
    // i32 memetakan putaran ke [-π, π) tanpa cabang: bit tertinggi fase
    // menjadi tanda, yang persis pembagian setengah putaran yang dibutuhkan.
    const SCALE: f32 = core::f32::consts::PI / 2_147_483_648.0;
    let x = (phase as i32) as f32 * SCALE;

    // 4/π·x − 4/π²·x|x| — eksak di 0, ±π/2, dan ±π.
    let y = 1.273_239_5 * x - 0.405_284_74 * x * libm::fabsf(x);
    // Satu langkah penghalusan: menekan THD dari ~1.8% ke ~0.06%.
    0.225 * (y * libm::fabsf(y) - y) + y
}

/// Segitiga dari fase, `[-1, 1]`, nol di fase 0 dan naik — sefase dengan sinus.
#[inline(always)]
pub fn tri_norm(phase: u32) -> f32 {
    // Digeser seperempat putaran supaya puncaknya jatuh di tempat yang sama
    // dengan puncak sinus; tanpa geseran ini mengganti shape saat berbunyi
    // menghasilkan lompatan fase yang terdengar sebagai klik.
    let p = phase.wrapping_sub(QUARTER_TURN);
    let s = (p as i32) as f32 * (1.0 / 2_147_483_648.0);
    1.0 - 2.0 * libm::fabsf(s)
}

/// Gigi gergaji naik dari fase, `[-1, 1)`, nol di fase 0.
#[inline(always)]
pub fn saw_norm(phase: u32) -> f32 {
    (phase as i32) as f32 * (1.0 / 2_147_483_648.0)
}

/// Kotak dari fase: +1 di separuh pertama putaran, −1 di separuh kedua.
#[inline(always)]
pub fn square_norm(phase: u32) -> f32 {
    if (phase as i32) >= 0 {
        1.0
    } else {
        -1.0
    }
}

#[inline(always)]
fn shape_of(phase: u32, s: LfoShape) -> f32 {
    match s {
        LfoShape::Sine => fast_sin_norm(phase),
        LfoShape::Triangle => tri_norm(phase),
        LfoShape::Saw => saw_norm(phase),
        LfoShape::Square => square_norm(phase),
    }
}

/// Osilator kontrol. Ukurannya 8 byte, jadi murah disimpan per-node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Lfo {
    phase: u32,
    inc: u32,
}

impl Lfo {
    pub const fn new() -> Self {
        Lfo { phase: 0, inc: 0 }
    }

    /// Setel laju dalam Hz. NON-RT (ada divisi f64), dipanggil sekali per blok.
    ///
    /// Frekuensi negatif berlaku (LFO berjalan mundur) dan menghasilkan `inc`
    /// yang membungkus — itu benar, bukan kebetulan.
    pub fn set_rate(&mut self, sample_rate: f32, hz: f32) {
        if !(sample_rate > 0.0) || !hz.is_finite() {
            return;
        }
        let turns_per_sample = (hz as f64) / (sample_rate as f64);
        // Batasi ke ±setengah laju sample; di atas itu LFO tidak bermakna dan
        // `as i64` bisa jenuh dengan cara yang tidak diinginkan.
        let t = turns_per_sample.clamp(-0.5, 0.5);
        self.inc = (t * 4_294_967_296.0) as i64 as u32;
    }

    /// Setel periode langsung dalam sample — jalur yang dipakai beat-sync,
    /// karena UI sudah menghitung "berapa sample satu putaran" dari BPM.
    pub fn set_period_samples(&mut self, n: f64) {
        if !(n >= 2.0) || !n.is_finite() {
            return;
        }
        self.inc = (4_294_967_296.0 / n) as i64 as u32;
    }

    /// Setel fase dalam putaran `[0, 1)` — dipakai sinkronisasi bar/beat.
    pub fn set_phase_turns(&mut self, turns: f32) {
        if !turns.is_finite() {
            return;
        }
        let t = clampf(turns, 0.0, 1.0);
        self.phase = (t as f64 * 4_294_967_296.0) as i64 as u32;
    }

    /// Kembalikan ke fase nol. Eksak — itu inti pemilihan akumulator.
    pub fn reset(&mut self) {
        self.phase = 0;
    }

    #[inline(always)]
    pub fn phase(&self) -> u32 {
        self.phase
    }

    #[inline(always)]
    pub fn inc(&self) -> u32 {
        self.inc
    }

    /// Nilai saat ini, lalu majukan satu sample.
    #[inline(always)]
    pub fn next(&mut self, s: LfoShape) -> f32 {
        let v = shape_of(self.phase, s);
        self.phase = self.phase.wrapping_add(self.inc);
        v
    }

    /// Nilai pada offset fase tertentu tanpa memajukan apa pun.
    ///
    /// Dipakai kanal kanan efek stereo: `peek_at(QUARTER_TURN, shape)` memberi
    /// beda fase 90° tanpa osilator kedua dan tanpa risiko keduanya melayang.
    #[inline(always)]
    pub fn peek_at(&self, offset: u32, s: LfoShape) -> f32 {
        shape_of(self.phase.wrapping_add(offset), s)
    }

    /// Majukan `n` sample tanpa menghitung nilai — untuk melewati blok yang
    /// di-bypass tanpa membuat fasenya melenceng dari transport.
    #[inline]
    pub fn advance(&mut self, n: u32) {
        self.phase = self.phase.wrapping_add(self.inc.wrapping_mul(n));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Aproksimasi harus cukup dekat dengan sinus asli di seluruh putaran.
    ///
    /// Ambangnya adalah batas galat SEBENARNYA dari parabola+penghalusan
    /// (~1.09e-3), bukan angka bulat yang dilonggarkan sampai lulus — jadi
    /// tes ini akan menangkap kalau ada yang merusak konstantanya.
    #[test]
    fn fast_sin_matches_libm_within_tolerance() {
        let mut worst = 0.0f32;
        for i in 0..4096u32 {
            let phase = (i as u64 * 4_294_967_296u64 / 4096) as u32;
            let x = (phase as i32) as f64 * (core::f64::consts::PI / 2_147_483_648.0);
            let want = libm::sin(x) as f32;
            let got = fast_sin_norm(phase);
            worst = worst.max((got - want).abs());
        }
        assert!(worst < 1.15e-3, "galat terburuk {worst}");
    }

    #[test]
    fn cardinal_points_are_exact_enough() {
        assert!(fast_sin_norm(0).abs() < 1e-6);
        assert!((fast_sin_norm(QUARTER_TURN) - 1.0).abs() < 1e-4);
        assert!((fast_sin_norm(3 * QUARTER_TURN) + 1.0).abs() < 1e-4);
    }

    /// Segitiga sefase dengan sinus: nol di 0, puncak di seperempat putaran.
    #[test]
    fn triangle_is_in_phase_with_sine() {
        assert!(tri_norm(0).abs() < 1e-6);
        assert!((tri_norm(QUARTER_TURN) - 1.0).abs() < 1e-6);
        assert!(tri_norm(2 * QUARTER_TURN).abs() < 1e-6);
        assert!((tri_norm(3 * QUARTER_TURN) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn every_shape_stays_in_range() {
        for shape in [
            LfoShape::Sine,
            LfoShape::Triangle,
            LfoShape::Saw,
            LfoShape::Square,
        ] {
            let mut l = Lfo::new();
            l.set_rate(48_000.0, 997.0);
            for _ in 0..20_000 {
                let v = l.next(shape);
                assert!((-1.0..=1.0).contains(&v), "{shape:?} keluar rentang: {v}");
            }
        }
    }

    /// INI alasan akumulator dipilih ketimbang osilator kuadratur: setelah
    /// sepuluh juta sample, fasenya harus **tepat** sama dengan perhitungan
    /// tertutup — nol drift, bukan "drift kecil".
    #[test]
    fn frequency_has_exactly_zero_drift() {
        const N: u32 = 10_000_000;
        let mut l = Lfo::new();
        l.set_rate(48_000.0, 0.25);
        let inc = l.inc();
        for _ in 0..N {
            l.next(LfoShape::Sine);
        }
        assert_eq!(l.phase(), inc.wrapping_mul(N));
    }

    #[test]
    fn reset_is_exact() {
        let mut l = Lfo::new();
        l.set_rate(48_000.0, 3.0);
        for _ in 0..12_345 {
            l.next(LfoShape::Sine);
        }
        l.reset();
        assert_eq!(l.phase(), 0);
        assert!(l.next(LfoShape::Sine).abs() < 1e-6);
    }

    /// Offset 90° harus benar-benar seperempat putaran di depan.
    #[test]
    fn quarter_turn_offset_is_ninety_degrees() {
        let mut l = Lfo::new();
        l.set_rate(48_000.0, 1.0);
        for _ in 0..777 {
            l.next(LfoShape::Sine);
        }
        let a = l.peek_at(0, LfoShape::Sine);
        let b = l.peek_at(QUARTER_TURN, LfoShape::Sine);
        // sin²+cos² = 1 untuk beda fase 90°.
        assert!((a * a + b * b - 1.0).abs() < 3e-3, "a={a} b={b}");
    }

    /// `advance(n)` harus identik dengan memanggil `next()` sebanyak n kali.
    #[test]
    fn advance_matches_repeated_next() {
        let mut a = Lfo::new();
        let mut b = Lfo::new();
        a.set_rate(48_000.0, 7.5);
        b.set_rate(48_000.0, 7.5);
        for _ in 0..1000 {
            a.next(LfoShape::Sine);
        }
        b.advance(1000);
        assert_eq!(a.phase(), b.phase());
    }

    /// Parameter tak masuk akal tidak boleh membuat state jadi sampah.
    #[test]
    fn bad_parameters_are_ignored_not_propagated() {
        let mut l = Lfo::new();
        l.set_rate(48_000.0, 2.0);
        let good = l.inc();
        l.set_rate(0.0, 2.0);
        l.set_rate(48_000.0, f32::NAN);
        l.set_period_samples(f64::NAN);
        l.set_period_samples(0.0);
        l.set_phase_turns(f32::NAN);
        assert_eq!(l.inc(), good);
        assert!(l.next(LfoShape::Sine).is_finite());
    }
}
