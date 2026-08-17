//! Kompresor feed-forward, stereo-linked, gain computer di domain log.
//!
//! Rantai (docs/02 §2b):
//! ```text
//! sidechain ─► detektor (peak|RMS) ─► dB ─► gain computer (soft knee)
//!                                              │ overshoot dB
//!                                              ▼
//!                                   envelope follower (att/rel one-pole)
//!                                              ▼
//!                            gain_lin = 10^((-env + makeup)/20)  ─► × input
//! ```
//!
//! Keputusan desain:
//! 1. **Feed-forward**, bukan feedback: ratio-nya eksak dan perilakunya
//!    terprediksi. Feedback terdengar lebih "vintage" tapi ratio efektifnya
//!    bergantung level dan sulit dibuat sample-accurate.
//! 2. **Gain computer di dB**, bukan linear: ratio dan knee memang didefinisikan
//!    di dB. Di linear butuh `powf` per sample; di log cukup add/mul.
//! 3. **Stereo-linked**: satu detektor untuk kedua channel, jadi image stereo
//!    tidak bergeser saat salah satu sisi lebih keras.
//! 4. **Detektor lewat generic**, bukan `match` di dalam loop — dua fungsi
//!    ter-monomorfisasi supaya inner loop tetap bersih dan bisa di-inline.

use crate::fastmath::{db_to_lin, lin_to_db};
use crate::{clampf, DENORM_EPS};

/// Jenis deteksi sidechain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Detector {
    /// `|x|` — merespons transien. Untuk limiting dan drum.
    Peak,
    /// Rata-rata kuadrat berjendela one-pole ~10 ms lalu `sqrt` — berkorelasi
    /// dengan loudness. Untuk bus dan vokal.
    Rms,
}

/// Parameter kompresor. Semua dalam satuan "manusia" (dB / ms / rasio).
#[derive(Clone, Copy, Debug)]
pub struct CompParams {
    pub threshold_db: f32,
    /// `1.0` = tanpa kompresi, `f32::INFINITY` praktis = limiter.
    pub ratio: f32,
    /// Lebar knee `W` dB, terpusat di threshold.
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    pub detector: Detector,
    /// Kalau `true`, `makeup_db` diabaikan dan dihitung dari threshold/ratio.
    pub auto_makeup: bool,
}

impl Default for CompParams {
    fn default() -> Self {
        CompParams {
            threshold_db: -18.0,
            ratio: 4.0,
            knee_db: 6.0,
            attack_ms: 10.0,
            release_ms: 100.0,
            makeup_db: 0.0,
            detector: Detector::Peak,
            auto_makeup: false,
        }
    }
}

/// Konstanta waktu jendela RMS. 10 ms adalah kompromi standar: cukup panjang
/// untuk berkorelasi dengan loudness, cukup pendek untuk tidak "telat" satu
/// suku kata.
const RMS_WINDOW_MS: f32 = 10.0;

/// Trait detektor internal. Sengaja tidak publik: ia hanya ada supaya
/// [`Compressor::process`] bisa di-monomorfisasi per detektor.
trait DetectorImpl {
    /// Mengembalikan level linear (amplitudo) dari sample stereo.
    fn level(state: &mut Compressor, l: f32, r: f32) -> f32;
}

struct PeakDet;
impl DetectorImpl for PeakDet {
    #[inline(always)]
    fn level(_s: &mut Compressor, l: f32, r: f32) -> f32 {
        // Stereo-linked: ambil yang terkeras.
        let al = libm::fabsf(l);
        let ar = libm::fabsf(r);
        if al > ar {
            al
        } else {
            ar
        }
    }
}

struct RmsDet;
impl DetectorImpl for RmsDet {
    #[inline(always)]
    fn level(s: &mut Compressor, l: f32, r: f32) -> f32 {
        // Mean-square dari kedua channel (link), lalu one-pole, lalu sqrt.
        let ms = (l * l + r * r) * 0.5;
        s.rms_env += (ms - s.rms_env) * s.rms_coeff;
        libm::sqrtf(if s.rms_env > 0.0 { s.rms_env } else { 0.0 })
    }
}

/// Kompresor stereo-linked.
pub struct Compressor {
    sample_rate: f32,

    // Parameter yang sudah diproses ke bentuk siap-pakai.
    threshold_db: f32,
    /// `1/ratio - 1`; negatif. Bentuk ini yang muncul di rumus knee.
    slope: f32,
    knee_db: f32,
    attack_coeff: f32,
    release_coeff: f32,
    makeup_db: f32,
    detector: Detector,

    // State.
    /// Envelope gain reduction dalam dB (selalu >= 0).
    env: f32,
    /// Mean-square terfilter untuk detektor RMS.
    rms_env: f32,
    rms_coeff: f32,
}

impl Compressor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        let mut c = Compressor {
            sample_rate: sr,
            threshold_db: -18.0,
            slope: 0.0,
            knee_db: 0.0,
            attack_coeff: 1.0,
            release_coeff: 1.0,
            makeup_db: 0.0,
            detector: Detector::Peak,
            env: 0.0,
            rms_env: 0.0,
            rms_coeff: one_pole_coeff(RMS_WINDOW_MS, sr),
        };
        c.set_params(&CompParams::default());
        c
    }

    /// Hitung ulang koefisien. Dipanggil saat parameter berubah / per blok —
    /// **tidak** di inner loop (ada `expf` di dalamnya).
    pub fn set_params(&mut self, p: &CompParams) {
        self.threshold_db = clampf(p.threshold_db, -96.0, 24.0);
        // ratio < 1 (ekspansi) tidak didukung di sini; clamp ke 1.
        let ratio = clampf(p.ratio, 1.0, 1_000.0);
        self.slope = 1.0 / ratio - 1.0;
        self.knee_db = clampf(p.knee_db, 0.0, 48.0);
        self.attack_coeff = one_pole_coeff(clampf(p.attack_ms, 0.0, 1_000.0), self.sample_rate);
        self.release_coeff = one_pole_coeff(clampf(p.release_ms, 0.0, 10_000.0), self.sample_rate);
        self.detector = p.detector;
        self.rms_coeff = one_pole_coeff(RMS_WINDOW_MS, self.sample_rate);

        self.makeup_db = if p.auto_makeup {
            // Kompensasi = seberapa banyak sinyal 0 dBFS akan diturunkan.
            // Jadi setelah makeup, puncak skala penuh kembali ke 0 dBFS.
            -self.gain_computer(0.0)
        } else {
            clampf(p.makeup_db, -24.0, 48.0)
        };
    }

    /// Nolkan state (dipakai saat seek/stop supaya envelope lama tidak bocor).
    pub fn reset(&mut self) {
        self.env = 0.0;
        self.rms_env = 0.0;
    }

    /// Gain reduction sekarang, dB positif. Untuk metering di luar blok.
    #[inline]
    pub fn gain_reduction_db(&self) -> f32 {
        self.env
    }

    /// Kurva statis: level input (dB) → **overshoot** (dB, >= 0) yang harus
    /// dibuang. Ini adalah `x - gain_computer(x)`.
    ///
    /// Rumus soft knee lebar `W` di sekitar threshold `T` (docs/02 §2b):
    /// ```text
    /// 2(x-T) < -W     → y = x                                (di bawah knee)
    /// |2(x-T)| <= W   → y = x + (1/R - 1)(x - T + W/2)²/(2W) (kuadratik)
    /// 2(x-T) > W      → y = T + (x - T)/R                    (di atas knee)
    /// ```
    /// Bentuk kuadratik itu dipilih justru karena ia C¹-kontinu di kedua batas
    /// — turunannya 0 di batas bawah dan `1/R` di batas atas, jadi tidak ada
    /// "patahan" yang terdengar saat sinyal melintasi knee.
    #[inline(always)]
    fn gain_computer(&self, x_db: f32) -> f32 {
        let t = self.threshold_db;
        let w = self.knee_db;
        let two_over = 2.0 * (x_db - t);
        if two_over < -w {
            x_db
        } else if two_over <= w {
            // w > 0 dijamin di cabang ini: kalau w == 0, cabang pertama sudah
            // menangkap x < T dan cabang ketiga menangkap x > T; hanya x == T
            // persis yang sampai sini, dan di situ pembilangnya juga 0.
            if w <= 0.0 {
                x_db
            } else {
                let d = x_db - t + w * 0.5;
                x_db + self.slope * d * d / (2.0 * w)
            }
        } else {
            t + (x_db - t) * (self.slope + 1.0)
        }
    }

    /// Kurva statis publik untuk tes & tampilan UI: input dB → output dB
    /// (sudah termasuk makeup gain).
    pub fn static_curve_db(&self, in_db: f32) -> f32 {
        self.gain_computer(in_db) + self.makeup_db
    }

    /// Proses satu blok stereo in-place.
    ///
    /// Mengembalikan **gain reduction maksimum dalam blok ini, dB positif**,
    /// untuk ditulis ke blok METER (docs/01 §1b). Ballistics release UI
    /// (~300 ms) dikerjakan di sisi UI, bukan di sini.
    ///
    /// Kalau panjang `l` dan `r` berbeda, hanya bagian yang sama-sama ada yang
    /// diproses — bukan `panic`, karena ini jalur RT.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> f32 {
        match self.detector {
            Detector::Peak => self.process_with::<PeakDet>(l, r),
            Detector::Rms => self.process_with::<RmsDet>(l, r),
        }
    }

    #[inline]
    fn process_with<D: DetectorImpl>(&mut self, l: &mut [f32], r: &mut [f32]) -> f32 {
        let n = if l.len() < r.len() { l.len() } else { r.len() };
        let mut max_gr = 0.0f32;
        let makeup = self.makeup_db;

        for i in 0..n {
            // Indexing di sini tidak bisa panic: `n <= l.len()` dan
            // `n <= r.len()` sudah dipastikan di atas, dan LLVM biasanya
            // menghapus bound check-nya karena batas loop-nya konstan `n`.
            let (lx, rx) = (l[i], r[i]);

            let level = D::level(self, lx, rx);
            let level_db = lin_to_db(level);
            let overshoot = level_db - self.gain_computer(level_db);
            // gain_computer monoton naik & <= x di atas knee, tapi pembulatan
            // f32 bisa menghasilkan -1e-7; kunci ke >= 0 supaya envelope tidak
            // pernah jadi "gain boost".
            let overshoot = if overshoot > 0.0 { overshoot } else { 0.0 };

            // Envelope one-pole asimetris. Satu branch per sample, tapi
            // polanya panjang (attack atau release bertahan ratusan sample)
            // jadi prediktor cabang hampir selalu benar.
            let c = if overshoot > self.env {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.env += (overshoot - self.env) * c;

            if self.env > max_gr {
                max_gr = self.env;
            }

            let g = db_to_lin(makeup - self.env);
            l[i] = lx * g;
            r[i] = rx * g;
        }

        // Flush denormal 1× per blok: `env` meluruh eksponensial ke 0 saat
        // sinyal senyap dan akan berakhir sebagai denormal kalau dibiarkan.
        if self.env < DENORM_EPS {
            self.env = 0.0;
        }
        if self.rms_env < DENORM_EPS {
            self.rms_env = 0.0;
        }

        max_gr
    }
}

/// `1 - exp(-1 / (t_detik * sr))`. `t = 0` → 1.0 (instan).
#[inline]
fn one_pole_coeff(time_ms: f32, sample_rate: f32) -> f32 {
    let t = time_ms * 1.0e-3;
    if t <= 0.0 {
        1.0
    } else {
        clampf(1.0 - libm::expf(-1.0 / (t * sample_rate)), 0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn comp(ratio: f32, knee: f32, thr: f32) -> Compressor {
        let mut c = Compressor::new(SR);
        c.set_params(&CompParams {
            threshold_db: thr,
            ratio,
            knee_db: knee,
            attack_ms: 0.0,
            release_ms: 0.0,
            makeup_db: 0.0,
            detector: Detector::Peak,
            auto_makeup: false,
        });
        c
    }

    #[test]
    fn hard_knee_static_curve_matches_ratio() {
        let c = comp(4.0, 0.0, -20.0);
        // Di bawah threshold: unity.
        for x in [-60.0f32, -40.0, -25.0] {
            assert!((c.static_curve_db(x) - x).abs() < 1e-3, "x = {x}");
        }
        // Di atas: out = T + (x-T)/R.
        for x in [-16.0f32, -8.0, 0.0, 6.0] {
            let want = -20.0 + (x + 20.0) / 4.0;
            assert!((c.static_curve_db(x) - want).abs() < 1e-3, "x = {x}");
        }
    }

    #[test]
    fn soft_knee_is_c1_continuous() {
        let c = comp(4.0, 12.0, -20.0);
        let (t, w) = (-20.0f32, 12.0f32);
        let lo = t - w / 2.0;
        let hi = t + w / 2.0;
        // Nilai di batas harus sama dengan segmen linear di kiri/kanan.
        assert!((c.static_curve_db(lo) - lo).abs() < 1e-3);
        assert!((c.static_curve_db(hi) - (t + (hi - t) / 4.0)).abs() < 1e-3);
        // Turunan numerik kontinu di batas.
        let d = |x: f32| (c.static_curve_db(x + 1e-3) - c.static_curve_db(x - 1e-3)) / 2e-3;
        assert!((d(lo) - 1.0).abs() < 0.02, "slope at lo = {}", d(lo));
        assert!((d(hi) - 0.25).abs() < 0.02, "slope at hi = {}", d(hi));
    }

    #[test]
    fn soft_knee_is_monotonic() {
        let c = comp(8.0, 18.0, -24.0);
        let mut prev = f32::NEG_INFINITY;
        let mut x = -60.0f32;
        while x <= 12.0 {
            let y = c.static_curve_db(x);
            assert!(y >= prev - 1e-4, "not monotonic at {x}");
            prev = y;
            x += 0.05;
        }
    }

    #[test]
    fn ratio_one_is_transparent() {
        let c = comp(1.0, 6.0, -20.0);
        for x in [-40.0f32, -20.0, 0.0] {
            assert!((c.static_curve_db(x) - x).abs() < 1e-3);
        }
    }

    #[test]
    fn processing_dc_converges_to_static_curve() {
        // Attack/release 0 → envelope langsung; DC 0 dBFS lewat kompresor
        // harus keluar persis di titik kurva statis.
        let mut c = comp(4.0, 0.0, -20.0);
        let mut l = [1.0f32; 512];
        let mut r = [1.0f32; 512];
        let gr = c.process(&mut l, &mut r);
        let out_db = lin_to_db(l[511].abs());
        let want = -20.0 + 20.0 / 4.0; // -15 dB
        assert!((out_db - want).abs() < 0.05, "out = {out_db}");
        assert!((gr - 15.0).abs() < 0.05, "gr = {gr}");
    }

    #[test]
    fn below_threshold_is_untouched() {
        let mut c = comp(4.0, 0.0, -20.0);
        let mut l = [0.01f32; 256]; // -40 dBFS
        let mut r = [0.01f32; 256];
        let gr = c.process(&mut l, &mut r);
        assert!(gr < 1e-3, "gr = {gr}");
        assert!((l[255] - 0.01).abs() < 1e-5);
    }

    #[test]
    fn auto_makeup_restores_full_scale() {
        let mut c = Compressor::new(SR);
        c.set_params(&CompParams {
            threshold_db: -20.0,
            ratio: 4.0,
            knee_db: 0.0,
            attack_ms: 0.0,
            release_ms: 0.0,
            makeup_db: 0.0,
            detector: Detector::Peak,
            auto_makeup: true,
        });
        // Kurva statis di 0 dB harus kembali ke 0 dB.
        assert!(c.static_curve_db(0.0).abs() < 1e-3);
        let mut l = [1.0f32; 256];
        let mut r = [1.0f32; 256];
        c.process(&mut l, &mut r);
        assert!((lin_to_db(l[255]) - 0.0).abs() < 0.05);
    }

    #[test]
    fn stereo_linked_preserves_balance() {
        let mut c = comp(4.0, 0.0, -20.0);
        let mut l = [1.0f32; 256];
        let mut r = [0.5f32; 256];
        c.process(&mut l, &mut r);
        // Rasio L:R harus tetap 2:1.
        assert!((l[255] / r[255] - 2.0).abs() < 1e-4);
    }

    #[test]
    fn rms_detector_settles_and_is_finite() {
        let mut c = Compressor::new(SR);
        c.set_params(&CompParams {
            detector: Detector::Rms,
            ratio: 4.0,
            knee_db: 6.0,
            threshold_db: -20.0,
            attack_ms: 1.0,
            release_ms: 50.0,
            ..Default::default()
        });
        let mut l = [1.0f32; 4096];
        let mut r = [1.0f32; 4096];
        let gr = c.process(&mut l, &mut r);
        assert!(gr.is_finite() && gr > 10.0, "gr = {gr}");
        assert!(l.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn silence_flushes_envelope() {
        let mut c = comp(4.0, 0.0, -20.0);
        let mut l = [1.0f32; 256];
        let mut r = [1.0f32; 256];
        c.process(&mut l, &mut r);
        // release_ms = 0 → langsung turun.
        let mut z1 = [0.0f32; 256];
        let mut z2 = [0.0f32; 256];
        c.process(&mut z1, &mut z2);
        assert_eq!(c.gain_reduction_db(), 0.0);
    }

    #[test]
    fn mismatched_lengths_do_not_panic() {
        let mut c = comp(4.0, 0.0, -20.0);
        let mut l = [1.0f32; 64];
        let mut r = [1.0f32; 16];
        let gr = c.process(&mut l, &mut r);
        assert!(gr.is_finite());
    }
}
