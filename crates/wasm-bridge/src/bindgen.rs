//! Surface BINDGEN — main thread & Web Worker. **Tidak realtime.**
//!
//! Boleh: `String`, `Vec`, `Result`, alokasi, `JsValue`. Dilarang: dipanggil
//! dari AudioWorklet (semua fungsi di sini bisa alokasi → `memory.grow` →
//! view JS basi, dan sebagian membangun string).
//!
//! Yang ada di sini:
//! - load/serialize project snapshot (postcard, docs/03 §3a),
//! - offline renderer untuk export worker,
//! - WAV encoder streaming (docs/03 §3b) + FLAC (lossless, terkompresi),
//! - import/decode asset PCM + peak pyramid,
//! - deteksi tempo (BPM) untuk readout gaya DJ,
//! - alokasi blok kontrol + info build (untuk `wasm-loader.ts`).

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

use daw_engine::Engine;
use daw_export::flac::{FlacBits, FlacSpec, FlacStreamWriter};
use daw_export::wav::{DitherSettings, WavFormat, WavSpec, WavStreamWriter};
use daw_export::OfflineRenderer;
use daw_timeline::TimelineSample;

/// Dipanggil sekali oleh `wasm-loader.ts` segera setelah instantiate di main
/// thread / worker. Memasang panic hook (docs: hanya di jalur non-RT).
#[wasm_bindgen(js_name = initNonRealtime)]
pub fn init_non_realtime() {
    crate::set_panic_hook();
}

/// Versi ABI — dicocokkan dengan konstanta di `wasm-loader.ts`.
#[wasm_bindgen(js_name = abiVersion)]
pub fn abi_version_js() -> u32 {
    crate::ABI_VERSION
}

/// Alokasi blok kontrol (wrapper bindgen dari `raw::control_block_alloc`)
/// supaya main thread tidak perlu memanggil export mentah.
/// Mengembalikan offset byte di dalam linear memory.
#[wasm_bindgen(js_name = allocControlBlock)]
pub fn alloc_control_block() -> u32 {
    crate::raw::control_block_alloc() as u32
}

/// Ukuran blok kontrol — JS assert terhadap `SAB_SIZE` di `sab-layout.ts`.
#[wasm_bindgen(js_name = controlBlockSize)]
pub fn control_block_size_js() -> u32 {
    crate::raw::CONTROL_SIZE as u32
}

/// Apakah artefak ini dibangun dengan `+atomics` (varian `mt`)?
/// Loader memakainya untuk memverifikasi bahwa varian yang terpilih memang
/// cocok dengan `crossOriginIsolated`.
#[wasm_bindgen(js_name = buildHasAtomics)]
pub fn build_has_atomics() -> bool {
    cfg!(target_feature = "atomics")
}

/// Apakah artefak ini dibangun dengan `+simd128`?
#[wasm_bindgen(js_name = buildHasSimd)]
pub fn build_has_simd() -> bool {
    cfg!(target_feature = "simd128")
}

// ---------------------------------------------------------------------------
// Snapshot dari model studio (JSON) — docs/03 §3a
// ---------------------------------------------------------------------------

/// Hasil membangun snapshot: byte postcard + peringatan yang WAJIB ditampilkan.
///
/// Dua nilai dalam satu objek, bukan dua panggilan: peringatan lahir dari
/// pemetaan yang sama dengan byte-nya, dan memisahkannya membuka kemungkinan
/// UI memakai snapshot tanpa pernah membaca peringatannya.
#[wasm_bindgen]
pub struct StudioSnapshot {
    bytes: Vec<u8>,
    warnings: Vec<String>,
    clip_count: u32,
}

#[wasm_bindgen]
impl StudioSnapshot {
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    /// Selisih yang TIDAK bisa dinyatakan engine, satu kalimat per baris.
    /// Kosong = file hasil export identik dengan yang didengar user.
    pub fn warnings(&self) -> Vec<JsValue> {
        self.warnings.iter().map(|w| JsValue::from_str(w)).collect()
    }

    /// Jumlah clip yang benar-benar akan berbunyi — UI memakainya untuk
    /// menolak export yang hasilnya pasti senyap.
    #[wasm_bindgen(js_name = clipCount)]
    pub fn clip_count(&self) -> u32 {
        self.clip_count
    }
}

/// Bangun snapshot postcard dari model studio TypeScript.
///
/// TS tidak bisa menghasilkan postcard dengan cara yang aman (tata letaknya
/// ditentukan definisi tipe Rust), jadi ia mengirim JSON dan Rust yang
/// memetakannya. Seluruh pemetaan — beserta daftar selisih antara kedua model —
/// ada di [`crate::studio`].
#[wasm_bindgen(js_name = snapshotFromStudioJson)]
pub fn snapshot_from_studio_json(json: &str) -> Result<StudioSnapshot, JsValue> {
    crate::set_panic_hook();
    let mapping = crate::studio::mapping_from_json(json).map_err(|e| JsValue::from_str(&e))?;
    let clip_count = mapping.project.clips.len() as u32;
    let bytes = mapping
        .project
        .to_bytes()
        .map_err(|e| JsValue::from_str(&format!("encode snapshot gagal: {e:?}")))?;
    Ok(StudioSnapshot {
        bytes,
        warnings: mapping.warnings,
        clip_count,
    })
}

// ---------------------------------------------------------------------------
// Offline render (export worker) — docs/03 §3a
// ---------------------------------------------------------------------------

/// Renderer offline: instance Engine **KEDUA**, dibangun dari snapshot project.
///
/// Kenapa instance kedua dan bukan berbagi engine realtime: state DSP
/// (biquad `s1/s2`, envelope compressor, delay line, cursor voice) berevolusi
/// per blok. Dua thread yang memproses dari state yang sama tidak menghasilkan
/// "sedikit beda" — hasilnya rusak dan non-deterministik (docs/03 §3a).
#[wasm_bindgen]
pub struct OfflineRender {
    inner: OfflineRenderer,
    /// Buffer planar hasil render satu batch. Dialokasi sekali.
    l: Vec<f32>,
    r: Vec<f32>,
    block: usize,
    /// PCM asset yang DIMILIKI renderer ini.
    ///
    /// `AssetTable` engine menyimpan `*const f32` mentah — ia tidak memiliki
    /// datanya. Kalau PCM-nya hidup di `Vec` milik pemanggil JS, pointer itu
    /// menggantung begitu GC/`free()` berjalan dan render membaca memori acak.
    /// Menaruhnya di sini mengikat masa hidup PCM ke masa hidup renderer, yang
    /// persis rentang waktu selama pointer itu dipakai.
    ///
    /// `Box<[f32]>` (bukan `Vec<Vec<f32>>` yang di-push): menambah elemen ke
    /// `Vec` luar memindahkan elemen-elemennya, tapi TIDAK memindahkan buffer
    /// yang ditunjuk `Box` — jadi pointer yang sudah didaftarkan tetap sah.
    assets: Vec<Box<[f32]>>,
}

#[wasm_bindgen]
impl OfflineRender {
    /// `snapshot` = hasil `project.snapshot()` (postcard). `start`/`end` dalam
    /// sample absolut timeline; dilewatkan sebagai `f64` karena JS number aman
    /// sampai 2^53 sample (≈ 5700 tahun @48k) — jauh lebih nyaman dari BigInt
    /// di jalur non-RT.
    #[wasm_bindgen(constructor)]
    pub fn new(
        snapshot: &[u8],
        sample_rate: u32,
        start: f64,
        end: f64,
        blocks_per_batch: u32,
    ) -> Result<OfflineRender, JsValue> {
        crate::set_panic_hook();
        let engine = Engine::from_snapshot(snapshot, sample_rate)
            .map_err(|e| JsValue::from_str(&format!("snapshot tidak valid: {e:?}")))?;
        let inner = OfflineRenderer::new(
            engine,
            TimelineSample(start.max(0.0) as u64),
            TimelineSample(end.max(0.0) as u64),
        );
        let block = (blocks_per_batch.max(1) as usize) * daw_rt::MAX_BLOCK;
        Ok(OfflineRender {
            inner,
            l: vec![0.0; block],
            r: vec![0.0; block],
            block,
            assets: Vec::new(),
        })
    }

    /// Daftarkan PCM satu asset SEBELUM render dimulai.
    ///
    /// Kenapa ini ada: `OfflineRender::new` hanya menerima snapshot, dan
    /// snapshot cuma menyebut asset lewat id — tanpa langkah ini setiap clip
    /// menunjuk slot kosong dan engine merender senyap sempurna, tanpa error.
    ///
    /// `data` = semua channel BERURUTAN (planar): channel `c` mulai di
    /// `c * frames`, sama seperti `importFromPcm`. Datanya DISALIN ke dalam
    /// renderer; view JS boleh dibuang setelah pemanggilan ini.
    #[wasm_bindgen(js_name = registerAsset)]
    pub fn register_asset(
        &mut self,
        id: u32,
        data: &[f32],
        channels: u32,
        frames: u32,
        sample_rate: u32,
    ) -> Result<(), JsValue> {
        let ch = channels.clamp(1, u8::MAX as u32) as usize;
        let n = frames as usize;
        if data.len() < ch * n {
            return Err(JsValue::from_str(&format!(
                "asset {id}: panjang data {} < channels*frames {}",
                data.len(),
                ch * n
            )));
        }
        if id > u16::MAX as u32 {
            return Err(JsValue::from_str(&format!(
                "asset id {id} di luar jangkauan"
            )));
        }

        let owned: Box<[f32]> = data[..ch * n].to_vec().into_boxed_slice();
        let asset = daw_engine::voice::Asset {
            data: owned.as_ptr(),
            frames: n,
            channels: ch as u8,
            sample_rate,
        };
        self.assets.push(owned);
        // SAFETY: `owned` baru saja dipindahkan ke `self.assets` dan tidak
        // pernah dimutasi, dibuang, atau direalokasi selama renderer hidup —
        // `Box<[f32]>` tidak pernah memindahkan buffer-nya. Slot juga tidak
        // pernah di-unregister, jadi pointer valid untuk seluruh masa render.
        unsafe {
            self.inner.engine_mut().register_asset(id as u16, asset);
        }
        Ok(())
    }

    /// Total frame yang akan dirender.
    #[wasm_bindgen(js_name = totalFrames)]
    pub fn total_frames(&self) -> f64 {
        self.inner.total_frames() as f64
    }

    /// Frame yang sudah dirender.
    #[wasm_bindgen(js_name = renderedFrames)]
    pub fn rendered_frames(&self) -> f64 {
        self.inner.rendered_frames() as f64
    }

    /// Render `blocks` blok. Mengembalikan jumlah frame yang dihasilkan;
    /// `0` berarti selesai. Output ada di [`Self::out_l_ptr`] / [`Self::out_r_ptr`].
    pub fn render(&mut self, blocks: u32) -> u32 {
        let blocks = (blocks as usize).min(self.block / daw_rt::MAX_BLOCK);
        self.inner.render_batch(blocks, &mut self.l, &mut self.r) as u32
    }

    /// Pointer buffer L. **Ambil ulang setiap batch** — `render` bisa memicu
    /// `memory.grow` di worker (docs/05).
    #[wasm_bindgen(js_name = outLPtr)]
    pub fn out_l_ptr(&self) -> u32 {
        self.l.as_ptr() as u32
    }

    /// Pointer buffer R.
    #[wasm_bindgen(js_name = outRPtr)]
    pub fn out_r_ptr(&self) -> u32 {
        self.r.as_ptr() as u32
    }

    /// Kapasitas buffer output dalam frame.
    #[wasm_bindgen(js_name = outCapacity)]
    pub fn out_capacity(&self) -> u32 {
        self.block as u32
    }
}

// ---------------------------------------------------------------------------
// WAV encoder streaming — docs/03 §3b
// ---------------------------------------------------------------------------

/// Format WAV yang didukung. Dither TPDF otomatis untuk 16-bit; **tidak pernah**
/// untuk float32 (docs/03 §3b).
#[wasm_bindgen]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum WavBits {
    Pcm16 = 0,
    Pcm24 = 1,
    Float32 = 2,
}

/// Writer WAV yang mengeluarkan chunk ~4 MiB, bukan satu `Vec` raksasa
/// (render 10 menit stereo 24-bit = 172 MB → `memory.grow` besar, dan ruang
/// alamat wasm32 hanya 4 GB).
#[wasm_bindgen]
pub struct WavEncoderHandle {
    inner: WavStreamWriter,
}

#[wasm_bindgen]
impl WavEncoderHandle {
    #[wasm_bindgen(constructor)]
    pub fn new(
        sample_rate: u32,
        channels: u32,
        bits: WavBits,
        dither_seed: u32,
    ) -> WavEncoderHandle {
        let format = match bits {
            WavBits::Pcm16 => WavFormat::Pcm16,
            WavBits::Pcm24 => WavFormat::Pcm24,
            WavBits::Float32 => WavFormat::Float32,
        };
        let spec = WavSpec {
            sample_rate,
            channels: channels.clamp(1, 2) as u16,
            format,
        };
        // Seed dari setelan export → dua export dengan setelan sama
        // menghasilkan file byte-identik (penting untuk tes null, docs/03 §3b).
        let dither = DitherSettings {
            seed: dither_seed as u64 | 1,
            ..DitherSettings::default()
        };
        WavEncoderHandle {
            inner: WavStreamWriter::new(spec, dither),
        }
    }

    /// Header dengan ukuran placeholder. Ditulis lebih dulu; digantikan oleh
    /// [`Self::patch_header`] setelah total byte diketahui.
    pub fn header(&self) -> Vec<u8> {
        self.inner.placeholder_header().to_vec()
    }

    /// Encode satu batch planar. Mengembalikan chunk 4 MiB kalau ambangnya
    /// tercapai, atau kosong. `l`/`r` disalin dari view JS (bukan pointer):
    /// jalur ini tidak realtime dan salinannya ~1 ms per 4 MB.
    pub fn encode(&mut self, l: &[f32], r: &[f32]) -> Vec<u8> {
        self.inner.write_planar(&[l, r]);
        match self.inner.poll_chunk() {
            Some(chunk) => {
                let out = chunk.to_vec();
                self.inner.release_chunk();
                out
            }
            None => Vec::new(),
        }
    }

    /// Sisa chunk terakhir (boleh kosong).
    pub fn flush(&mut self) -> Vec<u8> {
        let out = self.inner.finish().to_vec();
        self.inner.release_chunk();
        out
    }

    /// Header final (RIFF size + data size sudah benar). Main thread menaruhnya
    /// sebagai part pertama Blob, menggantikan header placeholder.
    #[wasm_bindgen(js_name = patchHeader)]
    pub fn patch_header(&self) -> Vec<u8> {
        self.inner.patch_header().to_vec()
    }
}

// ---------------------------------------------------------------------------
// FLAC encoder streaming — lossless, ±setengah ukuran WAV
// ---------------------------------------------------------------------------

/// Kedalaman bit FLAC. Tidak ada float32: FLAC menyimpan integer, dan
/// menawarkan pilihan yang tidak ada di formatnya hanya akan menyesatkan.
#[wasm_bindgen]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FlacBitsJs {
    Pcm16 = 0,
    Pcm24 = 1,
}

/// Writer FLAC dengan bentuk yang SAMA PERSIS dengan [`WavEncoderHandle`]
/// (`header`/`encode`/`flush`/`patchHeader`), supaya `run-export.ts` tidak
/// butuh cabang kedua: satu loop render, banyak encoder.
#[wasm_bindgen]
pub struct FlacEncoderHandle {
    inner: FlacStreamWriter,
}

#[wasm_bindgen]
impl FlacEncoderHandle {
    /// Melempar (bukan panic) kalau parameternya ditolak flacenc — pesannya
    /// sampai ke UI apa adanya.
    #[wasm_bindgen(constructor)]
    pub fn new(
        sample_rate: u32,
        channels: u32,
        bits: FlacBitsJs,
        dither_seed: u32,
    ) -> Result<FlacEncoderHandle, JsError> {
        let spec = FlacSpec {
            sample_rate,
            channels: channels.clamp(1, 2) as u16,
            bits: match bits {
                FlacBitsJs::Pcm16 => FlacBits::Pcm16,
                FlacBitsJs::Pcm24 => FlacBits::Pcm24,
            },
        };
        let dither = DitherSettings {
            seed: dither_seed as u64 | 1,
            ..DitherSettings::default()
        };
        FlacStreamWriter::new(spec, dither)
            .map(|inner| FlacEncoderHandle { inner })
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Header dengan `total_samples`/md5 masih nol. STREAMINFO panjangnya tetap,
    /// jadi [`Self::patch_header`] bisa menggantikannya byte-per-byte.
    pub fn header(&self) -> Result<Vec<u8>, JsError> {
        self.inner
            .placeholder_header()
            .map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn encode(&mut self, l: &[f32], r: &[f32]) -> Result<Vec<u8>, JsError> {
        self.inner
            .write_planar(&[l, r])
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(match self.inner.poll_chunk() {
            Some(chunk) => {
                let out = chunk.to_vec();
                self.inner.release_chunk();
                out
            }
            None => Vec::new(),
        })
    }

    /// Encode frame terakhir (yang boleh lebih pendek) lalu kembalikan sisanya.
    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        let out = self
            .inner
            .finish()
            .map_err(|e| JsError::new(&e.to_string()))?
            .to_vec();
        self.inner.release_chunk();
        Ok(out)
    }

    #[wasm_bindgen(js_name = patchHeader)]
    pub fn patch_header(&self) -> Result<Vec<u8>, JsError> {
        self.inner
            .patch_header()
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Import asset — docs/06
// ---------------------------------------------------------------------------

/// Hasil decode/import satu asset: PCM planar di linear memory + peak pyramid.
#[wasm_bindgen]
pub struct ImportedAsset {
    channels: Vec<Vec<f32>>,
    peaks: Vec<f32>,
    sample_rate: u32,
    frames: u32,
    peak_bucket: u32,
}

#[wasm_bindgen]
impl ImportedAsset {
    #[wasm_bindgen(js_name = sampleRate)]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    pub fn frames(&self) -> u32 {
        self.frames
    }
    pub fn channels(&self) -> u32 {
        self.channels.len() as u32
    }
    /// Pointer PCM channel ke-`ch`. Ambil ulang setelah operasi apa pun yang
    /// bisa alokasi (docs/05).
    #[wasm_bindgen(js_name = channelPtr)]
    pub fn channel_ptr(&self, ch: u32) -> u32 {
        self.channels
            .get(ch as usize)
            .map(|c| c.as_ptr() as u32)
            .unwrap_or(0)
    }
    /// Pointer peak pyramid: pasangan `(min, max)` per bucket, per channel,
    /// disusun `[ch0 buckets..., ch1 buckets...]`.
    #[wasm_bindgen(js_name = peaksPtr)]
    pub fn peaks_ptr(&self) -> u32 {
        self.peaks.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = peaksLen)]
    pub fn peaks_len(&self) -> u32 {
        self.peaks.len() as u32
    }
    /// Jumlah sample per bucket peak level terendah.
    #[wasm_bindgen(js_name = peakBucket)]
    pub fn peak_bucket(&self) -> u32 {
        self.peak_bucket
    }
}

/// Bangun asset dari PCM yang **sudah** ter-decode di JS (jalur
/// `decodeAudioData`): planar f32, satu `Float32Array` per channel yang
/// digabung jadi satu buffer interleaved-per-channel oleh pemanggil.
///
/// `data` = concat semua channel berurutan, panjang `frames * channels`.
#[wasm_bindgen(js_name = importFromPcm)]
pub fn import_from_pcm(
    data: &[f32],
    channels: u32,
    frames: u32,
    sample_rate: u32,
    target_rate: u32,
    peak_bucket: u32,
) -> Result<ImportedAsset, JsValue> {
    crate::set_panic_hook();
    let ch = channels.max(1) as usize;
    let n = frames as usize;
    if data.len() < ch * n {
        return Err(JsValue::from_str("panjang data < channels * frames"));
    }

    // Resample-on-import: seluruh engine bekerja pada satu sample rate
    // (ctx.sampleRate). Menyimpan asset di rate lain berarti resampling
    // per-blok di jalur realtime — mahal dan tidak perlu.
    let ratio = target_rate as f64 / sample_rate.max(1) as f64;
    let out_frames = if (ratio - 1.0).abs() < 1e-9 {
        n
    } else {
        ((n as f64) * ratio).round() as usize
    };

    let mut out: Vec<Vec<f32>> = Vec::with_capacity(ch);
    for c in 0..ch {
        let src = &data[c * n..c * n + n];
        if out_frames == n {
            out.push(src.to_vec());
        } else {
            let mut dst = vec![0.0f32; out_frames];
            let step = 1.0 / ratio;
            for (i, d) in dst.iter_mut().enumerate() {
                let pos = i as f64 * step;
                let i0 = pos.floor() as isize;
                let t = (pos - i0 as f64) as f32;
                let at = |k: isize| -> f32 {
                    let idx = (i0 + k).clamp(0, n as isize - 1) as usize;
                    src[idx]
                };
                *d = daw_dsp_hermite(at(-1), at(0), at(1), at(2), t);
            }
            out.push(dst);
        }
    }

    let bucket = peak_bucket.max(1) as usize;
    let buckets = out_frames.div_ceil(bucket);
    let mut peaks = vec![0.0f32; buckets * 2 * ch];
    for (c, chan) in out.iter().enumerate() {
        for b in 0..buckets {
            let s = b * bucket;
            let e = (s + bucket).min(chan.len());
            let (mut lo, mut hi) = (0.0f32, 0.0f32);
            for &v in &chan[s..e] {
                lo = lo.min(v);
                hi = hi.max(v);
            }
            peaks[(c * buckets + b) * 2] = lo;
            peaks[(c * buckets + b) * 2 + 1] = hi;
        }
    }

    Ok(ImportedAsset {
        channels: out,
        peaks,
        sample_rate: target_rate,
        frames: out_frames as u32,
        peak_bucket: bucket as u32,
    })
}

/// Cubic Hermite lokal — duplikat kecil dari `daw_dsp::resample::hermite4`
/// supaya crate ini tidak menarik `daw-dsp` hanya untuk satu fungsi import.
#[inline(always)]
fn daw_dsp_hermite(y_m1: f32, y0: f32, y1: f32, y2: f32, t: f32) -> f32 {
    let c0 = y0;
    let c1 = 0.5 * (y1 - y_m1);
    let c2 = y_m1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    let c3 = 0.5 * (y2 - y_m1) + 1.5 * (y0 - y1);
    ((c3 * t + c2) * t + c1) * t + c0
}

// ---------------------------------------------------------------------------
// Deteksi tempo (BPM)
// ---------------------------------------------------------------------------

/// Hasil analisis tempo satu asset.
#[wasm_bindgen]
pub struct TempoEstimate {
    bpm: f32,
    confidence: f32,
    beat_offset_sec: f32,
}

#[wasm_bindgen]
impl TempoEstimate {
    /// Ketukan per menit.
    #[wasm_bindgen(getter)]
    pub fn bpm(&self) -> f32 {
        self.bpm
    }

    /// 0..1. UI WAJIB memakainya: angka BPM untuk materi tanpa ketukan jelas
    /// (ambient, rekaman bicara) tidak berarti apa-apa, dan memajangnya seolah
    /// pasti adalah berbohong dengan presisi.
    #[wasm_bindgen(getter)]
    pub fn confidence(&self) -> f32 {
        self.confidence
    }

    /// Detik dari awal materi ke ketukan pertama yang terdeteksi.
    #[wasm_bindgen(getter, js_name = beatOffsetSec)]
    pub fn beat_offset_sec(&self) -> f32 {
        self.beat_offset_sec
    }
}

/// Deteksi tempo dari PCM planar.
///
/// `right` boleh `Float32Array` kosong untuk materi mono. Mengembalikan
/// `undefined` kalau materinya terlalu pendek (< 8 detik) atau senyap — itu
/// BUKAN error, jadi jangan dilempar sebagai exception; "tidak tahu" adalah
/// jawaban yang sah dan UI menampilkannya sebagai "—", bukan sebagai kegagalan.
///
/// WAJIB dipanggil dari Web Worker. Satu lintasan filterbank enam biquad atas
/// seluruh materi memakan ratusan milidetik untuk lagu lima menit; di main
/// thread itu terlihat sebagai UI yang membeku saat file di-drop.
#[wasm_bindgen(js_name = detectTempo)]
pub fn detect_tempo(left: &[f32], right: &[f32], sample_rate: f32) -> Option<TempoEstimate> {
    daw_analysis::detect_bpm(left, right, sample_rate).map(|e| TempoEstimate {
        bpm: e.bpm,
        confidence: e.confidence,
        beat_offset_sec: e.beat_offset_sec,
    })
}
