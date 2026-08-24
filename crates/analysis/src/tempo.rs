//! Dari ODF ke satu angka BPM.
//!
//! Inti masalahnya bukan "cari periode" — autokorelasi menyelesaikan itu dalam
//! sepuluh baris. Masalahnya adalah **ambiguitas oktaf**: lagu 128 BPM juga
//! sangat periodik pada 64 dan 256 BPM, dan autokorelasi mentah kerap memilih
//! yang salah. Dua mekanisme di bawah ini yang menanganinya, dan keduanya perlu:
//!
//! 1. **Sisir harmonik.** Skor sebuah periode `p` bukan `acf(p)` saja, melainkan
//!    `acf(p) + ½·acf(2p) + ¼·acf(3p) + ⅛·acf(4p)`. Periode yang benar punya
//!    puncak di semua kelipatannya; setengahnya (tempo dobel) jatuh di LEMBAH
//!    autokorelasi, jadi skornya anjlok. Ini mematikan kesalahan dobel-tempo.
//! 2. **Prior tempo.** Sisir tidak bisa membedakan `p` dari `2p` — keduanya
//!    punya puncak di semua kelipatan `2p`. Yang membedakan adalah bahwa
//!    manusia mendengar ketukan di sekitar 120 BPM (kurva resonansi
//!    Parncutt/Moelants). Skor dikalikan Gauss-log yang berpusat di sana.
//!
//! Angka yang dikembalikan sengaja disertai [`BpmEstimate::confidence`]. Deteksi
//! tempo pada materi tanpa ketukan jelas (pad, ambient, rekaman bicara) TIDAK
//! bisa benar, dan mengembalikan "94.7 BPM" tanpa keterangan untuk rekaman
//! podcast adalah berbohong dengan presisi. UI wajib membedakan keduanya.

use alloc::vec;
use alloc::vec::Vec;

use crate::odf::Odf;

/// Batas bawah pencarian (BPM). Di bawah ini yang terdeteksi hampir selalu
/// setengah dari tempo sebenarnya, bukan lagu yang benar-benar selambat itu.
pub const BPM_MIN: f32 = 60.0;

/// Batas atas pencarian (BPM).
pub const BPM_MAX: f32 = 200.0;

/// Pusat prior tempo. 120 BPM ≈ tempo yang paling sering dipilih orang saat
/// diminta mengetuk mengikuti musik.
pub const PREFERRED_BPM: f32 = 120.0;

/// Lebar prior dalam satuan log-natural. 0.55 berarti 100 dan 144 BPM masih
/// bernilai ~85% dari puncaknya, sedangkan 60 dan 240 turun ke ~30% — cukup
/// untuk memutus seri oktaf, tidak cukup untuk memaksa lagu 170 BPM jadi 85.
const PRIOR_SIGMA: f32 = 0.55;

/// Bobot sisir untuk kelipatan periode ke-1..4.
const COMB_WEIGHTS: [f32; 4] = [1.0, 0.5, 0.25, 0.125];

/// Kekuatan hukuman "grid ini melewatkan onset".
///
/// Sisir dan prior BERSAMA-SAMA masih tidak bisa memisahkan `p` dari `2p`:
/// keduanya punya puncak di setiap kelipatan `2p`, dan 85 vs 170 BPM kebetulan
/// simetris persis terhadap pusat prior (√(85·170) = 120.2) sehingga prior pun
/// tidak memihak. Yang memisahkan keduanya hanya satu pertanyaan: kalau `p`
/// benar, seharusnya TIDAK ada ketukan di tengah-tengahnya. Jadi kandidat
/// dihukum sebanding dengan kekuatan autokorelasi di `p/2`.
///
/// Hukumannya ditimbang oleh [`prior`] pada tempo GANDA. Alasannya: kalau
/// `2·bpm` sendiri bukan tempo yang masuk akal bagi manusia, puncak di `p/2`
/// itu subdivisi (1/8, 1/16), bukan ketukan — dan menghukum kandidat karena
/// punya subdivisi akan membuat setiap tempo kalah dari kelipatannya.
///
/// Timbangan itu HARUS mulus terhadap lag. Versi pertama memakai gerbang keras
/// ("hukum hanya kalau `p/2` di dalam rentang pencarian"), dan karena `p/2`
/// dihitung dengan pembagian integer, gerbang itu jadi fungsi tangga: lag 119
/// lolos tanpa hukuman sementara lag 120 kena. Puncak skor lantas bergeser satu
/// frame dan interpolasi parabola justru memperkuat pergeserannya — 100 BPM
/// terbaca 100.63. Prior mulus di mana-mana, jadi tidak ada tangga yang tersisa.
const SUBDIVISION_PENALTY: f32 = 1.0;

/// Lebar timbangan hukuman subdivisi, juga dalam log-natural.
///
/// Lebih sempit dari [`PRIOR_SIGMA`] dan itu disengaja. Yang ditanya di sini
/// bukan "seberapa disukai tempo ini" melainkan "mungkinkah 2×bpm ini benar-
/// benar sebuah KETUKAN". Ekor prior 0.55 masih bernilai 0.17 di 360 BPM —
/// cukup untuk menghukum kandidat 180 BPM karena punya hi-hat 1/8, dan itu
/// membuat 180 kalah dari 120 (kesalahan triplet). Pada 0.39, 360 BPM turun ke
/// 0.03 sementara 170 BPM (kasus yang memang harus dihukum) tetap 0.67.
const SUBDIVISION_SIGMA: f32 = 0.39;

/// Panjang jendela detrend (detik). Harus lebih panjang dari satu bar (~2 s di
/// 120 BPM 4/4) supaya rata-rata bergeraknya tidak ikut memakan ketukan itu
/// sendiri, tapi cukup pendek untuk mengikuti perubahan dinamika lagu.
const DETREND_SEC: f32 = 1.5;

/// Materi terpendek yang masih pantas dianalisis. Di bawah ini jumlah ketukan
/// yang bisa diamati terlalu sedikit untuk membedakan periodisitas dari
/// kebetulan — lebih baik mengaku tidak tahu.
pub const MIN_SECONDS: f32 = 8.0;

/// Jarak relatif di sekitar puncak yang dianggap "puncak yang sama" saat
/// mencari pesaing terdekat.
const PEAK_SKIRT: f32 = 0.08;

/// Lebar penghalusan ODF sebelum autokorelasi, dalam frame (σ Gauss).
///
/// Tanpa ini puncak autokorelasi hanya selebar satu-dua frame, sementara skor
/// cuma dievaluasi di lag BULAT. Periode sejati yang jatuh di tengah dua lag
/// (170 BPM di 200 Hz = 70.59 frame) karenanya diukur di LERENG puncaknya,
/// bukan di puncaknya — dan kerugian setengah frame itu porsinya makin besar
/// untuk tempo cepat. Akibatnya sistematis: tempo cepat kalah dari kelipatannya
/// bukan karena musiknya, melainkan karena cara kita mencuplik.
///
/// 1.5 frame = 7.5 ms: cukup melebarkan puncak sehingga lag bulat mana pun
/// menangkapnya, jauh lebih pendek dari jarak antar-onset musik mana pun
/// (~150 ms di 200 BPM 1/8), jadi tidak ada onset yang menyatu.
const ODF_SMOOTH_SIGMA: f32 = 1.5;

#[derive(Clone, Debug, PartialEq)]
pub struct BpmEstimate {
    /// Tempo dalam ketukan per menit.
    pub bpm: f32,
    /// 0..1. Rata-rata geometrik dari dua hal yang berbeda dan sama pentingnya:
    /// berapa banyak variasi ODF yang dijelaskan oleh periode ini, dan seberapa
    /// menonjol puncaknya dibanding kandidat lain. Satu saja tidak cukup —
    /// ODF yang sangat periodik bisa punya dua kandidat sama kuat, dan puncak
    /// yang sangat menonjol bisa berdiri di atas ODF yang isinya nyaris nol.
    ///
    /// SKALANYA TIDAK LINEAR TERHADAP INTUISI. Diukur pada materi nyata:
    /// derau putih 0.015, pad ambient 0.017, burst mirip bicara 0.046,
    /// dua lagu nyata 0.19 dan 0.22, groove sintetis 0.45–0.60. Musik nyata
    /// mengandung banyak isi ODF yang bukan ketukan, jadi 0.2 sudah berarti
    /// "hampir pasti benar" — bukan "ragu". Konsumen memakai ambang ~0.1
    /// (lihat `TEMPO_UNCERTAIN` di sisi web).
    pub confidence: f32,
    /// Detik dari awal materi ke ketukan pertama yang terdeteksi. Berguna untuk
    /// beatgrid; belum dipakai UI.
    pub beat_offset_sec: f32,
    /// Posisi beat individual hasil tracking, dalam detik dari awal asset.
    pub beat_times_sec: Vec<f32>,
}

/**
 * Pilih rangkaian beat individual yang menyeimbangkan onset lokal dan
 * kontinuitas tempo. Bentuknya mengikuti dynamic-programming Ellis (2007):
 * setiap frame memilih pendahulu terbaik di sekitar satu periode sebelumnya,
 * dengan penalti log-ratio untuk jarak yang terlalu pendek/panjang.
 */
fn track_beats(odf: &[f32], period: f32, rate: f32) -> Vec<f32> {
    if odf.is_empty() || !period.is_finite() || period <= 1.0 || !rate.is_finite() || rate <= 0.0 {
        return Vec::new();
    }
    let peak = odf.iter().copied().fold(0.0_f32, f32::max);
    if !peak.is_finite() || peak <= 0.0 {
        return Vec::new();
    }
    let n = odf.len();
    let min_step = libm::floorf(period * 0.5).max(1.0) as usize;
    let max_step = libm::ceilf(period * 1.5) as usize;
    let mut score = vec![0.0_f32; n];
    let mut prev = vec![usize::MAX; n];

    for i in 0..n {
        let local = odf[i] / peak;
        let lo = i.saturating_sub(max_step);
        let hi = i.saturating_sub(min_step);
        let mut best = 0.0_f32;
        let mut best_j = usize::MAX;
        if i >= min_step {
            for (j, prior_score) in score.iter().enumerate().take(hi + 1).skip(lo) {
                let ratio = (i - j) as f32 / period;
                let log_ratio = libm::logf(ratio);
                let candidate = *prior_score - 4.0 * log_ratio * log_ratio;
                if candidate > best {
                    best = candidate;
                    best_j = j;
                }
            }
        }
        score[i] = local + best;
        prev[i] = best_j;
    }

    // Akhiri di dua periode terakhir agar jalur meliputi materi, bukan berhenti
    // pada chorus keras di tengah lagu.
    let tail = (period * 2.0) as usize;
    let start = n.saturating_sub(tail.max(1));
    let mut at = start;
    for i in start..n {
        if score[i] > score[at] {
            at = i;
        }
    }
    let mut frames = Vec::new();
    loop {
        frames.push(at);
        let p = prev[at];
        if p == usize::MAX || p >= at {
            break;
        }
        at = p;
    }
    frames.reverse();
    frames
        .into_iter()
        .map(|frame| frame as f32 / rate)
        .collect()
}

/// Kurangi tren lambat lalu buang bagian negatifnya.
///
/// Tanpa ini, autokorelasi didominasi komponen DC ODF: hasilnya kurva segitiga
/// besar yang menurun monoton, dan puncak ketukan yang sebenarnya hanya jadi
/// riak kecil di atasnya. Rata-rata bergerak dijumlah di `f64` karena `f32`
/// kehilangan presisi pada penjumlahan berantai puluhan ribu suku.
fn detrend(v: &[f32], win: usize) -> Vec<f32> {
    let n = v.len();
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + v[i] as f64;
    }
    let half = win / 2;
    let mut out = vec![0.0f32; n];
    for (i, slot) in out.iter_mut().enumerate() {
        let a = i.saturating_sub(half);
        let b = (i + half + 1).min(n);
        let mean = ((prefix[b] - prefix[a]) / (b - a) as f64) as f32;
        let d = v[i] - mean;
        *slot = if d > 0.0 { d } else { 0.0 };
    }
    out
}

/// Konvolusi Gauss simetris, radius 3σ. Tepi ditangani dengan menjepit indeks
/// (bukan nol-padding) supaya awal dan akhir materi tidak jadi lembah palsu.
fn smooth_gauss(v: &[f32], sigma: f32) -> Vec<f32> {
    let radius = libm::ceilf(3.0 * sigma) as usize;
    let mut kernel = vec![0.0f32; 2 * radius + 1];
    let mut sum = 0.0f32;
    for (i, k) in kernel.iter_mut().enumerate() {
        let d = i as f32 - radius as f32;
        *k = libm::expf(-0.5 * (d / sigma) * (d / sigma));
        sum += *k;
    }
    for k in kernel.iter_mut() {
        *k /= sum;
    }
    let n = v.len();
    let mut out = vec![0.0f32; n];
    for (i, slot) in out.iter_mut().enumerate() {
        let mut acc = 0.0f32;
        for (j, k) in kernel.iter().enumerate() {
            let idx = (i + j).saturating_sub(radius).min(n - 1);
            acc += k * v[idx];
        }
        *slot = acc;
    }
    out
}

/// Autokorelasi tak-bias untuk lag `0..=max_lag`.
///
/// Pembaginya `n - lag`, bukan `n`: dengan pembagi tetap, nilai pada lag besar
/// otomatis mengecil hanya karena sukunya lebih sedikit, dan itu membuat tempo
/// lambat kalah sebelum dinilai.
fn autocorr(x: &[f32], max_lag: usize) -> Vec<f32> {
    let n = x.len();
    let mut out = vec![0.0f32; max_lag + 1];
    for (lag, slot) in out.iter_mut().enumerate() {
        if lag >= n {
            break;
        }
        let mut acc = 0.0f64;
        for i in 0..(n - lag) {
            acc += (x[i] as f64) * (x[i + lag] as f64);
        }
        *slot = (acc / (n - lag) as f64) as f32;
    }
    out
}

/// Gauss di ruang log BPM, berpusat di [`PREFERRED_BPM`].
fn log_gauss(bpm: f32, sigma: f32) -> f32 {
    let z = libm::logf(bpm / PREFERRED_BPM) / sigma;
    libm::expf(-0.5 * z * z)
}

/// Bobot preferensi tempo.
fn prior(bpm: f32) -> f32 {
    log_gauss(bpm, PRIOR_SIGMA)
}

/// Interpolasi parabola pada tiga titik di sekitar puncak.
///
/// Puncak sejati hampir tidak pernah jatuh tepat di indeks bulat. Tanpa ini
/// resolusinya terkunci pada satu frame ODF (±1.2 BPM di 120 BPM); dengan ini
/// turun ke ~±0.1 BPM, yang membedakan "128" dari "127.6".
fn refine_peak(scores: &[f32], i: usize) -> f32 {
    if i == 0 || i + 1 >= scores.len() {
        return i as f32;
    }
    let (ym, y0, yp) = (scores[i - 1], scores[i], scores[i + 1]);
    let denom = ym - 2.0 * y0 + yp;
    // denom >= 0 berarti titik ini bukan maksimum lokal parabola — jangan
    // memaksakan koreksi yang arahnya tidak bisa dipercaya.
    if denom >= -1e-12 {
        return i as f32;
    }
    let delta = 0.5 * (ym - yp) / denom;
    if delta.abs() > 1.0 {
        return i as f32;
    }
    i as f32 + delta
}

/// Cari fase ketukan: geseran yang membuat jumlah ODF di titik-titik ketukan
/// paling besar. Indeksnya dihitung dari periode PECAHAN lalu dibulatkan per
/// ketukan, bukan dengan menambah periode bulat berulang — kalau tidak,
/// selisih setengah frame per ketukan menumpuk jadi puluhan frame di akhir lagu.
fn beat_phase(odf: &[f32], period: f32) -> usize {
    let p_int = libm::roundf(period) as usize;
    if p_int == 0 {
        return 0;
    }
    let n = odf.len();
    let mut best_phi = 0usize;
    let mut best = f32::NEG_INFINITY;
    for phi in 0..p_int {
        let mut sum = 0.0f32;
        let mut k = 0usize;
        loop {
            let idx = libm::roundf(phi as f32 + k as f32 * period) as usize;
            if idx >= n {
                break;
            }
            sum += odf[idx];
            k += 1;
        }
        if sum > best {
            best = sum;
            best_phi = phi;
        }
    }
    best_phi
}

/// Perkirakan tempo dari ODF. `None` kalau materinya terlalu pendek atau tidak
/// mengandung variasi sama sekali (senyap).
pub fn estimate(odf: &Odf) -> Option<BpmEstimate> {
    let rate = odf.rate;
    let n = odf.frames.len();
    if rate <= 0.0 || (n as f32) / rate < MIN_SECONDS {
        return None;
    }

    let win = ((DETREND_SEC * rate) as usize).max(3) | 1;
    let d = detrend(&odf.frames, win);

    // Autokorelasi memakai versi HALUS; fase ketukan tetap memakai `d` yang
    // tajam, karena di sana yang dicari justru posisi persis onset.
    let smooth = smooth_gauss(&d, ODF_SMOOTH_SIGMA);
    let mean = smooth.iter().map(|v| *v as f64).sum::<f64>() / n as f64;
    let x: Vec<f32> = smooth.iter().map(|v| (*v as f64 - mean) as f32).collect();

    let lag_min = libm::floorf(rate * 60.0 / BPM_MAX).max(2.0) as usize;
    let lag_max = libm::ceilf(rate * 60.0 / BPM_MIN) as usize;
    if lag_max >= n / 2 {
        // Kurang dari dua periode terlambat pada tempo paling lambat: apa pun
        // yang keluar dari autokorelasi di sini adalah artefak panjang buffer.
        return None;
    }

    // Sisir butuh acf sampai 4× lag terpanjang. Kalau materinya tidak sepanjang
    // itu, harmonik yang tidak tersedia dilewati (lihat loop skor) — bukan
    // dianggap nol, karena nol akan menghukum tempo lambat secara sistematis.
    let acf_len = (lag_max * COMB_WEIGHTS.len()).min(n / 2);
    let acf = autocorr(&x, acf_len);
    let acf0 = x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / n as f64;
    if acf0 <= 0.0 {
        return None;
    }

    let mut scores = vec![f32::NEG_INFINITY; lag_max + 1];
    let mut best_lag = lag_min;
    let mut best_score = f32::NEG_INFINITY;
    for (lag, slot) in scores.iter_mut().enumerate().skip(lag_min) {
        let mut s = 0.0f32;
        let mut wsum = 0.0f32;
        for (k, w) in COMB_WEIGHTS.iter().enumerate() {
            let h = k + 1;
            let l = lag * h;
            if l >= acf.len() {
                break;
            }
            // Toleransi yang MELEBAR dengan nomor harmonik. Periode sejati
            // hampir tidak pernah bulat: 128 BPM di laju ODF 199.5 Hz = 93.52
            // frame. Harmonik ke-h dari kandidat bulat karenanya meleset sampai
            // (h-1)/2 frame, dan pada h=4 itu sudah cukup untuk melewatkan
            // puncak sepenuhnya — sehingga kandidat yang BENAR justru dihukum
            // dan tempo separuh (yang lag-nya kebetulan lebih dekat ke bulat)
            // menang. Mengambil maksimum di jendela kecil menghapus efek itu.
            let tol = h / 2;
            let lo = l.saturating_sub(tol);
            let hi = (l + tol).min(acf.len() - 1);
            let mut peak = acf[lo];
            for a in acf.iter().take(hi + 1).skip(lo + 1) {
                if *a > peak {
                    peak = *a;
                }
            }
            s += w * peak;
            wsum += w;
        }
        if wsum <= 0.0 {
            continue;
        }
        // Dinormalisasi dengan bobot yang BENAR-BENAR terpakai, supaya kandidat
        // yang sebagian harmoniknya di luar jangkauan tidak dirugikan.
        let mut s = s / wsum;

        let bpm_here = 60.0 * rate / lag as f32;

        // Hukuman subdivisi — lihat SUBDIVISION_PENALTY. `acf` di lag PECAHAN
        // `lag/2` diinterpolasi linear; membulatkannya akan mengembalikan
        // fungsi tangga yang justru dihindari di sini.
        if s > 0.0 {
            let half = lag as f32 * 0.5;
            let lo = half as usize;
            let mid = if lo + 1 < acf.len() {
                let f = half - lo as f32;
                acf[lo] * (1.0 - f) + acf[lo + 1] * f
            } else {
                acf[lo]
            };
            let ratio = (mid / s).clamp(0.0, 1.0);
            s /= 1.0 + SUBDIVISION_PENALTY * log_gauss(2.0 * bpm_here, SUBDIVISION_SIGMA) * ratio;
        }

        let s = s * prior(bpm_here);
        *slot = s;
        if s > best_score {
            best_score = s;
            best_lag = lag;
        }
    }
    if !best_score.is_finite() {
        return None;
    }

    let refined = refine_peak(&scores, best_lag);
    let period = if refined > 0.5 {
        refined
    } else {
        best_lag as f32
    };
    let bpm = 60.0 * rate / period;

    let periodicity = ((acf[best_lag] as f64 / acf0) as f32).clamp(0.0, 1.0);

    // Pesaing terdekat DI LUAR rok puncak. Kalau ada kandidat lain yang hampir
    // sama kuat, angka ini memang tidak layak dipercaya penuh.
    let mut runner_up = f32::NEG_INFINITY;
    for (lag, sc) in scores.iter().enumerate().skip(lag_min) {
        let ratio = lag as f32 / best_lag as f32;
        if (1.0 - ratio).abs() < PEAK_SKIRT {
            continue;
        }
        if *sc > runner_up {
            runner_up = *sc;
        }
    }
    let salience = if best_score > 0.0 {
        ((best_score - runner_up.max(0.0)) / best_score).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let confidence = libm::sqrtf(periodicity * salience).clamp(0.0, 1.0);
    let beat_offset_sec = beat_phase(&d, period) as f32 / rate;
    let beat_times_sec = track_beats(&d, period, rate);

    Some(BpmEstimate {
        bpm,
        confidence,
        beat_offset_sec,
        beat_times_sec,
    })
}

#[cfg(test)]
mod beat_track_tests {
    use super::track_beats;

    #[test]
    fn marker_mengikuti_onset_yang_sedikit_bergeser() {
        let mut odf = vec![0.0_f32; 1_000];
        let expected = [100_usize, 202, 299, 401, 500, 603, 700, 802, 899];
        for at in expected {
            odf[at] = 1.0;
        }
        let beats = track_beats(&odf, 100.0, 200.0);
        let frames: Vec<usize> = beats
            .iter()
            .map(|sec| (sec * 200.0).round() as usize)
            .collect();
        for at in expected {
            assert!(
                frames.iter().any(|got| got.abs_diff(at) <= 1),
                "onset {at} hilang: {frames:?}"
            );
        }
    }
}
