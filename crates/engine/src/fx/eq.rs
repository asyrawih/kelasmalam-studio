//! EQ parametrik 4-band stereo.

use daw_dsp::{Biquad, Coeffs, FilterKind};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};
use crate::snapshot::{EqBandSettings, EQ_BANDS};

#[inline]
fn filter_kind(v: u8) -> FilterKind {
    match v {
        0 => FilterKind::LowPass,
        1 => FilterKind::HighPass,
        2 => FilterKind::LowShelf,
        3 => FilterKind::HighShelf,
        4 => FilterKind::Peaking,
        5 => FilterKind::Notch,
        6 => FilterKind::AllPass,
        _ => FilterKind::BandPass,
    }
}

/// Label jenis filter. Urutannya WAJIB sama dengan `filter_kind` di atas —
/// indeksnya yang tersimpan, bukan namanya.
const KIND_CHOICES: &[&str] = &[
    "LOWPASS",
    "HIGHPASS",
    "LOWSHELF",
    "HIGHSHELF",
    "PEAKING",
    "NOTCH",
    "ALLPASS",
    "BANDPASS",
];

const ON_OFF: &[&str] = &["OFF", "ON"];

// Empat parameter per band ditulis lewat const fn supaya dua puluh deklarasi
// tidak jadi dua ratus baris yang saling menyalin — dan supaya mengubah
// rentang satu jenis parameter cukup di satu tempat.
const fn p_kind(id: &'static str, name: &'static str) -> ParamDesc {
    ParamDesc {
        id,
        name,
        unit: Unit::Choice,
        min: 0.0,
        max: 7.0,
        default: 4.0, // Peaking — sama dengan EqBandSettings::default()
        taper: Taper::Stepped(8),
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: KIND_CHOICES,
    }
}

const fn p_freq(id: &'static str, name: &'static str) -> ParamDesc {
    ParamDesc {
        id,
        name,
        unit: Unit::Hz,
        min: 20.0,
        max: 20_000.0,
        default: 1_000.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    }
}

const fn p_q(id: &'static str, name: &'static str) -> ParamDesc {
    ParamDesc {
        id,
        name,
        unit: Unit::Linear,
        min: 0.1,
        max: 40.0,
        default: 0.707,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    }
}

const fn p_gain(id: &'static str, name: &'static str) -> ParamDesc {
    ParamDesc {
        id,
        name,
        unit: Unit::Db,
        min: -24.0,
        max: 24.0,
        default: 0.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::BIPOLAR,
        choices: &[],
    }
}

const fn p_on(id: &'static str, name: &'static str) -> ParamDesc {
    ParamDesc {
        id,
        name,
        unit: Unit::Choice,
        min: 0.0,
        max: 1.0,
        default: 0.0,
        taper: Taper::Stepped(2),
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: ON_OFF,
    }
}

/// Lima parameter per band, empat band. Urutannya adalah kontrak: snapshot
/// menyimpan nilai berdasarkan indeks di sini.
static EQ_PARAMS: [ParamDesc; 20] = [
    p_kind("b1_kind", "1 TYPE"),
    p_freq("b1_freq", "1 FREQ"),
    p_q("b1_q", "1 Q"),
    p_gain("b1_gain", "1 GAIN"),
    p_on("b1_on", "1 ON"),
    p_kind("b2_kind", "2 TYPE"),
    p_freq("b2_freq", "2 FREQ"),
    p_q("b2_q", "2 Q"),
    p_gain("b2_gain", "2 GAIN"),
    p_on("b2_on", "2 ON"),
    p_kind("b3_kind", "3 TYPE"),
    p_freq("b3_freq", "3 FREQ"),
    p_q("b3_q", "3 Q"),
    p_gain("b3_gain", "3 GAIN"),
    p_on("b3_on", "3 ON"),
    p_kind("b4_kind", "4 TYPE"),
    p_freq("b4_freq", "4 FREQ"),
    p_q("b4_q", "4 Q"),
    p_gain("b4_gain", "4 GAIN"),
    p_on("b4_on", "4 ON"),
];

/// EQ 4-band stereo. Koefisien di-hitung ULANG PER BLOK, tidak per sample:
/// TDF-II menyimpan akumulator yang maknanya bergantung koefisien, jadi
/// mengubahnya tiap sample merusak sifat numeriknya (docs/02 §2b). Untuk sweep
/// cepat, blok dipecah di batas event (§2c).
pub struct Eq4 {
    coeffs: [Coeffs; EQ_BANDS],
    enabled: [bool; EQ_BANDS],
    l: [Biquad; EQ_BANDS],
    r: [Biquad; EQ_BANDS],
    dirty: bool,
    settings: [EqBandSettings; EQ_BANDS],
    sample_rate: f32,
}

impl Eq4 {
    pub fn set_band(&mut self, i: usize, s: EqBandSettings) {
        if i < EQ_BANDS {
            self.settings[i] = s;
            self.dirty = true;
        }
    }

    pub fn set_all(&mut self, s: &[EqBandSettings; EQ_BANDS]) {
        self.settings = *s;
        self.dirty = true;
    }

    /// Dipanggil di awal `process`, di luar inner loop.
    ///
    /// Sengaja TIDAK dipindah ke `prepare`. Setting EQ datang lewat command
    /// ring yang ber-timestamp, dan blok dipecah jadi sub-blok tepat di event
    /// itu supaya perubahannya sample-accurate. Kalau refresh-nya ditunda ke
    /// batas blok penuh, perubahan di tengah blok tertunda sampai 1024 sample
    /// pada render offline tapi cuma 128 sample pada realtime — dan hasil
    /// keduanya berhenti identik.
    #[inline]
    fn refresh(&mut self) {
        if !self.dirty {
            return;
        }
        for i in 0..EQ_BANDS {
            let s = self.settings[i];
            self.enabled[i] = s.enabled;
            if s.enabled {
                self.coeffs[i] = Coeffs::design(
                    filter_kind(s.kind),
                    self.sample_rate,
                    s.freq_hz,
                    s.q,
                    s.gain_db,
                );
            }
        }
        self.dirty = false;
    }
}

impl Effect for Eq4 {
    const DESC: EffectDesc = EffectDesc {
        kind: 0,
        id: "eq4",
        name: "EQ",
        category: Category::Eq,
        params: &EQ_PARAMS,
        summary: &[1, 3],
        max_tail_ms: 0,
        latency_frames: 0,
    };

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        // `from_fn` dipakai daripada `[expr; N]` supaya tidak menuntut `Copy`
        // pada tipe dari daw-dsp (kontrak tidak menjanjikannya).
        Eq4 {
            coeffs: core::array::from_fn(|_| Coeffs {
                b0: 1.0,
                b1: 0.0,
                b2: 0.0,
                a1: 0.0,
                a2: 0.0,
            }),
            enabled: [false; EQ_BANDS],
            l: core::array::from_fn(|_| Biquad::new()),
            r: core::array::from_fn(|_| Biquad::new()),
            dirty: true,
            settings: [EqBandSettings::default(); EQ_BANDS],
            sample_rate,
        }
    }

    /// Kosong sampai jalur param block hidup (Fase 3). Setting EQ hari ini
    /// datang dari snapshot lewat `set_all`, dan menimpanya dengan nol dari
    /// konteks kosong akan mematikan seluruh EQ.
    fn prepare(&mut self, _p: &ParamCtx<'_>) {}

    #[inline]
    fn process(&mut self, _mem: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        self.refresh();
        for i in 0..EQ_BANDS {
            if self.enabled[i] {
                self.l[i].process(l, &self.coeffs[i]);
                self.r[i].process(r, &self.coeffs[i]);
            }
        }
    }

    // Sengaja TIDAK membuang denormal di sini. Pembuangan per batas blok
    // terjadi pada posisi sample yang berbeda antara render 128-frame dan
    // 1024-frame, jadi hasilnya berhenti bit-identical — itu sebabnya
    // `null_test_block_size_invariance_with_fx` yang ada bertoleransi 1e-6
    // alih-alih eksak. Pembuangannya akan dipasang di grid sample absolut
    // bersamaan dengan refresh koefisien, yang justru MEMPERKETAT tes itu.

    fn reset(&mut self, _mem: &mut [f32]) {
        for b in self.l.iter_mut().chain(self.r.iter_mut()) {
            b.reset();
        }
    }

    /// Empat band × dua kanal × ~9 flop per sample TDF-II.
    fn cost_flops(&self) -> u32 {
        72
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_declares_five_params_per_band() {
        assert_eq!(Eq4::DESC.params.len(), EQ_BANDS * 5);
        assert!(Eq4::DESC.is_valid());
    }

    /// Default deskriptor harus cocok dengan apa yang benar-benar dipasang
    /// engine di instance baru. Kalau berbeda, UI menampilkan nilai yang tidak
    /// pernah didengar user.
    #[test]
    fn descriptor_defaults_match_engine_defaults() {
        let d = EqBandSettings::default();
        assert_eq!(Eq4::DESC.params[0].default, d.kind as f32);
        assert_eq!(Eq4::DESC.params[1].default, d.freq_hz);
        assert_eq!(Eq4::DESC.params[2].default, d.q);
        assert_eq!(Eq4::DESC.params[3].default, d.gain_db);
        assert_eq!(Eq4::DESC.params[4].default, if d.enabled { 1.0 } else { 0.0 });
    }

    /// Label jenis filter harus sejajar dengan pemetaan `filter_kind`.
    #[test]
    fn kind_choices_line_up_with_the_mapping() {
        assert_eq!(KIND_CHOICES.len(), 8);
        assert_eq!(filter_kind(0), FilterKind::LowPass);
        assert_eq!(filter_kind(4), FilterKind::Peaking);
        assert_eq!(filter_kind(7), FilterKind::BandPass);
        assert_eq!(Eq4::DESC.params[0].max, (KIND_CHOICES.len() - 1) as f32);
    }

    /// Band yang tidak diaktifkan harus melewatkan sinyal apa adanya.
    #[test]
    fn disabled_bands_are_bit_transparent() {
        let mut eq = Eq4::new(48_000.0, &mut []);
        let src: [f32; 64] = core::array::from_fn(|i| (i as f32) * 0.01 - 0.3);
        let mut l = src;
        let mut r = src;
        eq.process(&mut [], &mut l, &mut r);
        assert_eq!(l, src);
        assert_eq!(r, src);
    }

    /// Memecah blok jadi sub-blok harus menghasilkan bit yang sama — itu yang
    /// membuat render 128-frame dan 1024-frame identik.
    #[test]
    fn processing_is_resumable_across_sub_blocks() {
        let band = EqBandSettings {
            kind: 4,
            freq_hz: 1_000.0,
            q: 1.0,
            gain_db: 6.0,
            enabled: true,
        };
        let src: [f32; 256] = core::array::from_fn(|i| libm::sinf(i as f32 * 0.1) * 0.5);

        let mut whole = Eq4::new(48_000.0, &mut []);
        whole.set_band(0, band);
        let mut wl = src;
        let mut wr = src;
        whole.process(&mut [], &mut wl, &mut wr);

        let mut split = Eq4::new(48_000.0, &mut []);
        split.set_band(0, band);
        let mut sl = src;
        let mut sr_ = src;
        for c in 0..4 {
            let a = c * 64;
            let b = a + 64;
            split.process(&mut [], &mut sl[a..b], &mut sr_[a..b]);
        }

        assert_eq!(wl, sl, "kiri berbeda saat blok dipecah");
        assert_eq!(wr, sr_, "kanan berbeda saat blok dipecah");
    }
}
