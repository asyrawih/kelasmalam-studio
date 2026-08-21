//! Auto de-click untuk PCM offline.
//!
//! Jalur ini sengaja hidup di renderer offline, bukan sebagai `Fx` realtime:
//! keputusan apakah sebuah lonjakan benar-benar click membutuhkan sample di
//! SEBELAH KANAN lonjakan. Menaruh look-ahead di graph realtime akan menambah
//! latency dan menggeser track; memotong analisis per blok juga membuat hasil
//! berubah ketika ukuran blok berubah.
//!
//! Detektornya konservatif dan stereo-linked:
//!
//! 1. energi turunan di sebuah edge dibandingkan dengan baseline turunan jauh
//!    di kiri dan kanan;
//! 2. hanya edge besar yang punya edge lawan dalam jendela sangat pendek yang
//!    dianggap click (offset naik lalu kembali lagi);
//! 3. arah dan besar kedua edge harus saling membatalkan;
//! 4. rentang yang lolos diganti dengan interpolasi lurus antara dua sample
//!    bersih, pada SEMUA channel dengan batas yang sama.
//!
//! Syarat pasangan edge adalah pembeda penting dari gate/transient detector:
//! onset kick, snare, atau note yang menetap tidak mempunyai edge balik yang
//! cocok dan karena itu dibiarkan utuh.

/// Hasil satu pass de-click. Berguna untuk diagnostik tanpa perlu mengekspos
/// detail detektor ke UI.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeclickReport {
    pub repaired_clicks: u32,
    pub repaired_frames: u32,
}

/// Ambang default sengaja lebih konservatif daripada editor audio interaktif:
/// fitur ini otomatis, jadi false-positive pada transient musik lebih buruk
/// daripada membiarkan click kecil lolos.
const ENERGY_RATIO: f64 = 24.0;
const MIN_JUMP: f64 = 0.002;
const MAX_REPAIRS: usize = 1_000_000;

/// Bersihkan click impulsif dari PCM planar secara in-place.
///
/// `pcm` ditata `[channel0 seluruh frame][channel1 seluruh frame]...`.
/// Panjang click dan konteks diskalakan dari nilai referensi 44,1 kHz supaya
/// perilakunya tetap sama dalam satuan waktu pada asset 48/96 kHz.
pub fn auto_declick_planar(
    pcm: &mut [f32],
    channels: usize,
    frames: usize,
    sample_rate: u32,
) -> DeclickReport {
    if channels == 0 || frames < 4 || sample_rate == 0 {
        return DeclickReport::default();
    }
    let Some(required) = channels.checked_mul(frames) else {
        return DeclickReport::default();
    };
    if pcm.len() < required {
        return DeclickReport::default();
    }

    // Audacity-class click removal menargetkan spike yang sangat pendek.
    // 20 sample @44,1 kHz ~= 0,45 ms; di atas itu algoritma otomatis terlalu
    // mudah menganggap transient musik sebagai kerusakan.
    let max_width = scale_from_44k(20, sample_rate).clamp(2, 96);
    let context = scale_from_44k(96, sample_rate)
        .max(max_width * 3)
        .clamp(16, 512);
    if frames <= context + max_width + 3 {
        return DeclickReport::default();
    }

    // Deteksi dulu pada PCM asli, baru reparasi. Kalau sample langsung ditulis
    // saat scan, rolling baseline di frame berikutnya menjadi campuran audio
    // asli dan hasil reparasi sehingga keputusan bergantung pada urutan scan.
    let mut repairs: Vec<(u32, u32)> = Vec::new();
    let mut skip_until = 0usize;

    // Range baseline untuk t=1:
    // pre  = [max(1, t-context), t)
    // post = [t+max_width+1, t+max_width+1+context)
    let mut pre_sum = 0.0_f64;
    let post_first = 1 + max_width + 1;
    let post_last = (post_first + context).min(frames);
    let mut post_sum = sum_edge_energy(pcm, channels, frames, post_first, post_last);

    for t in 1..frames {
        if t > 1 {
            pre_sum += edge_energy_max(pcm, channels, frames, t - 1);
            if t > context + 1 {
                pre_sum -= edge_energy_max(pcm, channels, frames, t - context - 1);
            }

            let old_post = t + max_width;
            if old_post < frames {
                post_sum -= edge_energy_max(pcm, channels, frames, old_post);
            }
            let new_post = t + max_width + context;
            if new_post < frames {
                post_sum += edge_energy_max(pcm, channels, frames, new_post);
            }
            // Pembulatan `add - subtract` bisa menghasilkan -epsilon.
            pre_sum = pre_sum.max(0.0);
            post_sum = post_sum.max(0.0);
        }

        if t < skip_until || t + 1 >= frames || repairs.len() >= MAX_REPAIRS {
            continue;
        }

        let pre_first = t.saturating_sub(context).max(1);
        let pre_count = t - pre_first;
        let post_first = t + max_width + 1;
        let post_count = (post_first + context)
            .min(frames)
            .saturating_sub(post_first);
        // Jangan mengambil keputusan di tepi file dengan baseline sebelah
        // yang terlalu pendek. Reparasi tepi tanpa dua anchor juga mustahil.
        if pre_count < context / 3 || post_count < context / 3 {
            continue;
        }

        let baseline = (pre_sum / pre_count as f64)
            .max(post_sum / post_count as f64)
            .max((MIN_JUMP * MIN_JUMP) / ENERGY_RATIO);
        let start_energy = edge_energy_max(pcm, channels, frames, t);
        if start_energy < MIN_JUMP * MIN_JUMP || start_energy < baseline * ENERGY_RATIO {
            continue;
        }

        let last_exit = (t + max_width).min(frames - 1);
        let mut best: Option<(usize, f64)> = None;
        for exit in (t + 1)..=last_exit {
            let exit_energy = edge_energy_max(pcm, channels, frames, exit);
            // Edge balik boleh sedikit lebih lemah karena musik asli ikut
            // menumpang, tetapi tetap harus jauh di atas lantai lokal.
            if exit_energy < baseline * (ENERGY_RATIO * 0.20) {
                continue;
            }
            let pair = edge_pair_metrics(pcm, channels, frames, t, exit);
            if pair.start_energy <= 0.0 || pair.exit_energy <= 0.0 {
                continue;
            }
            let cosine_floor = -0.55 * (pair.start_energy * pair.exit_energy).sqrt();
            if pair.dot >= cosine_floor {
                continue;
            }
            let magnitude_ratio =
                pair.start_energy.max(pair.exit_energy) / pair.start_energy.min(pair.exit_energy);
            if magnitude_ratio > 4.0 {
                continue;
            }
            // Untuk click berbentuk offset pendek, d_start + d_exit hampir
            // nol. Musik di bawahnya menyisakan residual kecil; transient
            // normal biasanya tidak saling membatalkan sebaik ini.
            let cancellation =
                pair.residual_energy / (pair.start_energy + pair.exit_energy).max(f64::EPSILON);
            if cancellation > 0.20 {
                continue;
            }

            let score = cancellation + 0.015 * (exit - t) as f64;
            if best.map_or(true, |(_, old_score)| score < old_score) {
                best = Some((exit, score));
            }
        }

        if let Some((exit, _)) = best {
            repairs.push((t as u32, exit as u32));
            // `exit` adalah edge dari sample rusak terakhir ke anchor kanan;
            // kandidat berikutnya boleh dimulai sesudah anchor itu.
            skip_until = exit + 1;
        }
    }

    let mut report = DeclickReport::default();
    for &(start, end) in &repairs {
        let start = start as usize;
        let end = end as usize;
        if end <= start || end >= frames {
            continue;
        }
        let width = end - start;
        let denominator = (width + 1) as f32;
        for channel in 0..channels {
            let base = channel * frames;
            let left = pcm[base + start - 1];
            let right = pcm[base + end];
            if !left.is_finite() || !right.is_finite() {
                continue;
            }
            for i in 0..width {
                let mix = (i + 1) as f32 / denominator;
                pcm[base + start + i] = left + (right - left) * mix;
            }
        }
        report.repaired_clicks = report.repaired_clicks.saturating_add(1);
        report.repaired_frames = report.repaired_frames.saturating_add(width as u32);
    }
    report
}

#[derive(Clone, Copy, Debug, Default)]
struct EdgePairMetrics {
    start_energy: f64,
    exit_energy: f64,
    dot: f64,
    residual_energy: f64,
}

fn edge_pair_metrics(
    pcm: &[f32],
    channels: usize,
    frames: usize,
    start: usize,
    exit: usize,
) -> EdgePairMetrics {
    let mut out = EdgePairMetrics::default();
    for channel in 0..channels {
        let base = channel * frames;
        let a = (pcm[base + start] - pcm[base + start - 1]) as f64;
        let b = (pcm[base + exit] - pcm[base + exit - 1]) as f64;
        if !a.is_finite() || !b.is_finite() {
            return EdgePairMetrics::default();
        }
        out.start_energy += a * a;
        out.exit_energy += b * b;
        out.dot += a * b;
        out.residual_energy += (a + b) * (a + b);
    }
    out
}

fn edge_energy_max(pcm: &[f32], channels: usize, frames: usize, edge: usize) -> f64 {
    if edge == 0 || edge >= frames {
        return 0.0;
    }
    let mut energy = 0.0_f64;
    for channel in 0..channels {
        let base = channel * frames;
        let d = (pcm[base + edge] - pcm[base + edge - 1]) as f64;
        if !d.is_finite() {
            return 0.0;
        }
        energy = energy.max(d * d);
    }
    energy
}

fn sum_edge_energy(pcm: &[f32], channels: usize, frames: usize, first: usize, last: usize) -> f64 {
    (first..last)
        .map(|edge| edge_energy_max(pcm, channels, frames, edge))
        .sum()
}

fn scale_from_44k(samples: usize, sample_rate: u32) -> usize {
    ((samples as u64 * sample_rate as u64 + 22_050) / 44_100) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;
    const FRAMES: usize = 1_024;

    fn sine(frames: usize, hz: f32) -> Vec<f32> {
        (0..frames)
            .map(|i| (i as f32 * core::f32::consts::TAU * hz / SR as f32).sin() * 0.3)
            .collect()
    }

    #[test]
    fn repairs_a_one_sample_click_without_touching_the_other_channel_boundary() {
        let left = sine(FRAMES, 440.0);
        let right = sine(FRAMES, 660.0);
        let mut pcm = [left.clone(), right.clone()].concat();
        let at = 500;
        pcm[at] += 0.75;

        let report = auto_declick_planar(&mut pcm, 2, FRAMES, SR);

        assert_eq!(report.repaired_clicks, 1);
        assert_eq!(report.repaired_frames, 1);
        let expected_left = (left[at - 1] + left[at + 1]) * 0.5;
        let expected_right = (right[at - 1] + right[at + 1]) * 0.5;
        assert!((pcm[at] - expected_left).abs() < 1.0e-6);
        assert!((pcm[FRAMES + at] - expected_right).abs() < 1.0e-6);
    }

    #[test]
    fn repairs_a_short_plateau_click() {
        let clean = sine(FRAMES, 220.0);
        let mut pcm = clean.clone();
        for sample in &mut pcm[500..507] {
            *sample += 0.6;
        }

        let report = auto_declick_planar(&mut pcm, 1, FRAMES, SR);

        assert_eq!(report.repaired_clicks, 1);
        assert_eq!(report.repaired_frames, 7);
        for i in 500..507 {
            assert!((pcm[i] - clean[i]).abs() < 0.01);
        }
    }

    #[test]
    fn clean_audio_is_bit_identical() {
        let mut pcm = [sine(FRAMES, 440.0), sine(FRAMES, 8_000.0)].concat();
        let before = pcm.clone();

        let report = auto_declick_planar(&mut pcm, 2, FRAMES, SR);

        assert_eq!(report, DeclickReport::default());
        assert_eq!(pcm, before);
    }

    #[test]
    fn sustained_step_onset_is_not_a_click() {
        let mut pcm = vec![0.0; FRAMES];
        pcm[500..].fill(0.7);
        let before = pcm.clone();

        let report = auto_declick_planar(&mut pcm, 1, FRAMES, SR);

        assert_eq!(report, DeclickReport::default());
        assert_eq!(pcm, before);
    }

    #[test]
    fn click_width_scales_with_sample_rate() {
        assert_eq!(scale_from_44k(20, 44_100), 20);
        assert_eq!(scale_from_44k(20, 48_000), 22);
        assert_eq!(scale_from_44k(20, 96_000), 44);
    }
}
