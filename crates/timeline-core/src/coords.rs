//! Dua koordinat space — pertahanan utama terhadap off-by-one klasik.
//!
//! # Masalahnya
//!
//! Begitu sebuah clip punya `speed_ratio != 1.0`, ada **dua** sumbu waktu yang
//! sama-sama diukur dalam "sample" dan sama-sama `u64`:
//!
//! ```text
//!  SOURCE SPACE  (sumbu asset PCM)          TIMELINE SPACE (sumbu lagu)
//!  ├──────────────────────────────┤          ├──────────────┤
//!  0        source_start          n          0  timeline_pos  timeline_pos+len_tl
//!
//!  ratio = 2.0  →  4 sample source dimakan untuk tiap 2 sample timeline
//! ```
//!
//! Kalau keduanya bertipe `u64` polos, compiler tidak bisa menolong sama sekali:
//! `clip.source_start + drag_delta_pixels_converted` compile dengan sempurna dan
//! salah secara halus — hanya terdengar sebagai "clip meleset sedikit" saat
//! ratio bukan 1.0, yang berarti bug-nya lolos semua tes ratio-1.0.
//!
//! # Solusinya
//!
//! Dua newtype yang **tidak** punya `From<u64>`, `Add<u64>`, atau `Deref`.
//! Untuk membuatnya kamu harus mengetik nama space-nya:
//!
//! ```
//! use daw_timeline::{SourceSample, TimelineSample};
//! let a = SourceSample::new(1024);
//! let b = TimelineSample::new(1024);
//! // let c = a + b;             // ← tidak compile, dan memang tidak masuk akal
//! // let d: SourceSample = 1024.into();  // ← sengaja tidak disediakan
//! ```
//!
//! Konversi antar-space **hanya** lewat [`timeline_to_source`] /
//! [`source_to_timeline`], yang wajib menerima [`ClipGeometry`] — karena
//! konversinya memang mustahil tanpa tahu clip mana yang dimaksud.
//!
//! `raw()` ada, tapi namanya sengaja jelek: kalau kamu melihat `.raw()` di
//! review, itu tanda untuk berhenti dan bertanya "space-nya apa?".

use serde::{Deserialize, Serialize};

/// Posisi dalam **source space**: offset sample di dalam asset PCM.
///
/// Selalu diukur dari sample ke-0 asset, sebelum `speed_ratio` diterapkan.
#[derive(
    Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Default, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct SourceSample(pub u64);

/// Posisi dalam **timeline space**: offset sample dari awal lagu.
///
/// Ini yang dipakai transport, grid, snap, dan semua geometri UI.
#[derive(
    Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Default, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct TimelineSample(pub u64);

macro_rules! impl_space {
    ($t:ident, $doc:literal) => {
        impl $t {
            #[doc = $doc]
            #[inline]
            pub const fn new(v: u64) -> Self {
                Self(v)
            }

            /// Nilai mentah. Namanya sengaja "raw" — pakai hanya di batas
            /// sistem (serialisasi, indexing slice, FFI), jangan untuk aritmatika
            /// lintas space.
            #[inline]
            pub const fn raw(self) -> u64 {
                self.0
            }

            /// Geser maju, saturating. Tetap di space yang sama.
            #[inline]
            pub const fn offset(self, d: u64) -> Self {
                Self(self.0.saturating_add(d))
            }

            /// Geser mundur, saturating (tidak pernah negatif).
            #[inline]
            pub const fn back(self, d: u64) -> Self {
                Self(self.0.saturating_sub(d))
            }

            /// Geser dengan delta bertanda; clamp di 0.
            #[inline]
            pub const fn shift(self, d: i64) -> Self {
                if d >= 0 {
                    Self(self.0.saturating_add(d as u64))
                } else {
                    Self(self.0.saturating_sub(d.unsigned_abs()))
                }
            }

            /// Jarak `self - other` sebagai `u64`, saturating di 0.
            ///
            /// Sengaja bukan `Sub` operator: hasilnya **bukan** posisi, melainkan
            /// durasi, dan tipenya beda. Nama eksplisit mencegah kebingungan itu.
            #[inline]
            pub const fn distance_from(self, other: Self) -> u64 {
                self.0.saturating_sub(other.0)
            }

            /// Jarak bertanda, untuk delta drag.
            #[inline]
            pub fn signed_delta(self, other: Self) -> i64 {
                self.0 as i64 - other.0 as i64
            }

            #[inline]
            pub fn clamp_to(self, lo: Self, hi: Self) -> Self {
                if self.0 < lo.0 {
                    lo
                } else if self.0 > hi.0 {
                    hi
                } else {
                    self
                }
            }
        }
    };
}

impl_space!(
    SourceSample,
    "Buat posisi source-space. Wajib eksplisit — tidak ada `From<u64>`."
);
impl_space!(
    TimelineSample,
    "Buat posisi timeline-space. Wajib eksplisit — tidak ada `From<u64>`."
);

// -------------------------------------------------------------------------
// Viewport: timeline ↔ pixel
// -------------------------------------------------------------------------

/// Jendela pandang timeline yang sedang digambar UI.
///
/// `px_per_sample` disimpan sebagai `f64` dan bukan "samples per pixel" karena
/// zoom in ekstrem membuat samples-per-pixel jadi pecahan < 1 dan rawan
/// pembulatan; px-per-sample justru mengecil saat zoom out, di mana presisi
/// absolut memang tidak dibutuhkan.
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    /// Sample timeline di pixel x = 0.
    pub start: TimelineSample,
    /// Skala. 1.0 = 1 pixel per sample (zoom maksimum praktis).
    pub px_per_sample: f64,
    /// Lebar area gambar dalam CSS pixel (bukan device pixel).
    pub width_px: f32,
}

impl Viewport {
    #[inline]
    pub fn new(start: TimelineSample, px_per_sample: f64, width_px: f32) -> Self {
        Self {
            start,
            px_per_sample,
            width_px,
        }
    }

    /// Berapa sample yang jatuh di satu pixel. Dipakai memilih level pyramid.
    #[inline]
    pub fn samples_per_px(&self) -> f64 {
        if self.px_per_sample <= 0.0 {
            0.0
        } else {
            1.0 / self.px_per_sample
        }
    }

    /// Sample terakhir yang terlihat. Dipakai untuk virtualisasi (culling clip).
    #[inline]
    pub fn end(&self) -> TimelineSample {
        let span = (self.width_px as f64 * self.samples_per_px()) as u64;
        self.start.offset(span)
    }

    /// Apakah rentang `[from, to)` bersinggungan dengan viewport.
    #[inline]
    pub fn intersects(&self, from: TimelineSample, to: TimelineSample) -> bool {
        to > self.start && from < self.end()
    }
}

/// Timeline sample → pixel x. Bisa negatif (di kiri viewport) — itu sengaja,
/// caller yang meng-clip, karena clip yang sebagian terlihat tetap harus digambar.
#[inline]
pub fn sample_to_px(s: TimelineSample, v: &Viewport) -> f32 {
    (s.signed_delta(v.start) as f64 * v.px_per_sample) as f32
}

/// Pixel x → timeline sample, di-clamp ke 0 (tidak ada waktu negatif).
#[inline]
pub fn px_to_sample(px: f32, v: &Viewport) -> TimelineSample {
    if v.px_per_sample <= 0.0 {
        return v.start;
    }
    let d = px as f64 / v.px_per_sample;
    // `as i64` truncate ke arah nol; kita mau floor supaya monoton di px negatif.
    let d = if d < 0.0 { d - 0.999_999_9 } else { d };
    v.start.shift(d as i64)
}

// -------------------------------------------------------------------------
// Konversi lintas space
// -------------------------------------------------------------------------

/// Geometri minimum sebuah clip yang dibutuhkan untuk konversi space.
///
/// Sengaja struct terpisah dari [`crate::model::Clip`] supaya modul `coords`
/// tidak bergantung pada model penuh, dan supaya fungsi konversi bisa dites
/// tanpa membangun `Project`.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ClipGeometry {
    pub timeline_pos: TimelineSample,
    pub source_start: SourceSample,
    /// Panjang region source yang dipakai (SOURCE sample).
    pub source_len: u64,
    /// `> 1.0` = main lebih cepat = clip lebih **pendek** di timeline.
    pub speed_ratio: f64,
}

impl ClipGeometry {
    /// Ratio yang sudah dibersihkan: tidak pernah 0, NaN, atau negatif.
    ///
    /// Semua konversi memakai ini, jadi clip rusak (mis. hasil file korup)
    /// tidak pernah menghasilkan panjang tak hingga atau pembagian nol.
    #[inline]
    pub fn safe_ratio(&self) -> f64 {
        let r = self.speed_ratio;
        if r.is_finite() && r > 1e-6 && r < 1e6 {
            r
        } else {
            1.0
        }
    }

    /// Panjang clip **dalam timeline space** = `source_len / ratio`.
    ///
    /// Ini rumus kunci Bagian 8d. Trim, split, snap, hit-test, dan culling
    /// semuanya bekerja di angka ini — bukan di `source_len`.
    #[inline]
    pub fn timeline_len(&self) -> u64 {
        let n = (self.source_len as f64 / self.safe_ratio()) as u64;
        // Clip yang panjangnya membulat jadi 0 tidak boleh ada: `edit` menolak
        // menghasilkannya, tapi geometri tetap harus mengembalikan >= 1 supaya
        // rentang `[start, end)` tidak pernah kosong/terbalik.
        if n == 0 {
            1
        } else {
            n
        }
    }

    /// Akhir clip di timeline (eksklusif).
    #[inline]
    pub fn timeline_end(&self) -> TimelineSample {
        self.timeline_pos.offset(self.timeline_len())
    }

    /// Akhir region source (eksklusif).
    #[inline]
    pub fn source_end(&self) -> SourceSample {
        self.source_start.offset(self.source_len)
    }

    /// Apakah `t` berada di dalam clip.
    #[inline]
    pub fn contains(&self, t: TimelineSample) -> bool {
        t >= self.timeline_pos && t < self.timeline_end()
    }
}

/// **Timeline → source.** Satu-satunya jalan yang sah.
///
/// ```text
/// source = source_start + round((t - timeline_pos) * ratio)
/// ```
///
/// Di-clamp ke `[source_start, source_end]`: `t` di luar clip mengembalikan
/// tepi terdekat, bukan angka liar. Kenapa clamp dan bukan `Option`: 99%
/// pemanggilnya (trim handle, playhead readout, waveform) mau perilaku clamp,
/// dan `Option` di situ hanya jadi `.unwrap()` berjejer. Kalau kamu butuh tahu
/// apakah `t` di dalam clip, tanya [`ClipGeometry::contains`] dulu.
///
/// Hasilnya **dibulatkan**. Untuk jalur render pakai [`timeline_to_source_frac`]
/// — fractional cursor tidak boleh dibulatkan per-sample, itu jitter.
#[inline]
pub fn timeline_to_source(clip: &ClipGeometry, t: TimelineSample) -> SourceSample {
    if t <= clip.timeline_pos {
        return clip.source_start;
    }
    let dt = t.distance_from(clip.timeline_pos) as f64;
    // +0.5 lalu truncate = round-half-up untuk nilai non-negatif. Dipakai
    // supaya tidak butuh `f64::round` (std-only di lingkungan no_std).
    let ds = (dt * clip.safe_ratio() + 0.5) as u64;
    let s = clip.source_start.offset(ds);
    if s > clip.source_end() {
        clip.source_end()
    } else {
        s
    }
}

/// Versi pecahan untuk jalur render (fractional read cursor, lihat `docs/07`).
///
/// Mengembalikan posisi source sebagai `f64` **tanpa** pembulatan dan **tanpa**
/// clamp atas — voice engine yang memutuskan apa yang terjadi di ujung clip
/// (fade-out lalu mati), dan pembulatan di sini akan terdengar sebagai jitter
/// pitch.
#[inline]
pub fn timeline_to_source_frac(clip: &ClipGeometry, t: TimelineSample) -> f64 {
    let dt = t.signed_delta(clip.timeline_pos) as f64;
    clip.source_start.raw() as f64 + dt * clip.safe_ratio()
}

/// **Source → timeline.** Inverse dari [`timeline_to_source`].
///
/// ```text
/// t = timeline_pos + round((source - source_start) / ratio)
/// ```
///
/// Dipakai saat UI punya posisi di dalam asset (mis. marker hasil transient
/// detection, atau posisi cue point) dan perlu menggambarnya di timeline.
///
/// **Bukan bijektif**, dan tidak bisa dibuat bijektif — itu sifat resampling,
/// bukan bug yang bisa diperbaiki:
/// - `ratio > 1.0`: beberapa source sample memetakan ke timeline sample yang sama.
/// - `ratio < 1.0`: satu source sample menutupi `1/ratio` timeline sample, jadi
///   informasi posisi sub-source hilang saat maju ke source space.
///
/// Batas error round-trip `source_to_timeline(timeline_to_source(t))` karena itu
/// adalah **satu source sample yang dinyatakan dalam timeline unit**, yaitu
/// `ceil(1/ratio) + 1`. Untuk `ratio >= 1` itu berarti ≤ 2 sample; untuk clip
/// yang diperlambat 4× (`ratio = 0.25`) berarti ≤ 5 sample. Ini di-property-test
/// di bawah.
///
/// Konsekuensi praktis: **jangan pernah** menyimpan hasil round-trip kembali ke
/// clip. Trim menyimpan hasil konversi satu arah (`timeline → source`) saja —
/// lihat `edit::trim_left`. Kalau UI melakukan round-trip per gerakan mouse,
/// clip akan "melayang" beberapa sample per detik.
#[inline]
pub fn source_to_timeline(clip: &ClipGeometry, s: SourceSample) -> TimelineSample {
    if s <= clip.source_start {
        return clip.timeline_pos;
    }
    let ds = s.distance_from(clip.source_start) as f64;
    let dt = (ds / clip.safe_ratio() + 0.5) as u64;
    let t = clip.timeline_pos.offset(dt);
    if t > clip.timeline_end() {
        clip.timeline_end()
    } else {
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn geom(ratio: f64, pos: u64, src: u64, len: u64) -> ClipGeometry {
        ClipGeometry {
            timeline_pos: TimelineSample::new(pos),
            source_start: SourceSample::new(src),
            source_len: len,
            speed_ratio: ratio,
        }
    }

    #[test]
    fn ratio_one_is_identity_shift() {
        let g = geom(1.0, 1000, 500, 2000);
        assert_eq!(timeline_to_source(&g, TimelineSample::new(1000)).raw(), 500);
        assert_eq!(
            timeline_to_source(&g, TimelineSample::new(1500)).raw(),
            1000
        );
        assert_eq!(g.timeline_len(), 2000);
    }

    #[test]
    fn double_speed_halves_timeline_length() {
        let g = geom(2.0, 0, 0, 2000);
        assert_eq!(g.timeline_len(), 1000);
        assert_eq!(timeline_to_source(&g, TimelineSample::new(500)).raw(), 1000);
    }

    #[test]
    fn ratio_is_sanitised() {
        assert_eq!(geom(0.0, 0, 0, 10).safe_ratio(), 1.0);
        assert_eq!(geom(f64::NAN, 0, 0, 10).safe_ratio(), 1.0);
        assert_eq!(geom(-2.0, 0, 0, 10).safe_ratio(), 1.0);
    }

    proptest! {
        /// Round-trip lintas space stabil dalam satu SOURCE sample — yang di
        /// timeline space berarti `ceil(1/ratio) + 1`. Lihat doc `source_to_timeline`.
        #[test]
        fn space_roundtrip_within_one_source_sample(
            ratio in 0.25f64..4.0,
            pos in 0u64..1_000_000,
            src in 0u64..1_000_000,
            len in 1u64..1_000_000,
            off in 0u64..1_000_000,
        ) {
            let g = geom(ratio, pos, src, len);
            let t = TimelineSample::new(pos + off.min(g.timeline_len().saturating_sub(1)));
            let s = timeline_to_source(&g, t);
            let back = source_to_timeline(&g, s);
            let tol = (1.0 / ratio).ceil() as i64 + 1;
            prop_assert!(
                back.signed_delta(t).abs() <= tol,
                "t={t:?} s={s:?} back={back:?} ratio={ratio} tol={tol}"
            );
        }

        /// Konversi harus monoton: waktu maju di timeline tidak boleh mundur di source.
        #[test]
        fn conversion_is_monotonic(ratio in 0.25f64..4.0, a in 0u64..100_000, d in 0u64..100_000) {
            let g = geom(ratio, 0, 0, 10_000_000);
            let s0 = timeline_to_source(&g, TimelineSample::new(a));
            let s1 = timeline_to_source(&g, TimelineSample::new(a + d));
            prop_assert!(s1 >= s0);
        }

        /// px_to_sample(sample_to_px(s)) harus kembali ke s untuk zoom masuk akal.
        #[test]
        fn pixel_roundtrip(start in 0u64..1_000_000, s in 0u64..1_000_000, zoom in 0.001f64..1.0) {
            let v = Viewport::new(TimelineSample::new(start), zoom, 1200.0);
            let px = sample_to_px(TimelineSample::new(s), &v);
            let back = px_to_sample(px, &v);
            let tol = (1.0 / zoom) as i64 + 2;
            prop_assert!(back.signed_delta(TimelineSample::new(s)).abs() <= tol);
        }
    }
}
