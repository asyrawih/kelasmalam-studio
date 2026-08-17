//! Insert chain per unit: EQ 4-band + kompresor.
//!
//! Dispatch memakai `enum`, BUKAN `dyn Trait` (docs/01 §1c): jumlah efek
//! terbatas dan diketahui, jadi kita dapat branch yang terprediksi dan tidak
//! ada cache miss dari vtable di inner loop.

use daw_dsp::{Biquad, Coeffs, CompParams, Compressor, Detector, FilterKind};

use crate::snapshot::{CompSettings, EqBandSettings, EQ_BANDS};

#[inline]
fn filter_kind(v: u8) -> FilterKind {
    match v {
        0 => FilterKind::LowPass,
        1 => FilterKind::HighPass,
        2 => FilterKind::LowShelf,
        3 => FilterKind::HighShelf,
        4 => FilterKind::Peaking,
        5 => FilterKind::Notch,
        6 => FilterKind::AllPass,
        _ => FilterKind::BandPass,
    }
}

/// EQ 4-band stereo. Koefisien di-hitung ULANG PER BLOK, tidak per sample:
/// TDF-II menyimpan akumulator yang maknanya bergantung koefisien, jadi
/// mengubahnya tiap sample merusak sifat numeriknya (docs/02 §2b). Untuk sweep
/// cepat, blok dipecah di batas event (§2c).
pub struct Eq4 {
    coeffs: [Coeffs; EQ_BANDS],
    enabled: [bool; EQ_BANDS],
    l: [Biquad; EQ_BANDS],
    r: [Biquad; EQ_BANDS],
    dirty: bool,
    settings: [EqBandSettings; EQ_BANDS],
    sample_rate: f32,
}

impl Eq4 {
    pub fn new(sample_rate: f32) -> Self {
        // `from_fn` dipakai daripada `[expr; N]` supaya tidak menuntut `Copy`
        // pada tipe dari daw-dsp (kontrak tidak menjanjikannya).
        Eq4 {
            coeffs: core::array::from_fn(|_| Coeffs {
                b0: 1.0,
                b1: 0.0,
                b2: 0.0,
                a1: 0.0,
                a2: 0.0,
            }),
            enabled: [false; EQ_BANDS],
            l: core::array::from_fn(|_| Biquad::new()),
            r: core::array::from_fn(|_| Biquad::new()),
            dirty: true,
            settings: [EqBandSettings::default(); EQ_BANDS],
            sample_rate,
        }
    }

    pub fn set_band(&mut self, i: usize, s: EqBandSettings) {
        if i < EQ_BANDS {
            self.settings[i] = s;
            self.dirty = true;
        }
    }

    pub fn set_all(&mut self, s: &[EqBandSettings; EQ_BANDS]) {
        self.settings = *s;
        self.dirty = true;
    }

    pub fn reset(&mut self) {
        for b in self.l.iter_mut().chain(self.r.iter_mut()) {
            b.reset();
        }
    }

    /// Dipanggil sekali di awal blok, di luar inner loop.
    #[inline]
    fn refresh(&mut self) {
        if !self.dirty {
            return;
        }
        for i in 0..EQ_BANDS {
            let s = self.settings[i];
            self.enabled[i] = s.enabled;
            if s.enabled {
                self.coeffs[i] = Coeffs::design(
                    filter_kind(s.kind),
                    self.sample_rate,
                    s.freq_hz,
                    s.q,
                    s.gain_db,
                );
            }
        }
        self.dirty = false;
    }

    #[inline]
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.refresh();
        for i in 0..EQ_BANDS {
            if self.enabled[i] {
                self.l[i].process(l, &self.coeffs[i]);
                self.r[i].process(r, &self.coeffs[i]);
            }
        }
    }
}

/// Kompresor feed-forward stereo-linked + laporan gain reduction ke meter.
pub struct CompNode {
    comp: Compressor,
    /// GR maksimum (dB, positif) di blok terakhir — dibaca meter.rs.
    pub last_gr_db: f32,
}

impl CompNode {
    pub fn new(sample_rate: f32) -> Self {
        CompNode {
            comp: Compressor::new(sample_rate),
            last_gr_db: 0.0,
        }
    }

    pub fn set_settings(&mut self, s: &CompSettings) {
        self.comp.set_params(&CompParams {
            threshold_db: s.threshold_db,
            ratio: s.ratio,
            knee_db: s.knee_db,
            attack_ms: s.attack_ms,
            release_ms: s.release_ms,
            makeup_db: s.makeup_db,
            detector: if s.detector == 1 {
                Detector::Rms
            } else {
                Detector::Peak
            },
            auto_makeup: s.auto_makeup,
        });
    }
}

/// Node insert. Satu varian per jenis efek — lihat catatan enum-dispatch di atas.
pub enum FxNode {
    Eq(Eq4),
    Comp(CompNode),
}

impl FxNode {
    /// In-place, stereo planar. Zero alloc, no panic.
    #[inline]
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        match self {
            FxNode::Eq(e) => e.process(l, r),
            FxNode::Comp(c) => {
                let gr = c.comp.process(l, r);
                // Kita simpan MAKSIMUM dalam blok penuh; sub-blok split membuat
                // process() dipanggil beberapa kali per blok.
                if gr > c.last_gr_db {
                    c.last_gr_db = gr;
                }
            }
        }
    }
}

/// Tabel FX datar: 2 node per unit (EQ lalu kompresor), dialokasi SEKALI.
pub struct FxRack {
    nodes: alloc::boxed::Box<[FxNode]>,
}

impl FxRack {
    pub fn new(units: usize, sample_rate: f32) -> Self {
        let mut v = alloc::vec::Vec::with_capacity(units * 2);
        for _ in 0..units {
            v.push(FxNode::Eq(Eq4::new(sample_rate)));
            v.push(FxNode::Comp(CompNode::new(sample_rate)));
        }
        FxRack {
            nodes: v.into_boxed_slice(),
        }
    }

    #[inline]
    pub fn get_mut(&mut self, node: u16) -> Option<&mut FxNode> {
        self.nodes.get_mut(node as usize)
    }

    pub fn eq_mut(&mut self, unit: u16) -> Option<&mut Eq4> {
        match self.nodes.get_mut(unit as usize * 2) {
            Some(FxNode::Eq(e)) => Some(e),
            _ => None,
        }
    }

    pub fn comp_mut(&mut self, unit: u16) -> Option<&mut CompNode> {
        match self.nodes.get_mut(unit as usize * 2 + 1) {
            Some(FxNode::Comp(c)) => Some(c),
            _ => None,
        }
    }

    /// GR blok terakhir untuk unit tsb (0.0 kalau bukan kompresor).
    pub fn gain_reduction(&self, unit: u16) -> f32 {
        match self.nodes.get(unit as usize * 2 + 1) {
            Some(FxNode::Comp(c)) => c.last_gr_db,
            _ => 0.0,
        }
    }

    /// Dipanggil sekali di AWAL tiap blok penuh (bukan sub-blok).
    pub fn begin_block(&mut self) {
        for n in self.nodes.iter_mut() {
            if let FxNode::Comp(c) = n {
                c.last_gr_db = 0.0;
            }
        }
    }

    /// Reset seluruh state IIR/envelope — dipakai saat seek & saat plan diganti.
    pub fn reset_all(&mut self) {
        for n in self.nodes.iter_mut() {
            match n {
                FxNode::Eq(e) => e.reset(),
                FxNode::Comp(c) => c.last_gr_db = 0.0,
            }
        }
    }
}
