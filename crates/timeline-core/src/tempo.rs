//! Tempo map: konversi tick ↔ sample dengan aritmatika **integer penuh**.
//!
//! Implementasi dari `docs/02-dsp-engine.md` §2c. Ringkas alasannya:
//!
//! - Tempo disimpan sebagai `micros_per_quarter_note` (`u32`, persis seperti
//!   MIDI tempo meta-event), **bukan** BPM `f32`. BPM 128 → 468_750 µs, eksak.
//!   BPM 120 → 500_000 µs, eksak. Sebaliknya `60.0/128.0` di f32 tidak eksak dan
//!   errornya terakumulasi.
//! - Konversi selalu **absolut dari jangkar segmen terdekat**, tidak pernah
//!   inkremental. Tidak ada `pos += samples_per_tick`.
//! - Pembilang dihitung di `u128` lalu satu pembagian integer. Tidak ada float
//!   sama sekali di jalur ini → deterministik dan reversibel, dan hasilnya sama
//!   persis di realtime maupun di offline export (syarat null-test Bagian 7).
//!
//! PPQ = 960 (bukan 480) supaya triplet (960/3 = 320) dan 128th note
//! (960*4/128 = 30) representable sebagai integer eksak.

use alloc::vec;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::coords::TimelineSample;

/// Pulses per quarter note. Lihat `docs/00-api-contract.md`.
pub const PPQ: u64 = 960;

/// Tempo default kalau map kosong: 120 BPM.
pub const DEFAULT_MICROS_PER_QN: u32 = 500_000;

/// Satu segmen tempo konstan.
///
/// `sample` adalah **jangkar**: posisi awal segmen dalam sample, dihitung sekali
/// (berantai dari segmen sebelumnya) saat map berubah. Karena tiap jangkar
/// integer eksak, error pembulatan tidak terakumulasi lintas segmen — yang
/// tersisa hanya ≤1 sample per batas segmen, dan itu *stabil*: dibaca 1000 kali
/// hasilnya tetap sama.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TempoSegment {
    /// Awal segmen dalam PPQ tick.
    pub tick: u64,
    /// Awal segmen dalam sample. Turunan — jangan di-set manual, dihitung oleh
    /// [`TempoMap::rebuild_anchors`]. Ikut di-serialize supaya file project bisa
    /// diverifikasi, tapi selalu dihitung ulang saat load.
    #[serde(default)]
    pub sample: u64,
    /// Mikrodetik per quarter note. Integer, seperti MIDI.
    pub micros_per_qn: u32,
}

impl TempoSegment {
    pub const fn new(tick: u64, micros_per_qn: u32) -> Self {
        Self {
            tick,
            sample: 0,
            micros_per_qn,
        }
    }

    /// BPM sebagai f64 — **hanya untuk ditampilkan di UI**, tidak pernah dipakai
    /// untuk menghitung posisi.
    pub fn bpm(&self) -> f64 {
        60_000_000.0 / self.micros_per_qn as f64
    }

    /// Konversi BPM dari UI ke integer µs/QN. Pembulatan terjadi **sekali di
    /// sini**, bukan di setiap konversi posisi.
    pub fn micros_from_bpm(bpm: f64) -> u32 {
        if !(bpm.is_finite() && (1.0..=999.0).contains(&bpm)) {
            return DEFAULT_MICROS_PER_QN;
        }
        (60_000_000.0 / bpm + 0.5) as u32
    }
}

/// Segmen birama. Dipisah dari tempo karena keduanya berubah independen
/// (ganti 4/4 → 7/8 tanpa ganti tempo, dan sebaliknya).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSigSegment {
    pub tick: u64,
    pub numerator: u16,
    /// Kekuatan dua: 1,2,4,8,16...
    pub denominator: u16,
}

impl TimeSigSegment {
    pub const fn new(tick: u64, numerator: u16, denominator: u16) -> Self {
        Self {
            tick,
            numerator,
            denominator,
        }
    }

    /// Panjang satu bar dalam tick.
    #[inline]
    pub fn ticks_per_bar(&self) -> u64 {
        let den = if self.denominator == 0 {
            4
        } else {
            self.denominator as u64
        };
        let num = if self.numerator == 0 {
            4
        } else {
            self.numerator as u64
        };
        (PPQ * 4 / den) * num
    }

    /// Panjang satu beat (satu satuan penyebut) dalam tick.
    #[inline]
    pub fn ticks_per_beat(&self) -> u64 {
        let den = if self.denominator == 0 {
            4
        } else {
            self.denominator as u64
        };
        PPQ * 4 / den
    }
}

/// Grid snap yang bisa dipilih user.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Grid {
    /// Awal bar, mengikuti birama aktif.
    Bar,
    /// Satu beat (satuan penyebut birama).
    Beat,
    /// Pembagian not: `Div(4)` = 1/4, `Div(16)` = 1/16. `n` harus > 0.
    Div(u32),
    /// Triplet: `Triplet(8)` = 1/8 triplet = 2/3 dari 1/8.
    Triplet(u32),
    /// Tanpa snap.
    Off,
}

impl Grid {
    /// Panjang grid dalam tick, `None` untuk [`Grid::Off`] dan [`Grid::Bar`]
    /// (bar butuh konteks birama, ditangani terpisah di [`TempoMap::snap`]).
    #[inline]
    fn ticks(&self, sig: &TimeSigSegment) -> Option<u64> {
        match *self {
            Grid::Off | Grid::Bar => None,
            Grid::Beat => Some(sig.ticks_per_beat()),
            Grid::Div(n) => {
                if n == 0 {
                    None
                } else {
                    Some((PPQ * 4 / n as u64).max(1))
                }
            }
            Grid::Triplet(n) => {
                if n == 0 {
                    None
                } else {
                    Some(((PPQ * 4 * 2) / (n as u64 * 3)).max(1))
                }
            }
        }
    }
}

/// Peta tempo + birama untuk seluruh project.
///
/// Invariant (dijaga oleh [`TempoMap::rebuild_anchors`], yang dipanggil setiap
/// kali map dimutasi):
/// 1. `tempo` tidak pernah kosong dan tersortir naik berdasarkan `tick`.
/// 2. `tempo[0].tick == 0`.
/// 3. `tempo[i].sample` konsisten dengan `cached_sr`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TempoMap {
    tempo: Vec<TempoSegment>,
    time_sig: Vec<TimeSigSegment>,
    /// Sample rate yang dipakai saat jangkar dihitung terakhir kali.
    cached_sr: u32,
}

impl Default for TempoMap {
    fn default() -> Self {
        Self::constant(120.0, 48_000)
    }
}

impl TempoMap {
    /// Map tempo konstan 4/4 — kasus 99% project.
    pub fn constant(bpm: f64, sample_rate: u32) -> Self {
        let mut m = Self {
            tempo: vec![TempoSegment::new(0, TempoSegment::micros_from_bpm(bpm))],
            time_sig: vec![TimeSigSegment::new(0, 4, 4)],
            cached_sr: sample_rate,
        };
        m.rebuild_anchors(sample_rate);
        m
    }

    pub fn tempo_segments(&self) -> &[TempoSegment] {
        &self.tempo
    }

    pub fn time_sigs(&self) -> &[TimeSigSegment] {
        &self.time_sig
    }

    /// Sisipkan/ganti segmen tempo di `tick` dan hitung ulang jangkar.
    pub fn set_tempo(&mut self, tick: u64, micros_per_qn: u32) {
        let micros = micros_per_qn.max(1);
        match self.tempo.binary_search_by_key(&tick, |s| s.tick) {
            Ok(i) => self.tempo[i].micros_per_qn = micros,
            Err(i) => self.tempo.insert(i, TempoSegment::new(tick, micros)),
        }
        if self.tempo[0].tick != 0 {
            self.tempo
                .insert(0, TempoSegment::new(0, DEFAULT_MICROS_PER_QN));
        }
        let sr = self.cached_sr;
        self.rebuild_anchors(sr);
    }

    pub fn set_time_sig(&mut self, tick: u64, numerator: u16, denominator: u16) {
        let seg = TimeSigSegment::new(tick, numerator.max(1), denominator.max(1));
        match self.time_sig.binary_search_by_key(&tick, |s| s.tick) {
            Ok(i) => self.time_sig[i] = seg,
            Err(i) => self.time_sig.insert(i, seg),
        }
        if self.time_sig[0].tick != 0 {
            self.time_sig.insert(0, TimeSigSegment::new(0, 4, 4));
        }
    }

    /// Hitung ulang seluruh jangkar sample untuk `sample_rate`.
    ///
    /// Wajib dipanggil setelah load file project (karena sample rate device bisa
    /// berbeda dari yang dipakai saat menyimpan) dan setelah tiap mutasi tempo.
    /// Biayanya O(n) dengan n = jumlah segmen (biasanya 1).
    pub fn rebuild_anchors(&mut self, sample_rate: u32) {
        let sr = sample_rate.max(1);
        self.cached_sr = sr;
        if self.tempo.is_empty() {
            self.tempo.push(TempoSegment::new(0, DEFAULT_MICROS_PER_QN));
        }
        self.tempo.sort_unstable_by_key(|s| s.tick);
        self.time_sig.sort_unstable_by_key(|s| s.tick);
        if self.time_sig.is_empty() {
            self.time_sig.push(TimeSigSegment::new(0, 4, 4));
        }
        self.tempo[0].tick = 0;
        self.tempo[0].sample = 0;
        for i in 1..self.tempo.len() {
            let prev = self.tempo[i - 1];
            let d_tick = self.tempo[i].tick.saturating_sub(prev.tick);
            self.tempo[i].sample = prev.sample + ticks_to_samples(d_tick, prev.micros_per_qn, sr);
        }
    }

    /// Index segmen tempo yang berlaku di `tick`.
    #[inline]
    fn tempo_idx_at_tick(&self, tick: u64) -> usize {
        match self.tempo.binary_search_by_key(&tick, |s| s.tick) {
            Ok(i) => i,
            Err(0) => 0,
            Err(i) => i - 1,
        }
    }

    /// Index segmen tempo yang berlaku di `sample`.
    #[inline]
    fn tempo_idx_at_sample(&self, sample: u64) -> usize {
        match self.tempo.binary_search_by_key(&sample, |s| s.sample) {
            Ok(i) => i,
            Err(0) => 0,
            Err(i) => i - 1,
        }
    }

    /// Birama yang berlaku di `tick`.
    #[inline]
    pub fn time_sig_at(&self, tick: u64) -> TimeSigSegment {
        match self.time_sig.binary_search_by_key(&tick, |s| s.tick) {
            Ok(i) => self.time_sig[i],
            Err(0) => TimeSigSegment::new(0, 4, 4),
            Err(i) => self.time_sig[i - 1],
        }
    }

    /// Nomor bar (mulai dari 1) dan tick awal bar tersebut.
    pub fn bar_at(&self, tick: u64) -> (u64, u64) {
        // Berjalan per-segmen birama, bukan per-bar: O(jumlah perubahan birama).
        let mut bar = 1u64;
        for w in 0..self.time_sig.len() {
            let sig = self.time_sig[w];
            let seg_end = self.time_sig.get(w + 1).map(|s| s.tick).unwrap_or(u64::MAX);
            let tpb = sig.ticks_per_bar().max(1);
            if tick < seg_end {
                let n = (tick - sig.tick) / tpb;
                return (bar + n, sig.tick + n * tpb);
            }
            bar += (seg_end - sig.tick).div_ceil(tpb);
        }
        (bar, tick)
    }
}

/// `d_tick` tick pada tempo `micros_per_qn` → berapa sample.
///
/// Ini rumusnya, dan ia sepenuhnya integer:
/// ```text
///            d_tick * micros_per_qn * sample_rate
/// samples =  ────────────────────────────────────
///                    PPQ * 1_000_000
/// ```
/// Pembilang bisa besar (d_tick 10^9 × µs 10^6 × sr 10^5 ≈ 10^20), jadi `u128`
/// bukan kemewahan — `u64` overflow di lagu panjang.
#[inline]
fn ticks_to_samples(d_tick: u64, micros_per_qn: u32, sr: u32) -> u64 {
    let num = d_tick as u128 * micros_per_qn as u128 * sr as u128;
    let den = PPQ as u128 * 1_000_000u128;
    (num / den) as u64
}

/// Inverse dari [`ticks_to_samples`].
#[inline]
fn samples_to_ticks(d_sample: u64, micros_per_qn: u32, sr: u32) -> u64 {
    let mpq = micros_per_qn.max(1) as u128;
    let num = d_sample as u128 * PPQ as u128 * 1_000_000u128;
    let den = mpq * sr.max(1) as u128;
    (num / den) as u64
}

/// PPQ tick → posisi timeline dalam sample.
pub fn tick_to_sample(map: &TempoMap, tick: u64, sr: u32) -> TimelineSample {
    debug_assert!(
        map.cached_sr == sr,
        "jangkar tempo map dihitung untuk sr lain — panggil rebuild_anchors dulu"
    );
    let i = map.tempo_idx_at_tick(tick);
    let seg = map.tempo[i];
    let anchor = if map.cached_sr == sr {
        seg.sample
    } else {
        // Fallback aman kalau caller lupa rebuild: hitung berantai on the fly.
        let mut acc = 0u64;
        for k in 1..=i {
            let p = map.tempo[k - 1];
            acc += ticks_to_samples(map.tempo[k].tick - p.tick, p.micros_per_qn, sr);
        }
        acc
    };
    TimelineSample::new(anchor + ticks_to_samples(tick - seg.tick, seg.micros_per_qn, sr))
}

/// Posisi timeline dalam sample → PPQ tick.
pub fn sample_to_tick(map: &TempoMap, s: TimelineSample, sr: u32) -> u64 {
    let i = map.tempo_idx_at_sample(s.raw());
    let seg = map.tempo[i];
    seg.tick + samples_to_ticks(s.raw().saturating_sub(seg.sample), seg.micros_per_qn, sr)
}

/// Snap posisi timeline ke grid.
///
/// Dilakukan **di tick space**, bukan di sample space: snap di sample space
/// akan meleset saat tempo bukan pembagi bulat dari sample rate, dan lebih
/// buruk lagi, meleset dengan besaran berbeda di setiap bar.
///
/// Pembulatan ke tetangga **terdekat** (bukan floor), karena itu yang diharapkan
/// user saat men-drag: clip menempel ke garis yang paling dekat dengan kursor.
pub fn snap(s: TimelineSample, grid: Grid, map: &TempoMap, sr: u32) -> TimelineSample {
    if matches!(grid, Grid::Off) {
        return s;
    }
    let tick = sample_to_tick(map, s, sr);
    let sig = map.time_sig_at(tick);

    let step = match grid {
        Grid::Bar => sig.ticks_per_bar().max(1),
        _ => match grid.ticks(&sig) {
            Some(t) => t,
            None => return s,
        },
    };
    // Grid selalu diukur relatif terhadap awal segmen birama, bukan terhadap
    // tick 0 — kalau tidak, birama 7/8 di tengah lagu bikin grid bar melenceng.
    let base = sig.tick;
    let rel = tick.saturating_sub(base);
    let lo = rel / step * step;
    let hi = lo + step;
    let snapped = if rel - lo <= hi - rel { lo } else { hi };
    tick_to_sample(map, base + snapped, sr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn exact_at_120bpm() {
        let m = TempoMap::constant(120.0, 48_000);
        // 1 quarter @120bpm = 0.5s = 24000 sample.
        assert_eq!(tick_to_sample(&m, PPQ, 48_000).raw(), 24_000);
        assert_eq!(tick_to_sample(&m, PPQ * 4, 48_000).raw(), 96_000);
        assert_eq!(sample_to_tick(&m, TimelineSample::new(24_000), 48_000), PPQ);
    }

    #[test]
    fn bpm_128_is_exact_integer_micros() {
        assert_eq!(TempoSegment::micros_from_bpm(128.0), 468_750);
    }

    #[test]
    fn tempo_change_anchors_chain() {
        let mut m = TempoMap::constant(120.0, 48_000);
        m.set_tempo(PPQ * 4, 250_000); // bar 2 → 240 bpm
        let segs = m.tempo_segments();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[1].sample, 96_000);
        // 1 quarter @240bpm = 12000 sample.
        assert_eq!(tick_to_sample(&m, PPQ * 5, 48_000).raw(), 108_000);
    }

    #[test]
    fn snap_to_bar_and_triplet() {
        let m = TempoMap::constant(120.0, 48_000);
        // 1 bar = 96000 sample. 50000 → bar 1 (96000 lebih dekat? tidak: 50000-0=50000, 96000-50000=46000)
        assert_eq!(
            snap(TimelineSample::new(50_000), Grid::Bar, &m, 48_000).raw(),
            96_000
        );
        assert_eq!(
            snap(TimelineSample::new(40_000), Grid::Bar, &m, 48_000).raw(),
            0
        );
        // 1/8 triplet = 960*4*2/(8*3) = 320 tick.
        assert_eq!(
            Grid::Triplet(8).ticks(&TimeSigSegment::new(0, 4, 4)),
            Some(320)
        );
        assert_eq!(
            Grid::Div(16).ticks(&TimeSigSegment::new(0, 4, 4)),
            Some(240)
        );
    }

    #[test]
    fn snapped_positions_are_idempotent() {
        let m = TempoMap::constant(137.0, 44_100);
        for g in [Grid::Bar, Grid::Beat, Grid::Div(16), Grid::Triplet(8)] {
            let a = snap(TimelineSample::new(1_234_567), g, &m, 44_100);
            let b = snap(a, g, &m, 44_100);
            assert_eq!(a, b, "snap tidak idempoten untuk {g:?}");
        }
    }

    #[test]
    fn bar_numbering() {
        let m = TempoMap::constant(120.0, 48_000);
        assert_eq!(m.bar_at(0), (1, 0));
        assert_eq!(m.bar_at(PPQ * 4), (2, PPQ * 4));
        assert_eq!(m.bar_at(PPQ * 4 + 10), (2, PPQ * 4));
    }

    proptest! {
        /// Round-trip tick → sample → tick. Toleransi 1 tick: pembagian integer
        /// dua arah tidak bisa bijektif saat 1 tick < 1 sample (tempo sangat cepat).
        #[test]
        fn tick_sample_roundtrip(
            tick in 0u64..(PPQ * 4 * 2000),
            bpm in 20.0f64..300.0,
            sr in prop::sample::select(vec![44_100u32, 48_000, 88_200, 96_000]),
        ) {
            let m = TempoMap::constant(bpm, sr);
            let s = tick_to_sample(&m, tick, sr);
            let back = sample_to_tick(&m, s, sr);
            prop_assert!(
                back.abs_diff(tick) <= 1,
                "tick={tick} sample={} back={back} bpm={bpm} sr={sr}", s.raw()
            );
        }

        /// Monoton: tick naik ⇒ sample tidak pernah turun. Ini yang menjaga
        /// scheduler tidak pernah melihat waktu mundur.
        #[test]
        fn tick_to_sample_monotonic(a in 0u64..1_000_000, d in 0u64..1_000_000, bpm in 20.0f64..300.0) {
            let m = TempoMap::constant(bpm, 48_000);
            prop_assert!(tick_to_sample(&m, a + d, 48_000) >= tick_to_sample(&m, a, 48_000));
        }

        /// Round-trip lintas beberapa segmen tempo.
        #[test]
        fn multi_segment_roundtrip(tick in 0u64..(PPQ * 400)) {
            let mut m = TempoMap::constant(90.0, 48_000);
            m.set_tempo(PPQ * 8, TempoSegment::micros_from_bpm(174.0));
            m.set_tempo(PPQ * 40, TempoSegment::micros_from_bpm(60.0));
            let s = tick_to_sample(&m, tick, 48_000);
            let back = sample_to_tick(&m, s, 48_000);
            prop_assert!(back.abs_diff(tick) <= 1, "tick={tick} back={back}");
        }

        /// Hasil snap selalu tepat di grid: snap(snap(x)) == snap(x).
        #[test]
        fn snap_idempotent(pos in 0u64..50_000_000, div in prop::sample::select(vec![1u32,2,4,8,16,32])) {
            let m = TempoMap::constant(120.0, 48_000);
            let a = snap(TimelineSample::new(pos), Grid::Div(div), &m, 48_000);
            let b = snap(a, Grid::Div(div), &m, 48_000);
            prop_assert_eq!(a, b);
        }
    }
}
