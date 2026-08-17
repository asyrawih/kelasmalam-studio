//! Dev-only host: menjalankan `daw_engine::Engine` di atas device audio default
//! lewat cpal, supaya engine bisa didengar, di-`dbg!`, dan di-profil dengan
//! perkakas native (lldb, `cargo flamegraph`, perf) — hal yang praktis mustahil
//! di dalam AudioWorklet. Lihat docs/04-build.md.
//!
//! Jalankan: `cargo run -p daw-native-host --release`
//!
//! Binary ini TIDAK ikut ke produksi dan tidak pernah di-build ke wasm.

use std::sync::mpsc;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use daw_engine::Engine;
use daw_rt::MAX_BLOCK;

/// `Engine` bukan `Send` karena `AssetTable` menyimpan raw pointer ke PCM
/// (di WASM: shared linear memory). Itu batasan yang benar untuk kasus umum —
/// kita TIDAK menyatakan `Engine: Send` secara global.
///
/// Di host dev ini situasinya sempit dan bisa dibuktikan aman: engine dipindah
/// SEKALI ke dalam audio callback cpal, dan setelah itu hanya thread audio
/// tersebut yang pernah menyentuhnya — tidak ada handle lain yang tersisa.
/// Ini invariant yang sama dengan yang dipegang worklet (docs/01 §1c).
struct SendEngine(Engine);

// SAFETY: lihat komentar di atas — kepemilikan eksklusif satu thread setelah
// dipindahkan; tidak ada alias ke PCM yang ditunjuk AssetTable di host ini
// (host dev belum memuat asset sama sekali).
unsafe impl Send for SendEngine {}

impl SendEngine {
    /// Dipanggil lewat wrapper, BUKAN `engine.0.render_block(..)`.
    /// Edition 2021 punya "precise capture": `engine.0.render_block(..)` di dalam
    /// closure hanya menangkap field `.0` (yaitu `Engine`, yang bukan `Send`),
    /// sehingga `unsafe impl Send` di wrapper jadi sia-sia. Memanggil method pada
    /// `engine` memaksa closure menangkap struct utuh.
    #[inline]
    fn render_block(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.0.render_block(l, r);
    }
}

fn main() -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow!("tidak ada output device default"))?;
    let supported = device
        .default_output_config()
        .context("gagal membaca config output default")?;

    println!("device : {}", device.name().unwrap_or_else(|_| "?".into()));
    println!("config : {supported:?}");

    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();

    // Channel error: callback audio TIDAK boleh panic/println, jadi error
    // dikirim ke main thread lewat mpsc dan dilaporkan di sana.
    let (err_tx, err_rx) = mpsc::channel::<String>();

    match sample_format {
        SampleFormat::F32 => run::<f32>(&device, &config, err_tx)?,
        SampleFormat::I16 => run::<i16>(&device, &config, err_tx)?,
        SampleFormat::U16 => run::<u16>(&device, &config, err_tx)?,
        other => return Err(anyhow!("format sample tidak didukung: {other:?}")),
    }

    println!("playing — Ctrl-C untuk berhenti");
    // Stream hidup selama `run` belum kembali... tapi `run` mengembalikan
    // stream-nya lewat forget di dalam; di sini kita cukup blok di rx.
    if let Ok(msg) = err_rx.recv() {
        eprintln!("stream error: {msg}");
    }
    Ok(())
}

/// Bangun stream output dan mulai memutar. Stream sengaja di-`std::mem::forget`
/// agar tetap hidup setelah fungsi ini kembali (host ini memang berjalan sampai
/// proses dibunuh).
fn run<T>(device: &cpal::Device, config: &StreamConfig, err_tx: mpsc::Sender<String>) -> Result<()>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    let sample_rate = config.sample_rate.0;
    let channels = config.channels as usize;

    // SATU-SATUNYA titik alokasi engine (docs/00). Semua sisanya zero-alloc.
    let mut engine = SendEngine(Engine::new(sample_rate, MAX_BLOCK));

    // Buffer planar milik host; engine menulis ke sini, lalu kita interleave.
    // Dialokasikan sekali di luar callback — jangan pernah alokasi di dalamnya.
    let mut buf_l = vec![0.0f32; MAX_BLOCK];
    let mut buf_r = vec![0.0f32; MAX_BLOCK];

    let stream = device.build_output_stream(
        config,
        move |out: &mut [T], _: &cpal::OutputCallbackInfo| {
            let frames_total = out.len() / channels;
            let mut done = 0usize;

            // cpal bisa meminta lebih dari MAX_BLOCK frame sekaligus
            // (mis. ALSA dengan buffer besar), jadi pecah jadi beberapa blok.
            while done < frames_total {
                let n = (frames_total - done).min(MAX_BLOCK);
                engine.render_block(&mut buf_l[..n], &mut buf_r[..n]);

                for i in 0..n {
                    let base = (done + i) * channels;
                    let frame = &mut out[base..base + channels];
                    match channels {
                        1 => frame[0] = T::from_sample(0.5 * (buf_l[i] + buf_r[i])),
                        _ => {
                            frame[0] = T::from_sample(buf_l[i]);
                            frame[1] = T::from_sample(buf_r[i]);
                            // Channel surround (kalau ada) dibiarkan senyap.
                            for s in &mut frame[2..] {
                                *s = T::from_sample(0.0f32);
                            }
                        }
                    }
                }
                done += n;
            }
        },
        move |err| {
            // Callback error cpal berjalan di thread lain; cukup teruskan.
            let _ = err_tx.send(err.to_string());
        },
        None, // tanpa timeout
    )?;

    stream.play().context("gagal memulai stream")?;
    std::mem::forget(stream);
    Ok(())
}
