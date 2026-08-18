//! PITCH — penggeser nada dua-tap ber-crossfade.
//!
//! ## Kenapa bukan phase vocoder, dan bukan granular
//!
//! **Phase vocoder** memberi kualitas terbaik tapi butuh jendela ≥2048 sample
//! — 43 ms latensi pada 48 kHz. Engine ini tidak punya kompensasi delay
//! (alasan lengkapnya di `flanger.rs`), jadi efek berlatensi akan menggeser
//! satu track terhadap seluruh mix sementara null-test tetap lulus. Ditambah
//! FFT dan tabel twiddle-nya 10–15 KB untuk satu efek, di artefak yang punya
//! anggaran ukuran nyata.
//!
//! **Granular** lebih baik pada materi polifonik, tapi keunggulannya datang
//! dari onset grain yang DIACAK. Keacakan di jalur render berarti state PRNG
//! jadi bagian dari state render, yang harus selamat melewati snapshot secara
//! identik supaya null-test dan kesetaraan offline/realtime tetap berlaku —
//! sebuah invarian baru yang harus dibela selamanya, demi sebuah mainan DJ.
//!
//! ## Trik yang menghilangkan satu-satunya bahaya nyatanya
//!
//! Delay baca harus melingkar di dalam jendela. Implementasi berbasis float
//! akhirnya selalu menemui masalah yang sama: akumulasi pembulatan membuat
//! posisinya melenceng keluar `[0, W)`, dan gejalanya muncul setelah berjam-jam.
//!
//! Di sini pembungkusnya dilakukan **akumulator fase u32**: `p.wrapping_add(inc)`
//! bit-eksak dan mustahil melenceng. `p` yang sama juga mengindeks jendelanya,
//! jadi kedua tap dijamin sinkron.
//!
//! Jendelanya `sin`, dan tap kedua digeser setengah putaran. `sin²+cos² = 1`
//! membuat jumlah dayanya konstan persis, dan tiap tap meredup ke **tepat nol**
//! di titik wrap-nya sendiri — jadi diskontinuitas gigi gergajinya dijendelakan
//! menjadi senyap alih-alih menjadi klik.

use daw_dsp::{ceil_pow2, fast_sin_norm, DcBlock, Delay, OnePoleLp, Smoother};

use super::desc::{pflag, Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
use super::{Effect, ParamCtx};

const MAX_WINDOW_MS: f32 = 120.0;
/// Tap hermite butuh ruang di kedua sisi.
const MIN_DELAY: f32 = 2.0;

static PARAMS: [ParamDesc; 5] = [
    ParamDesc {
        id: "semitones",
        name: "PITCH",
        unit: Unit::Semitones,
        min: -12.0,
        max: 12.0,
        default: 0.0,
        taper: Taper::Stepped(25),
        smoothing: Smoothing::Stepped,
        flags: pflag::PRIMARY | pflag::BIPOLAR,
        choices: &[],
    },
    ParamDesc {
        id: "cents",
        name: "FINE",
        unit: Unit::Linear,
        min: -100.0,
        max: 100.0,
        default: 0.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Stepped,
        flags: pflag::BIPOLAR,
        choices: &[],
    },
    ParamDesc {
        id: "window",
        name: "GRAIN",
        unit: Unit::Ms,
        min: 20.0,
        max: MAX_WINDOW_MS,
        default: 60.0,
        taper: Taper::Log,
        smoothing: Smoothing::Sample(50.0),
        flags: pflag::NONE,
        choices: &[],
    },
    ParamDesc {
        id: "feedback",
        name: "FB",
        unit: Unit::Percent,
        min: 0.0,
        max: 0.9,
        default: 0.0,
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
        default: 1.0,
        taper: Taper::Linear,
        smoothing: Smoothing::Sample(15.0),
        flags: pflag::PRIMARY,
        choices: &[],
    },
];

fn line_len(sample_rate: f32) -> usize {
    ceil_pow2((MAX_WINDOW_MS * 0.001 * sample_rate) as usize + 64)
}

pub struct PitchFx {
    sample_rate: f32,
    w: [usize; 2],
    /// Fase jendela. Wrapping-nya bit-eksak — lihat catatan modul.
    phase: u32,
    inc: u32,
    window: Smoother,
    fb: Smoother,
    mix: Smoother,
    damp: [OnePoleLp; 2],
    dc: [DcBlock; 2],
    fed: [f32; 2],
    primed: bool,
}

impl PitchFx {
    /// `inc` sedemikian sehingga posisi baca bergerak `1 − ratio` sample per
    /// sample keluaran, membungkus tepat sekali tiap panjang jendela.
    fn set_ratio(&mut self, ratio: f32, window_samples: f32) {
        let w = window_samples.max(8.0);
        let step = (1.0 - ratio) as f64 / w as f64;
        self.inc = (step * 4_294_967_296.0) as i64 as u32;
    }
}

impl Effect for PitchFx {
    const DESC: EffectDesc = EffectDesc {
        kind: 7,
        id: "pitch",
        name: "PITCH",
        category: Category::Pitch,
        params: &PARAMS,
        summary: &[0, 4],
        max_tail_ms: 4_000,
        latency_frames: 0,
    };

    fn mem_frames(sample_rate: f32) -> usize {
        line_len(sample_rate) * 2
    }

    fn new(sample_rate: f32, _mem: &mut [f32]) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        PitchFx {
            sample_rate: sr,
            w: [0, 0],
            phase: 0,
            inc: 0,
            window: Smoother::new(sr, 50.0, 0.060 * sr),
            fb: Smoother::new(sr, 20.0, 0.0),
            mix: Smoother::new(sr, 15.0, 1.0),
            damp: [OnePoleLp::with_cutoff(sr, 12_000.0); 2],
            dc: [DcBlock::with_rate(sr); 2],
            fed: [0.0, 0.0],
            primed: false,
        }
    }

    fn prepare(&mut self, p: &ParamCtx<'_>) {
        let semis = p.at_or(0, 0.0).clamp(-24.0, 24.0);
        let cents = p.at_or(1, 0.0).clamp(-200.0, 200.0);
        let win = (p.at_or(2, 60.0).clamp(5.0, MAX_WINDOW_MS) * 0.001 * self.sample_rate)
            .max(8.0);
        let fb = p.at_or(3, 0.0).clamp(0.0, 0.9);
        let mix = p.at_or(4, 1.0).clamp(0.0, 1.0);

        let ratio = libm::exp2f((semis + cents / 100.0) / 12.0).clamp(0.25, 4.0);
        self.window.set_target(win);
        self.fb.set_target(fb);
        self.mix.set_target(mix);
        if !self.primed {
            self.primed = true;
            self.window.set_immediate(win);
            self.fb.set_immediate(fb);
            self.mix.set_immediate(mix);
        }
        // Fase TIDAK di-reset saat window berubah: me-reset-nya melompatkan
        // kedua tap sekaligus, dan itu terdengar sebagai klik. Yang berubah
        // hanya lajunya, sehingga jendelanya sesaat "wobble" — dan wobble itu
        // memang bunyi yang benar untuk perubahan ukuran grain.
        self.set_ratio(ratio, self.window.current());
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
        const TO_UNIT: f32 = 1.0 / 4_294_967_296.0;

        for i in 0..n {
            let win = self.window.next();
            let fb = self.fb.next();
            let mix = self.mix.next();

            let pa = self.phase;
            let pb = pa.wrapping_add(0x8000_0000);
            let da = MIN_DELAY + (pa as f32 * TO_UNIT) * win;
            let db = MIN_DELAY + (pb as f32 * TO_UNIT) * win;

            // Jendela sin: nol persis di titik wrap masing-masing tap, dan
            // wA² + wB² = 1 sehingga dayanya konstan.
            let wa = fast_sin_norm(pa >> 1);
            let wb = fast_sin_norm((pa >> 1).wrapping_add(0x4000_0000));

            line_l.push(l[i] + self.fed[0]);
            line_r.push(r[i] + self.fed[1]);
            let wl = line_l.read_frac(da) * wa + line_l.read_frac(db) * wb;
            let wr = line_r.read_frac(da) * wa + line_r.read_frac(db) * wb;

            // Damping DAN DC block wajib di loop: dengan pergeseran nada,
            // energi bermigrasi monoton ke arah Nyquist (naik) atau ke DC
            // (turun) tiap lintasan. Tanpa keduanya, umpan-balik tidak stabil
            // dalam arti apa pun yang berguna walau `fb < 1`.
            self.fed[0] = self.dc[0].tick(self.damp[0].tick(wl)) * fb;
            self.fed[1] = self.dc[1].tick(self.damp[1].tick(wr)) * fb;

            l[i] = l[i] * (1.0 - mix) + wl * mix;
            r[i] = r[i] * (1.0 - mix) + wr * mix;

            self.phase = self.phase.wrapping_add(self.inc);
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
        self.window.flush_denormal();
        self.fb.flush_denormal();
        self.mix.flush_denormal();
    }

    fn reset(&mut self, mem: &mut [f32]) {
        for s in mem.iter_mut() {
            *s = 0.0;
        }
        self.w = [0, 0];
        self.phase = 0;
        self.fed = [0.0, 0.0];
        for d in self.damp.iter_mut() {
            d.reset();
        }
        for d in self.dc.iter_mut() {
            d.reset();
        }
    }

    fn tail_frames(&self, sample_rate: f32) -> u32 {
        let fb = self.fb.target().abs().min(0.9);
        let w = self.window.target().max(1.0);
        let passes = if fb < 1.0e-3 {
            1.0
        } else {
            libm::logf(1.0e-4) / libm::logf(fb)
        };
        let cap = sample_rate * (Self::DESC.max_tail_ms as f32 * 0.001);
        let frames = w * passes;
        if frames > cap {
            cap as u32
        } else {
            frames as u32
        }
    }

    fn cost_flops(&self) -> u32 {
        94
    }
}
