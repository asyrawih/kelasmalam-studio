//! Dua filter satu-kutub untuk **jalur feedback**: peredam nada dan pemblokir DC.
//!
//! ## Kenapa one-pole dan bukan biquad untuk damping
//!
//! `biquad.rs` sudah punya lowpass yang lebih baik, jadi memakainya di dalam
//! loop feedback terlihat wajar. Tapi biquad dengan resonansi punya `|H(ω)| > 1`
//! di sekitar cutoff-nya. Di dalam loop dengan gain `fb`, syarat stabilitasnya
//! jadi `fb · max|H| < 1`, dan `max|H|` bergantung pada Q yang bisa diubah user
//! — artinya stabilitas jadi sesuatu yang harus dihitung dan dijaga.
//!
//! One-pole lowpass punya `|H(ω)| ≤ 1` **tanpa syarat**, untuk `a` mana pun di
//! `[0, 1]`. Bukti stabilitas loop-nya jadi satu baris: `|H_loop| ≤ fb < 1`.
//! Itu yang membuat SPIRAL/ECHO/PITCH aman disapu user sambil berbunyi.
//!
//! ## Kenapa DC blocker wajib, bukan opsional
//!
//! Loop feedback adalah integrator untuk komponen DC: dengan `fb = 0.98`,
//! gain DC-nya `1/(1−0.98) = 50×`. Sumber DC-nya bukan cuma materi input —
//! injeksi anti-denormal dan asimetri interpolasi juga menyumbang. Tanpa
//! pemblokir, delay dengan feedback tinggi perlahan menuju saturasi, dan
//! gejalanya muncul sebagai "reverb-nya lama-lama pecah" yang nyaris mustahil
//! dilacak balik ke penyebabnya. Ini kegagalan yang tidak pernah ada yang tes
//! dan semua orang kirim.

use crate::{clampf, flush_denorm};

const TWO_PI: f32 = core::f32::consts::TAU;

/// Lowpass satu-kutub. `|H(ω)| ≤ 1` untuk semua `a ∈ [0, 1]`.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct OnePoleLp {
    y: f32,
    a: f32,
}

impl OnePoleLp {
    pub const fn new() -> Self {
        OnePoleLp { y: 0.0, a: 1.0 }
    }

    pub fn with_cutoff(sample_rate: f32, hz: f32) -> Self {
        let mut f = OnePoleLp::new();
        f.set_cutoff(sample_rate, hz);
        f
    }

    /// `a = 1 − exp(−2π·f/sr)`. NON-RT: dipanggil sekali per blok (atau per
    /// grid refresh), tidak per sample — `expf` terlalu mahal untuk inner loop.
    pub fn set_cutoff(&mut self, sample_rate: f32, hz: f32) {
        if !(sample_rate > 0.0) || !hz.is_finite() {
            return;
        }
        // Cutoff di Nyquist atau di atasnya berarti "tidak menyaring apa pun",
        // dan itu harus BENAR-BENAR `a = 1`. Rumus `1 − exp(−2πf/sr)` cuma
        // mendekati 1 secara asimtotik: tepat di Nyquist nilainya 1 − e^−π ≈
        // 0.957, yang masih meredam terdengar. Di dalam loop feedback selisih
        // itu muncul sebagai ekor yang jauh lebih pendek dari yang diminta —
        // persis kenapa cabang ini ada.
        if hz >= sample_rate * 0.5 {
            self.a = 1.0;
            return;
        }
        let f = clampf(hz, 0.0, sample_rate * 0.5);
        self.a = clampf(1.0 - libm::expf(-TWO_PI * f / sample_rate), 0.0, 1.0);
    }

    /// Koefisien saat ini, untuk tes dan untuk node yang menyalin state.
    #[inline(always)]
    pub fn coeff(&self) -> f32 {
        self.a
    }

    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> f32 {
        self.y += (x - self.y) * self.a;
        self.y
    }

    pub fn reset(&mut self) {
        self.y = 0.0;
    }

    /// Sekali per blok — state IIR butuh ratusan sample untuk meluruh ke
    /// denormal, jadi memeriksanya per sample cuma membuang siklus.
    pub fn flush_denormal(&mut self) {
        self.y = flush_denorm(self.y);
    }
}

/// Pemblokir DC: `y[n] = x[n] − x[n−1] + r·y[n−1]`.
///
/// Highpass satu-kutub dengan zero tepat di DC, jadi penolakan DC-nya total,
/// bukan sekadar teredam.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct DcBlock {
    x1: f32,
    y1: f32,
    r: f32,
}

/// Cutoff bawaan. 20 Hz berada di bawah pita dengar tapi cukup tinggi untuk
/// meluruhkan DC dalam puluhan milidetik, bukan detik.
pub const DC_BLOCK_HZ: f32 = 20.0;

impl DcBlock {
    pub const fn new() -> Self {
        DcBlock {
            x1: 0.0,
            y1: 0.0,
            r: 0.0,
        }
    }

    pub fn with_rate(sample_rate: f32) -> Self {
        let mut f = DcBlock::new();
        f.set_rate(sample_rate, DC_BLOCK_HZ);
        f
    }

    pub fn set_rate(&mut self, sample_rate: f32, hz: f32) {
        if !(sample_rate > 0.0) || !hz.is_finite() {
            return;
        }
        // `r` harus < 1 tegas: r = 1 membuat filter jadi integrator murni,
        // yang persis kebalikan dari yang diinginkan.
        self.r = clampf(1.0 - TWO_PI * hz / sample_rate, 0.0, 0.999_9);
    }

    #[inline(always)]
    pub fn coeff(&self) -> f32 {
        self.r
    }

    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> f32 {
        let y = x - self.x1 + self.r * self.y1;
        self.x1 = x;
        self.y1 = y;
        y
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.y1 = 0.0;
    }

    pub fn flush_denormal(&mut self) {
        self.x1 = flush_denorm(self.x1);
        self.y1 = flush_denorm(self.y1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    /// Puncak keluaran setelah settle, untuk sinus `hz` beramplitudo 1.
    fn measure_gain(mut tick: impl FnMut(f32) -> f32, hz: f32) -> f32 {
        let w = core::f32::consts::TAU * hz / SR;
        // Settle dulu, baru ukur — kalau tidak yang terukur transien.
        let settle = (SR / hz.max(1.0)) as usize * 4 + 2000;
        for n in 0..settle {
            tick(libm::sinf(w * n as f32));
        }
        let mut peak = 0.0f32;
        for n in settle..settle + (SR / hz.max(1.0)) as usize * 4 + 200 {
            peak = peak.max(tick(libm::sinf(w * n as f32)).abs());
        }
        peak
    }

    /// INI properti yang membuat loop feedback bisa dibuktikan stabil sebaris.
    #[test]
    fn lowpass_gain_never_exceeds_unity() {
        for i in 0..64 {
            // 20 Hz .. 20 kHz, log-spaced.
            let hz = 20.0 * libm::powf(1000.0, i as f32 / 63.0);
            for &cutoff in &[100.0f32, 1_000.0, 8_000.0, 20_000.0] {
                let mut f = OnePoleLp::with_cutoff(SR, cutoff);
                let g = measure_gain(|x| f.tick(x), hz);
                assert!(
                    g <= 1.0 + 1e-3,
                    "cutoff {cutoff} Hz, sinyal {hz} Hz: gain {g} > 1"
                );
            }
        }
    }

    #[test]
    fn lowpass_passes_dc_and_stops_high() {
        let mut f = OnePoleLp::with_cutoff(SR, 1_000.0);
        for _ in 0..10_000 {
            f.tick(1.0);
        }
        assert!((f.tick(1.0) - 1.0).abs() < 1e-3, "DC harus lewat utuh");

        let mut f = OnePoleLp::with_cutoff(SR, 100.0);
        let g = measure_gain(|x| f.tick(x), 10_000.0);
        assert!(g < 0.05, "10 kHz lewat cutoff 100 Hz: gain {g}");
    }

    /// Konstanta harus benar-benar menolak DC, bukan cuma meredamnya.
    #[test]
    fn dc_block_removes_constant_offset() {
        let mut f = DcBlock::with_rate(SR);
        let mut last = 0.0;
        for _ in 0..SR as usize {
            last = f.tick(1.0);
        }
        assert!(last.abs() < 1e-3, "sisa DC {last}");
    }

    /// Dan harus meneruskan pita audio nyaris utuh.
    #[test]
    fn dc_block_passes_audio_band() {
        for &hz in &[100.0f32, 1_000.0, 10_000.0] {
            let mut f = DcBlock::with_rate(SR);
            let g = measure_gain(|x| f.tick(x), hz);
            assert!((g - 1.0).abs() < 0.02, "{hz} Hz teredam jadi {g}");
        }
    }

    /// Skenario sebenarnya: loop feedback yang tanpa DC blocker akan menuju
    /// saturasi. Dengan blocker, dia harus tetap terkurung.
    #[test]
    fn feedback_loop_with_dc_block_stays_bounded() {
        let mut lp = OnePoleLp::with_cutoff(SR, 6_000.0);
        let mut dc = DcBlock::with_rate(SR);
        let mut state = 0.0f32;
        for _ in 0..2_000_000 {
            // Input DC murni — kasus terburuk untuk integrator.
            let fed = lp.tick(dc.tick(0.5 + state));
            state = fed * 0.98;
            assert!(state.is_finite());
        }
        assert!(state.abs() < 1.0, "loop lari ke {state}");
    }

    #[test]
    fn flush_clears_decayed_state() {
        let mut f = OnePoleLp::with_cutoff(SR, 1_000.0);
        f.y = 1.0e-30;
        f.flush_denormal();
        assert_eq!(f.y, 0.0);

        let mut d = DcBlock::with_rate(SR);
        d.x1 = 1.0e-30;
        d.y1 = -1.0e-30;
        d.flush_denormal();
        assert_eq!(d.x1, 0.0);
        assert_eq!(d.y1, 0.0);
    }

    #[test]
    fn bad_parameters_are_ignored() {
        let mut f = OnePoleLp::with_cutoff(SR, 1_000.0);
        let good = f.coeff();
        f.set_cutoff(0.0, 1_000.0);
        f.set_cutoff(SR, f32::NAN);
        assert_eq!(f.coeff(), good);

        let mut d = DcBlock::with_rate(SR);
        let good = d.coeff();
        d.set_rate(-1.0, 20.0);
        d.set_rate(SR, f32::INFINITY);
        assert_eq!(d.coeff(), good);
    }
}
