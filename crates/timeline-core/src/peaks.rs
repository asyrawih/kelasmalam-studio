//! Peak pyramid multi-resolusi — fondasi rendering waveform.
//!
//! # Masalah yang diselesaikan
//!
//! Lagu 5 menit stereo @48k = 28.8 juta sample per channel. Menggambar 1200 px
//! waveform dari raw sample berarti membaca 24.000 sample per pixel, per clip,
//! **setiap kali user scroll**. Di 32 track itu ratusan juta pembacaan per
//! frame — bukan lambat, tapi mustahil.
//!
//! Pyramid memindahkan biaya itu ke waktu import (sekali, di Worker) dan
//! membuat biaya render **proporsional terhadap lebar pixel**, bukan terhadap
//! panjang audio.
//!
//! # Kenapa min/max, bukan RMS atau abs-max
//!
//! Satu bucket harus digambar sebagai satu batang vertikal. Yang benar secara
//! visual adalah **rentang** yang ditempuh sinyal di bucket itu, yaitu `[min, max]`:
//! - `abs_max` saja menggambar waveform simetris palsu — sinyal dengan DC offset
//!   atau asimetri (vokal, brass) terlihat salah.
//! - RMS menggambar energi, bukan bentuk gelombang, dan menyembunyikan transien
//!   — padahal transien justru yang dicari user saat mengedit.
//!
//! # Kenapa tiga level 64 / 512 / 4096
//!
//! Tiap level naik ×8. Kenapa 8 dan bukan 2:
//!
//! | Faktor | Jumlah level (28.8 M sample) | Overhead memori | Error kualitas |
//! |---|---|---|---|
//! | ×2 dari 64 | ~19 level | ~100% dari level 0 | terbaik |
//! | **×8 dari 64** | **3 level** | **~14% dari level 0** | tak terlihat |
//! | ×64 | 2 level | ~1.6% | lompatan detail kelihatan saat zoom |
//!
//! Dengan faktor 8, samples-per-pixel yang tidak persis kelipatan level berarti
//! satu pixel menggabungkan 1–8 bucket. Menggabungkan min/max itu **eksak**
//! (min dari min, max dari max) — tidak ada degradasi kualitas sama sekali,
//! hanya sedikit lebih banyak bucket yang dibaca. Jadi faktor besar itu murni
//! menang; batasnya cuma "jangan sampai satu pixel butuh membaca ratusan bucket".
//!
//! Memori: level 0 = `2 × 4 B × (n/64)` = **1/8 byte per sample** ≈ 3.6 MB untuk
//! lagu 5 menit stereo. Level 1+2 menambah 14%. PCM aslinya sendiri 230 MB.
//!
//! # Kenapa level 1 dan 2 dibangun dari level 0, bukan dari PCM
//!
//! `min(min(a),min(b)) == min(a∪b)`. Min/max itu asosiatif, jadi membangun
//! bertingkat memberi hasil **identik bit-per-bit** dengan membangun dari raw,
//! tapi membaca PCM hanya sekali (satu pass, cache-friendly) alih-alih tiga kali.
//! Ini di-property-test terhadap brute force di bawah.

use alloc::vec;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::coords::{ClipGeometry, SourceSample, TimelineSample};

/// Stride tiap level, dalam sample. Harus naik dan tiap level harus kelipatan
/// bulat dari level sebelumnya.
pub const LEVEL_STRIDES: [u32; 3] = [64, 512, 4096];

/// Satu bucket: rentang amplitudo yang ditempuh sinyal.
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MinMax {
    pub min: f32,
    pub max: f32,
}

impl MinMax {
    pub const EMPTY: Self = MinMax { min: 0.0, max: 0.0 };

    #[inline]
    pub fn merge(self, o: MinMax) -> MinMax {
        MinMax {
            min: if o.min < self.min { o.min } else { self.min },
            max: if o.max > self.max { o.max } else { self.max },
        }
    }

    /// Amplitudo puncak absolut di bucket ini — dipakai untuk indikator clip.
    #[inline]
    pub fn peak(&self) -> f32 {
        let a = if self.min < 0.0 { -self.min } else { self.min };
        let b = if self.max < 0.0 { -self.max } else { self.max };
        if a > b {
            a
        } else {
            b
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Level {
    pub stride: u32,
    pub buckets: Vec<MinMax>,
}

/// Pyramid untuk **satu channel**. Stereo = dua pyramid; kalau UI menggambar
/// waveform gabungan, ia menggabungkan hasil `read_range` keduanya — bukan
/// membangun pyramid ketiga.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pyramid {
    /// Jumlah sample sumber yang diringkas.
    pub source_frames: u64,
    /// Terurut dari stride terkecil ke terbesar.
    pub levels: Vec<Level>,
}

/// Bangun pyramid dari PCM satu channel.
///
/// Satu pass melewati `pcm` untuk level 0, lalu tiap level berikutnya dibangun
/// dari level sebelumnya. Total O(n + n/64 + n/512) ≈ O(n).
///
/// Dipanggil di import worker, tidak pernah di audio thread.
pub fn build_pyramid(pcm: &[f32]) -> Pyramid {
    let mut levels: Vec<Level> = Vec::with_capacity(LEVEL_STRIDES.len());

    // --- level 0: satu-satunya yang menyentuh raw PCM ---
    let s0 = LEVEL_STRIDES[0] as usize;
    let n0 = pcm.len().div_ceil(s0);
    let mut b0: Vec<MinMax> = Vec::with_capacity(n0);
    for chunk in pcm.chunks(s0) {
        let mut mm = MinMax { min: f32::INFINITY, max: f32::NEG_INFINITY };
        for &v in chunk {
            // Perbandingan manual, bukan f32::min/max: `min`/`max` bukan bagian
            // dari `core` (no_std), dan versi manual ini juga lebih cepat karena
            // tidak menangani NaN secara khusus.
            if v < mm.min {
                mm.min = v;
            }
            if v > mm.max {
                mm.max = v;
            }
        }
        b0.push(sanitize(mm));
    }
    levels.push(Level { stride: LEVEL_STRIDES[0], buckets: b0 });

    // --- level 1..n: dibangun dari level sebelumnya ---
    for li in 1..LEVEL_STRIDES.len() {
        let factor = (LEVEL_STRIDES[li] / LEVEL_STRIDES[li - 1]) as usize;
        let prev = &levels[li - 1].buckets;
        let mut cur = Vec::with_capacity(prev.len().div_ceil(factor));
        for chunk in prev.chunks(factor) {
            let mut mm = chunk[0];
            for &b in &chunk[1..] {
                mm = mm.merge(b);
            }
            cur.push(mm);
        }
        levels.push(Level { stride: LEVEL_STRIDES[li], buckets: cur });
    }

    Pyramid { source_frames: pcm.len() as u64, levels }
}

#[inline]
fn sanitize(mm: MinMax) -> MinMax {
    // Chunk kosong tidak mungkin (chunks tidak menghasilkan chunk kosong), tapi
    // NaN di PCM mungkin (file rusak) dan akan membuat perbandingan gagal total.
    if mm.min.is_finite() && mm.max.is_finite() {
        mm
    } else {
        MinMax::EMPTY
    }
}

impl Pyramid {
    /// Perkiraan memori pyramid dalam byte — dipakai budget asset pool.
    pub fn bytes(&self) -> usize {
        self.levels.iter().map(|l| l.buckets.len() * core::mem::size_of::<MinMax>()).sum()
    }

    /// Pilih level terbaik untuk `samples_per_px`: level dengan stride terbesar
    /// yang masih `<= samples_per_px`, supaya tiap pixel membaca `>= 1` bucket.
    ///
    /// Kalau `samples_per_px < 64` (zoom sangat dalam), kita tetap memakai level
    /// 0 dan tiap bucket melebar jadi beberapa pixel. **Ini trade-off yang
    /// disadari**: di bawah 64 spp waveform jadi bertangga. Di zoom sedalam itu
    /// UI sebaiknya beralih ke jalur "draw raw samples" terpisah (rentang yang
    /// terlihat < 100k sample, jadi membaca raw memang murah di situ) — pyramid
    /// bukan alat yang tepat dan kita tidak memaksakannya.
    #[inline]
    pub fn level_for(&self, samples_per_px: f64) -> usize {
        let mut best = 0usize;
        for (i, l) in self.levels.iter().enumerate() {
            if (l.stride as f64) <= samples_per_px {
                best = i;
            }
        }
        best
    }

    /// Baca rentang **source space** `[from, to)` dan ringkas jadi `out_px` kolom.
    ///
    /// Tidak pernah menyentuh raw PCM — pyramid ini bahkan tidak memilikinya.
    /// Biaya: O(out_px + bucket_yang_dibaca), dengan `bucket_yang_dibaca ≈ out_px`
    /// (per konstruksi pemilihan level) sampai maksimal 8× itu.
    pub fn read_range(&self, from: SourceSample, to: SourceSample, out_px: usize) -> Vec<MinMax> {
        let mut out = vec![MinMax::EMPTY; out_px];
        self.read_range_into(from, to, &mut out);
        out
    }

    /// Versi tanpa alokasi — UI memanggil ini per frame dengan buffer yang
    /// dipakai ulang. Panjang `out` menentukan jumlah kolom.
    pub fn read_range_into(&self, from: SourceSample, to: SourceSample, out: &mut [MinMax]) {
        if out.is_empty() {
            return;
        }
        let n_px = out.len();
        let from_s = from.raw().min(self.source_frames);
        let to_s = to.raw().clamp(from_s, self.source_frames);
        let span = to_s - from_s;
        if span == 0 {
            out.fill(MinMax::EMPTY);
            return;
        }

        let spp = span as f64 / n_px as f64;
        let lvl = &self.levels[self.level_for(spp)];
        let stride = lvl.stride as u64;
        let nb = lvl.buckets.len();

        for (px, slot) in out.iter_mut().enumerate() {
            // Batas pixel di source space, lalu ke index bucket.
            let a = from_s + (px as u64 * span) / n_px as u64;
            let b = from_s + ((px as u64 + 1) * span) / n_px as u64;
            let i0 = (a / stride) as usize;
            // +1 supaya rentang bucket inklusif di ujung; minimal satu bucket.
            let i1 = ((b.saturating_sub(1) / stride) as usize + 1).min(nb);
            if i0 >= nb || i0 >= i1 {
                *slot = MinMax::EMPTY;
                continue;
            }
            let mut mm = lvl.buckets[i0];
            for &bk in &lvl.buckets[i0 + 1..i1] {
                mm = mm.merge(bk);
            }
            *slot = mm;
        }
    }

    /// Baca waveform sebuah clip untuk rentang **timeline space**.
    ///
    /// Inilah trik "clip yang di-stretch tidak butuh pyramid baru" dari Bagian 8d:
    /// kita hanya mengubah rentang yang dibaca lewat [`crate::timeline_to_source`],
    /// yang efeknya **striding dengan faktor ratio**. Clip dengan `ratio = 2.0`
    /// membaca rentang source dua kali lebih panjang untuk lebar pixel yang sama
    /// — dan `read_range` otomatis naik satu-dua level pyramid untuk itu.
    /// Biaya mengubah `speed_ratio`: **nol**. Tidak ada regenerasi, tidak ada
    /// invalidasi cache, tidak ada worker yang dibangunkan.
    ///
    /// `from_tl`/`to_tl` di-clamp ke batas clip, jadi caller boleh melempar
    /// rentang viewport apa adanya.
    pub fn read_clip_range(
        &self,
        clip: &ClipGeometry,
        from_tl: TimelineSample,
        to_tl: TimelineSample,
        out: &mut [MinMax],
    ) {
        let a = from_tl.clamp_to(clip.timeline_pos, clip.timeline_end());
        let b = to_tl.clamp_to(clip.timeline_pos, clip.timeline_end());
        let src_a = crate::coords::timeline_to_source(clip, a);
        let src_b = crate::coords::timeline_to_source(clip, b);
        self.read_range_into(src_a, src_b, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Referensi brute-force: iterasi raw sample. Hanya untuk tes.
    fn brute(pcm: &[f32], from: usize, to: usize) -> MinMax {
        let to = to.min(pcm.len());
        if from >= to {
            return MinMax::EMPTY;
        }
        let mut mm = MinMax { min: f32::INFINITY, max: f32::NEG_INFINITY };
        for &v in &pcm[from..to] {
            if v < mm.min {
                mm.min = v;
            }
            if v > mm.max {
                mm.max = v;
            }
        }
        mm
    }

    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| ((i % 1000) as f32 / 500.0) - 1.0).collect()
    }

    #[test]
    fn level_shapes() {
        let p = build_pyramid(&ramp(100_000));
        assert_eq!(p.levels.len(), 3);
        assert_eq!(p.levels[0].buckets.len(), 100_000usize.div_ceil(64));
        assert_eq!(p.levels[1].buckets.len(), p.levels[0].buckets.len().div_ceil(8));
        assert_eq!(p.levels[2].buckets.len(), p.levels[1].buckets.len().div_ceil(8));
    }

    #[test]
    fn higher_levels_equal_brute_force() {
        let pcm = ramp(200_000);
        let p = build_pyramid(&pcm);
        for (li, lvl) in p.levels.iter().enumerate() {
            let s = lvl.stride as usize;
            for (bi, b) in lvl.buckets.iter().enumerate() {
                let want = brute(&pcm, bi * s, (bi + 1) * s);
                assert_eq!(*b, want, "level {li} bucket {bi}");
            }
        }
    }

    #[test]
    fn level_selection_follows_zoom() {
        let p = build_pyramid(&ramp(1_000_000));
        assert_eq!(p.level_for(10.0), 0);
        assert_eq!(p.level_for(64.0), 0);
        assert_eq!(p.level_for(500.0), 0);
        assert_eq!(p.level_for(512.0), 1);
        assert_eq!(p.level_for(4096.0), 2);
        assert_eq!(p.level_for(100_000.0), 2);
    }

    #[test]
    fn stretched_clip_reads_twice_the_source() {
        let pcm = ramp(400_000);
        let p = build_pyramid(&pcm);
        let g = ClipGeometry {
            timeline_pos: TimelineSample::new(0),
            source_start: SourceSample::new(0),
            source_len: 400_000,
            speed_ratio: 2.0,
        };
        assert_eq!(g.timeline_len(), 200_000);
        let mut out = vec![MinMax::EMPTY; 100];
        p.read_clip_range(&g, TimelineSample::new(0), TimelineSample::new(200_000), &mut out);
        // Harus setara membaca SELURUH source di 100 kolom.
        let direct = p.read_range(SourceSample::new(0), SourceSample::new(400_000), 100);
        assert_eq!(out, direct);
    }

    #[test]
    fn empty_and_out_of_bounds_are_safe() {
        let p = build_pyramid(&ramp(1000));
        assert_eq!(p.read_range(SourceSample::new(500), SourceSample::new(500), 4), vec![MinMax::EMPTY; 4]);
        let r = p.read_range(SourceSample::new(900), SourceSample::new(99_999), 8);
        assert_eq!(r.len(), 8);
        assert!(p.read_range(SourceSample::new(0), SourceSample::new(1000), 0).is_empty());
    }

    #[test]
    fn nan_in_pcm_does_not_poison() {
        let mut pcm = ramp(1000);
        pcm[10] = f32::NAN;
        let p = build_pyramid(&pcm);
        assert!(p.levels[0].buckets.iter().all(|b| b.min.is_finite() && b.max.is_finite()));
    }

    proptest! {
        /// Hasil `read_range` harus MELIPUTI hasil brute force: min tidak lebih
        /// besar, max tidak lebih kecil. (Tidak bisa sama persis karena bucket
        /// tidak sejajar dengan batas pixel — dan itu memang benar secara visual:
        /// waveform boleh sedikit "lebih gemuk", tidak boleh memotong puncak.)
        #[test]
        fn read_range_never_clips_peaks(
            n in 5_000usize..60_000,
            from in 0usize..40_000,
            len in 1usize..40_000,
            px in 1usize..300,
        ) {
            let pcm = ramp(n);
            let p = build_pyramid(&pcm);
            let from = from.min(n.saturating_sub(1));
            let to = (from + len).min(n);
            prop_assume!(to > from);
            let out = p.read_range(SourceSample::new(from as u64), SourceSample::new(to as u64), px);
            prop_assert_eq!(out.len(), px);

            let span = to - from;
            for (i, got) in out.iter().enumerate() {
                let a = from + i * span / px;
                let b = from + (i + 1) * span / px;
                if b <= a { continue; }
                let want = brute(&pcm, a, b);
                prop_assert!(got.min <= want.min + 1e-6, "px {i}: min {} > brute {}", got.min, want.min);
                prop_assert!(got.max >= want.max - 1e-6, "px {i}: max {} < brute {}", got.max, want.max);
            }
        }

        /// Membaca seluruh asset dalam 1 kolom harus persis min/max global.
        #[test]
        fn full_range_single_column_is_global_minmax(n in 1_000usize..50_000) {
            let pcm = ramp(n);
            let p = build_pyramid(&pcm);
            let got = p.read_range(SourceSample::new(0), SourceSample::new(n as u64), 1)[0];
            let want = brute(&pcm, 0, n);
            prop_assert!((got.min - want.min).abs() < 1e-6);
            prop_assert!((got.max - want.max).abs() < 1e-6);
        }
    }
}
