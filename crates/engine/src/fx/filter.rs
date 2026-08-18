//! FILTER — sapuan resonan satu knob, gaya rekordbox.
//!
//! Tengah = lewat, putar kiri = lowpass turun, putar kanan = highpass naik.
//!
//! ## Kenapa DUA biquad yang selalu ada, bukan satu yang ditukar jenisnya
//!
//! Bentuk naif `if knob < 0 { LowPass } else { HighPass }` punya diskontinuitas
//! nyata, dan bukan di tempat orang mencarinya. Bukan di frekuensinya —
//! lowpass di 20 kHz dan highpass di 20 Hz sama-sama nyaris rata. Yang patah
//! ada di dua tempat lain:
//!
//! 1. **State filter.** `Biquad` adalah TDF-II: isi `s1`/`s2` maknanya
//!    bergantung koefisien (lihat catatan di `daw_dsp::biquad`). Mengganti
//!    `FilterKind` membuat state bukan-nol ditafsirkan sebagai milik filter
//!    lain — klik, tiap kali knob melewati tengah.
//! 2. **Resonansi.** Pada `Q = 4`, lowpass di 0.49·sr punya puncak resonan
//!    tepat di bawah Nyquist dan highpass di 20 Hz punya puncak di 20 Hz.
//!    Tidak satu pun dari keduanya "lewat".
//!
//! Dengan dua biquad yang selalu terpasang seri, tidak ada cabang, tidak ada
//! pergantian jenis, dan tidak ada state yang direinterpretasi. Diskontinuitasnya
//! bukan "dihindari" — ia tidak ada. Harganya dua biquad permanen, dan itu
//! harga yang benar.
//!
//! ## Kenapa cutoff dihaluskan di ruang log2
//!
//! Penghalusan linear-Hz membuat ujung bawah sapuan merangkak dan ujung atasnya
//! menyentak: 100 Hz per detik tidak terdengar apa-apa di 8 kHz dan terdengar
//! seperti lompatan di 60 Hz. Yang dipersepsi telinga adalah rasio, jadi yang
//! dihaluskan harus logaritmanya.

use daw_dsp::{Biquad, Coeffs, FilterKind, Smoother};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{grid_take, Effect, ParamCtx, GRID};

/// Ujung bawah sapuan lowpass. Di bawah ini yang tersisa hanya rumble.
const LP_BOTTOM: f32 = 30.0;
/// Ujung atas sapuan highpass, sebelum dibatasi Nyquist.
const HP_TOP_MAX: f32 = 18_000.0;
/// Ujung bawah highpass — cukup rendah untuk terasa "tidak menyaring".
const HP_BOTTOM: f32 = 10.0;
/// Q maksimum pada resonansi penuh.
const Q_MAX: f32 = 8.0;
/// Q netral (Butterworth).
const Q_FLAT: f32 = core::f32::consts::FRAC_1_SQRT_2;

/// Kemiringan sapuan.
///
/// Sapuan eksponensial murni menghabiskan seperempat travel pertamanya antara
/// 23 kHz dan 10 kHz — rentang yang pada kebanyakan materi tidak terdengar,
/// sehingga knob terasa mati di awal. Pangkat 0.8 masuk ke pita yang terdengar
/// lebih cepat sambil tetap monoton dan mulus.
const SWEEP_SKEW: f32 = 0.8;

/// Titik knob tempat resonansi mencapai penuh.
const RES_FULL_AT: f32 = 0.5;

static PARAMS: [ParamDesc; 2] = [
    ParamDesc {
        id: "knob",
        name: "FILTER",
        unit: Unit::Linear,
        min: -1.0,
        max: 1.0,
        default: 0.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(25.0),
        flags: pflag::PRIMARY | pflag::BIPOLAR,
        choices: &[],
    },
    ParamDesc {
        id: "resonance",
        name: "RESO",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 0.3,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(25.0),
        flags: pflag::NONE,
        choices: &[],
    },
];

pub struct FilterFx {
    sample_rate: f32,
    /// Cutoff dihaluskan dalam log2(Hz) — lihat catatan modul.
    lp_log2: Smoother,
    hp_log2: Smoother,
    q: Smoother,
    lp_c: Coeffs,
    hp_c: Coeffs,
    lp: [Biquad; 2],
    hp: [Biquad; 2],
    /// Posisi sample absolut, untuk grid refresh.
    n_since: u32,
    primed: bool,
}

#[inline]
fn log2f(x: f32) -> f32 {
    libm::log2f(if x > 1.0e-6 { x } else { 1.0e-6 })
}

impl FilterFx {
    fn lp_top(&self) -> f32 {
        // 0.49·sr adalah batas internal `Coeffs::design`; memakainya di sini
        // membuat ujung sapuan benar-benar "tidak menyaring" alih-alih
        // dipotong diam-diam di dalam desainer koefisien.
        self.sample_rate * 0.49
    }

    fn hp_top(&self) -> f32 {
        let n = self.sample_rate * 0.45;
        if n < HP_TOP_MAX {
            n
        } else {
            HP_TOP_MAX
        }
    }

    /// Frekuensi target untuk posisi knob.
    fn targets(&self, knob: f32, resonance: f32) -> (f32, f32, f32) {
        let k = if knob.is_finite() { knob } else { 0.0 };
        let u = if k < 0.0 { -k } else { 0.0 }; // jumlah lowpass
        let v = if k > 0.0 { k } else { 0.0 }; // jumlah highpass

        let lp_top = self.lp_top();
        let lp = lp_top * libm::powf(LP_BOTTOM / lp_top, libm::powf(u, SWEEP_SKEW));
        let hp_top = self.hp_top();
        let hp = HP_BOTTOM * libm::powf(hp_top / HP_BOTTOM, libm::powf(v, SWEEP_SKEW));

        // Resonansi masuk sebagai KUADRAT jarak dari tengah: masuk linear
        // membuat resonansi terdengar "menyala" tepat saat knob bergerak
        // sedikit dari netral, padahal di situ user justru ingin netral.
        let s = {
            let a = if k < 0.0 { -k } else { k } / RES_FULL_AT;
            if a > 1.0 {
                1.0
            } else {
                a
            }
        };
        let r = if resonance.is_finite() {
            resonance.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let q = Q_FLAT + (Q_MAX - Q_FLAT) * r * s * s;
        (lp, hp, q)
    }

    fn refresh(&mut self) {
        let lp = libm::exp2f(self.lp_log2.current());
        let hp = libm::exp2f(self.hp_log2.current());
        let q = self.q.current();
        self.lp_c = Coeffs::design(FilterKind::LowPass, self.sample_rate, lp, q, 0.0);
        self.hp_c = Coeffs::design(FilterKind::HighPass, self.sample_rate, hp, q, 0.0);
    }
}

impl Effect for FilterFx {
    const DESC: EffectDesc = EffectDesc {
        kind: 2,
        id: "filter",
        name: "FILTER",
        category: Category::Filter,
        params: &PARAMS,
        summary: &[0, 1],
        // Dering Q=8 meluruh jauh di bawah 50 ms.
        max_tail_ms: 50,
        latency_frames: 0,
    };

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        let mut f = FilterFx {
            sample_rate: sr,
            lp_log2: Smoother::new(sr, 25.0, log2f(sr * 0.49)),
            hp_log2: Smoother::new(sr, 25.0, log2f(HP_BOTTOM)),
            q: Smoother::new(sr, 25.0, Q_FLAT),
            lp_c: Coeffs::design(FilterKind::LowPass, sr, sr * 0.49, Q_FLAT, 0.0),
            hp_c: Coeffs::design(FilterKind::HighPass, sr, HP_BOTTOM, Q_FLAT, 0.0),
            lp: [Biquad::new(); 2],
            hp: [Biquad::new(); 2],
            n_since: 0,
            primed: false,
        };
        f.refresh();
        f
    }

    fn prepare(&mut self, p: &ParamCtx<'_>) {
        let (lp, hp, q) = self.targets(p.at_or(0, 0.0), p.at_or(1, 0.3));
        self.lp_log2.set_target(log2f(lp));
        self.hp_log2.set_target(log2f(hp));
        self.q.set_target(q);
        if !self.primed {
            // Blok pertama tidak boleh terdengar sebagai sapuan dari netral ke
            // posisi yang diminta — efek yang baru dipasang harus langsung
            // berada di setelannya.
            self.primed = true;
            self.lp_log2.set_immediate(log2f(lp));
            self.hp_log2.set_immediate(log2f(hp));
            self.q.set_immediate(q);
            self.refresh();
        }
    }

    fn process(&mut self, _mem: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let mut off = 0usize;
        while off < n {
            let (take, refresh) = grid_take(self.n_since, n - off, GRID);
            if refresh {
                self.refresh();
            }
            let end = off + take;
            // Highpass dulu, baru lowpass: urutannya tidak mengubah respons
            // magnitudo, tapi menaruh highpass di depan menjaga tahap kedua dari
            // materi DC yang bisa membuat resonansinya menonjol.
            self.hp[0].process(&mut l[off..end], &self.hp_c);
            self.hp[1].process(&mut r[off..end], &self.hp_c);
            self.lp[0].process(&mut l[off..end], &self.lp_c);
            self.lp[1].process(&mut r[off..end], &self.lp_c);
            for _ in 0..take {
                self.lp_log2.next();
                self.hp_log2.next();
                self.q.next();
            }
            self.n_since = self.n_since.wrapping_add(take as u32);
            off = end;
        }
    }

    fn end_block(&mut self, _mem: &mut [f32]) {
        for b in self.lp.iter_mut().chain(self.hp.iter_mut()) {
            b.flush_denormal();
        }
    }

    fn reset(&mut self, _mem: &mut [f32]) {
        for b in self.lp.iter_mut().chain(self.hp.iter_mut()) {
            b.reset();
        }
        self.n_since = 0;
    }

    fn tail_frames(&self, sample_rate: f32) -> u32 {
        (sample_rate * 0.05) as u32
    }

    /// Dua biquad × dua kanal × ~9 flop.
    fn cost_flops(&self) -> u32 {
        36
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    const SR: f32 = 48_000.0;

    fn run(fx: &mut FilterFx, knob: f32, reso: f32, input: &[f32]) -> Vec<f32> {
        let params = [knob, reso];
        let ctx = ParamCtx::new(&params, SR, SR * 0.5);
        let mut out = Vec::new();
        for chunk in input.chunks(128) {
            let mut l: Vec<f32> = chunk.to_vec();
            let mut r: Vec<f32> = chunk.to_vec();
            fx.prepare(&ctx);
            fx.process(&mut [], &mut l, &mut r);
            fx.end_block(&mut []);
            out.extend_from_slice(&l);
        }
        out
    }

    fn sine(hz: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| libm::sinf(core::f32::consts::TAU * hz * i as f32 / SR) * 0.5)
            .collect()
    }

    fn peak(v: &[f32]) -> f32 {
        v.iter().fold(0.0f32, |a, b| a.max(b.abs()))
    }

    /// Tengah harus benar-benar netral. Kalau tidak, memasang FILTER dan tidak
    /// menyentuhnya sudah mengubah suara.
    #[test]
    fn centre_is_flat_across_the_audible_band() {
        for hz in [100.0f32, 500.0, 1_000.0, 5_000.0, 10_000.0] {
            let mut fx = FilterFx::new(SR, &mut []);
            let out = run(&mut fx, 0.0, 0.3, &sine(hz, 8192));
            let g = peak(&out[4096..]) / 0.5;
            assert!(
                (g - 1.0).abs() < 0.06,
                "{hz} Hz di tengah: gain {g}, seharusnya ~1"
            );
        }
    }

    #[test]
    fn turning_left_removes_highs_and_right_removes_lows() {
        let mut lp = FilterFx::new(SR, &mut []);
        let hi = run(&mut lp, -1.0, 0.0, &sine(8_000.0, 8192));
        assert!(peak(&hi[4096..]) < 0.02, "lowpass penuh masih meloloskan 8 kHz");

        let mut hp = FilterFx::new(SR, &mut []);
        let lo = run(&mut hp, 1.0, 0.0, &sine(60.0, 8192));
        assert!(peak(&lo[4096..]) < 0.02, "highpass penuh masih meloloskan 60 Hz");
    }

    /// INI alasan dua biquad selalu terpasang, bukan satu yang ditukar jenisnya.
    ///
    /// Versi yang menukar `FilterKind` di tengah akan menafsirkan ulang state
    /// TDF-II dan menghasilkan lompatan tepat saat knob melewati nol — klik
    /// yang muncul HANYA saat disapu, jadi tidak terlihat pada tes statis.
    #[test]
    fn sweeping_through_centre_produces_no_discontinuity() {
        let mut fx = FilterFx::new(SR, &mut []);
        // Sinus KONTINU sepanjang seluruh sapuan. Kalau tiap langkah knob
        // diberi potongan yang dimulai ulang dari fase 0, input-nya sendiri
        // yang diskontinu dan tes ini mengukur cacat buatannya sendiri.
        const STEPS: usize = 120;
        const BLOCK: usize = 128;
        let input = sine(440.0, STEPS * BLOCK);

        let mut prev = 0.0f32;
        let mut worst = 0.0f32;
        let mut first = true;
        for step in 0..STEPS {
            let knob = -0.3 + 0.6 * (step as f32 / (STEPS - 1) as f32);
            let slice = &input[step * BLOCK..(step + 1) * BLOCK];
            let out = run(&mut fx, knob, 0.8, slice);
            for v in out {
                if !first {
                    worst = worst.max((v - prev).abs());
                }
                prev = v;
                first = false;
            }
        }
        // Sinus 440 Hz pada 48 kHz bergerak <0.04 per sample; ambang 0.1
        // memberi ruang untuk resonansi tanpa memaafkan klik.
        assert!(worst < 0.1, "lompatan {worst} saat knob melewati tengah");
    }

    /// Resonansi harus benar-benar tidak ada di tengah — kalau tidak, netral
    /// membawa puncak yang tidak diminta siapa pun.
    #[test]
    fn resonance_is_absent_at_centre_regardless_of_the_knob() {
        let fx = FilterFx::new(SR, &mut []);
        let (_, _, q) = fx.targets(0.0, 1.0);
        assert!((q - Q_FLAT).abs() < 1e-6, "Q di tengah = {q}");
        let (_, _, q_half) = fx.targets(-RES_FULL_AT, 1.0);
        assert!(q_half > Q_MAX - 0.01, "Q penuh belum tercapai: {q_half}");
    }

    /// Sample rate rendah tidak boleh membuat rentang sapuan jadi terbalik.
    #[test]
    fn sweep_ranges_stay_ordered_at_every_sample_rate() {
        for sr in [8_000.0f32, 48_000.0, 96_000.0, 384_000.0] {
            let fx = FilterFx::new(sr, &mut []);
            let (lp_open, hp_open, _) = fx.targets(0.0, 0.0);
            let (lp_shut, _, _) = fx.targets(-1.0, 0.0);
            let (_, hp_shut, _) = fx.targets(1.0, 0.0);
            assert!(lp_open > lp_shut, "{sr}: lowpass tidak turun");
            assert!(hp_shut > hp_open, "{sr}: highpass tidak naik");
            assert!(lp_open <= sr * 0.5, "{sr}: lowpass melewati Nyquist");
            assert!(hp_shut <= sr * 0.5, "{sr}: highpass melewati Nyquist");
        }
    }
}
