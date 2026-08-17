//! `daw-rt` — primitif realtime & shared-memory untuk DawOnWeb.
//!
//! Isinya hal-hal yang harus benar secara *ordering*, bukan secara DSP:
//! - [`layout`] — peta byte SharedArrayBuffer kontrol (docs/01 §1b).
//! - [`ring`] — ring SPSC command UI→audio, wait-free di sisi audio.
//! - [`seqlock`] — publikasi transport/meter audio→UI tanpa pernah memblok
//!   penulis.
//! - [`pool`] — pool kapasitas tetap untuk voice, nol alokasi setelah `new()`.
//! - [`rt_guard`] — (fitur `rt-guard`) allocator penjaga untuk membuktikan di
//!   CI bahwa jalur render tidak mengalokasi.
//!
//! Crate ini `no_std`-compatible dan **tidak** bergantung pada `alloc`.
//! Fitur `std` hanya untuk tes.

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_op_in_unsafe_fn)]

pub mod layout;
pub mod pool;
pub mod ring;
pub mod seqlock;

#[cfg(feature = "rt-guard")]
pub mod rt_guard;

pub use layout::{layout_json, off, CACHE_LINE, SAB_SIZE};
pub use pool::{Handle, Pool};
pub use ring::{Command, SpscConsumer, SpscProducer};
pub use seqlock::{SeqReader, SeqWriter};

// ───────────────────── konstanta global (docs/00) ─────────────────────

/// Ukuran scratch maksimum; `render_block` menerima `frames <= MAX_BLOCK`.
///
/// 1024 dan bukan 128: render **offline** (export) memakai jalur render yang
/// sama dengan realtime, dan di sana blok besar jauh lebih efisien. Realtime
/// tetap memanggilnya dengan 128 (render quantum WebAudio).
pub const MAX_BLOCK: usize = 1024;

/// Batas atas track. Menentukan ukuran array meter di SAB (32 + master = 33).
pub const MAX_TRACKS: usize = 32;

/// Batas atas voice yang berbunyi bersamaan. Kalau habis: voice stealing,
/// bukan alokasi.
pub const MAX_VOICES: usize = 256;

/// Jumlah scratch buffer stereo yang di-pre-alokasi. Kebutuhan sebenarnya untuk
/// graph target cuma 4 (docs/02 §2a); 16 adalah cadangan supaya graph
/// bercabang tetap muat tanpa pernah mengalokasi di RT.
pub const MAX_BUFFERS: usize = 16;

/// Kapasitas ring command. **Pangkat dua** — index dibungkus dengan mask.
pub const CMD_CAPACITY: usize = 1024;

/// Pulses per quarter note. 960 (bukan 480) supaya triplet dan not 1/128
/// representable secara eksak.
pub const PPQ: u64 = 960;

// Konstanta di sini dan di `layout` harus sepakat — kalau tidak, ring akan
// mem-baca di luar blok datanya.
const _: () = {
    assert!(CMD_CAPACITY == layout::CMD_CAPACITY);
    assert!(CMD_CAPACITY.is_power_of_two());
    assert!(MAX_TRACKS + 1 == layout::METER_COUNT);
    assert!(MAX_BLOCK.is_power_of_two());
};

/// Tipe voice pool berukuran standar proyek.
pub type VoicePool<T> = Pool<T, MAX_VOICES>;
