//! REVERB — feedback delay network 8×8.
//!
//! Inti DSP-nya ada di `daw_dsp::fdn`, termasuk alasan memilih FDN ketimbang
//! Freeverb dan Householder ketimbang Hadamard. Berkas ini menambahkan yang
//! dibutuhkan sebuah EFEK di atas jaringan itu: pre-delay, lebar stereo, dan
//! campuran kering/basah.
//!
//! ## Yang sengaja TIDAK ada: kluster allpass diffuser
//!
//! Reverb klasik menaruh beberapa allpass di depan tangki untuk menaikkan
//! kerapatan geman awal. Di sini tidak, karena kerapatannya sudah datang dari
//! tempat lain: matriks Householder mencampur kedelapan line **tiap sample**,
//! bukan membiarkannya paralel seperti comb Freeverb, dan empat line
//! dimodulasi untuk memecah nada berdiri. Menambahkan diffuser berarti empat
//! delay line lagi dan lebih banyak konstanta ajaib untuk perbaikan yang tidak
//! terdengar pada ekor sepanjang ini — dan artefak wasm punya anggaran ukuran
//! yang nyata (`scripts/size-check.sh`).
//!
//! Kalau kelak ada materi yang membuktikan geman awalnya terlalu jarang,
//! tempatnya jelas: antara pre-delay dan `Fdn8::tick`.

use daw_dsp::{ceil_pow2, fdn, Delay, Fdn8, Smoother};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};

const MAX_PREDELAY_MS: f32 = 200.0;

static PARAMS: [ParamDesc; 7] = [
    ParamDesc {
        id: "decay",
        name: "DECAY",
        unit: Unit::Ms,
        min: 200.0,
        max: 12_000.0,
        default: 2_200.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::PRIMARY,
        choices: &[],
    },
    ParamDesc {
        id: "size",
        name: "SIZE",
        unit: Unit::Percent,
        min: 0.3,
        max: 1.0,
        default: 0.8,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "damp",
        name: "DAMP",
        unit: Unit::Hz,
        min: 500.0,
        max: 16_000.0,
        default: 5_000.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "predelay",
        name: "PRE",
        unit: Unit::Ms,
        min: 0.0,
        max: MAX_PREDELAY_MS,
        default: 20.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(30.0),
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "modulation",
        name: "MOD",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 0.35,
        taper: Taper::Linear,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "width",
        name: "WIDTH",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 1.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(20.0),
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "mix",
        name: "MIX",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 0.25,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(15.0),
        flags: pflag::PRIMARY,
        choices: &[],
    },
];

fn pre_len(sample_rate: f32) -> usize {
    ceil_pow2((MAX_PREDELAY_MS * 0.001 * sample_rate) as usize + 32)
}

pub struct ReverbFx {
    sample_rate: f32,
    net: Fdn8,
    w: [usize; 2],
    predelay: Smoother,
    width: Smoother,
    mix: Smoother,
    rt60_s: f32,
    primed: bool,
}

impl Effect for ReverbFx {
    const DESC: EffectDesc = EffectDesc {
        kind: 6,
        id: "reverb",
        name: "REVERB",
        category: Category::TimeBased,
        params: &PARAMS,
        summary: &[0, 6],
        max_tail_ms: 20_000,
        latency_frames: 0,
    };

    fn mem_frames(sample_rate: f32) -> usize {
        fdn::mem_frames(sample_rate) + pre_len(sample_rate) * 2
    }

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        ReverbFx {
            sample_rate: sr,
            net: Fdn8::new(sr),
            w: [0, 0],
            predelay: Smoother::new(sr, 30.0, 0.020 * sr),
            width: Smoother::new(sr, 20.0, 1.0),
            mix: Smoother::new(sr, 15.0, 0.25),
            rt60_s: 2.2,
            primed: false,
        }
    }

    fn prepare(&mut self, p: &ParamCtx<'_>) {
        self.rt60_s = (p.at_or(0, 2_200.0) * 0.001).clamp(0.05, 60.0);
        let size = p.at_or(1, 0.8);
        let damp = p.at_or(2, 5_000.0);
        let modu = p.at_or(4, 0.35);
        let pre =
            (p.at_or(3, 20.0).clamp(0.0, MAX_PREDELAY_MS) * 0.001 * self.sample_rate).max(1.0);
        let width = p.at_or(5, 1.0).clamp(0.0, 1.0);
        let mix = p.at_or(6, 0.25).clamp(0.0, 1.0);

        self.net.set_params(self.rt60_s, size, damp, modu);
        self.predelay.set_target(pre);
        self.width.set_target(width);
        self.mix.set_target(mix);
        if !self.primed {
            self.primed = true;
            self.predelay.set_immediate(pre);
            self.width.set_immediate(width);
            self.mix.set_immediate(mix);
        }
    }

    fn process(&mut self, mem: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let fdn_len = fdn::mem_frames(self.sample_rate);
        if mem.len() < fdn_len + 2 {
            return;
        }
        let (net_mem, pre_mem) = mem.split_at_mut(fdn_len);
        let half = pre_mem.len() / 2;
        if half == 0 {
            return;
        }
        let (pl, pr) = pre_mem.split_at_mut(half);
        let (Some(mut line_l), Some(mut line_r)) =
            (Delay::attach(pl, self.w[0]), Delay::attach(pr, self.w[1]))
        else {
            return;
        };

        for i in 0..n {
            let pre = self.predelay.next();
            let width = self.width.next();
            let mix = self.mix.next();

            let dl = line_l.tick(l[i], pre);
            let dr = line_r.tick(r[i], pre);
            let (mut wl, mut wr) = self.net.tick(net_mem, dl, dr);

            // Lebar: 0 = mono penuh, 1 = seperti keluar tangki. Dihitung dari
            // mid/side supaya width=0 tidak menurunkan level (yang terjadi
            // kalau kedua kanal cuma dirata-rata dan sisanya dibuang).
            let mid = (wl + wr) * 0.5;
            let side = (wl - wr) * 0.5 * width;
            wl = mid + side;
            wr = mid - side;

            l[i] = l[i] * (1.0 - mix) + wl * mix;
            r[i] = r[i] * (1.0 - mix) + wr * mix;
        }

        self.w = [line_l.write_pos(), line_r.write_pos()];
    }

    fn end_block(&mut self, _mem: &mut [f32]) {
        self.net.flush_denormals();
        self.predelay.flush_denormal();
        self.width.flush_denormal();
        self.mix.flush_denormal();
    }

    fn reset(&mut self, mem: &mut [f32]) {
        let fdn_len = fdn::mem_frames(self.sample_rate);
        if mem.len() >= fdn_len {
            let (net_mem, pre_mem) = mem.split_at_mut(fdn_len);
            self.net.reset(net_mem);
            for s in pre_mem.iter_mut() {
                *s = 0.0;
            }
        }
        self.w = [0, 0];
    }

    fn tail_frames(&self, sample_rate: f32) -> u32 {
        // RT60 adalah −60 dB; ekor dianggap habis di −80 dB, jadi 4/3 kalinya.
        let frames = self.rt60_s * sample_rate * (4.0 / 3.0);
        let cap = sample_rate * (Self::DESC.max_tail_ms as f32 * 0.001);
        if frames > cap {
            cap as u32
        } else {
            frames as u32
        }
    }

    fn cost_flops(&self) -> u32 {
        190
    }
}
