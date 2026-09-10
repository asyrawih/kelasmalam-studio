//! Tes `vocal_split.rs` — cermin `packages/vocal-split/src/__tests__/
//! {stft-roundtrip,segment-stitch}.test.ts` (docs/26 P0) plus paritas
//! TS↔Rust dan satu tes `#[ignore]` dengan model asli.
//!
//! Sinyal uji dibangkitkan dengan PRNG yang sama dengan TS (mulberry32)
//! supaya angka SNR di laporan bisa dibandingkan lintas bahasa.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::vocal_split::{
    hann_periodic, hanning_symmetric, padded_length, segment_count, segment_step, spec_index,
    zero_low_bins, Accel, MdxModel, MdxParams, MdxStft, OrtMdxModel, SeparateOptions,
    KIM_VOCAL_2_MDX,
};
use crate::{mdx_params, separate, HostError, ModelId};

const SR: usize = 44_100;
const KIM: MdxParams = KIM_VOCAL_2_MDX;

// ------------------------------------------------------------ Helper

/// mulberry32 — sama dengan `signals.ts`.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

fn snr_db(reference: &[f32], got: &[f32]) -> f64 {
    assert_eq!(reference.len(), got.len());
    let mut signal = 0f64;
    let mut noise = 0f64;
    for (r, g) in reference.iter().zip(got) {
        let r = *r as f64;
        let d = r - *g as f64;
        signal += r * r;
        noise += d * d;
    }
    if noise == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (signal / noise).log10()
    }
}

/// Derau putih stereo + sinus 440 Hz / 1 kHz — `noisePlusSine`.
fn noise_plus_sine(length: usize, seed: u32) -> (Vec<f32>, Vec<f32>) {
    let mut rng = Rng(seed);
    let mut left = vec![0f32; length];
    let mut right = vec![0f32; length];
    for n in 0..length {
        let t = n as f64 / SR as f64;
        left[n] = (0.3 * (rng.next() * 2.0 - 1.0)
            + 0.4 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32;
        right[n] = (0.3 * (rng.next() * 2.0 - 1.0)
            + 0.4 * (2.0 * std::f64::consts::PI * 1000.0 * t).cos()) as f32;
    }
    (left, right)
}

/// `bandLimitedStereo`: 24 sinus fase acak 300 Hz – 12 kHz, AM 0,3 Hz,
/// fade raised-cosine `fade_seconds` di kedua ujung.
fn band_limited_stereo(length: usize, seed: u32, fade_seconds: f64) -> (Vec<f32>, Vec<f32>) {
    let tones = 24;
    let (low, high) = (300.0f64, 12_000.0f64);
    let mut rng = Rng(seed);
    let mut freqs = Vec::new();
    let mut phases_l = Vec::new();
    let mut phases_r = Vec::new();
    let mut amps = Vec::new();
    for _ in 0..tones {
        freqs.push(low * (high / low).powf(rng.next()));
        phases_l.push(2.0 * std::f64::consts::PI * rng.next());
        phases_r.push(2.0 * std::f64::consts::PI * rng.next());
        amps.push((0.5 + 0.5 * rng.next()) / tones as f64);
    }
    let fade = ((fade_seconds * SR as f64).floor() as usize).min(length / 2);
    let mut left = vec![0f32; length];
    let mut right = vec![0f32; length];
    for n in 0..length {
        let mut l = 0f64;
        let mut r = 0f64;
        for i in 0..tones {
            let w = 2.0 * std::f64::consts::PI * freqs[i] * n as f64 / SR as f64;
            l += amps[i] * (w + phases_l[i]).sin();
            r += amps[i] * (w + phases_r[i]).sin();
        }
        let am = 0.75 + 0.25 * (2.0 * std::f64::consts::PI * 0.3 * n as f64 / SR as f64).sin();
        let mut env = am;
        if n < fade {
            env *= 0.5 - 0.5 * (std::f64::consts::PI * n as f64 / fade as f64).cos();
        }
        let from_end = length - 1 - n;
        if from_end < fade {
            env *= 0.5 - 0.5 * (std::f64::consts::PI * from_end as f64 / fade as f64).cos();
        }
        left[n] = (l * env) as f32;
        right[n] = (r * env) as f32;
    }
    (left, right)
}

/// Model identitas yang juga memeriksa bentuk tensor.
struct Identity {
    calls: usize,
}

impl MdxModel for Identity {
    fn run(&mut self, input: &[f32], dims: [usize; 4]) -> Result<Vec<f32>, HostError> {
        assert_eq!(dims, [1, 4, 3072, 256]);
        assert_eq!(input.len(), 4 * 3072 * 256);
        self.calls += 1;
        Ok(input.to_vec())
    }
}

fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

fn opts(overlap: f32, denoise: bool) -> SeparateOptions {
    SeparateOptions {
        overlap,
        denoise,
        compensate: true,
    }
}

// ------------------------------------------------------------ Parameter & window

#[test]
fn params_and_geometry_mirror_typescript() {
    assert_eq!(mdx_params(ModelId::KimVocal2), Some(KIM));
    assert_eq!(mdx_params(ModelId::Base), None);
    assert_eq!(KIM.frames_per_segment(), 256);
    assert_eq!(KIM.samples_per_segment(), 261_120);
    assert_eq!(KIM.trim(), 3840);
    assert_eq!(KIM.n_bins(), 3841);

    let gen = 261_120 - 2 * 3840;
    let len = SR * 240; // lagu 4 menit
    assert_eq!(
        padded_length(len, &KIM),
        3840 + len + gen + 3840 - (len % gen)
    );
    // docs/26 §1: ≈ 41 segmen tanpa overlap, ≈ 55 dengan 0,25.
    assert_eq!(segment_count(len, &KIM, 0.0).unwrap(), 41);
    assert_eq!(segment_count(len, &KIM, 0.25).unwrap(), 55);
    assert_eq!(segment_step(&KIM, 0.25).unwrap(), 195_840);
    assert_eq!(segment_step(&KIM, 0.5).unwrap(), 130_560);
    assert!(matches!(
        segment_step(&KIM, 1.0),
        Err(HostError::Invalid(_))
    ));
}

#[test]
fn windows_match_torch_and_numpy() {
    // Hann periodik: w[0] = 0, w[N/2] = 1, w[N−1] ≠ 0 (bukan simetris).
    let w = hann_periodic(8);
    assert_eq!(w[0], 0.0);
    assert!((w[4] - 1.0).abs() < 1e-15);
    assert!((w[1] - w[7]).abs() < 1e-15);
    assert!((w[7] - (0.5 - 0.5 * (2.0 * std::f64::consts::PI * 7.0 / 8.0).cos())).abs() < 1e-15);
    // np.hanning
    assert_eq!(hanning_symmetric(1), vec![1.0]);
    let h = hanning_symmetric(5);
    assert!(h[0].abs() < 1e-15);
    assert!((h[2] - 1.0).abs() < 1e-15);
    assert!(h[4].abs() < 1e-15);
    assert!((h[1] - 0.5).abs() < 1e-15);
}

#[test]
fn zero_low_bins_clears_three_bins_in_four_channels() {
    let (dim_f, frames) = (8, 4);
    let mut spec = vec![1f32; 4 * dim_f * frames];
    zero_low_bins(&mut spec, dim_f, frames, 3);
    for c in 0..4 {
        for k in 0..dim_f {
            for t in 0..frames {
                let v = spec[spec_index(dim_f, frames, c, k, t)];
                assert_eq!(v, if k < 3 { 0.0 } else { 1.0 });
            }
        }
    }
}

// ------------------------------------------------------------ STFT

#[test]
fn stft_shape_and_channel_layout() {
    let mut stft = MdxStft::from_params(&KIM).unwrap();
    let segment = KIM.samples_per_segment();
    assert_eq!(stft.frame_count(segment), 256);
    assert_eq!(stft.spec_size(256), 4 * 3072 * 256);
    assert_eq!(stft.n_bins(), 3841);

    // Sinus 1 kHz hanya di L (bin 1000·7680/44100 ≈ 174,15) tidak bocor ke R.
    let left: Vec<f32> = (0..segment)
        .map(|n| (2.0 * std::f64::consts::PI * 1000.0 * n as f64 / SR as f64).sin() as f32)
        .collect();
    let right = vec![0f32; segment];
    let mut spec = vec![0f32; stft.spec_size(256)];
    stft.forward(&left, &right, &mut spec).unwrap();
    let t = 100;
    let mut energy_l = 0f64;
    let mut energy_r = 0f64;
    let mut peak = (0usize, 0f64);
    for k in 0..KIM.dim_f {
        let lr = spec[spec_index(3072, 256, 0, k, t)] as f64;
        let li = spec[spec_index(3072, 256, 1, k, t)] as f64;
        let rr = spec[spec_index(3072, 256, 2, k, t)] as f64;
        let ri = spec[spec_index(3072, 256, 3, k, t)] as f64;
        let mag = lr * lr + li * li;
        energy_l += mag;
        energy_r += rr * rr + ri * ri;
        if mag > peak.1 {
            peak = (k, mag);
        }
    }
    assert!(energy_r < 1e-18, "bocor ke R: {energy_r}");
    assert!(energy_l > 0.0);
    assert_eq!(peak.0, 174);
    // Skala torch.stft tak dinormalisasi: puncak sinus amplitudo 1 dengan Hann ≈ N/4.
    let peak_mag = peak.1.sqrt();
    assert!(peak_mag > 0.6 * 7680.0 / 4.0 && peak_mag < 1.05 * 7680.0 / 4.0);
}

#[test]
fn stft_roundtrip_full_dim_f_30s_exceeds_100_db() {
    let mut stft = MdxStft::new(KIM.n_fft, KIM.hop, 3841).unwrap();
    let length = SR * 30;
    let (left, right) = noise_plus_sine(length, 11);
    let frames = stft.frame_count(length);
    let mut spec = vec![0f32; stft.spec_size(frames)];
    stft.forward(&left, &right, &mut spec).unwrap();
    let mut out_l = vec![0f32; length];
    let mut out_r = vec![0f32; length];
    stft.inverse(&spec, frames, &mut out_l, &mut out_r, Some(length))
        .unwrap();
    let (snr_l, snr_r) = (snr_db(&left, &out_l), snr_db(&right, &out_r));
    println!("[stft-roundtrip] dim_f 3841, 30 s: SNR L {snr_l:.1} dB, R {snr_r:.1} dB");
    assert!(snr_l > 100.0);
    assert!(snr_r > 100.0);
}

#[test]
fn stft_crop_matches_full_below_3072_and_reconstructs_band_limited() {
    let mut full = MdxStft::new(KIM.n_fft, KIM.hop, 3841).unwrap();
    let mut crop = MdxStft::from_params(&KIM).unwrap();
    let segment = KIM.samples_per_segment();
    let (left, right) = noise_plus_sine(segment, 5);
    let mut spec_full = vec![0f32; full.spec_size(256)];
    let mut spec_crop = vec![0f32; crop.spec_size(256)];
    full.forward(&left, &right, &mut spec_full).unwrap();
    crop.forward(&left, &right, &mut spec_crop).unwrap();
    for c in 0..4 {
        for k in 0..3072 {
            for t in 0..256 {
                assert_eq!(
                    spec_full[spec_index(3841, 256, c, k, t)],
                    spec_crop[spec_index(3072, 256, c, k, t)],
                    "bin < 3072 harus identik"
                );
            }
        }
    }
    // Rekonstruksi dari crop == rekonstruksi dari versi penuh yang bin ≥ 3072-nya dinolkan.
    let mut zeroed = spec_full.clone();
    for c in 0..4 {
        for k in 3072..3841 {
            let start = spec_index(3841, 256, c, k, 0);
            zeroed[start..start + 256].fill(0.0);
        }
    }
    let (mut a_l, mut a_r) = (vec![0f32; segment], vec![0f32; segment]);
    let (mut b_l, mut b_r) = (vec![0f32; segment], vec![0f32; segment]);
    full.inverse(&zeroed, 256, &mut a_l, &mut a_r, None)
        .unwrap();
    crop.inverse(&spec_crop, 256, &mut b_l, &mut b_r, None)
        .unwrap();
    assert!(snr_db(&a_l, &b_l) > 120.0);
    assert!(snr_db(&a_r, &b_r) > 120.0);

    // Sinyal 30 s yang energinya < 12 kHz (bin < 3072) kembali > 100 dB dari crop.
    let length = SR * 30;
    let (left, right) = band_limited_stereo(length, 9, 0.25);
    let frames = crop.frame_count(length);
    let mut spec = vec![0f32; crop.spec_size(frames)];
    crop.forward(&left, &right, &mut spec).unwrap();
    let (mut out_l, mut out_r) = (vec![0f32; length], vec![0f32; length]);
    crop.inverse(&spec, frames, &mut out_l, &mut out_r, Some(length))
        .unwrap();
    let (snr_l, snr_r) = (snr_db(&left, &out_l), snr_db(&right, &out_r));
    println!(
        "[stft-roundtrip] dim_f 3072, band-limited 30 s: SNR L {snr_l:.1} dB, R {snr_r:.1} dB"
    );
    assert!(snr_l > 100.0);
    assert!(snr_r > 100.0);
}

/// Paritas TS↔Rust: bin STFT untuk sinyal sinus deterministik, dibandingkan
/// dengan angka dari implementasi TS. Angka diperoleh dengan
/// `bun run parity.ts` di scratchpad yang mengimpor
/// `packages/vocal-split/src/mdx-stft.ts`:
///
/// ```ts
/// const stft = createMdxStft({ nFft: 7680, hop: 1024, dimF: 3072 });
/// const length = 8192; // 9 frame
/// for (n) left[n] = 0.5·sin(2π·1000·n/44100) + 0.25·sin(2π·3500·n/44100 + 0.3);
///         right[n] = 0.4·cos(2π·440·n/44100) + 0.1·sin(2π·12000·n/44100 + 1.1);
/// const spec = stft.forward(left, right);
/// console.log(spec[specIndex(3072, 9, c, k, t)].toPrecision(9));
/// ```
#[test]
fn stft_parity_with_typescript_reference() {
    let length = 8192;
    let mut left = vec![0f32; length];
    let mut right = vec![0f32; length];
    let tau = 2.0 * std::f64::consts::PI;
    for n in 0..length {
        let t = n as f64 / SR as f64;
        left[n] = (0.5 * (tau * 1000.0 * t).sin() + 0.25 * (tau * 3500.0 * t + 0.3).sin()) as f32;
        right[n] = (0.4 * (tau * 440.0 * t).cos() + 0.1 * (tau * 12000.0 * t + 1.1).sin()) as f32;
    }
    let mut stft = MdxStft::from_params(&KIM).unwrap();
    let frames = stft.frame_count(length);
    assert_eq!(frames, 9);
    let mut spec = vec![0f32; stft.spec_size(frames)];
    stft.forward(&left, &right, &mut spec).unwrap();

    // (channel, bin, frame, nilai dari TS)
    let expected: [(usize, usize, usize, f64); 12] = [
        (0, 174, 4, -648.512878),
        (1, 174, 4, -689.020569),
        (2, 77, 4, -470.625916),
        (3, 77, 4, 519.697205),
        (0, 609, 0, -320.033966),
        (1, 609, 8, -66.8521347),
        (2, 2090, 3, 103.493317),
        (3, 2090, 5, 129.677139),
        (0, 0, 2, 3.55706859),
        (2, 3071, 6, 0.0703470409),
        (1, 1, 0, 8.39259218e-15),
        (3, 1200, 7, -0.0595307760),
    ];
    for (c, k, t, want) in expected {
        let got = spec[spec_index(3072, frames, c, k, t)] as f64;
        // Toleransi relatif 1e-4 (dua FFT berbeda) dengan lantai absolut untuk
        // nilai yang ≈ 0.
        let tol = 1e-4 * want.abs().max(1.0);
        assert!(
            (got - want).abs() <= tol,
            "spec[{c}, {k}, {t}] = {got} ≠ TS {want}"
        );
    }
    let sum: f64 = spec.iter().map(|v| *v as f64).sum();
    assert!(
        (sum - -17.7356412).abs() < 1e-3,
        "jumlah seluruh tensor {sum}"
    );
}

// ------------------------------------------------------------ Pipa segmen

#[test]
fn stitch_identity_overlap_025_and_05_is_transparent() {
    let length = SR * 30;
    let (left, right) = band_limited_stereo(length, 21, 0.25);
    for overlap in [0.25f32, 0.5] {
        let mut model = Identity { calls: 0 };
        let mut progress = Vec::new();
        let began = Instant::now();
        let result = separate(
            &mut model,
            &KIM,
            &left,
            &right,
            &opts(overlap, false),
            &mut |done, total| progress.push((done, total)),
            &no_cancel(),
        )
        .unwrap();
        let ms = began.elapsed().as_millis();
        assert_eq!(result.vocals_l.len(), length);
        assert_eq!(result.vocals_r.len(), length);
        assert_eq!(result.inst_l.len(), length);
        assert_eq!(result.inst_r.len(), length);

        let snr_l = snr_db(&left, &result.vocals_l);
        let snr_r = snr_db(&right, &result.vocals_r);
        // Terburuk per jendela 1 detik (sambungan segmen).
        let mut worst = f64::INFINITY;
        for start in (0..length).step_by(SR) {
            let end = (start + SR).min(length);
            worst = worst.min(snr_db(&left[start..end], &result.vocals_l[start..end]));
            worst = worst.min(snr_db(&right[start..end], &result.vocals_r[start..end]));
        }
        let edge = snr_db(&left[..4096], &result.vocals_l[..4096]).min(snr_db(
            &left[length - 4096..],
            &result.vocals_l[length - 4096..],
        ));
        println!(
            "[segment-stitch] overlap {overlap}: SNR L {snr_l:.1} dB, R {snr_r:.1} dB, terburuk/1 s {worst:.1} dB, tepi {edge:.1} dB, {} segmen, {ms} ms",
            progress.len()
        );
        assert!(snr_l > 100.0);
        assert!(snr_r > 100.0);
        assert!(worst > 100.0);
        assert!(edge > 100.0);

        // inst = mix − vokal × 1.009 persis per sampel.
        for n in (0..length).step_by(1000) {
            let want = (left[n] as f64 - result.vocals_l[n] as f64 * KIM.compensate) as f32;
            assert!((result.inst_l[n] - want).abs() < 1e-6);
        }
        let total = segment_count(length, &KIM, overlap).unwrap() as u64;
        assert_eq!(progress.len() as u64, total);
        assert_eq!(model.calls as u64, total);
        assert_eq!(*progress.last().unwrap(), (total, total));
        for (i, (done, t)) in progress.iter().enumerate() {
            assert_eq!((*done, *t), (i as u64 + 1, total));
        }
    }
}

#[test]
fn stitch_odd_lengths_keep_length_and_content() {
    for length in [1usize, 261_120, 261_121] {
        let (left, right) = band_limited_stereo(length, length as u32, 0.05);
        for overlap in [0.25f32, 0.5] {
            let mut model = Identity { calls: 0 };
            let result = separate(
                &mut model,
                &KIM,
                &left,
                &right,
                &opts(overlap, false),
                &mut |_, _| {},
                &no_cancel(),
            )
            .unwrap();
            assert_eq!(result.vocals_l.len(), length);
            assert_eq!(result.vocals_r.len(), length);
            assert_eq!(result.inst_l.len(), length);
            assert_eq!(result.inst_r.len(), length);
            assert!(result
                .vocals_l
                .iter()
                .chain(&result.inst_r)
                .all(|v| v.is_finite()));
            if length > 1 {
                let snr = snr_db(&left, &result.vocals_l);
                println!("[segment-stitch] panjang {length}, overlap {overlap}: SNR {snr:.1} dB");
                assert!(snr > 100.0);
            }
        }
    }
}

#[test]
fn compensate_off_gives_plain_difference() {
    let (left, right) = band_limited_stereo(SR * 2, 4, 0.25);
    let mut model = Identity { calls: 0 };
    let result = separate(
        &mut model,
        &KIM,
        &left,
        &right,
        &SeparateOptions {
            overlap: 0.25,
            denoise: false,
            compensate: false,
        },
        &mut |_, _| {},
        &no_cancel(),
    )
    .unwrap();
    let peak = result
        .inst_l
        .iter()
        .chain(&result.inst_r)
        .fold(0f32, |m, v| m.max(v.abs()));
    assert!(peak < 1e-4, "mix − vokal harus ≈ 0, puncak {peak}");
}

#[test]
fn denoise_with_identity_stays_identity_and_calls_model_twice() {
    let length = SR * 3;
    let (left, right) = band_limited_stereo(length, 33, 0.25);
    let mut model = Identity { calls: 0 };
    let result = separate(
        &mut model,
        &KIM,
        &left,
        &right,
        &opts(0.25, true),
        &mut |_, _| {},
        &no_cancel(),
    )
    .unwrap();
    let total = segment_count(length, &KIM, 0.25).unwrap();
    assert_eq!(model.calls, 2 * total);
    let snr = snr_db(&left, &result.vocals_l);
    println!("[segment-stitch] denoise identitas 3 s: SNR {snr:.1} dB");
    assert!(snr > 100.0);

    // Denoise membatalkan komponen genap model: y = x + 0.1·|x| → x.
    struct Even;
    impl MdxModel for Even {
        fn run(&mut self, input: &[f32], _: [usize; 4]) -> Result<Vec<f32>, HostError> {
            Ok(input.iter().map(|v| v + 0.1 * v.abs()).collect())
        }
    }
    let (left, right) = band_limited_stereo(SR * 2, 8, 0.25);
    let plain = separate(
        &mut Even,
        &KIM,
        &left,
        &right,
        &opts(0.25, false),
        &mut |_, _| {},
        &no_cancel(),
    )
    .unwrap();
    let denoised = separate(
        &mut Even,
        &KIM,
        &left,
        &right,
        &opts(0.25, true),
        &mut |_, _| {},
        &no_cancel(),
    )
    .unwrap();
    let before = snr_db(&left, &plain.vocals_l);
    let after = snr_db(&left, &denoised.vocals_l);
    println!(
        "[segment-stitch] model genap: tanpa denoise {before:.1} dB, dengan denoise {after:.1} dB"
    );
    assert!(before < 60.0);
    assert!(after > 100.0);
}

#[test]
fn cancel_flag_aborts_with_cancelled() {
    let (left, right) = band_limited_stereo(SR * 30, 21, 0.25);
    // Dibatalkan dari dalam model pada panggilan ketiga: `separate` memeriksa
    // flag setelah model kembali → gagal sebelum progres ke-3.
    struct CancelOnThird<'a> {
        calls: usize,
        flag: &'a AtomicBool,
    }
    impl MdxModel for CancelOnThird<'_> {
        fn run(&mut self, input: &[f32], _: [usize; 4]) -> Result<Vec<f32>, HostError> {
            self.calls += 1;
            if self.calls == 3 {
                self.flag.store(true, Ordering::Relaxed);
            }
            Ok(input.to_vec())
        }
    }
    let flag = AtomicBool::new(false);
    let mut model = CancelOnThird {
        calls: 0,
        flag: &flag,
    };
    let mut progress = 0;
    let err = separate(
        &mut model,
        &KIM,
        &left,
        &right,
        &opts(0.25, false),
        &mut |_, _| progress += 1,
        &flag,
    )
    .unwrap_err();
    assert!(matches!(err, HostError::Cancelled), "dapat {err:?}");
    assert_eq!(err.code(), "CANCELLED");
    assert_eq!(model.calls, 3);
    assert_eq!(progress, 2);

    // Flag yang sudah menyala sebelum mulai → langsung Cancelled, model tidak dipanggil.
    let flag = AtomicBool::new(true);
    let mut model = Identity { calls: 0 };
    let err = separate(
        &mut model,
        &KIM,
        &left,
        &right,
        &opts(0.25, false),
        &mut |_, _| {},
        &flag,
    )
    .unwrap_err();
    assert!(matches!(err, HostError::Cancelled));
    assert_eq!(model.calls, 0);
}

#[test]
fn accel_parse_and_availability() {
    assert_eq!(
        Accel::parse("cpu", None).unwrap(),
        Accel::Cpu { threads: 4 }
    );
    assert_eq!(
        Accel::parse("cpu", Some(0)).unwrap(),
        Accel::Cpu { threads: 1 }
    );
    assert_eq!(
        Accel::parse("cpu", Some(8)).unwrap(),
        Accel::Cpu { threads: 8 }
    );
    assert!(matches!(
        Accel::parse("cuda", None),
        Err(HostError::Invalid(_))
    ));
    if cfg!(target_os = "macos") {
        assert_eq!(Accel::available(), &["cpu", "coreml"]);
        assert_eq!(Accel::parse("coreml", None).unwrap(), Accel::CoreMl);
    } else {
        assert_eq!(Accel::available(), &["cpu"]);
        assert!(matches!(
            Accel::parse("coreml", None),
            Err(HostError::Invalid(_))
        ));
    }
}

// ------------------------------------------------------------ Model asli

/// Path model asli untuk tes `#[ignore]` — bukan bagian repo.
const REAL_MODEL: &str = "/private/tmp/claude-501/-Users-dxh4nan-Projects-DawOnWeb/77d16620-1714-4a4c-8e19-a6ce37a4284e/scratchpad/Kim_Vocal_2.onnx";

/// Benchmark satu segmen dengan model asli, cermin docs/26 §4 (native CPU 4
/// thread ≈ 1 051 ms, CoreML ≈ 388 ms di M4). Jalankan:
/// `cargo test -p daw-desktop-host --release -- --ignored vocal_split_real_model --nocapture`
#[test]
#[ignore]
fn vocal_split_real_model() {
    let path = Path::new(REAL_MODEL);
    if !path.is_file() {
        eprintln!("model asli tidak ada di {REAL_MODEL}; tes dilewati");
        return;
    }
    let dims = [1usize, 4, 3072, 256];
    let mut rng = Rng(99);
    let input: Vec<f32> = (0..dims.iter().product::<usize>())
        .map(|_| ((rng.next() - 0.5) * 0.1) as f32)
        .collect();

    let mut runs = vec![
        (Accel::Cpu { threads: 4 }, false),
        (Accel::Cpu { threads: 4 }, true),
    ];
    if cfg!(target_os = "macos") {
        runs.push((Accel::CoreMl, false));
        runs.push((Accel::CoreMl, true));
    }
    for (accel, pin_batch) in runs {
        let began = Instant::now();
        let mut model = OrtMdxModel::load_with(path, accel, pin_batch).unwrap();
        let load_ms = began.elapsed().as_millis();
        // Pemanasan sekali, lalu 4 kali diukur (median).
        let out = model.run(&input, dims).unwrap();
        assert_eq!(out.len(), input.len());
        assert!(out.iter().all(|v| v.is_finite()));
        let mut times = Vec::new();
        for _ in 0..4 {
            let t = Instant::now();
            let _ = model.run(&input, dims).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = times[times.len() / 2];
        let rtf = 261_120.0 / 44_100.0 / (median / 1000.0);
        println!(
            "[vocal_split_real_model] {:?} pin_batch={pin_batch} (coreml terdaftar: {}): load {load_ms} ms | per-segmen {} ms | median {median:.0} ms | RTF {rtf:.2}x | lagu 4 mnt (55 segmen) ≈ {:.1} mnt",
            accel,
            model.coreml_registered(),
            times.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>().join(" "),
            55.0 * median / 60_000.0
        );
    }

    // Pipa utuh 6 detik lewat model asli: hasil terhingga, vokal ≠ mix.
    let length = SR * 6;
    let (left, right) = noise_plus_sine(length, 3);
    let mut model = OrtMdxModel::load(path, Accel::Cpu { threads: 4 }).unwrap();
    let began = Instant::now();
    let result = separate(
        &mut model,
        &KIM,
        &left,
        &right,
        &opts(0.25, false),
        &mut |d, t| println!("  segmen {d}/{t}"),
        &no_cancel(),
    )
    .unwrap();
    println!(
        "[vocal_split_real_model] pipa 6 s CPU 4 thread: {} ms",
        began.elapsed().as_millis()
    );
    assert!(result.vocals_l.iter().all(|v| v.is_finite()));
    let snr = snr_db(&left, &result.vocals_l);
    println!("[vocal_split_real_model] 'SNR' vokal vs mix derau+sinus: {snr:.1} dB (harus rendah: model membuang derau)");
    assert!(snr < 30.0);
}
