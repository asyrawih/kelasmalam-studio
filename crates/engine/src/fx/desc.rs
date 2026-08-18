//! Deskriptor parameter — **satu-satunya sumber** pengetahuan tentang parameter
//! sebuah efek.
//!
//! Ini yang membuat katalog efek bisa tumbuh tanpa biaya. Tanpa deskriptor,
//! tiap efek baru menuntut: knob di UI, pemetaan nilai↔posisi knob, format
//! penyimpanan, validasi, dan label. Enam efek berarti enam salinan dari
//! kelimanya, dan salinan yang keenam pasti berbeda tipis dari yang pertama.
//!
//! Dengan deskriptor, efek mendeklarasikan parameternya sebagai data statis,
//! dan SEMUA lapisan lain membacanya: UI merakit knob dari `taper` dan `unit`,
//! snapshot menyimpan `Vec<f32>` yang diindeks urutan `params`, dan validasi
//! jadi satu tes generik yang mengiterasi katalog. Menambah efek ke-20 tidak
//! menambah satu baris pun kode UI.
//!
//! Semuanya `&'static str` dan `&'static [..]`: deskriptor hidup di `.rodata`,
//! tidak pernah dialokasi, jadi aman dibaca dari jalur mana pun.

use serde::Serialize;

/// Satuan fisik parameter. Menentukan bagaimana UI memformat nilainya, BUKAN
/// bagaimana engine memakainya.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unit {
    /// Angka polos tanpa satuan.
    Linear,
    /// 0..1 ditampilkan sebagai 0..100%.
    Percent,
    Db,
    Hz,
    Ms,
    /// Kelipatan beat (1/4, 1/2, 1, 2, ...). Nilai kanoniknya tetap ms; ini
    /// menandai parameter yang UI-nya boleh menawarkan tombol SYNC.
    Beats,
    /// Rasio kompresi dan sejenisnya (4:1).
    Ratio,
    Semitones,
    Degrees,
    /// Pilihan diskret; label ada di `ParamDesc::choices`.
    Choice,
}

/// Bagaimana posisi knob 0..1 dipetakan ke nilai.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "k")]
pub enum Taper {
    /// `v = min + t·(max−min)`
    Linear,
    /// `v = min·(max/min)^t`. Untuk frekuensi dan waktu, yang persepsinya
    /// logaritmik. **`min` wajib > 0** — divalidasi `ParamDesc::is_valid`.
    Log,
    /// `v = min + (max−min)·t^k`. `k > 1` memberi resolusi lebih di ujung bawah
    /// tanpa menuntut `min > 0` seperti `Log`.
    Power(f32),
    /// `n` langkah diskret; UI menggambar detent.
    Stepped(u16),
}

/// Bagaimana perubahan nilai diredam supaya tidak terdengar sebagai klik.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "tauMs")]
pub enum Smoothing {
    /// Di-latch di batas blok. Untuk parameter yang mengubah TOPOLOGI (jenis
    /// filter, pembagian sync). Node WAJIB melakukan crossfade internalnya
    /// sendiri saat nilai ini berubah.
    Stepped,
    /// Dihitung ulang di `prepare`, konstan di dalam blok. Untuk koefisien
    /// biquad, yang state-nya memang tidak boleh diubah per sample.
    Block,
    /// `Smoother` satu-kutub per sample, tau dalam milidetik.
    Sample(f32),
}

/// Bendera parameter. Bit, bukan enum, karena bisa gabungan.
pub mod pflag {
    pub const NONE: u8 = 0;
    /// Boleh dinyatakan dalam beat; UI menawarkan tombol SYNC.
    pub const BEAT_SYNC: u8 = 1 << 0;
    /// Rentangnya −x..+x dan UI menggambarnya dari tengah.
    pub const BIPOLAR: u8 = 1 << 1;
    /// Parameter "besar" gaya rekordbox — satu knob raksasa di panel FX.
    pub const PRIMARY: u8 = 1 << 2;
    /// Perubahannya menghasilkan lompatan yang DISENGAJA (SPIRAL). UI tidak
    /// menampilkan peringatan zipper dan node tidak meluncurkan nilainya.
    pub const JUMPS: u8 = 1 << 3;
}

/// Golongan efek, untuk pengelompokan di UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Eq,
    Dynamics,
    Filter,
    TimeBased,
    Modulation,
    Pitch,
}

/// Deskripsi satu parameter.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDesc {
    /// Id stabil. **Ikut tersimpan di file project — jangan pernah diubah.**
    pub id: &'static str,
    /// Label UI, huruf besar mengikuti design ("TIME", "DEPTH").
    pub name: &'static str,
    pub unit: Unit,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub taper: Taper,
    pub smoothing: Smoothing,
    pub flags: u8,
    /// Hanya untuk `Unit::Choice`: label tiap langkah.
    pub choices: &'static [&'static str],
}

impl ParamDesc {
    /// Batasi ke rentang. Ditulis tangan, bukan `f32::clamp`, karena yang
    /// terakhir panic kalau `min > max` — dan `render_block` tidak boleh panic.
    #[inline]
    pub fn clamp(&self, v: f32) -> f32 {
        // NaN jatuh ke default: bentuk `v > min` false untuk NaN, jadi cabang
        // pertama menangkapnya sebelum sempat menyebar ke state efek.
        if !(v > self.min) {
            if v.is_nan() {
                return self.default;
            }
            return self.min;
        }
        if v > self.max {
            self.max
        } else {
            v
        }
    }

    /// Posisi knob `t ∈ [0,1]` → nilai.
    pub fn from_norm(&self, t: f32) -> f32 {
        let t = if !(t > 0.0) {
            0.0
        } else if t > 1.0 {
            1.0
        } else {
            t
        };
        let v = match self.taper {
            Taper::Linear => self.min + t * (self.max - self.min),
            Taper::Log => {
                // `min > 0` dijamin `is_valid`; kalau toh nol, jatuh ke linear
                // daripada menghasilkan −inf.
                if self.min > 0.0 && self.max > 0.0 {
                    self.min * libm::powf(self.max / self.min, t)
                } else {
                    self.min + t * (self.max - self.min)
                }
            }
            Taper::Power(k) => {
                let k = if k > 0.0 { k } else { 1.0 };
                self.min + (self.max - self.min) * libm::powf(t, k)
            }
            Taper::Stepped(n) => {
                if n < 2 {
                    self.min
                } else {
                    let steps = (n - 1) as f32;
                    let i = libm::roundf(t * steps);
                    self.min + (i / steps) * (self.max - self.min)
                }
            }
        };
        self.clamp(v)
    }

    /// Nilai → posisi knob `t ∈ [0,1]`. Kebalikan `from_norm`.
    pub fn to_norm(&self, v: f32) -> f32 {
        let v = self.clamp(v);
        let span = self.max - self.min;
        let t = match self.taper {
            Taper::Linear | Taper::Stepped(_) => {
                if span != 0.0 {
                    (v - self.min) / span
                } else {
                    0.0
                }
            }
            Taper::Log => {
                if self.min > 0.0 && self.max > 0.0 && v > 0.0 && self.max != self.min {
                    libm::logf(v / self.min) / libm::logf(self.max / self.min)
                } else if span != 0.0 {
                    (v - self.min) / span
                } else {
                    0.0
                }
            }
            Taper::Power(k) => {
                let k = if k > 0.0 { k } else { 1.0 };
                if span != 0.0 {
                    libm::powf((v - self.min) / span, 1.0 / k)
                } else {
                    0.0
                }
            }
        };
        if !(t > 0.0) {
            0.0
        } else if t > 1.0 {
            1.0
        } else {
            t
        }
    }

    /// Cek konsistensi. Dipakai tes konformans yang mengiterasi katalog, jadi
    /// deskriptor yang salah ketahuan saat `cargo test`, bukan saat dipakai.
    pub fn is_valid(&self) -> bool {
        if self.id.is_empty() || self.name.is_empty() {
            return false;
        }
        if !self.min.is_finite() || !self.max.is_finite() || !self.default.is_finite() {
            return false;
        }
        if self.min > self.max {
            return false;
        }
        if self.default < self.min || self.default > self.max {
            return false;
        }
        // Taper logaritmik tidak terdefinisi kalau menyentuh atau melewati nol.
        if matches!(self.taper, Taper::Log) && self.min <= 0.0 {
            return false;
        }
        if let Taper::Power(k) = self.taper {
            if !(k > 0.0) || !k.is_finite() {
                return false;
            }
        }
        if let Smoothing::Sample(tau) = self.smoothing {
            if !(tau >= 0.0) || !tau.is_finite() {
                return false;
            }
        }
        // `Choice` tanpa label tidak bisa digambar UI.
        if matches!(self.unit, Unit::Choice) && self.choices.is_empty() {
            return false;
        }
        true
    }
}

/// Deskripsi satu efek.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectDesc {
    /// Diskriminan `FxKind`. **Kontrak serialisasi — jangan digeser.**
    pub kind: u16,
    /// Id stabil, huruf kecil ("echo"). Dipakai JSON.
    pub id: &'static str,
    /// Label UI ("ECHO").
    pub name: &'static str,
    pub category: Category,
    pub params: &'static [ParamDesc],
    /// Indeks parameter yang diringkas di baris rack ("TIME 1/4 · FB 60%").
    pub summary: &'static [usize],
    /// Ekor terpanjang yang mungkin, untuk anggaran keep-alive per-clip.
    pub max_tail_ms: u32,
    /// Latensi tetap yang diperkenalkan. Nol untuk seluruh katalog awal —
    /// `ProcessPlan` belum bisa menyatakan kompensasi delay, jadi efek
    /// berlatensi ditolak sampai bisa.
    pub latency_frames: u32,
}

impl EffectDesc {
    pub fn param(&self, i: usize) -> Option<&'static ParamDesc> {
        self.params.get(i)
    }

    /// Cari indeks parameter dari id-nya. NON-RT (perbandingan string).
    pub fn param_index(&self, id: &str) -> Option<usize> {
        self.params.iter().position(|p| p.id == id)
    }

    pub fn is_valid(&self) -> bool {
        if self.id.is_empty() || self.name.is_empty() {
            return false;
        }
        if !self.params.iter().all(|p| p.is_valid()) {
            return false;
        }
        // Id parameter harus unik: snapshot menyimpan nilai berdasar urutan,
        // tapi UI dan JSON mengacu berdasar id. Duplikat membuat keduanya
        // menunjuk hal yang berbeda tanpa ada yang error.
        for (i, a) in self.params.iter().enumerate() {
            for b in self.params.iter().skip(i + 1) {
                if a.id == b.id {
                    return false;
                }
            }
        }
        self.summary.iter().all(|i| *i < self.params.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIN: ParamDesc = ParamDesc {
        id: "lin",
        name: "LIN",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 0.5,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(20.0),
        flags: pflag::NONE,
        choices: &[],
    };

    const LOG: ParamDesc = ParamDesc {
        id: "log",
        name: "LOG",
        unit: Unit::Hz,
        min: 20.0,
        max: 20_000.0,
        default: 1_000.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    };

    fn log_taper() -> ParamDesc {
        ParamDesc {
            id: "log_t",
            taper: Taper::Log,
            ..LOG
        }
    }

    fn power_taper() -> ParamDesc {
        ParamDesc {
            id: "pow_t",
            taper: Taper::Power(2.0),
            min: -1.0,
            max: 1.0,
            default: 0.0,
            ..LIN
        }
    }

    fn stepped() -> ParamDesc {
        ParamDesc {
            id: "step_t",
            taper: Taper::Stepped(5),
            min: 0.0,
            max: 4.0,
            default: 0.0,
            ..LIN
        }
    }

    /// Pulang-pergi posisi knob → nilai → posisi knob harus mendarat di tempat
    /// yang sama. Kalau tidak, knob "melompat" saat user melepas dan menyentuh
    /// lagi — gejala yang sering disalahartikan sebagai bug UI.
    ///
    /// Hanya untuk taper kontinu. `Stepped` sengaja TIDAK memenuhi ini: dia
    /// membulatkan ke detent terdekat, jadi posisi di antara dua detent memang
    /// tidak boleh kembali ke tempatnya. Sifat yang benar untuk stepped adalah
    /// roundtrip NILAI, diuji terpisah di bawah.
    #[test]
    fn norm_roundtrips_on_continuous_tapers() {
        let cases = [LIN, log_taper(), power_taper()];
        for p in cases.iter() {
            for i in 0..=20 {
                let t = i as f32 / 20.0;
                let v = p.from_norm(t);
                let back = p.to_norm(v);
                assert!(
                    (back - t).abs() < 1e-3,
                    "{}: t={t} -> v={v} -> t={back}",
                    p.id
                );
            }
        }
    }

    /// Untuk taper stepped, nilai di detent harus kembali persis ke dirinya.
    #[test]
    fn stepped_roundtrips_by_value() {
        let p = stepped();
        for i in 0..5 {
            let v = i as f32;
            let back = p.from_norm(p.to_norm(v));
            assert!((back - v).abs() < 1e-4, "detent {v} -> {back}");
        }
    }

    #[test]
    fn endpoints_are_exact() {
        for p in [LIN, log_taper(), power_taper(), stepped()].iter() {
            assert!((p.from_norm(0.0) - p.min).abs() < 1e-4, "{} min", p.id);
            assert!((p.from_norm(1.0) - p.max).abs() < 1e-2, "{} max", p.id);
        }
    }

    /// Taper logaritmik harus terasa logaritmik: titik tengah knob adalah
    /// rerata GEOMETRIK, bukan aritmetik.
    #[test]
    fn log_midpoint_is_geometric_mean() {
        let p = log_taper();
        let mid = p.from_norm(0.5);
        let want = libm::sqrtf(p.min * p.max);
        assert!((mid - want).abs() / want < 1e-3, "mid={mid}, want={want}");
    }

    #[test]
    fn stepped_snaps_to_detents() {
        let p = stepped();
        for i in 0..=20 {
            let v = p.from_norm(i as f32 / 20.0);
            assert!((v - libm::roundf(v)).abs() < 1e-4, "tidak di detent: {v}");
        }
    }

    /// NaN tidak boleh pernah lolos ke state efek.
    #[test]
    fn nan_clamps_to_default_not_to_nan() {
        assert_eq!(LIN.clamp(f32::NAN), LIN.default);
        assert!(LIN.from_norm(f32::NAN).is_finite());
        assert!(LIN.to_norm(f32::NAN).is_finite());
    }

    #[test]
    fn out_of_range_is_clamped_both_ways() {
        assert_eq!(LIN.clamp(-5.0), 0.0);
        assert_eq!(LIN.clamp(5.0), 1.0);
        assert_eq!(LIN.from_norm(-1.0), LIN.min);
        assert_eq!(LIN.from_norm(2.0), LIN.max);
        assert_eq!(LIN.to_norm(-1.0), 0.0);
        assert_eq!(LIN.to_norm(2.0), 1.0);
    }

    #[test]
    fn validation_catches_the_mistakes_it_exists_for() {
        assert!(LIN.is_valid());

        // Taper log yang menyentuh nol.
        let bad = ParamDesc {
            min: 0.0,
            taper: Taper::Log,
            ..LOG
        };
        assert!(!bad.is_valid(), "log dengan min=0 harus ditolak");

        // Default di luar rentang.
        let bad = ParamDesc { default: 9.0, ..LIN };
        assert!(!bad.is_valid());

        // min > max.
        let bad = ParamDesc {
            min: 1.0,
            max: 0.0,
            default: 0.5,
            ..LIN
        };
        assert!(!bad.is_valid());

        // Choice tanpa label.
        let bad = ParamDesc {
            unit: Unit::Choice,
            ..LIN
        };
        assert!(!bad.is_valid());
    }

    #[test]
    fn effect_validation_catches_duplicate_param_ids() {
        static DUP: [ParamDesc; 2] = [LIN, LIN];
        let d = EffectDesc {
            kind: 0,
            id: "x",
            name: "X",
            category: Category::Filter,
            params: &DUP,
            summary: &[0],
            max_tail_ms: 0,
            latency_frames: 0,
        };
        assert!(!d.is_valid(), "id parameter duplikat harus ditolak");
    }

    #[test]
    fn effect_validation_catches_summary_out_of_range() {
        static ONE: [ParamDesc; 1] = [LIN];
        let d = EffectDesc {
            kind: 0,
            id: "x",
            name: "X",
            category: Category::Filter,
            params: &ONE,
            summary: &[5],
            max_tail_ms: 0,
            latency_frames: 0,
        };
        assert!(!d.is_valid());
    }
}
