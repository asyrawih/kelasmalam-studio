//! Vocal split Kim_Vocal_2 (MDX-Net) native — docs/26 §1, §4 (P3b).
//!
//! Port SATU-BANDING-SATU dari `packages/vocal-split/src/{fft,mdx-stft,
//! mdx-separate}.ts`, yang sudah dibuktikan lawan rujukan UVR (null test
//! > 130 dB). Semantiknya ditiru persis, bukan "kira-kira sama": window Hann
//! periodik, padding refleksi torch, frame `1 + floor(len/hop)`, layout
//! `[4, dim_f, frames]` = `[L.re, L.im, R.re, R.im]`, crop 3072 dari 3841 bin,
//! iSTFT dengan normalisasi Σw², segmen `hop·(2^dim_t − 1)`, pad `trim`/
//! `gen + trim − (len mod gen)`, jahitan `np.hanning` simetris + divider,
//! `inst = mix − vocals × compensate`. Tes paritas di `tests.rs` membandingkan
//! bin STFT dengan angka yang dihitung implementasi TS.
//!
//! Kenapa native: WASM 8 thread 4,3 s/segmen gagal gerbang P1; native CPU
//! 4 thread ≈ 1,05 s, CoreML ≈ 0,39 s (docs/26 §4). Yang berubah hanya
//! runtime — UI dan job di TS tetap, PCM masuk/keluar lewat IPC biner
//! (`apps/desktop/src-tauri/src/commands/vocal_split.rs`).
//!
//! Presisi: FFT dan akumulasi di `f64` (rustfft), tensor model `f32` —
//! sama dengan TS yang memakai Float64 di dalam dan Float32 di tepi. Semua
//! operasi tunggal `f64 → f32` menghasilkan pembulatan yang sama dengan
//! operasi `f32` langsung (presisi ganda ≥ 2p + 2), jadi hasil kedua sisi
//! sama secara numerik sampai perbedaan urutan penjumlahan FFT (~1e-12).
//!
//! # Binari ONNX Runtime (temuan, September 2026, `ort` 2.0.0-rc.13)
//!
//! Fitur `download-binaries` mengunduh arsip prebuilt pyke saat build
//! pertama (`~/.cache/ort.pyke.io/dfbin/<target>/<hash>`) dan menautkannya
//! **STATIC** (`cargo:rustc-link-lib=static=onnxruntime`, `libonnxruntime.a`)
//! — di `build/main.rs` ort-sys tidak ada jalur dylib untuk binari pyke.
//! Untuk `aarch64-apple-darwin` satu-satunya distribusi adalah `coreml`
//! (dan `coreml,webgpu`), jadi CoreML selalu ikut tertaut dan tidak ada
//! `.dylib` yang harus dibundel/ditandatangani: binari `daw-desktop` sudah
//! memuat ORT. Yang ditautkan tambahan: `libc++`, framework Foundation +
//! CoreML, `clang_rt.osx`. Fitur `coreml` HANYA di macOS
//! (`[target.'cfg(target_os = "macos")'.dependencies]`): di Windows/Linux
//! ort-sys mencocokkan himpunan fitur dengan tabel distribusi dan `coreml`
//! tidak ada di sana → `link_error_bad_dist_features`. Di
//! `x86_64-pc-windows-msvc` distribusinya `directml` (DX12 + DirectML.dll
//! tertaut walau EP DirectML tidak kita daftarkan) — itu urusan build
//! Windows, belum diverifikasi di sini. `tls-rustls` dipilih untuk unduhan
//! build supaya tidak ada OpenSSL di CI Ubuntu (prinsip yang sama dengan
//! reqwest di crate ini).

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

use crate::{HostError, ModelId};

// ------------------------------------------------------------ Parameter

/// Parameter MDX-Net dari `model_data.json` UVR — cermin `MdxParams` di
/// `packages/vocal-split/src/catalog.ts`. Semuanya menentukan bentuk tensor;
/// salah satu saja meleset → ORT menolak dengan shape mismatch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MdxParams {
    /// Ukuran FFT (window Hann periodik).
    pub n_fft: usize,
    /// Lompatan STFT; tetap 1024 di seluruh keluarga MDX-Net.
    pub hop: usize,
    /// Bin terbawah yang masuk model; sisanya dibuang lalu diisi nol saat iSTFT.
    pub dim_f: usize,
    /// Frame per segmen = `2^dim_t`.
    pub dim_t: u32,
    /// Pengali output vokal sebelum `inst = mix − vocals × compensate`.
    pub compensate: f64,
}

impl MdxParams {
    /// Frame per segmen: `2^dim_t` (256).
    pub fn frames_per_segment(&self) -> usize {
        1 << self.dim_t
    }

    /// Sampel per segmen: `hop × (frames − 1)` — 261 120 untuk Kim_Vocal_2.
    pub fn samples_per_segment(&self) -> usize {
        self.hop * (self.frames_per_segment() - 1)
    }

    /// Sampel yang dipotong di kedua tepi tiap segmen: `n_fft / 2`.
    pub fn trim(&self) -> usize {
        self.n_fft / 2
    }

    /// `n_fft/2 + 1` — 3841 untuk Kim_Vocal_2.
    pub fn n_bins(&self) -> usize {
        self.n_fft / 2 + 1
    }
}

/// Kim_Vocal_2 — `VOCAL_MODELS['kim-vocal-2'].mdx` di TS.
pub const KIM_VOCAL_2_MDX: MdxParams = MdxParams {
    n_fft: 7680,
    hop: 1024,
    dim_f: 3072,
    dim_t: 8,
    compensate: 1.009,
};

/// Parameter MDX untuk id model; `None` untuk model yang bukan MDX-Net (SCNet).
pub fn mdx_params(id: ModelId) -> Option<MdxParams> {
    match id {
        ModelId::KimVocal2 => Some(KIM_VOCAL_2_MDX),
        ModelId::Base | ModelId::Large => None,
    }
}

// ------------------------------------------------------------ Window

/// Hann periodik: `0.5 − 0.5·cos(2πn/N)` — `torch.hann_window(N, periodic=True)`.
pub fn hann_periodic(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos())
        .collect()
}

/// `np.hanning(n)`: Hann simetris `0.5 − 0.5·cos(2πk/(n−1))`; `n = 1` → `[1]`.
pub fn hanning_symmetric(n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![1.0];
    }
    (0..n)
        .map(|k| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (n - 1) as f64).cos())
        .collect()
}

/// Indeks elemen `[channel, bin, frame]` dalam tensor `[4, dim_f, frames]`.
pub fn spec_index(dim_f: usize, frames: usize, channel: usize, bin: usize, frame: usize) -> usize {
    (channel * dim_f + bin) * frames + frame
}

/// Nol-kan `count` bin terbawah di keempat channel — `spek[:, :, :3, :] *= 0`
/// di `run_model` UVR, dilakukan SEBELUM tensor masuk model.
pub fn zero_low_bins(spec: &mut [f32], dim_f: usize, frames: usize, count: usize) {
    for channel in 0..4 {
        for bin in 0..count.min(dim_f) {
            let start = spec_index(dim_f, frames, channel, bin, 0);
            spec[start..start + frames].fill(0.0);
        }
    }
}

// ------------------------------------------------------------ STFT

/// STFT / iSTFT dengan semantik kelas `STFT` UVR — lihat kepala modul dan
/// `mdx-stft.ts`. Dua channel real dikemas jadi satu FFT kompleks
/// (`z = l + i·r`) dan dipisah lewat simetri Hermitian.
///
/// Buffer kerja dialokasikan sekali dan tumbuh bila input lebih panjang dari
/// yang pernah dilihat — semua segmen produksi berukuran sama.
pub struct MdxStft {
    n_fft: usize,
    hop: usize,
    dim_f: usize,
    half: usize,
    n_bins: usize,
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
    window: Vec<f64>,
    buf: Vec<Complex<f64>>,
    scratch: Vec<Complex<f64>>,
    pad_l: Vec<f64>,
    pad_r: Vec<f64>,
    ola_l: Vec<f64>,
    ola_r: Vec<f64>,
    envelope: Vec<f64>,
}

impl MdxStft {
    /// `dim_f` boleh melebihi 3072 (tes memakai 3841 = penuh) tapi tidak
    /// boleh melebihi `n_bins`.
    pub fn new(n_fft: usize, hop: usize, dim_f: usize) -> Result<Self, HostError> {
        if n_fft % 2 != 0 || n_fft < 2 || hop < 1 || dim_f < 1 {
            return Err(HostError::Invalid(format!(
                "parameter STFT tidak valid: n_fft {n_fft}, hop {hop}, dim_f {dim_f}"
            )));
        }
        let half = n_fft / 2;
        let n_bins = half + 1;
        if dim_f > n_bins {
            return Err(HostError::Invalid(format!(
                "dim_f {dim_f} melebihi jumlah bin {n_bins}"
            )));
        }
        let mut planner = FftPlanner::<f64>::new();
        let forward = planner.plan_fft_forward(n_fft);
        let inverse = planner.plan_fft_inverse(n_fft);
        let scratch_len = forward
            .get_inplace_scratch_len()
            .max(inverse.get_inplace_scratch_len());
        Ok(Self {
            n_fft,
            hop,
            dim_f,
            half,
            n_bins,
            forward,
            inverse,
            window: hann_periodic(n_fft),
            buf: vec![Complex::new(0.0, 0.0); n_fft],
            scratch: vec![Complex::new(0.0, 0.0); scratch_len],
            pad_l: Vec::new(),
            pad_r: Vec::new(),
            ola_l: Vec::new(),
            ola_r: Vec::new(),
            envelope: Vec::new(),
        })
    }

    pub fn from_params(params: &MdxParams) -> Result<Self, HostError> {
        Self::new(params.n_fft, params.hop, params.dim_f)
    }

    pub fn n_bins(&self) -> usize {
        self.n_bins
    }

    /// Jumlah frame untuk input sepanjang `length` (center-padded): `1 + floor(length/hop)`.
    pub fn frame_count(&self, length: usize) -> usize {
        1 + length / self.hop
    }

    /// Ukuran tensor `[4, dim_f, frames]` dalam elemen.
    pub fn spec_size(&self, frames: usize) -> usize {
        4 * self.dim_f * frames
    }

    /// STFT stereo → `out` berukuran tepat `spec_size(frame_count(len))`.
    pub fn forward(
        &mut self,
        left: &[f32],
        right: &[f32],
        out: &mut [f32],
    ) -> Result<(), HostError> {
        let length = left.len();
        if right.len() != length {
            return Err(HostError::Invalid(format!(
                "panjang channel berbeda: {length} vs {}",
                right.len()
            )));
        }
        let frames = self.frame_count(length);
        let size = self.spec_size(frames);
        if out.len() != size {
            return Err(HostError::Invalid(format!(
                "buffer spektrum {} ≠ {size}",
                out.len()
            )));
        }
        let padded = length + self.n_fft;
        if self.pad_l.len() < padded {
            self.pad_l.resize(padded, 0.0);
            self.pad_r.resize(padded, 0.0);
        }
        reflect_pad(left, self.half, &mut self.pad_l)?;
        reflect_pad(right, self.half, &mut self.pad_r)?;

        let dim_f = self.dim_f;
        let plane_l = 0;
        let plane_li = dim_f * frames;
        let plane_r = 2 * dim_f * frames;
        let plane_ri = 3 * dim_f * frames;

        for t in 0..frames {
            let base = t * self.hop;
            for n in 0..self.n_fft {
                let w = self.window[n];
                self.buf[n] = Complex::new(self.pad_l[base + n] * w, self.pad_r[base + n] * w);
            }
            self.forward
                .process_with_scratch(&mut self.buf, &mut self.scratch);
            // z = l + i·r → L[k] = (Z[k] + conj Z[N−k]) / 2, R[k] = (Z[k] − conj Z[N−k]) / 2i.
            for k in 0..dim_f {
                let mirror = if k == 0 { 0 } else { self.n_fft - k };
                let z = self.buf[k];
                let m = self.buf[mirror];
                let column = k * frames + t;
                out[plane_l + column] = (0.5 * (z.re + m.re)) as f32;
                out[plane_li + column] = (0.5 * (z.im - m.im)) as f32;
                out[plane_r + column] = (0.5 * (z.im + m.im)) as f32;
                out[plane_ri + column] = (0.5 * (m.re - z.re)) as f32;
            }
        }
        Ok(())
    }

    /// iSTFT tensor `[4, dim_f, frames]` → `length` sampel per channel.
    /// `length` default `hop × (frames − 1)`, sama dengan `torch.istft` tanpa
    /// argumen `length`.
    pub fn inverse(
        &mut self,
        spec: &[f32],
        frames: usize,
        out_left: &mut [f32],
        out_right: &mut [f32],
        length: Option<usize>,
    ) -> Result<(), HostError> {
        if frames < 1 {
            return Err(HostError::Invalid("iSTFT butuh minimal satu frame".into()));
        }
        if spec.len() != self.spec_size(frames) {
            return Err(HostError::Invalid(format!(
                "buffer spektrum {} ≠ {}",
                spec.len(),
                self.spec_size(frames)
            )));
        }
        let length = length.unwrap_or(self.hop * (frames - 1));
        if out_left.len() < length || out_right.len() < length {
            return Err(HostError::Invalid(format!(
                "buffer keluaran lebih pendek dari {length}"
            )));
        }
        let padded = (frames - 1) * self.hop + self.n_fft;
        if length + self.half > padded {
            return Err(HostError::Invalid(format!(
                "panjang {length} melebihi cakupan {frames} frame"
            )));
        }
        if self.ola_l.len() < padded {
            self.ola_l.resize(padded, 0.0);
            self.ola_r.resize(padded, 0.0);
            self.envelope.resize(padded, 0.0);
        }
        self.ola_l[..padded].fill(0.0);
        self.ola_r[..padded].fill(0.0);
        self.envelope[..padded].fill(0.0);

        let dim_f = self.dim_f;
        let plane_l = 0;
        let plane_li = dim_f * frames;
        let plane_r = 2 * dim_f * frames;
        let plane_ri = 3 * dim_f * frames;
        let scale = 1.0 / self.n_fft as f64;

        for t in 0..frames {
            // Z[k] = L[k] + i·R[k] untuk k ∈ [0, N/2]; sisanya lewat simetri
            // Hermitian masing-masing channel: Z[N−k] = conj L[k] + i·conj R[k].
            for k in 0..self.n_bins {
                let (lr, mut li, rr, mut ri) = if k < dim_f {
                    let column = k * frames + t;
                    (
                        spec[plane_l + column] as f64,
                        spec[plane_li + column] as f64,
                        spec[plane_r + column] as f64,
                        spec[plane_ri + column] as f64,
                    )
                } else {
                    (0.0, 0.0, 0.0, 0.0)
                };
                if k == 0 || k == self.half {
                    li = 0.0;
                    ri = 0.0;
                }
                self.buf[k] = Complex::new(lr - ri, li + rr);
                if k > 0 && k < self.half {
                    self.buf[self.n_fft - k] = Complex::new(lr + ri, rr - li);
                }
            }
            self.inverse
                .process_with_scratch(&mut self.buf, &mut self.scratch);
            let base = t * self.hop;
            for n in 0..self.n_fft {
                let w = self.window[n];
                let z = self.buf[n] * scale;
                self.ola_l[base + n] += z.re * w;
                self.ola_r[base + n] += z.im * w;
                self.envelope[base + n] += w * w;
            }
        }

        // Normalisasi jumlah kuadrat window lalu potong padding center. torch
        // menolak (NOLA) bila envelope ≈ 0; di sini sampel itu dibiarkan 0.
        for n in 0..length {
            let e = self.envelope[n + self.half];
            if e > 1e-11 {
                out_left[n] = (self.ola_l[n + self.half] / e) as f32;
                out_right[n] = (self.ola_r[n + self.half] / e) as f32;
            } else {
                out_left[n] = 0.0;
                out_right[n] = 0.0;
            }
        }
        Ok(())
    }
}

/// Padding refleksi ala torch (`reflect`, tanpa mengulang sampel tepi):
/// `[x[h], …, x[1], x[0], x[1], …, x[L−1], x[L−2], …, x[L−1−h]]`.
/// Mensyaratkan `L > h`, sama seperti torch yang menolak padding ≥ dimensi.
fn reflect_pad(src: &[f32], half: usize, dst: &mut [f64]) -> Result<(), HostError> {
    let length = src.len();
    if length <= half {
        return Err(HostError::Invalid(format!(
            "input {length} sampel terlalu pendek untuk padding refleksi {half}"
        )));
    }
    for i in 0..half {
        dst[i] = src[half - i] as f64;
    }
    for (i, &s) in src.iter().enumerate() {
        dst[half + i] = s as f64;
    }
    let tail = half + length;
    for i in 0..half {
        dst[tail + i] = src[length - 2 - i] as f64;
    }
    Ok(())
}

// ------------------------------------------------------------ Pipa segmen

/// Model MDX: tensor masuk `[1, 4, dim_f, frames]` → tensor keluar dengan
/// layout yang sama. Trait supaya pipa bisa diuji dengan model identitas
/// tanpa ORT (docs/26 P0: jangan men-debug model dan transform sekaligus).
pub trait MdxModel {
    fn run(&mut self, input: &[f32], dims: [usize; 4]) -> Result<Vec<f32>, HostError>;
}

/// Pilihan `separate` — cermin `MdxSeparateOptions` TS tanpa callback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SeparateOptions {
    /// 0 (tidak ditawarkan UI, lihat docs/26 §1 temuan P0), 0,25, atau 0,5.
    pub overlap: f32,
    /// Model dijalankan pada `x` dan `−x`, hasil `(y⁺ − y⁻)/2`. Biaya 2×.
    pub denoise: bool,
    /// `false` → instrumental = `mix − vokal` tanpa pengali `params.compensate`.
    pub compensate: bool,
}

/// Hasil: empat channel sepanjang input.
#[derive(Clone, Debug, PartialEq)]
pub struct Separated {
    pub vocals_l: Vec<f32>,
    pub vocals_r: Vec<f32>,
    pub inst_l: Vec<f32>,
    pub inst_r: Vec<f32>,
}

/// Panjang mix setelah pad depan `trim` dan pad belakang `gen + trim − (len mod gen)`.
pub fn padded_length(length: usize, params: &MdxParams) -> usize {
    let segment = params.samples_per_segment();
    let trim = params.trim();
    let gen = segment - 2 * trim;
    let pad = gen + trim - (length % gen);
    trim + length + pad
}

/// `floor((1 − overlap) × segment)` — 195 840 untuk 0,25; 130 560 untuk 0,5.
pub fn segment_step(params: &MdxParams, overlap: f32) -> Result<usize, HostError> {
    if !(0.0..1.0).contains(&overlap) {
        return Err(HostError::Invalid(format!(
            "overlap {overlap} harus di [0, 1)"
        )));
    }
    let step = ((1.0 - overlap as f64) * params.samples_per_segment() as f64).floor() as usize;
    if step == 0 {
        return Err(HostError::Invalid(format!(
            "overlap {overlap} terlalu besar"
        )));
    }
    Ok(step)
}

/// Jumlah segmen = jumlah laporan progres: `ceil(paddedLength / step)`.
pub fn segment_count(length: usize, params: &MdxParams, overlap: f32) -> Result<usize, HostError> {
    let step = segment_step(params, overlap)?;
    Ok(padded_length(length, params).div_ceil(step))
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), HostError> {
    if cancel.load(Ordering::Relaxed) {
        Err(HostError::Cancelled)
    } else {
        Ok(())
    }
}

/// `demix` + `run_model` python-audio-separator — urutan persis
/// `separateMdx` di `mdx-separate.ts` (lihat kepala modul).
///
/// `progress(done, total)` dipanggil sekali per segmen; `cancel` diperiksa
/// sebelum tiap segmen dan setelah model kembali → [`HostError::Cancelled`].
pub fn separate(
    model: &mut dyn MdxModel,
    params: &MdxParams,
    left: &[f32],
    right: &[f32],
    opts: &SeparateOptions,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<Separated, HostError> {
    let length = left.len();
    if right.len() != length {
        return Err(HostError::Invalid(format!(
            "panjang channel berbeda: {length} vs {}",
            right.len()
        )));
    }
    let compensate = if opts.compensate {
        params.compensate
    } else {
        1.0
    };
    let segment = params.samples_per_segment();
    let frames = params.frames_per_segment();
    let trim = params.trim();
    let total = padded_length(length, params);
    let step = segment_step(params, opts.overlap)?;
    let dims = [1, 4, params.dim_f, frames];
    let mut stft = MdxStft::from_params(params)?;

    check_cancel(cancel)?;

    // Mix terpad: [nol × trim, mix, nol × pad].
    let mut mix_l = vec![0f32; total];
    let mut mix_r = vec![0f32; total];
    mix_l[trim..trim + length].copy_from_slice(left);
    mix_r[trim..trim + length].copy_from_slice(right);

    let mut acc_l = vec![0f64; total];
    let mut acc_r = vec![0f64; total];
    let mut divider = vec![0f64; total];

    // Buffer per segmen, dialokasikan sekali.
    let mut seg_l = vec![0f32; segment];
    let mut seg_r = vec![0f32; segment];
    let mut out_l = vec![0f32; segment];
    let mut out_r = vec![0f32; segment];
    let mut spec = vec![0f32; stft.spec_size(frames)];
    let mut negated = if opts.denoise {
        vec![0f32; spec.len()]
    } else {
        Vec::new()
    };
    let mut full_window: Option<Vec<f64>> = None;

    let segments = total.div_ceil(step) as u64;
    let mut done = 0u64;
    let mut start = 0;
    while start < total {
        check_cancel(cancel)?;
        let end = (start + segment).min(total);
        let actual = end - start;

        seg_l.fill(0.0);
        seg_r.fill(0.0);
        seg_l[..actual].copy_from_slice(&mix_l[start..end]);
        seg_r[..actual].copy_from_slice(&mix_r[start..end]);

        stft.forward(&seg_l, &seg_r, &mut spec)?;
        zero_low_bins(&mut spec, params.dim_f, frames, 3);

        let predicted = if opts.denoise {
            for (n, s) in negated.iter_mut().zip(&spec) {
                *n = -s;
            }
            let mut positive = model.run(&spec, dims)?;
            check_cancel(cancel)?;
            let negative = model.run(&negated, dims)?;
            if positive.len() != spec.len() || negative.len() != spec.len() {
                return Err(model_length_error(
                    positive.len().max(negative.len()),
                    spec.len(),
                ));
            }
            for (p, n) in positive.iter_mut().zip(&negative) {
                *p = (0.5 * *p as f64 - 0.5 * *n as f64) as f32;
            }
            positive
        } else {
            model.run(&spec, dims)?
        };
        check_cancel(cancel)?;
        if predicted.len() != spec.len() {
            return Err(model_length_error(predicted.len(), spec.len()));
        }

        stft.inverse(&predicted, frames, &mut out_l, &mut out_r, None)?;

        if opts.overlap == 0.0 {
            for n in 0..actual {
                acc_l[start + n] += out_l[n] as f64;
                acc_r[start + n] += out_r[n] as f64;
                divider[start + n] += 1.0;
            }
        } else {
            let partial;
            let window: &[f64] = if actual == segment {
                full_window.get_or_insert_with(|| hanning_symmetric(segment))
            } else {
                partial = hanning_symmetric(actual);
                &partial
            };
            for n in 0..actual {
                let w = window[n];
                acc_l[start + n] += out_l[n] as f64 * w;
                acc_r[start + n] += out_r[n] as f64 * w;
                divider[start + n] += w;
            }
        }

        done += 1;
        progress(done, segments);
        start += step;
    }

    let mut vocals_l = vec![0f32; length];
    let mut vocals_r = vec![0f32; length];
    let mut inst_l = vec![0f32; length];
    let mut inst_r = vec![0f32; length];
    for n in 0..length {
        let d = divider[trim + n];
        let vl = if d > 0.0 { acc_l[trim + n] / d } else { 0.0 };
        let vr = if d > 0.0 { acc_r[trim + n] / d } else { 0.0 };
        vocals_l[n] = vl as f32;
        vocals_r[n] = vr as f32;
        inst_l[n] = (left[n] as f64 - vl * compensate) as f32;
        inst_r[n] = (right[n] as f64 - vr * compensate) as f32;
    }

    Ok(Separated {
        vocals_l,
        vocals_r,
        inst_l,
        inst_r,
    })
}

fn model_length_error(got: usize, expected: usize) -> HostError {
    HostError::Inference(format!(
        "model mengembalikan {got} elemen, diharapkan {expected}"
    ))
}

// ------------------------------------------------------------ ORT

/// Akselerator inferensi. `CoreMl` hanya ada artinya di macOS; di platform
/// lain [`OrtMdxModel::load`] menolaknya dengan `Invalid`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Accel {
    Cpu { threads: usize },
    CoreMl,
}

impl Accel {
    /// Nama akselerator yang bisa diminta di mesin ini — kontrak
    /// `vocal_split_accels`: `["cpu"]` atau `["cpu", "coreml"]` di macOS.
    pub fn available() -> &'static [&'static str] {
        if cfg!(target_os = "macos") {
            &["cpu", "coreml"]
        } else {
            &["cpu"]
        }
    }

    /// Dari nama kontrak (`cpu` | `coreml`) dan jumlah thread CPU opsional.
    pub fn parse(name: &str, threads: Option<usize>) -> Result<Self, HostError> {
        match name {
            "cpu" => Ok(Accel::Cpu {
                threads: threads.unwrap_or(DEFAULT_THREADS).max(1),
            }),
            "coreml" if cfg!(target_os = "macos") => Ok(Accel::CoreMl),
            "coreml" => Err(HostError::Invalid(
                "akselerator coreml hanya tersedia di macOS".into(),
            )),
            other => Err(HostError::Invalid(format!(
                "akselerator tidak dikenal: {other:?}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Accel::Cpu { .. } => "cpu",
            Accel::CoreMl => "coreml",
        }
    }
}

/// Thread intra-op bawaan; sama dengan default dialog TS (`min(4, cores − 2)`
/// pada mesin 8-core).
pub const DEFAULT_THREADS: usize = 4;

/// Nama tensor Kim_Vocal_2 (docs/26 §1). Diverifikasi saat load, bukan
/// dipercaya buta.
const INPUT_NAME: &str = "input";
const OUTPUT_NAME: &str = "output";
/// Nama dimensi batch bebas di kedua tensor (`dim_param` ONNX).
const BATCH_DIM: &str = "batch_size";

/// Sesi ONNX Runtime untuk satu model MDX.
pub struct OrtMdxModel {
    session: ort::session::Session,
    input_name: String,
    output_name: String,
    accel: Accel,
    coreml_registered: bool,
}

impl OrtMdxModel {
    /// Muat model dari `path`. `CoreMl`: EP CoreML didaftarkan dengan
    /// `error_on_failure`; kalau pendaftaran gagal, sesi dibangun ulang CPU
    /// dan [`coreml_registered`](Self::coreml_registered) `false`. Node yang
    /// tidak didukung CoreML jatuh ke CPU per node — itu urusan ORT.
    pub fn load(path: &Path, accel: Accel) -> Result<Self, HostError> {
        // Dimensi batch dipatok HANYA untuk CoreML — lihat `load_with`.
        Self::load_with(path, accel, matches!(accel, Accel::CoreMl))
    }

    /// `pin_batch`: patok dimensi bebas `batch_size` = 1 supaya seluruh bentuk
    /// statis. CoreML butuh ini — tanpanya ia menolak mengompilasi subgraf
    /// ("input has unbounded dimension") dan menjatuhkannya ke CPU; dengan
    /// pin, per segmen 366 → 349 ms. Di CPU justru SEBALIKNYA: dengan pin
    /// 1 455 ms, tanpa pin 1 018 ms (diukur A/B dalam satu proses, M4) —
    /// bentuk statis mengubah pilihan kernel/fusi ORT ke yang lebih lambat.
    /// Maka `load` memutuskan per akselerator; parameter ini dibuka
    /// `pub(crate)` supaya tes benchmark bisa mengukur keduanya.
    pub(crate) fn load_with(path: &Path, accel: Accel, pin_batch: bool) -> Result<Self, HostError> {
        let mut coreml_registered = false;
        let builder = match accel {
            Accel::Cpu { threads } => {
                ort::session::Session::builder()?.with_intra_threads(threads.max(1))?
            }
            Accel::CoreMl => {
                #[cfg(target_os = "macos")]
                {
                    use ort::ep::coreml::{ComputeUnits, ModelFormat};
                    let ep = ort::ep::CoreML::default()
                        .with_model_format(ModelFormat::MLProgram)
                        .with_compute_units(ComputeUnits::All)
                        .build()
                        .error_on_failure();
                    match ort::session::Session::builder()?.with_execution_providers([ep]) {
                        Ok(builder) => {
                            coreml_registered = true;
                            builder
                        }
                        Err(e) => {
                            eprintln!(
                                "vocal-split: EP CoreML gagal didaftarkan, jatuh ke CPU: {e}"
                            );
                            e.recover().with_intra_threads(DEFAULT_THREADS)?
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Err(HostError::Invalid(
                        "akselerator coreml hanya tersedia di macOS".into(),
                    ));
                }
            }
        };
        let builder = if pin_batch {
            builder.with_dimension_override(BATCH_DIM, 1)?
        } else {
            builder
        };
        let session = builder
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
            .commit_from_file(path)?;

        let input_name = find_outlet(session.inputs(), INPUT_NAME, "input")?;
        let output_name = find_outlet(session.outputs(), OUTPUT_NAME, "output")?;
        Ok(Self {
            session,
            input_name,
            output_name,
            accel,
            coreml_registered,
        })
    }

    pub fn accel(&self) -> Accel {
        self.accel
    }

    /// `true` hanya kalau EP CoreML benar-benar terdaftar di sesi ini.
    pub fn coreml_registered(&self) -> bool {
        self.coreml_registered
    }
}

fn find_outlet(
    outlets: &[ort::value::Outlet],
    want: &str,
    kind: &str,
) -> Result<String, HostError> {
    if outlets.iter().any(|o| o.name() == want) {
        return Ok(want.to_owned());
    }
    let names: Vec<&str> = outlets.iter().map(|o| o.name()).collect();
    Err(HostError::Inference(format!(
        "model tidak punya {kind} bernama {want:?}; yang ada: {names:?}"
    )))
}

impl MdxModel for OrtMdxModel {
    fn run(&mut self, input: &[f32], dims: [usize; 4]) -> Result<Vec<f32>, HostError> {
        let expected: usize = dims.iter().product();
        if input.len() != expected {
            return Err(HostError::Invalid(format!(
                "tensor {} elemen tidak cocok dengan dims {dims:?}",
                input.len()
            )));
        }
        let shape: [i64; 4] = dims.map(|d| d as i64);
        // Tanpa salinan: tensor meminjam `input` selama `run`.
        let tensor = ort::value::TensorRef::from_array_view((shape, input))?;
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => tensor])?;
        let value = outputs.get(self.output_name.as_str()).ok_or_else(|| {
            HostError::Inference(format!("keluaran {:?} tidak ada", self.output_name))
        })?;
        let (out_shape, data) = value.try_extract_tensor::<f32>()?;
        if data.len() != expected {
            return Err(HostError::Inference(format!(
                "bentuk keluaran {:?} ≠ {shape:?}",
                &out_shape[..]
            )));
        }
        Ok(data.to_vec())
    }
}

/// `ort::Error<R>` membawa `SessionBuilder` untuk dipulihkan (`R`); di sini
/// hanya pesannya yang dipakai.
impl<R> From<ort::Error<R>> for HostError {
    fn from(e: ort::Error<R>) -> Self {
        HostError::Inference(e.to_string())
    }
}

// ------------------------------------------------------------ Engine

/// Cache sesi: satu [`OrtMdxModel`] per `(model, accel)`, dipegang crate
/// Tauri di `AppState` di balik `Mutex` — job kedua saat job berjalan
/// ditolak `BUSY` oleh `try_lock`, bukan diantre.
#[derive(Default)]
pub struct VocalSplitEngine {
    sessions: HashMap<(ModelId, Accel), OrtMdxModel>,
}

impl VocalSplitEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sesi untuk `(id, accel)`, dimuat dari `path` sekali lalu dipakai ulang.
    pub fn model(
        &mut self,
        path: &Path,
        id: ModelId,
        accel: Accel,
    ) -> Result<&mut OrtMdxModel, HostError> {
        match self.sessions.entry((id, accel)) {
            Entry::Occupied(entry) => Ok(entry.into_mut()),
            Entry::Vacant(entry) => Ok(entry.insert(OrtMdxModel::load(path, accel)?)),
        }
    }

    /// Buang semua sesi (mis. setelah model diganti di disk).
    pub fn clear(&mut self) {
        self.sessions.clear();
    }
}
