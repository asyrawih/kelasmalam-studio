//! `daw-analysis` — analisis materi audio yang berjalan OFFLINE.
//!
//! Crate ini sengaja terpisah dari `daw-dsp`. `daw-dsp` terikat aturan realtime
//! (nol alokasi, nol panic, nol `dyn`); yang di sini justru butuh mengalokasi
//! buffer sepanjang lagu dan melakukan beberapa lintasan penuh atasnya.
//! Menggabungkannya berarti aturan realtime di `daw-dsp` tidak lagi bisa dibaca
//! sebagai janji.
//!
//! Isinya saat ini satu hal: deteksi tempo (BPM) gaya DJ — lihat [`detect_bpm`].
//! Jalannya sekali per asset saat import, di dalam Web Worker, bukan di thread
//! audio dan bukan di main thread.

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod odf;
pub mod tempo;

pub use odf::{Odf, ODF_RATE};
pub use tempo::{BpmEstimate, BPM_MAX, BPM_MIN, MIN_SECONDS, PREFERRED_BPM};

/// Deteksi tempo dari PCM planar.
///
/// `right` boleh kosong untuk materi mono; kalau panjangnya sama dengan `left`
/// keduanya di-downmix. Mengembalikan `None` kalau materi terlalu pendek
/// ([`MIN_SECONDS`]) atau tidak punya variasi sama sekali.
///
/// Biayanya satu lintasan filterbank atas seluruh materi (enam biquad per
/// sample) plus autokorelasi atas ODF yang 200×  lebih pendek. Untuk lagu lima
/// menit di 48 kHz itu ratusan milidetik — alasan kenapa ini WAJIB di worker.
pub fn detect_bpm(left: &[f32], right: &[f32], sample_rate: f32) -> Option<BpmEstimate> {
    let odf = odf::analyze(left, right, sample_rate)?;
    tempo::estimate(&odf)
}
