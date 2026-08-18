//! ECHO — delay berumpan-balik gaya DJ.
//!
//! ## Kenapa perubahan waktu di-CROSSFADE, bukan diluncurkan
//!
//! Mengganti pembagian 1/4 → 1/8 harus terdengar bersih. Meluncurkan posisi
//! baca akan meng-doppler seluruh ekor yang sedang berbunyi — itu efek yang
//! bagus, tapi namanya SPIRAL dan ia punya berkasnya sendiri. Melompatkannya
//! langsung menghasilkan klik.
//!
//! Jadi ada dua tap: tap A di waktu lama, tap B di waktu baru, disilangkan
//! dengan kurva equal-power selama 15 ms. `libm::sinf` hanya dipanggil SELAMA
//! crossfade berlangsung — preseden yang sama dengan `voice::fade_gain`.
//!
//! Pencacah crossfade-nya digerakkan PER SAMPLE, bukan per panggilan `process`.
//! Kalau per panggilan, memecah blok 1024 jadi 8×128 akan menjalankan
//! crossfade delapan kali lebih cepat dan hasil render berhenti identik —
//! `conformance::every_effect_is_resumable_across_sub_blocks` menolaknya.
//!
//! ## Kenapa ada DC blocker di dalam loop
//!
//! Lingkaran umpan-balik adalah integrator untuk komponen DC: pada `fb = 0.9`
//! gain DC-nya sepuluh kali. Sumbernya bukan hanya materi input — injeksi
//! anti-denormal dan asimetri interpolasi ikut menyumbang. Tanpa pemblokir,
//! ekor dengan feedback tinggi perlahan menuju saturasi, dan gejalanya muncul
//! sebagai "lama-lama pecah" yang nyaris mustahil dilacak balik.
//!
//! ## Ping-pong
//!
//! Menyilangkan umpan-balik antar kanal (`fb_L ← out_R`) tidak menambah satu
//! flop pun, dan itu yang orang harapkan dari echo DJ.

use daw_dsp::{ceil_pow2, DcBlock, Delay, OnePoleLp, Smoother};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};

/// Delay terpanjang yang bisa disimpan. Di atas ini nilainya dibatasi, bukan
/// membuat buffer membesar — memori arena adalah anggaran yang dibagi bersama.
pub const MAX_DELAY_SECONDS: f32 = 2.0;

/// Panjang crossfade saat waktu delay berubah.
const XFADE_MS: f32 = 15.0;

const ON_OFF: &[&str] = &["OFF", "ON"];

static PARAMS: [ParamDesc; 5] = [
    ParamDesc {
        id: "time",
        name: "TIME",
        unit: Unit::Ms,
        min: 10.0,
        max: 2_000.0,
        default: 375.0,
        taper: Taper::Log,
        smoothing: Smoothing::Stepped,
        flags: pflag::PRIMARY | pflag::BEAT_SYNC,
        choices: &[],
    },
    ParamDesc {
        id: "feedback",
        name: "FB",
        unit: Unit::Percent,
        min: 0.0,
        max: 0.95,
        default: 0.45,
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
        default: 6_000.0,
        taper: Taper::Log,
        smoothing: Smoothing::Block,
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "pingpong",
        name: "P-PONG",
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
        id: "mix",
        name: "LEVEL",
        unit: Unit::Percent,
        min: 0.0,
        max: 1.0,
        default: 0.35,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(15.0),
        flags: pflag::PRIMARY,
        choices: &[],
    },
];

/// Panjang satu kanal, dalam f32.
fn line_len(sample_rate: f32) -> usize {
    ceil_pow2((MAX_DELAY_SECONDS * sample_rate) as usize + 64)
}

pub struct EchoFx {
    sample_rate: f32,
    w: [usize; 2],
    /// Delay tap A dan B dalam sample. B hanya berarti selama crossfade.
    time_a: f32,
    time_b: f32,
    xfade: u32,
    xfade_len: u32,
    fb: Smoother,
    mix: Smoother,
    damp: [OnePoleLp; 2],
    dc: [DcBlock; 2],
    fed: [f32; 2],
    pingpong: bool,
    primed: bool,
}

impl EchoFx {
    fn max_delay(&self) -> f32 {
        (line_len(self.sample_rate) - 4) as f32
    }

    fn clamp_time(&self, ms: f32) -> f32 {
        let s = if ms.is_finite() { ms } else { 375.0 } * 0.001 * self.sample_rate;
        s.clamp(1.0, self.max_delay())
    }
}

impl Effect for EchoFx {
    const DESC: EffectDesc = EffectDesc {
        kind: 3,
        id: "echo",
        name: "ECHO",
        category: Category::TimeBased,
        params: &PARAMS,
        summary: &[0, 1],
        // Waktu maksimum × jumlah lintasan sampai −80 dB pada feedback tertinggi.
        max_tail_ms: 40_000,
        latency_frames: 0,
    };

    fn mem_frames(sample_rate: f32) -> usize {
        line_len(sample_rate) * 2
    }

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        let t = 0.375 * sr;
        EchoFx {
            sample_rate: sr,
            w: [0, 0],
            time_a: t,
            time_b: t,
            xfade: 0,
            xfade_len: (XFADE_MS * 0.001 * sr) as u32 + 1,
            fb: Smoother::new(sr, 20.0, 0.45),
            mix: Smoother::new(sr, 15.0, 0.35),
            damp: [OnePoleLp::with_cutoff(sr, 6_000.0); 2],
            dc: [DcBlock::with_rate(sr); 2],
            fed: [0.0, 0.0],
            pingpong: false,
            primed: false,
        }
    }

    fn prepare(&mut self, p: &ParamCtx<'_>) {
        let target = self.clamp_time(p.at_or(0, 375.0));
        let fb = p.at_or(1, 0.45).clamp(0.0, 0.95);
        let damp = p.at_or(2, 6_000.0);
        let mix = p.at_or(4, 0.35).clamp(0.0, 1.0);

        self.pingpong = p.at_or(3, 0.0) >= 0.5;
        self.fb.set_target(fb);
        self.mix.set_target(mix);
        for d in self.damp.iter_mut() {
            d.set_cutoff(self.sample_rate, damp);
        }

        if !self.primed {
            self.primed = true;
            self.time_a = target;
            self.time_b = target;
            self.fb.set_immediate(fb);
            self.mix.set_immediate(mix);
            return;
        }
        // Setengah sample: di bawah itu perubahannya tidak terdengar dan
        // memulai crossfade justru menambah kerja tanpa alasan.
        if (target - self.time_b).abs() > 0.5 {
            // Perubahan di tengah crossfade MENGARAHKAN ULANG tap B, bukan
            // memulai tap ketiga: dua tap adalah seluruh anggarannya.
            self.time_b = target;
            self.xfade = self.xfade_len;
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

        let inv = 1.0 / self.xfade_len as f32;
        for i in 0..n {
            let fb = self.fb.next();
            let mix = self.mix.next();

            let (ga, gb) = if self.xfade > 0 {
                let t = 1.0 - self.xfade as f32 * inv;
                let a = core::f32::consts::FRAC_PI_2 * t;
                (libm::cosf(a), libm::sinf(a))
            } else {
                (1.0, 0.0)
            };

            line_l.push(l[i] + self.fed[0]);
            line_r.push(r[i] + self.fed[1]);

            let mut wl = line_l.read_frac(self.time_a) * ga;
            let mut wr = line_r.read_frac(self.time_a) * ga;
            if gb > 0.0 {
                wl += line_l.read_frac(self.time_b) * gb;
                wr += line_r.read_frac(self.time_b) * gb;
            }

            let dl = self.dc[0].tick(self.damp[0].tick(wl)) * fb;
            let dr = self.dc[1].tick(self.damp[1].tick(wr)) * fb;
            if self.pingpong {
                self.fed[0] = dr;
                self.fed[1] = dl;
            } else {
                self.fed[0] = dl;
                self.fed[1] = dr;
            }

            l[i] = l[i] * (1.0 - mix) + wl * mix;
            r[i] = r[i] * (1.0 - mix) + wr * mix;

            if self.xfade > 0 {
                self.xfade -= 1;
                if self.xfade == 0 {
                    self.time_a = self.time_b;
                }
            }
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
        self.xfade = 0;
        self.time_b = self.time_a;
        for d in self.damp.iter_mut() {
            d.reset();
        }
        for d in self.dc.iter_mut() {
            d.reset();
        }
    }

    /// Waktu sampai ekornya turun −80 dB, dihitung dari parameter saja.
    ///
    /// WAJIB fungsi murni: mengukur energi membuat panjangnya bergantung pada
    /// slice yang kebetulan diberikan pemanggil, dan chain per-clip lalu
    /// dibebaskan pada waktu berbeda antara render 128 dan 1024 frame.
    fn tail_frames(&self, sample_rate: f32) -> u32 {
        let fb = self.fb.target().abs().min(0.999);
        let t = self.time_a.max(1.0);
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
        50
    }
}
