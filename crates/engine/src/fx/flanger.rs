//! FLANGER — delay pendek yang disapu LFO, dengan umpan-balik.
//!
//! ## Kenapa BUKAN through-zero
//!
//! Flanger through-zero butuh jalur kering ikut di-delay sebesar kedalaman
//! modulasi supaya tap basah bisa menyeberanginya. Itu menambahkan ~5 ms
//! latensi **pada sebuah insert track**.
//!
//! Engine ini tidak punya kompensasi delay: tidak ada `Step::Delay`,
//! `build_plan` tidak menghitung latensi, dan send adalah tap post-fader dari
//! buffer yang sama. Menyalakan TZF di satu track akan menggeser track itu 5 ms
//! terhadap seluruh mix DAN terhadap send-nya sendiri — comb filtering di
//! semua tempat, muncul hanya ketika satu user menyalakan satu efek.
//!
//! Yang membuatnya berbahaya: null-test tetap LULUS. Ia deterministik, jadi
//! render 128 dan 1024 frame tetap identik sementara mix-nya salah. Tidak ada
//! tes yang akan menangkapnya.
//!
//! Syarat untuk membukanya kelak ditulis di sini supaya tidak jadi "suatu
//! saat": TZF menunggu `ProcessPlan` bisa menyatakan latensi per node.
//!
//! Umpan-balik NEGATIF didukung dan bukan detail: comb terbalik adalah asal
//! nada "jet" yang berongga.

use daw_dsp::{ceil_pow2, Delay, Lfo, LfoShape, Smoother, QUARTER_TURN};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};

const MAX_DEPTH_MS: f32 = 5.0;
const MAX_BASE_MS: f32 = 5.0;
/// Ruang untuk depth + base + margin interpolasi.
const MAX_TOTAL_MS: f32 = MAX_DEPTH_MS + MAX_BASE_MS + 2.0;

const SHAPES: &[&str] = &["SINE", "TRI"];

static PARAMS: [ParamDesc; 7] = [
    ParamDesc {
        id: "rate",
        name: "RATE",
        unit: Unit::Hz,
        min: 0.02,
        max: 10.0,
        default: 0.25,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::PRIMARY | pflag::BEAT_SYNC,
        choices: &[],
    },
    ParamDesc {
        id: "depth",
        name: "DEPTH",
        unit: Unit::Ms,
        min: 0.0,
        max: MAX_DEPTH_MS,
        default: 2.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(20.0),
        flags: pflag::PRIMARY,
        choices: &[],
    },
    ParamDesc {
        id: "base",
        name: "DELAY",
        unit: Unit::Ms,
        min: 0.1,
        max: MAX_BASE_MS,
        default: 0.5,
        taper: Taper::Log,
        smoothing: Smoothing::Sample(20.0),
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "feedback",
        name: "FB",
        unit: Unit::Percent,
        min: -0.95,
        max: 0.95,
        default: 0.5,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(20.0),
        flags: pflag::BIPOLAR,
        choices: &[],
    },
    ParamDesc {
        id: "shape",
        name: "SHAPE",
        unit: Unit::Choice,
        min: 0.0,
        max: 1.0,
        default: 1.0,
        taper: Taper::Stepped(2),
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: SHAPES,
    },
    ParamDesc {
        id: "stereo",
        name: "WIDTH",
        unit: Unit::Degrees,
        min: 0.0,
        max: 180.0,
        default: 90.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "mix",
        name: "MIX",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 0.5,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(15.0),
        flags: pflag::NONE,
        choices: &[],
    },
];

fn line_len(sample_rate: f32) -> usize {
    ceil_pow2((MAX_TOTAL_MS * 0.001 * sample_rate) as usize + 32)
}

pub struct FlangerFx {
    sample_rate: f32,
    w: [usize; 2],
    lfo: Lfo,
    shape: LfoShape,
    /// Offset fase kanal kanan, dalam satuan putaran u32.
    stereo_offset: u32,
    depth: Smoother,
    base: Smoother,
    fb: Smoother,
    mix: Smoother,
    fed: [f32; 2],
    primed: bool,
}

impl Effect for FlangerFx {
    const DESC: EffectDesc = EffectDesc {
        kind: 5,
        id: "flanger",
        name: "FLANGER",
        category: Category::Modulation,
        params: &PARAMS,
        summary: &[0, 1],
        max_tail_ms: 400,
        latency_frames: 0,
    };

    fn mem_frames(sample_rate: f32) -> usize {
        line_len(sample_rate) * 2
    }

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        let mut lfo = Lfo::new();
        lfo.set_rate(sr, 0.25);
        FlangerFx {
            sample_rate: sr,
            w: [0, 0],
            lfo,
            shape: LfoShape::Triangle,
            stereo_offset: QUARTER_TURN,
            depth: Smoother::new(sr, 20.0, 2.0 * 0.001 * sr),
            base: Smoother::new(sr, 20.0, 0.5 * 0.001 * sr),
            fb: Smoother::new(sr, 20.0, 0.5),
            mix: Smoother::new(sr, 15.0, 0.5),
            fed: [0.0, 0.0],
            primed: false,
        }
    }

    fn prepare(&mut self, p: &ParamCtx<'_>) {
        let rate = p.at_or(0, 0.25).clamp(0.0, 20.0);
        let depth = p.at_or(1, 2.0).clamp(0.0, MAX_DEPTH_MS) * 0.001 * self.sample_rate;
        let base = p.at_or(2, 0.5).clamp(0.05, MAX_BASE_MS) * 0.001 * self.sample_rate;
        let fb = p.at_or(3, 0.5).clamp(-0.95, 0.95);
        let mix = p.at_or(6, 0.5).clamp(0.0, 1.0);

        // Laju diubah lewat `inc` saja; fase TIDAK pernah di-reset. Me-reset
        // fase saat rate berubah akan terdengar sebagai lompatan di tengah
        // sapuan.
        self.lfo.set_rate(self.sample_rate, rate);
        self.shape = if p.at_or(4, 1.0) >= 0.5 {
            LfoShape::Triangle
        } else {
            LfoShape::Sine
        };
        let deg = p.at_or(5, 90.0).clamp(0.0, 180.0);
        self.stereo_offset = ((deg / 360.0) as f64 * 4_294_967_296.0) as i64 as u32;

        self.depth.set_target(depth);
        self.base.set_target(base);
        self.fb.set_target(fb);
        self.mix.set_target(mix);
        if !self.primed {
            self.primed = true;
            self.depth.set_immediate(depth);
            self.base.set_immediate(base);
            self.fb.set_immediate(fb);
            self.mix.set_immediate(mix);
        }
    }

    fn process(&mut self, mem: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let half = mem.len() / 2;
        if half == 0 {
            return;
        }
        let (ml, mr) = mem.split_at_mut(half);
        let (Some(mut line_l), Some(mut line_r)) =
            (Delay::attach(ml, self.w[0]), Delay::attach(mr, self.w[1]))
        else {
            return;
        };

        for i in 0..n {
            // Depth dan base WAJIB lewat smoother: menggeser knob depth tanpa
            // penghalusan menggeser pointer baca puluhan sample sekaligus, dan
            // itu terdengar sebagai klik. Ini bug flanger yang paling sering.
            let depth = self.depth.next();
            let base = self.base.next();
            let fb = self.fb.next();
            let mix = self.mix.next();

            let ml_v = self.lfo.peek_at(0, self.shape);
            let mr_v = self.lfo.peek_at(self.stereo_offset, self.shape);
            self.lfo.next(self.shape);

            let dl = base + depth * (ml_v * 0.5 + 0.5);
            let dr = base + depth * (mr_v * 0.5 + 0.5);

            line_l.push(l[i] + self.fed[0]);
            line_r.push(r[i] + self.fed[1]);
            let wl = line_l.read_frac(dl);
            let wr = line_r.read_frac(dr);

            self.fed[0] = wl * fb;
            self.fed[1] = wr * fb;

            l[i] = l[i] * (1.0 - mix) + wl * mix;
            r[i] = r[i] * (1.0 - mix) + wr * mix;
        }

        self.w = [line_l.write_pos(), line_r.write_pos()];
    }

    fn end_block(&mut self, _mem: &mut [f32]) {
        self.depth.flush_denormal();
        self.base.flush_denormal();
        self.fb.flush_denormal();
        self.mix.flush_denormal();
    }

    fn reset(&mut self, mem: &mut [f32]) {
        for s in mem.iter_mut() {
            *s = 0.0;
        }
        self.w = [0, 0];
        self.fed = [0.0, 0.0];
        self.lfo.reset();
    }

    fn tail_frames(&self, sample_rate: f32) -> u32 {
        let fb = self.fb.target().abs().min(0.95);
        let d = (self.base.target() + self.depth.target()).max(1.0);
        let passes = if fb < 1.0e-3 {
            1.0
        } else {
            libm::logf(1.0e-4) / libm::logf(fb)
        };
        let cap = sample_rate * (Self::DESC.max_tail_ms as f32 * 0.001);
        let frames = d * passes;
        if frames > cap {
            cap as u32
        } else {
            frames as u32
        }
    }

    fn cost_flops(&self) -> u32 {
        60
    }
}
