# API Contract (dipatuhi semua crate — jangan diubah tanpa update dokumen ini)

Edition 2021. Semua crate `#![no_std]`-compatible kecuali `export`, `wasm-bridge`,
`native-host`. Nama crate di Cargo: `daw-dsp`, `daw-rt`, `daw-timeline`,
`daw-engine`, `daw-export`, `daw-wasm` (dir: `crates/{dsp,rt,timeline-core,engine,export,wasm-bridge}`).

## Konstanta global (`daw-rt`)

```rust
pub const MAX_BLOCK: usize   = 1024;   // ukuran scratch; render_block menerima frames <= ini
pub const MAX_TRACKS: usize  = 32;
pub const MAX_VOICES: usize  = 256;
pub const MAX_BUFFERS: usize = 16;     // scratch stereo
pub const CMD_CAPACITY: usize = 1024;  // power of two
pub const PPQ: u64 = 960;
```

## `daw-dsp`

```rust
// smooth.rs
pub struct Smoother { .. }
impl Smoother {
    pub fn new(sample_rate: f32, tau_ms: f32, init: f32) -> Self;
    pub fn set_target(&mut self, v: f32);
    pub fn set_immediate(&mut self, v: f32);
    #[inline(always)] pub fn next(&mut self) -> f32;
    pub fn flush_denormal(&mut self);       // panggil 1x per blok
}

// biquad.rs
pub struct Coeffs { pub b0: f32, pub b1: f32, pub b2: f32, pub a1: f32, pub a2: f32 } // sudah dinormalisasi a0
pub enum FilterKind { LowPass, HighPass, LowShelf, HighShelf, Peaking, Notch, AllPass, BandPass }
impl Coeffs {
    pub fn design(kind: FilterKind, sample_rate: f32, freq_hz: f32, q: f32, gain_db: f32) -> Coeffs;
}
pub struct Biquad { s1: f32, s2: f32 }     // TDF-II, state saja
impl Biquad {
    pub const fn new() -> Self;
    pub fn reset(&mut self);
    #[inline(always)] pub fn tick(&mut self, x: f32, c: &Coeffs) -> f32;
    pub fn process(&mut self, buf: &mut [f32], c: &Coeffs);   // in-place, flush denormal di akhir
}

// comp.rs
pub enum Detector { Peak, Rms }
pub struct CompParams { pub threshold_db: f32, pub ratio: f32, pub knee_db: f32,
                        pub attack_ms: f32, pub release_ms: f32, pub makeup_db: f32,
                        pub detector: Detector, pub auto_makeup: bool }
pub struct Compressor { .. }
impl Compressor {
    pub fn new(sample_rate: f32) -> Self;
    pub fn set_params(&mut self, p: &CompParams);
    /// stereo linked; mengembalikan gain reduction maksimum (dB, positif) di blok ini
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> f32;
}

// mix.rs — semua planar, panjang sama
pub fn add_scaled(dst: &mut [f32], src: &[f32], gain: f32);
pub fn add_scaled_ramp(dst: &mut [f32], src: &[f32], g0: f32, g1: f32);
pub fn copy_scaled(dst: &mut [f32], src: &[f32], gain: f32);
pub fn clear(dst: &mut [f32]);
pub fn peak(buf: &[f32]) -> f32;
pub fn rms(buf: &[f32]) -> f32;
// versi SIMD di balik #[cfg(target_feature = "simd128")], fallback scalar identik secara numerik-toleran

// resample.rs
#[inline(always)] pub fn hermite4(y_m1: f32, y0: f32, y1: f32, y2: f32, t: f32) -> f32;
pub struct FracCursor { pub pos: f64, pub ratio: f64 }   // lihat docs/07

// fastmath.rs
pub fn fast_log2(x: f32) -> f32;
pub fn fast_exp2(x: f32) -> f32;
pub fn db_to_lin(db: f32) -> f32;
pub fn lin_to_db(x: f32) -> f32;
```

## `daw-rt`

```rust
// layout.rs — offset SAB, HARUS cocok dengan web/src/audio/sab-layout.ts
pub mod off { pub const TRANSPORT_SEQ: usize = 0x0000; /* dst, lihat docs/01 */ }

// ring.rs
#[repr(C)] #[derive(Clone, Copy)]
pub struct Command { pub op: u8, pub flags: u8, pub target: u16, pub param: u32,
                     pub at_sample: u64 }   // 16 byte
pub struct SpscProducer { .. }   // dipakai sisi non-RT (opsional; JS juga bisa jadi producer)
pub struct SpscConsumer { .. }
impl SpscConsumer {
    /// # Safety: base harus menunjuk ke shared memory dengan layout dari layout.rs
    pub unsafe fn from_raw(base: *mut u8) -> Self;
    pub fn pop(&mut self) -> Option<Command>;
}

// seqlock.rs
pub struct SeqWriter { .. }   pub struct SeqReader { .. }

// pool.rs
pub struct Pool<T> { .. }     // alloc()/free()/iter_active(), zero alloc setelah new()
```

## `daw-timeline`

```rust
// Dua koordinat space — TYPE-SAFE, tidak boleh saling ditukar tanpa konversi eksplisit
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)] pub struct SourceSample(pub u64);
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)] pub struct TimelineSample(pub u64);

pub struct Viewport { pub start: TimelineSample, pub px_per_sample: f64, pub width_px: f32 }
pub fn sample_to_px(s: TimelineSample, v: &Viewport) -> f32;
pub fn px_to_sample(px: f32, v: &Viewport) -> TimelineSample;

pub struct TempoMap { .. }
pub fn tick_to_sample(map: &TempoMap, tick: u64, sr: u32) -> TimelineSample;
pub fn sample_to_tick(map: &TempoMap, s: TimelineSample, sr: u32) -> u64;
pub fn snap(s: TimelineSample, grid: Grid, map: &TempoMap, sr: u32) -> TimelineSample;

// model.rs — Clip/Track/Project (serde, lihat docs/06)
```

## `daw-engine`

```rust
pub struct Engine { .. }
impl Engine {
    pub fn new(sample_rate: u32, max_frames: usize) -> Self;      // SATU-SATUNYA titik alokasi
    pub fn from_snapshot(bytes: &[u8], sample_rate: u32) -> Result<Self, EngineError>;
    pub fn apply(&mut self, cmd: Command);                        // non-RT juga pakai ini
    /// JALUR RENDER SATU-SATUNYA. Dipakai realtime DAN offline. Zero alloc, no panic.
    pub fn render_block(&mut self, out_l: &mut [f32], out_r: &mut [f32]);
    pub fn transport(&self) -> &Transport;
    pub fn seek(&mut self, pos: TimelineSample);
}
```

## `daw-export`

```rust
pub struct OfflineRenderer { .. }
impl OfflineRenderer {
    pub fn new(engine: Engine, start: TimelineSample, end: TimelineSample) -> Self;
    /// render N blok; mengembalikan frame yang dihasilkan (0 = selesai)
    pub fn render_batch(&mut self, blocks: usize, out_l: &mut [f32], out_r: &mut [f32]) -> usize;
    pub fn total_frames(&self) -> u64;
    pub fn rendered_frames(&self) -> u64;
}
pub enum WavFormat { Pcm16, Pcm24, Float32 }
pub struct WavStreamWriter { .. }   // header patch + chunk 4 MiB, lihat docs/03b
```

## Aturan yang mengikat

1. `dsp`, `rt`, `timeline-core`, `engine`, `export` **tidak boleh** bergantung
   pada `wasm-bindgen`, `web-sys`, `js-sys`.
2. Tidak ada alokasi, `panic!`, `unwrap`, `expect`, `format!` di jalur
   `render_block` dan turunannya.
3. Semua buffer **planar** (`&[f32]` per channel). Interleave hanya di WAV writer.
4. Angka posisi selalu integer sample (`u64`), tidak pernah detik float.
