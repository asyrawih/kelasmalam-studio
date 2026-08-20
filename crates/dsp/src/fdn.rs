//! Feedback Delay Network 8×8 dengan pencampur Householder — inti REVERB.
//!
//! ## Kenapa FDN dan bukan Freeverb
//!
//! Freeverb (8 comb + 4 allpass, dikali dua kanal) butuh **24 konstanta ajaib**
//! (12 panjang line × 2 offset stereo) dan sekitar 120 baris. FDN butuh 8
//! panjang dan sekitar 60 baris, dan hasilnya lebih padat: comb Freeverb murni
//! paralel — tidak pernah saling bertukar energi — sedangkan matriks FDN
//! mencampur kedelapan line **tiap sample**, jadi kerapatan gemanya tumbuh
//! seperti 16 comb.
//!
//! Yang menentukan pilihan bukan itu, melainkan stabilitasnya. Dengan matriks
//! ortogonal dan gain per-line `g_i`, seluruh loop adalah kontraksi kalau
//! `max|g_i| < 1` — **tanpa syarat lain**. Artinya user boleh menyapu decay
//! sementara ekornya masih berdenging tanpa ada kombinasi parameter yang bisa
//! meledak. Freeverb juga stabil, tapi tidak punya jaminan setara saat
//! dimodulasi, dan modulasi justru yang dibutuhkan supaya FDN 8-line tidak
//! berbunyi seperti per logam.
//!
//! ## Kenapa Householder dan bukan Hadamard
//!
//! Keduanya ortogonal (lossless). Hadamard mencampur sedikit lebih merata per
//! tahap, tapi butuh butterfly bersarang: 24 add/sub + 8 kali `1/√8` = 32 flop.
//! Householder adalah `y_i = x_i − (2/N)·Σx`: satu penjumlahan, satu kali,
//! delapan pengurangan — **17 flop dan 5 baris**. Dengan delapan panjang line
//! yang saling mendekati prima, bedanya tidak terdengar, jadi selisih flop dan
//! jumlah barisnya yang menentukan.
//!
//! ## Kenapa memori diindeks langsung, bukan lewat `Delay`
//!
//! FDN harus membaca kedelapan line SEBELUM menulis salah satunya (mixernya
//! menggandeng semuanya). Delapan `Delay` hidup bersamaan berarti delapan
//! pinjaman mutable ke satu slice, yang butuh rantai `split_at_mut` yang lebih
//! panjang daripada aritmetika indeksnya sendiri. Line-nya berada di offset
//! yang diketahui dengan panjang pangkat dua, jadi indeks langsung lebih
//! pendek dan sama amannya (mask menjamin dalam rentang).

use crate::delay::ceil_pow2;
use crate::onepole::OnePoleLp;
use crate::resample::hermite4;
use crate::{clampf, ANTI_DENORM};

/// Jumlah line. Mengubahnya berarti mengubah faktor Householder `2/N`.
pub const FDN_LINES: usize = 8;

/// Panjang line dalam milidetik. Saling mendekati prima dalam sample pada
/// sample rate mana pun yang wajar — itu yang mencegah geman menumpuk jadi
/// nada, dan kenapa angkanya tidak bulat.
const LINE_MS: [f32; FDN_LINES] = [23.4, 29.5, 36.7, 41.3, 47.1, 53.9, 61.1, 67.3];

/// Ruang ekstra per line untuk modulasi dan pembulatan `size`.
const LINE_MARGIN: usize = 64;

/// Modulasi bawaan, dalam milidetik puncak-ke-nol.
const MOD_MS: f32 = 0.3;

/// Laju modulasi. Cukup lambat untuk tidak terdengar sebagai vibrato, cukup
/// cepat untuk memecah nada berdiri dalam waktu satu ekor.
const MOD_HZ: f32 = 0.7;

/// Pencampur Householder: refleksi `H = I − (2/N)·J`.
///
/// Ortogonal, jadi `‖Hx‖ = ‖x‖` **persis**. Itu bukan detail implementasi
/// melainkan bukti stabilitas jaringan ini, dan diuji sebagai properti.
#[inline(always)]
pub fn householder8(x: &mut [f32; FDN_LINES]) {
    let mut s = 0.0f32;
    for v in x.iter() {
        s += *v;
    }
    let c = s * (2.0 / FDN_LINES as f32);
    for v in x.iter_mut() {
        *v -= c;
    }
}

/// Satu line: di mana dia di arena, seberapa panjang, dan di mana kepala tulis.
#[derive(Clone, Copy, Debug, Default)]
struct Line {
    off: u32,
    mask: u32,
    w: u32,
    /// Jarak baca nominal dalam sample, sebelum `size` dan modulasi.
    nominal: f32,
}

/// Jaringan delay berumpan-balik 8×8.
#[derive(Clone, Debug)]
pub struct Fdn8 {
    lines: [Line; FDN_LINES],
    damp: [OnePoleLp; FDN_LINES],
    g: [f32; FDN_LINES],
    size: f32,
    mod_depth_samples: f32,
    mod_phase: u32,
    mod_inc: u32,
    sample_rate: f32,
}

/// Berapa f32 yang dibutuhkan satu instance pada sample rate ini.
///
/// Dipanggil alokator arena engine SEBELUM render, jadi kegagalan memori jadi
/// `PlanError` yang terlihat user, bukan alokasi di jalur realtime.
pub fn mem_frames(sample_rate: f32) -> usize {
    let mut total = 0usize;
    for ms in LINE_MS.iter() {
        total += line_len(sample_rate, *ms);
    }
    total
}

fn line_len(sample_rate: f32, ms: f32) -> usize {
    let n = (ms * 0.001 * sample_rate) as usize;
    ceil_pow2(n + LINE_MARGIN)
}

impl Fdn8 {
    /// Susun tata letak line. NON-RT.
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        let mut lines = [Line::default(); FDN_LINES];
        let mut off = 0u32;
        for (i, ms) in LINE_MS.iter().enumerate() {
            let len = line_len(sr, *ms);
            lines[i] = Line {
                off,
                mask: (len - 1) as u32,
                w: 0,
                nominal: ms * 0.001 * sr,
            };
            off += len as u32;
        }
        let mut f = Fdn8 {
            lines,
            damp: [OnePoleLp::new(); FDN_LINES],
            g: [0.0; FDN_LINES],
            size: 1.0,
            mod_depth_samples: MOD_MS * 0.001 * sr,
            mod_phase: 0,
            mod_inc: 0,
            sample_rate: sr,
        };
        f.set_mod_rate(MOD_HZ);
        f.set_params(2.2, 1.0, 5_000.0, 0.35);
        f
    }

    fn set_mod_rate(&mut self, hz: f32) {
        let t = ((hz as f64) / (self.sample_rate as f64)).clamp(0.0, 0.5);
        self.mod_inc = (t * 4_294_967_296.0) as i64 as u32;
    }

    /// Setel decay, ukuran ruang, damping, dan kedalaman modulasi.
    ///
    /// NON-RT: memakai `expf`/`log`. Dipanggil sekali per blok (atau per grid
    /// refresh), tidak per sample.
    pub fn set_params(&mut self, rt60_s: f32, size: f32, damp_hz: f32, mod_depth: f32) {
        // rt60 = 0 akan membagi nol di rumus gain. Ditangkap di sini, di sisi
        // non-RT, supaya inner loop tidak pernah perlu memeriksanya.
        let rt60 = clampf(if rt60_s.is_finite() { rt60_s } else { 2.0 }, 0.05, 60.0);
        self.size = clampf(if size.is_finite() { size } else { 1.0 }, 0.3, 1.0);
        let depth = clampf(
            if mod_depth.is_finite() {
                mod_depth
            } else {
                0.0
            },
            0.0,
            1.0,
        );
        self.mod_depth_samples = depth * MOD_MS * 0.001 * self.sample_rate;

        let total = rt60 * self.sample_rate;
        for i in 0..FDN_LINES {
            self.damp[i].set_cutoff(self.sample_rate, damp_hz);
            let d = self.lines[i].nominal * self.size;
            // Peluruhan −60 dB sepanjang rt60: g = 10^(−3·d/(rt60·sr)).
            // Dibatasi tegas di bawah 1 — itu syarat kontraksinya.
            self.g[i] = clampf(libm::powf(10.0, -3.0 * d / total), 0.0, 0.9999);
        }
    }

    /// Nolkan seluruh state. `mem` harus region yang sama dengan yang dipakai
    /// `tick`.
    pub fn reset(&mut self, mem: &mut [f32]) {
        for s in mem.iter_mut() {
            *s = 0.0;
        }
        for i in 0..FDN_LINES {
            self.lines[i].w = 0;
            self.damp[i].reset();
        }
        self.mod_phase = 0;
    }

    /// Sekali per blok.
    pub fn flush_denormals(&mut self) {
        for d in self.damp.iter_mut() {
            d.flush_denormal();
        }
    }

    #[inline(always)]
    fn read(mem: &[f32], line: &Line, d: f32) -> f32 {
        let max = (line.mask as f32) - 2.0;
        // NaN jatuh ke batas bawah — lihat catatan di `delay::read_frac`.
        let d = if d > 1.0 {
            if d > max {
                max
            } else {
                d
            }
        } else {
            1.0
        };
        let i = d as u32;
        let t = d - (i as f32);
        let mask = line.mask;
        let base = line.off as usize;
        let k = line.w.wrapping_sub(1 + i) & mask;
        hermite4(
            mem[base + ((k + 1) & mask) as usize],
            mem[base + k as usize],
            mem[base + (k.wrapping_sub(1) & mask) as usize],
            mem[base + (k.wrapping_sub(2) & mask) as usize],
            t,
        )
    }

    /// Satu frame stereo masuk, satu frame stereo keluar.
    ///
    /// `mem` panjangnya harus `mem_frames(sample_rate)`; kalau lebih pendek,
    /// fungsi ini mengembalikan senyap alih-alih panic.
    #[inline]
    pub fn tick(&mut self, mem: &mut [f32], in_l: f32, in_r: f32) -> (f32, f32) {
        let need =
            self.lines[FDN_LINES - 1].off as usize + self.lines[FDN_LINES - 1].mask as usize + 1;
        if mem.len() < need {
            return (0.0, 0.0);
        }

        // Modulasi: dua fase berlawanan, dipakai bergantian antar line. Satu
        // osilator untuk delapan line — line yang bergerak searah tidak
        // memecah nada berdiri, jadi tandanya harus berselang.
        let m = crate::lfo::fast_sin_norm(self.mod_phase) * self.mod_depth_samples;
        self.mod_phase = self.mod_phase.wrapping_add(self.mod_inc);

        let mut v = [0.0f32; FDN_LINES];
        // `i` mengindeks EMPAT larik sekaligus: `v`, `self.lines`, `self.damp`,
        // dan `self.g`. Bentuk `v.iter_mut().enumerate()` yang disarankan clippy
        // hanya menghilangkan satu dari empat indeks itu — tiga sisanya tetap
        // `[i]`, jadi yang didapat cuma satu binding tambahan tanpa satu pun
        // pemeriksaan batas yang hilang. Menghilangkan semuanya butuh rantai
        // `zip` berlapis di jalur yang dieksekusi per sample.
        #[allow(clippy::needless_range_loop)]
        for i in 0..FDN_LINES {
            let modu = if i & 1 == 0 { m } else { -m };
            let d = self.lines[i].nominal * self.size + modu;
            let raw = Self::read(mem, &self.lines[i], d);
            v[i] = self.damp[i].tick(raw) * self.g[i];
        }

        // Keluaran diambil PRA-campur: empat line kiri, empat kanan. Pasca
        // campur setiap keluaran mengandung kedelapan line, jadi kiri dan
        // kanan jadi nyaris identik dan stereonya runtuh.
        let out_l = v[0] + v[1] + v[2] + v[3];
        let out_r = v[4] + v[5] + v[6] + v[7];

        householder8(&mut v);

        // Injeksi anti-denormal satu kali di input: matriks menyebarkannya ke
        // kedelapan line dalam satu sample, jadi tidak perlu per line.
        let anti = if self.mod_phase & 1 == 0 {
            ANTI_DENORM
        } else {
            -ANTI_DENORM
        };
        // Sama seperti loop di atas: `i` mengindeks `v`, `self.lines`, dan `mem`
        // sekaligus, jadi `enumerate()` tidak menghilangkan indeksnya.
        #[allow(clippy::needless_range_loop)]
        for i in 0..FDN_LINES {
            let inject = if i & 1 == 0 { in_l } else { in_r };
            let base = self.lines[i].off as usize;
            let w = self.lines[i].w as usize;
            mem[base + w] = v[i] + inject * 0.5 + anti;
            self.lines[i].w = (self.lines[i].w + 1) & self.lines[i].mask;
        }

        (out_l * 0.5, out_r * 0.5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    /// INI bukti stabilitas jaringan, ditulis sebagai tes: matriksnya ortogonal,
    /// jadi norma vektornya kekal persis. Kalau properti ini rusak, tidak ada
    /// kombinasi gain yang bisa menjamin FDN-nya tidak meledak.
    #[test]
    fn householder_preserves_norm() {
        let cases: [[f32; FDN_LINES]; 5] = [
            [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
            [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0],
            [0.3, -0.7, 0.1, 0.9, -0.2, 0.5, -0.4, 0.6],
            [-2.5, 1.25, 0.0, 3.0, -1.0, 0.5, 0.75, -0.125],
        ];
        for x in cases.iter() {
            let before: f32 = x.iter().map(|v| v * v).sum();
            let mut y = *x;
            householder8(&mut y);
            let after: f32 = y.iter().map(|v| v * v).sum();
            assert!(
                (before - after).abs() < 1e-4 * before.max(1.0),
                "norma berubah: {before} -> {after}"
            );
        }
    }

    /// Refleksi diterapkan dua kali harus kembali ke asal (`H² = I`).
    #[test]
    fn householder_is_an_involution() {
        let x: [f32; FDN_LINES] = [0.3, -0.7, 0.1, 0.9, -0.2, 0.5, -0.4, 0.6];
        let mut y = x;
        householder8(&mut y);
        householder8(&mut y);
        for i in 0..FDN_LINES {
            assert!(
                (y[i] - x[i]).abs() < 1e-5,
                "elemen {i}: {} vs {}",
                y[i],
                x[i]
            );
        }
    }

    #[test]
    fn memory_layout_is_consistent() {
        let f = Fdn8::new(SR);
        let need = mem_frames(SR);
        let last = f.lines[FDN_LINES - 1];
        assert_eq!(need, last.off as usize + last.mask as usize + 1);
        // Angka di plan: ~24576 sample @48k.
        assert_eq!(need, 24_576);
    }

    /// RT60 terukur harus mendekati yang diminta.
    ///
    /// Dua hal yang harus benar supaya angkanya bermakna:
    ///
    /// 1. Yang diukur **laju** peluruhan antara dua jendela, bukan level
    ///    relatif terhadap puncak awal — respons impuls FDN naik dulu sebelum
    ///    meluruh, jadi acuan puncak awal menghitung fase naik itu sebagai
    ///    peluruhan dan melaporkan rt60 yang terlalu pendek.
    /// 2. Pakai **RMS**, bukan puncak. Di awal ekor gemanya masih jarang dan
    ///    berpuncak tinggi; kerapatannya baru terbentuk setelah beberapa kali
    ///    panjang line. Puncak jendela awal karenanya bias ke atas, dan
    ///    rt60 terukur ikut terlalu pendek.
    #[test]
    fn rt60_is_close_to_requested() {
        for &rt60 in &[0.5f32, 2.0, 6.0] {
            let mut f = Fdn8::new(SR);
            let mut mem = vec![0.0f32; mem_frames(SR)];
            // Damping benar-benar dimatikan supaya yang terukur murni gain.
            f.set_params(rt60, 1.0, SR, 0.0);

            f.tick(&mut mem, 1.0, 1.0);

            let win = (0.05 * SR) as usize;
            let t1 = (0.3 * rt60 * SR) as usize;
            let t2 = (0.85 * rt60 * SR) as usize;
            let (mut s1, mut s2) = (0.0f64, 0.0f64);
            for n in 0..t2 + win {
                let (l, r) = f.tick(&mut mem, 0.0, 0.0);
                let e = (l * l + r * r) as f64;
                if n >= t1 && n < t1 + win {
                    s1 += e;
                }
                if n >= t2 && n < t2 + win {
                    s2 += e;
                }
            }
            assert!(s1 > 0.0 && s2 > 0.0, "rt60 {rt60}s: tidak ada sinyal");
            let p1 = (s1 / win as f64).sqrt() as f32;
            let p2 = (s2 / win as f64).sqrt() as f32;

            // level(t) = A·10^(−3t/rt60)  =>  rt60 = −3·Δt / log10(p2/p1)
            let dt = (t2 - t1) as f32 / SR;
            let measured = -3.0 * dt / libm::log10f(p2 / p1);
            let err = (measured - rt60).abs() / rt60;
            assert!(
                err < 0.15,
                "rt60 diminta {rt60}s, terukur {measured}s (galat {:.0}%)",
                err * 100.0
            );
        }
    }

    /// Decay terpanjang, gain paling dekat 1: harus tetap terkurung selamanya.
    #[test]
    fn stays_bounded_at_maximum_decay() {
        let mut f = Fdn8::new(SR);
        let mut mem = vec![0.0f32; mem_frames(SR)];
        f.set_params(60.0, 1.0, 16_000.0, 1.0);
        let mut peak = 0.0f32;
        for n in 0..1_000_000 {
            // Noise deterministik, bukan rand — render path harus reproducible.
            let x = if n < 100_000 {
                libm::sinf(n as f32 * 0.37).mul_add(0.5, libm::sinf(n as f32 * 1.13) * 0.5)
            } else {
                0.0
            };
            let (l, r) = f.tick(&mut mem, x, -x);
            assert!(l.is_finite() && r.is_finite(), "non-finite di sample {n}");
            peak = peak.max(l.abs().max(r.abs()));
        }
        assert!(peak < 100.0, "puncak {peak} — jaringan menguat");
    }

    /// Senyap masuk dari keadaan bersih harus menghasilkan senyap keluar
    /// (kecuali sisa anti-denormal yang jauh di bawah pendengaran).
    #[test]
    fn silence_in_is_silence_out() {
        let mut f = Fdn8::new(SR);
        let mut mem = vec![0.0f32; mem_frames(SR)];
        for _ in 0..10_000 {
            let (l, r) = f.tick(&mut mem, 0.0, 0.0);
            assert!(l.abs() < 1e-10 && r.abs() < 1e-10, "bocor: {l}, {r}");
        }
    }

    /// Memori kurang panjang: senyap, bukan panic.
    #[test]
    fn short_memory_returns_silence_not_panic() {
        let mut f = Fdn8::new(SR);
        let mut mem = vec![0.0f32; 16];
        assert_eq!(f.tick(&mut mem, 1.0, 1.0), (0.0, 0.0));
    }

    #[test]
    fn bad_parameters_never_produce_nan() {
        let mut f = Fdn8::new(SR);
        let mut mem = vec![0.0f32; mem_frames(SR)];
        f.set_params(f32::NAN, f32::NAN, f32::NAN, f32::NAN);
        f.set_params(0.0, 0.0, 0.0, 0.0);
        f.set_params(-5.0, 100.0, -100.0, 50.0);
        for _ in 0..10_000 {
            let (l, r) = f.tick(&mut mem, 0.5, -0.5);
            assert!(l.is_finite() && r.is_finite());
        }
    }
}
