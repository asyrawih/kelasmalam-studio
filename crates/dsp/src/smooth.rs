//! Parameter smoothing one-pole — anti zipper-noise.
//!
//! Kenapa one-pole dan bukan linear ramp dengan counter: linear ramp butuh
//! `if remaining > 0 { .. } else { cur = target }` di inner loop. Branch itu
//! salah prediksi tepat di akhir ramp, dan di jalur yang dipanggil 48000×/detik
//! per parameter itu terasa. One-pole `cur += (target - cur) * coeff` sama
//! sekali tanpa branch.
//!
//! Konsekuensinya: `cur` tidak pernah *persis* sama dengan `target`. Selisihnya
//! turun eksponensial di bawah -120 dB dalam beberapa milidetik, dan sisanya
//! dibuang oleh [`Smoother::flush_denormal`] sekali per blok. Kalau memang
//! butuh nilai eksak pada sample tertentu (otomasi bertimestamp), pakai
//! sub-block split di engine, bukan mengubah smoother ini.

use crate::{clampf, DENORM_EPS};

/// Smoother eksponensial satu kutub.
#[derive(Clone, Copy, Debug)]
pub struct Smoother {
    cur: f32,
    target: f32,
    coeff: f32,
}

impl Smoother {
    /// `tau_ms` adalah konstanta waktu; ~99% jarak ditempuh dalam `3 * tau`.
    /// Jadi untuk ramp 15 ms yang direkomendasikan docs/02 §2a, pakai
    /// `tau_ms = 5.0`.
    pub fn new(sample_rate: f32, tau_ms: f32, init: f32) -> Self {
        let mut s = Smoother {
            cur: init,
            target: init,
            coeff: 1.0,
        };
        s.set_time(sample_rate, tau_ms);
        s
    }

    /// Hitung ulang koefisien. `coeff = 1 - exp(-1 / (tau_detik * sr))`.
    ///
    /// Bukan RT-path: `expf` hanya dipanggil saat parameter waktu berubah.
    pub fn set_time(&mut self, sample_rate: f32, tau_ms: f32) {
        // Sample rate/tau yang tidak masuk akal tidak boleh menghasilkan NaN
        // di audio thread — lebih baik di-clamp ke perilaku "instan".
        let sr = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        let tau_s = clampf(tau_ms, 0.0, 60_000.0) * 1.0e-3;
        self.coeff = if tau_s <= 0.0 {
            1.0
        } else {
            clampf(1.0 - libm::expf(-1.0 / (tau_s * sr)), 0.0, 1.0)
        };
    }

    /// Set tujuan; nilai sekarang tetap dan meluncur ke sana.
    #[inline(always)]
    pub fn set_target(&mut self, v: f32) {
        self.target = v;
    }

    /// Lompat langsung (dipakai saat seek / init preset — bukan saat user
    /// menggerakkan fader, karena itu justru sumber klik).
    #[inline(always)]
    pub fn set_immediate(&mut self, v: f32) {
        self.cur = v;
        self.target = v;
    }

    /// Nilai sekarang tanpa memajukan state.
    #[inline(always)]
    pub fn current(&self) -> f32 {
        self.cur
    }

    /// Target sekarang.
    #[inline(always)]
    pub fn target(&self) -> f32 {
        self.target
    }

    /// Batas atas lompatan yang boleh dilakukan `flush_denormal`: -80 dB
    /// relatif terhadap target. Di bawah ini tidak ada yang bisa mendengar
    /// diskontinuitasnya.
    const MAX_SNAP_REL: f32 = 1.0e-4;

    /// Ambang "sudah sampai".
    ///
    /// Ambang absolut (mis. `DENORM_EPS`) tidak cukup, dan alasannya numerik,
    /// bukan estetis: one-pole berhenti maju jauh **sebelum** selisihnya jadi
    /// denormal. Begitu `(target - cur) * coeff` lebih kecil dari setengah ULP
    /// `cur`, penjumlahannya membulat kembali ke `cur` dan selisihnya
    /// **berhenti mengecil** selamanya. Titik macet itu ada di sekitar
    /// `|target| * EPSILON / coeff` — untuk target 0.25 dan coeff 0.02 itu
    /// ~7e-7, sepuluh pangkat sebelas lebih besar dari `DENORM_EPS`. Dengan
    /// ambang absolut, `flush_denormal` tidak akan pernah menggigit dan
    /// smoother tidak pernah persis sama dengan target.
    ///
    /// Jadi ambangnya mengikuti titik macet itu, tapi dibatasi
    /// [`Self::MAX_SNAP_REL`] supaya smoother ber-tau sangat panjang (coeff
    /// kecil → titik macet besar) tidak pernah melompat secara terdengar; ia
    /// cukup tidak snap.
    #[inline(always)]
    fn settle_eps(&self) -> f32 {
        let mag = libm::fabsf(self.target);
        let stall = if self.coeff > 0.0 {
            mag * (4.0 * f32::EPSILON / self.coeff)
        } else {
            0.0
        };
        let cap = mag * Self::MAX_SNAP_REL;
        DENORM_EPS + if stall < cap { stall } else { cap }
    }

    /// `true` kalau sudah praktis sampai (dipakai di luar inner loop untuk
    /// melewati pekerjaan, jangan dipakai sebagai branch per sample).
    #[inline(always)]
    pub fn is_settled(&self) -> bool {
        libm::fabsf(self.target - self.cur) <= self.settle_eps()
    }

    /// Satu langkah. Branchless, ini satu-satunya fungsi di jalur per-sample.
    ///
    /// `clippy::should_implement_trait` sengaja dimatikan: namanya ditetapkan
    /// docs/00 (kontrak API), dan `Iterator` tidak cocok — ia menuntut
    /// `Option<f32>` yang berarti satu branch per sample, persis yang
    /// dihindari smoother ini.
    #[allow(clippy::should_implement_trait)]
    #[inline(always)]
    pub fn next(&mut self) -> f32 {
        self.cur += (self.target - self.cur) * self.coeff;
        self.cur
    }

    /// Panggil **1× per blok**.
    ///
    /// `target - cur` mengecil eksponensial dan akhirnya jadi denormal;
    /// operasi aritmetika pada denormal bisa 10–100× lebih lambat di sebagian
    /// mikroarsitektur, dan WASM tidak punya FTZ/DAZ untuk menolongnya
    /// (docs/02 §2b). Menyamakan `cur` ke `target` memutus rantai itu.
    #[inline]
    pub fn flush_denormal(&mut self) {
        if self.is_settled() {
            self.cur = self.target;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_target_within_three_tau() {
        let sr = 48_000.0;
        let mut s = Smoother::new(sr, 5.0, 0.0);
        s.set_target(1.0);
        // 15 ms = 3 * tau  →  1 - exp(-3) ≈ 0.9502
        for _ in 0..(0.015 * sr) as usize {
            s.next();
        }
        assert!(s.current() > 0.94, "cur = {}", s.current());
        // 50 ms harus praktis selesai.
        for _ in 0..(0.05 * sr) as usize {
            s.next();
        }
        assert!((s.current() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn flush_snaps_to_target() {
        let mut s = Smoother::new(48_000.0, 1.0, 0.0);
        s.set_target(0.25);
        for _ in 0..48_000 {
            s.next();
        }
        s.flush_denormal();
        assert!((s.current() - 0.25).abs() < f32::EPSILON);
        assert!(s.is_settled());
    }

    #[test]
    fn immediate_does_not_ramp() {
        let mut s = Smoother::new(48_000.0, 5.0, 0.0);
        s.set_immediate(-3.0);
        assert!((s.next() - (-3.0)).abs() < f32::EPSILON);
    }

    #[test]
    fn zero_tau_is_instant() {
        let mut s = Smoother::new(48_000.0, 0.0, 0.0);
        s.set_target(1.0);
        assert!((s.next() - 1.0).abs() < f32::EPSILON);
    }
}
