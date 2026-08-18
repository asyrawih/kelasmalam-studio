//! Kompresor feed-forward stereo-linked.

use daw_dsp::{CompParams, Compressor, Detector};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};
use crate::snapshot::CompSettings;

const DETECTOR_CHOICES: &[&str] = &["PEAK", "RMS"];
const ON_OFF: &[&str] = &["OFF", "ON"];

/// Urutannya kontrak: snapshot menyimpan nilai berdasarkan indeks di sini.
/// Default-nya disamakan dengan `CompSettings::default()`.
static COMP_PARAMS: [ParamDesc; 9] = [
    ParamDesc {
        id: "threshold",
        name: "THRESH",
        unit: Unit::Db,
        min: -60.0,
        max: 0.0,
        default: -18.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::PRIMARY,
        choices: &[],
    },
    ParamDesc {
        id: "ratio",
        name: "RATIO",
        unit: Unit::Ratio,
        min: 1.0,
        max: 20.0,
        default: 3.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::PRIMARY,
        choices: &[],
    },
    ParamDesc {
        id: "knee",
        name: "KNEE",
        unit: Unit::Db,
        min: 0.0,
        max: 24.0,
        default: 6.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "attack",
        name: "ATTACK",
        unit: Unit::Ms,
        min: 0.1,
        max: 200.0,
        default: 10.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "release",
        name: "RELEASE",
        unit: Unit::Ms,
        min: 5.0,
        max: 2_000.0,
        default: 120.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "makeup",
        name: "MAKEUP",
        unit: Unit::Db,
        min: -24.0,
        max: 24.0,
        default: 0.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::BIPOLAR,
        choices: &[],
    },
    ParamDesc {
        id: "detector",
        name: "DET",
        unit: Unit::Choice,
        min: 0.0,
        max: 1.0,
        default: 0.0,
        taper: Taper::Stepped(2),
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: DETECTOR_CHOICES,
    },
    ParamDesc {
        id: "auto_makeup",
        name: "AUTO",
        unit: Unit::Choice,
        min: 0.0,
        max: 1.0,
        default: 0.0,
        taper: Taper::Stepped(2),
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: ON_OFF,
    },
    ParamDesc {
        id: "enabled",
        name: "ON",
        unit: Unit::Choice,
        min: 0.0,
        max: 1.0,
        default: 0.0,
        taper: Taper::Stepped(2),
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: ON_OFF,
    },
];

/// Kompresor feed-forward stereo-linked + laporan gain reduction ke meter.
pub struct CompNode {
    comp: Compressor,
    /// GR maksimum (dB, positif) di blok terakhir — dibaca meter.rs.
    pub last_gr_db: f32,
}

impl CompNode {
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

impl Effect for CompNode {
    const DESC: EffectDesc = EffectDesc {
        kind: 1,
        id: "comp",
        name: "COMP",
        category: Category::Dynamics,
        params: &COMP_PARAMS,
        summary: &[0, 1],
        max_tail_ms: 0,
        latency_frames: 0,
    };

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        CompNode {
            comp: Compressor::new(sample_rate),
            last_gr_db: 0.0,
        }
    }

    /// Kosong sampai jalur param block hidup (Fase 3) — lihat catatan di `eq.rs`.
    fn prepare(&mut self, _p: &ParamCtx<'_>) {}

    /// GR dilaporkan sebagai MAKSIMUM dalam blok penuh, jadi akumulatornya
    /// dinolkan di sini dan bukan di `process` — `process` dipanggil beberapa
    /// kali per blok kalau ada event yang memecah sub-blok.
    fn begin_block(&mut self, _mem: &mut [f32]) {
        self.last_gr_db = 0.0;
    }

    #[inline]
    fn process(&mut self, _mem: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        let gr = self.comp.process(l, r);
        if gr > self.last_gr_db {
            self.last_gr_db = gr;
        }
    }

    fn reset(&mut self, _mem: &mut [f32]) {
        self.last_gr_db = 0.0;
    }

    fn cost_flops(&self) -> u32 {
        30
    }

    fn gain_reduction_db(&self) -> f32 {
        self.last_gr_db
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_is_valid_and_matches_engine_defaults() {
        assert!(CompNode::DESC.is_valid());
        let d = CompSettings::default();
        assert_eq!(CompNode::DESC.params[0].default, d.threshold_db);
        assert_eq!(CompNode::DESC.params[1].default, d.ratio);
        assert_eq!(CompNode::DESC.params[2].default, d.knee_db);
        assert_eq!(CompNode::DESC.params[3].default, d.attack_ms);
        assert_eq!(CompNode::DESC.params[4].default, d.release_ms);
        assert_eq!(CompNode::DESC.params[5].default, d.makeup_db);
        assert_eq!(CompNode::DESC.params[6].default, d.detector as f32);
    }

    /// GR harus maksimum se-blok, bukan nilai sub-blok terakhir — meter yang
    /// membaca sub-blok terakhir akan berkedip-kedip alih-alih menahan puncak.
    #[test]
    fn gain_reduction_is_the_block_maximum() {
        let mut c = CompNode::new(48_000.0, &mut []);
        c.set_settings(&CompSettings {
            threshold_db: -24.0,
            ratio: 8.0,
            enabled: true,
            ..CompSettings::default()
        });
        c.begin_block(&mut []);

        // Sub-blok keras dulu, lalu senyap: yang dilaporkan harus tetap yang keras.
        let mut loud_l = [0.9f32; 64];
        let mut loud_r = [0.9f32; 64];
        c.process(&mut [], &mut loud_l, &mut loud_r);
        let after_loud = c.gain_reduction_db();
        assert!(after_loud > 0.0, "kompresor tidak bekerja: {after_loud}");

        let mut quiet_l = [0.0f32; 64];
        let mut quiet_r = [0.0f32; 64];
        c.process(&mut [], &mut quiet_l, &mut quiet_r);
        assert_eq!(
            c.gain_reduction_db(),
            after_loud,
            "GR turun mengikuti sub-blok terakhir"
        );
    }
}
