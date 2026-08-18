//! Onset Detection Function — mengubah PCM menjadi satu deret "seberapa besar
//! sesuatu MULAI berbunyi di sini", jauh lebih jarang dari sample rate.
//!
//! Kenapa tidak mendeteksi tempo langsung dari PCM: gelombangnya sendiri
//! periodik pada frekuensi nada (ratusan Hz), sementara beat ada di 1–3 Hz.
//! Autokorelasi di atas PCM mentah akan mengunci ke pitch, bukan ke ketukan.
//! Jadi PCM diringkas dulu jadi ODF pada [`ODF_RATE`], baru periodisitasnya
//! dicari (lihat [`crate::tempo`]).
//!
//! Metodenya mengikuti Scheirer (1998) "Tempo and beat analysis of acoustic
//! musical signals": pecah ke beberapa band, ambil envelope tiap band, lalu
//! jumlahkan kenaikannya. Alasan memakai BANYAK band dan bukan satu envelope
//! penuh: kick dan hi-hat sering tidak jatuh bersamaan, dan pada mix yang padat
//! energi bass menutupi transien treble sepenuhnya kalau semuanya dijumlah
//! dulu. Dipisah per band, hi-hat tetap terlihat walau kick sedang menghantam.
//!
//! Dua keputusan yang menentukan kualitas hasilnya:
//!
//! - **Envelope-nya asimetris** (serang cepat, lepas lambat). Envelope simetris
//!   ikut turun secepat ia naik, sehingga selisih antar-frame besar di kedua
//!   arah dan ekor not terbaca seperti onset baru. Dengan pelepasan lambat,
//!   hanya AWAL bunyi yang menghasilkan lonjakan.
//! - **Selisihnya diambil di domain log**, bukan linear. Log berarti yang
//!   diukur adalah perubahan RELATIF, jadi bait yang lirih menyumbang sama
//!   besar dengan chorus yang keras. Tanpa itu, autokorelasi praktis hanya
//!   melihat bagian paling keras dari lagu dan tempo bagian lain terabaikan.
//!
//! Ini jalur OFFLINE. Boleh alokasi, boleh lambat — tapi tetap tanpa `panic!`
//! supaya kegagalan muncul sebagai `None`, bukan sebagai trap di dalam worker.

use alloc::vec;
use alloc::vec::Vec;

use daw_dsp::{Biquad, Coeffs, FilterKind};

/// Laju frame ODF (Hz). 200 dipilih, bukan 100 seperti kebanyakan tulisan:
/// resolusi BPM sebanding dengan jumlah frame per beat. Di 100 Hz, satu frame
/// meleset pada 120 BPM = ±2.4 BPM — terlalu kasar untuk angka yang dipajang
/// dua digit di belakang koma. Di 200 Hz jadi ±1.2 BPM sebelum interpolasi,
/// dan ~±0.1 BPM sesudahnya (lihat `tempo::refine_peak`).
pub const ODF_RATE: f32 = 200.0;

/// Batas antar band (Hz). Enam band, spasi oktaf — pembagian Scheirer.
const BAND_EDGES: [f32; 5] = [200.0, 400.0, 800.0, 1600.0, 3200.0];

/// Jumlah band = jumlah batas + 1 (band terbawah lowpass, teratas highpass).
pub const BANDS: usize = BAND_EDGES.len() + 1;

/// Konstanta waktu serang envelope (detik). Harus lebih pendek dari transien
/// terpendek yang ingin ditangkap (~5 ms untuk hi-hat).
const ATTACK_TAU: f32 = 0.002;

/// Konstanta waktu lepas (detik). Jauh lebih panjang dari serang — itu yang
/// membuat ODF hanya bereaksi pada awal bunyi, bukan pada peluruhannya.
const RELEASE_TAU: f32 = 0.100;

/// Lantai sebelum `ln`. Mencegah `ln(0) = -inf` dan sekaligus menjadi ambang
/// senyap: perubahan di bawah level ini dianggap tidak berarti, jadi noise
/// floor tidak ikut menghasilkan onset palsu.
const ENV_FLOOR: f32 = 1e-6;

/// Hasil ringkasan PCM.
pub struct Odf {
    /// Satu nilai per frame, selalu >= 0.
    pub frames: Vec<f32>,
    /// Laju frame SEBENARNYA. Bukan konstan [`ODF_RATE`]: hop harus bilangan
    /// bulat sample, jadi di 44.1 kHz hasilnya 199.5 Hz, bukan 200. Memakai
    /// nilai nominal di sini akan menggeser BPM ~0.2% — terlihat sebagai
    /// "128.3" untuk lagu yang jelas-jelas 128.
    pub rate: f32,
}

/// Koefisien one-pole dari konstanta waktu.
fn pole(tau_sec: f32, sample_rate: f32) -> f32 {
    let n = tau_sec * sample_rate;
    if n <= 1.0 {
        return 1.0;
    }
    1.0 - libm::expf(-1.0 / n)
}

/// Desain bandpass untuk rentang `[lo, hi]`.
///
/// Q dihitung dari lebar band relatif (`fc / bandwidth`) supaya band benar-benar
/// menutupi rentangnya; Q tetap akan membuat band lebar di frekuensi tinggi
/// bocor ke tetangganya dan band sempit di bawah meninggalkan lubang.
fn band_coeffs(lo: f32, hi: f32, sample_rate: f32) -> Coeffs {
    let fc = libm::sqrtf(lo * hi);
    let q = fc / (hi - lo);
    Coeffs::design(FilterKind::BandPass, sample_rate, fc, q, 0.0)
}

struct BandState {
    coeffs: Coeffs,
    filter: Biquad,
    env: f32,
    /// `ln(env)` pada frame sebelumnya. Disimpan agar selisih log tidak perlu
    /// menyimpan seluruh riwayat envelope.
    prev_ln: f32,
}

/// Bangun ODF dari sumber stereo (atau mono kalau `right` kosong).
///
/// Downmix terjadi di sini, per sample, tanpa membuat buffer mono perantara —
/// pada lagu 5 menit itu 28 MB yang tidak perlu dialokasikan.
pub fn analyze(left: &[f32], right: &[f32], sample_rate: f32) -> Option<Odf> {
    if sample_rate <= 0.0 || left.is_empty() {
        return None;
    }
    let stereo = right.len() == left.len();

    // Hop harus integer: frame ODF diambil tepat tiap `hop` sample.
    let hop = libm::roundf(sample_rate / ODF_RATE) as usize;
    if hop == 0 {
        return None;
    }
    let rate = sample_rate / hop as f32;

    let attack = pole(ATTACK_TAU, sample_rate);
    let release = pole(RELEASE_TAU, sample_rate);

    let mut bands: Vec<BandState> = Vec::with_capacity(BANDS);
    for b in 0..BANDS {
        let coeffs = if b == 0 {
            Coeffs::design(FilterKind::LowPass, sample_rate, BAND_EDGES[0], 0.707, 0.0)
        } else if b == BANDS - 1 {
            Coeffs::design(
                FilterKind::HighPass,
                sample_rate,
                BAND_EDGES[BAND_EDGES.len() - 1],
                0.707,
                0.0,
            )
        } else {
            band_coeffs(BAND_EDGES[b - 1], BAND_EDGES[b], sample_rate)
        };
        bands.push(BandState {
            coeffs,
            filter: Biquad::default(),
            env: 0.0,
            prev_ln: libm::logf(ENV_FLOOR),
        });
    }

    let n_frames = left.len() / hop;
    let mut frames = vec![0.0f32; n_frames];

    let mut i = 0usize;
    for slot in frames.iter_mut() {
        let end = i + hop;
        for n in i..end {
            // SAFETY-by-construction: `end <= n_frames * hop <= left.len()`.
            let x = if stereo {
                0.5 * (left[n] + right[n])
            } else {
                left[n]
            };
            for band in bands.iter_mut() {
                let y = band.filter.tick(x, &band.coeffs);
                let mag = if y < 0.0 { -y } else { y };
                // Asimetris: naik pakai koefisien serang, turun pakai lepas.
                let k = if mag > band.env { attack } else { release };
                band.env += k * (mag - band.env);
            }
        }
        i = end;

        // Satu frame ODF = jumlah KENAIKAN log tiap band. Penurunan dibuang
        // (half-wave rectify): kita mencari awal bunyi, bukan akhirnya.
        let mut flux = 0.0f32;
        for band in bands.iter_mut() {
            let ln_now = libm::logf(band.env + ENV_FLOOR);
            let d = ln_now - band.prev_ln;
            band.prev_ln = ln_now;
            if d > 0.0 {
                flux += d;
            }
        }
        *slot = flux;
    }

    Some(Odf { frames, rate })
}
