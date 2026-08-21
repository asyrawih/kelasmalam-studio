//! Pemisahan stem mid/side komplementer untuk preview realtime dan export.

use daw_dsp::{Biquad, Coeffs, FilterKind};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};

static PARAMS: [ParamDesc; 5] = [
    ParamDesc {
        id: "vocal",
        name: "VOCAL",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 1.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "bass",
        name: "BASS",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 1.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "other",
        name: "OTHER",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 1.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "bassSplitHz",
        name: "BASS XOVER",
        unit: Unit::Hz,
        min: 60.0,
        max: 300.0,
        default: 180.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "voiceTopHz",
        name: "VOICE TOP",
        unit: Unit::Hz,
        min: 2000.0,
        max: 12000.0,
        default: 6000.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
];

pub struct StemFx {
    sample_rate: f32,
    low: Biquad,
    voice: Biquad,
    low_c: Coeffs,
    voice_c: Coeffs,
    vocal: f32,
    bass: f32,
    other: f32,
}

impl Effect for StemFx {
    const DESC: EffectDesc = EffectDesc {
        kind: 8,
        id: "stem",
        name: "STEM",
        category: Category::Filter,
        params: &PARAMS,
        summary: &[0, 1, 2],
        max_tail_ms: 50,
        latency_frames: 0,
    };

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        Self {
            sample_rate: sr,
            low: Biquad::new(),
            voice: Biquad::new(),
            low_c: Coeffs::design(FilterKind::LowPass, sr, 180.0, 1.0, 0.0),
            voice_c: Coeffs::design(FilterKind::LowPass, sr, 6000.0, 1.0, 0.0),
            vocal: 1.0,
            bass: 1.0,
            other: 1.0,
        }
    }

    fn prepare(&mut self, p: &ParamCtx<'_>) {
        self.vocal = p.at_or(0, 1.0).clamp(0.0, 1.0);
        self.bass = p.at_or(1, 1.0).clamp(0.0, 1.0);
        self.other = p.at_or(2, 1.0).clamp(0.0, 1.0);
        self.low_c = Coeffs::design(
            FilterKind::LowPass,
            self.sample_rate,
            p.at_or(3, 180.0),
            1.0,
            0.0,
        );
        self.voice_c = Coeffs::design(
            FilterKind::LowPass,
            self.sample_rate,
            p.at_or(4, 6000.0),
            1.0,
            0.0,
        );
    }

    fn process(&mut self, _mem: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        for (left, right) in l.iter_mut().zip(r.iter_mut()) {
            let mid = (*left + *right) * 0.5;
            let side = (*left - *right) * 0.5;
            let low = self.low.tick(mid, &self.low_c);
            let mid_high = mid - low;
            let voice = self.voice.tick(mid_high, &self.voice_c);
            let high = mid_high - voice;
            let m = self.bass * low + self.vocal * voice + self.other * high;
            let s = self.other * side;
            *left = m + s;
            *right = m - s;
        }
    }

    fn end_block(&mut self, _mem: &mut [f32]) {
        self.low.flush_denormal();
        self.voice.flush_denormal();
    }

    fn reset(&mut self, _mem: &mut [f32]) {
        self.low.reset();
        self.voice.reset();
    }

    fn tail_frames(&self, sample_rate: f32) -> u32 {
        (sample_rate * 0.05) as u32
    }
    fn cost_flops(&self) -> u32 {
        32
    }
}
