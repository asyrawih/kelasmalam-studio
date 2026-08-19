//! SPIRAL — delay gaya tape yang waktunya MELUNCUR, jadi tiap perubahan waktu
//! menggeser pitch ekor yang sedang berbunyi.
//!
//! ## Apa yang sebenarnya terjadi
//!
//! Doppler-nya ada **hanya selama waktu delay sedang berubah**. Begitu ia
//! berhenti, repeat berikutnya kembali ke pitch aslinya. "Spiral tanpa ujung"
//! yang orang kenal adalah hasil feedback tinggi DITAMBAH knob yang terus
//! digerakkan: tiap lintasan menerapkan ulang pergeserannya, jadi efeknya
//! mengompon.
//!
//! ## Kenapa luncurannya eksponensial, bukan linear
//!
//! Motor tape melambat secara eksponensial. Ramp linear memberi offset pitch
//! yang KONSTAN selama transisi lalu menyentak kembali ke normal di akhir —
//! bunyinya seperti pitch-bend wheel, bukan seperti tape.
//!
//! ## Bahaya yang harus dijaga: pointer baca menyusul pointer tulis
//!
//! Rasio pitch selama luncuran adalah `1 − d′(n)`, dengan `d′` perubahan delay
//! per sample. Untuk lompatan satu detik, `d′` bisa jauh melebihi 1 — pointer
//! baca lalu bergerak mundur melewati pointer tulis lebih cepat daripada
//! materi ditulis, dan yang terdengar bukan delay melainkan tape yang di-rewind.
//! Karena itu `d′` dibatasi `±0.5`, yang mengurung pitch di ±1 oktaf. Satu
//! `clamp` per sample.

use daw_dsp::{ceil_pow2, DcBlock, Delay, OnePoleLp, Smoother};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};

const MAX_DELAY_SECONDS: f32 = 1.0;

/// Batas perubahan delay per sample. ±0.5 = pitch terkurung di ±1 oktaf.
const MAX_SLEW: f32 = 0.5;

static PARAMS: [ParamDesc; 5] = [
    ParamDesc {
        id: "time",
        name: "TIME",
        unit: Unit::Ms,
        min: 1.0,
        max: 1_000.0,
        default: 250.0,
        taper: Taper::Log,
        smoothing: Smoothing::Sample(120.0),
        // Perubahannya memang menghasilkan lompatan yang DISENGAJA — itulah
        // efeknya. UI tidak perlu memperingatkan soal zipper di sini.
        flags: pflag::PRIMARY | pflag::JUMPS | pflag::BEAT_SYNC,
        choices: &[],
    },
    ParamDesc {
        id: "feedback",
        name: "FB",
        unit: Unit::Percent,
        min: 0.0,
        max: 0.98,
        default: 0.85,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(20.0),
        flags: pflag::PRIMARY,
        choices: &[],
    },
    ParamDesc {
        id: "damp",
        name: "TONE",
        unit: Unit::Hz,
        min: 500.0,
        max: 18_000.0,
        default: 4_000.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "glide",
        name: "GLIDE",
        unit: Unit::Ms,
        min: 5.0,
        max: 500.0,
        default: 120.0,
        taper: Taper::Log,
        smoothing: Smoothing::Stepped,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "mix",
        name: "LEVEL",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 0.5,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(15.0),
        flags: pflag::PRIMARY,
        choices: &[],
    },
];

fn line_len(sample_rate: f32) -> usize {
    ceil_pow2((MAX_DELAY_SECONDS * sample_rate) as usize + 64)
}

pub struct SpiralFx {
    sample_rate: f32,
    w: [usize; 2],
    /// Delay saat ini dan tujuannya, dalam sample.
    cur: f32,
    target: f32,
    /// Koefisien satu-kutub luncuran. Dihitung di `prepare` karena `glide`
    /// boleh diubah user.
    glide_k: f32,
    fb: Smoother,
    mix: Smoother,
    damp: [OnePoleLp; 2],
    dc: [DcBlock; 2],
    fed: [f32; 2],
    primed: bool,
}

impl SpiralFx {
    fn max_delay(&self) -> f32 {
        (line_len(self.sample_rate) - 4) as f32
    }

    fn clamp_time(&self, ms: f32) -> f32 {
        let s = if ms.is_finite() { ms } else { 250.0 } * 0.001 * self.sample_rate;
        s.clamp(2.0, self.max_delay())
    }
}

impl Effect for SpiralFx {
    const DESC: EffectDesc = EffectDesc {
        kind: 4,
        id: "spiral",
        name: "SPIRAL",
        category: Category::TimeBased,
        params: &PARAMS,
        summary: &[0, 1],
        max_tail_ms: 30_000,
        latency_frames: 0,
    };

    fn mem_frames(sample_rate: f32) -> usize {
        line_len(sample_rate) * 2
    }

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        SpiralFx {
            sample_rate: sr,
            w: [0, 0],
            cur: 0.25 * sr,
            target: 0.25 * sr,
            glide_k: 1.0 - libm::expf(-1.0 / (0.120 * sr)),
            fb: Smoother::new(sr, 20.0, 0.85),
            mix: Smoother::new(sr, 15.0, 0.5),
            damp: [OnePoleLp::with_cutoff(sr, 4_000.0); 2],
            dc: [DcBlock::with_rate(sr); 2],
            fed: [0.0, 0.0],
            primed: false,
        }
    }

    fn prepare(&mut self, p: &ParamCtx<'_>) {
        self.target = self.clamp_time(p.at_or(0, 250.0));
        let fb = p.at_or(1, 0.85).clamp(0.0, 0.98);
        let damp = p.at_or(2, 4_000.0);
        let glide_ms = p.at_or(3, 120.0).clamp(1.0, 2_000.0);
        let mix = p.at_or(4, 0.5).clamp(0.0, 1.0);

        self.fb.set_target(fb);
        self.mix.set_target(mix);
        for d in self.damp.iter_mut() {
            d.set_cutoff(self.sample_rate, damp);
        }
        // tau dalam sample; `expf` di sini bukan di inner loop.
        self.glide_k = 1.0 - libm::expf(-1.0 / (glide_ms * 0.001 * self.sample_rate));

        if !self.primed {
            self.primed = true;
            self.cur = self.target;
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
            let fb = self.fb.next();
            let mix = self.mix.next();

            // Luncuran eksponensial dengan batas laju. Batasnya yang mencegah
            // pointer baca menyusul pointer tulis — lihat catatan modul.
            let mut step = (self.target - self.cur) * self.glide_k;
            // Clippy menyarankan `step.clamp(-MAX_SLEW, MAX_SLEW)`. `f32::clamp`
            // PANIC kalau batasnya tidak terurut, dan aturan crate ini (docs/01
            // §1c, diulang di komentar `ParamDesc::clamp`) melarang panic di
            // jalur render — itu justru kenapa `clampf` ditulis tangan dan
            // dipakai di mana-mana. Batas di sini memang konstanta, jadi panic
            // itu tidak akan terjadi; tapi memakai API yang bisa panic di inner
            // loop RT hanya karena "kebetulan aman di sini" adalah preseden yang
            // salah untuk baris berikutnya yang menyalinnya.
            #[allow(clippy::manual_clamp)]
            if step > MAX_SLEW {
                step = MAX_SLEW;
            } else if step < -MAX_SLEW {
                step = -MAX_SLEW;
            }
            self.cur += step;

            line_l.push(l[i] + self.fed[0]);
            line_r.push(r[i] + self.fed[1]);
            let wl = line_l.read_frac(self.cur);
            let wr = line_r.read_frac(self.cur);

            self.fed[0] = self.dc[0].tick(self.damp[0].tick(wl)) * fb;
            self.fed[1] = self.dc[1].tick(self.damp[1].tick(wr)) * fb;

            l[i] = l[i] * (1.0 - mix) + wl * mix;
            r[i] = r[i] * (1.0 - mix) + wr * mix;
        }

        self.w = [line_l.write_pos(), line_r.write_pos()];
    }

    fn end_block(&mut self, _mem: &mut [f32]) {
        for d in self.damp.iter_mut() {
            d.flush_denormal();
        }
        for d in self.dc.iter_mut() {
            d.flush_denormal();
        }
        self.fb.flush_denormal();
        self.mix.flush_denormal();
    }

    fn reset(&mut self, mem: &mut [f32]) {
        for s in mem.iter_mut() {
            *s = 0.0;
        }
        self.w = [0, 0];
        self.fed = [0.0, 0.0];
        self.cur = self.target;
        for d in self.damp.iter_mut() {
            d.reset();
        }
        for d in self.dc.iter_mut() {
            d.reset();
        }
    }

    fn tail_frames(&self, sample_rate: f32) -> u32 {
        let fb = self.fb.target().abs().min(0.999);
        let t = self.cur.max(1.0);
        let passes = if fb < 1.0e-3 {
            1.0
        } else {
            libm::logf(1.0e-4) / libm::logf(fb)
        };
        let frames = t * passes;
        let cap = sample_rate * (Self::DESC.max_tail_ms as f32 * 0.001);
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
