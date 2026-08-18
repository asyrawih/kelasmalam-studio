//! Delay line ring dengan pembacaan fraksional — primitif bersama untuk
//! SPIRAL, ECHO, FLANGER, dan PITCH.
//!
//! ## Kenapa meminjam memori, bukan memilikinya
//!
//! Crate ini tanpa `alloc` (lihat `lib.rs`), jadi `Delay` tidak bisa punya
//! `Box<[f32]>`. Itu bukan keterbatasan yang disiasati melainkan yang
//! diinginkan: engine mengalokasi SATU arena FX sekali saat start, lalu
//! membagikan region-nya ke tiap node. Dengan begitu pool insert per-clip bisa
//! memakai ulang region yang sama tanpa alokasi apa pun di jalur render.
//!
//! `Delay` karenanya adalah *view* berumur pendek: node menyimpan posisi tulis
//! (`w`) di antara blok, lalu memasang ulang view-nya tiap blok.
//!
//! ## Kenapa panjangnya pangkat dua
//!
//! Alternatifnya panjang eksak dengan `if idx >= len { idx -= len }` (empat
//! cabang per pembacaan, karena hermite butuh empat tap) atau `%` (satu
//! divisi). Mask menang, dan alasan utamanya BUKAN kecepatan:
//!
//! - **Indeks ter-mask selalu di dalam rentang.** Read pointer SPIRAL meluncur
//!   dan bisa sesaat melewati batas nominal; dengan mask itu jadi wrap (audio
//!   salah beberapa sample) alih-alih jalur panic. `render_block` tidak boleh
//!   `panic!` (docs/01 §1c), jadi ini syarat, bukan optimisasi.
//! - Membuat `attach` tidak bisa gagal karena indeks.
//!
//! Harganya memori: `ceil_pow2` membuang sampai 2×. Pemborosan itu terbatas
//! dan dibayar oleh batas arena FX di engine.
//!
//! ## Anti-denormal, dan kenapa tandanya diambil dari posisi tulis
//!
//! Loop feedback yang meluruh akan masuk wilayah denormal dan di WASM tidak ada
//! FTZ/DAZ (docs/02 §2b), jadi tiap sample disuntik `ANTI_DENORM` dengan tanda
//! bergantian supaya tidak menghasilkan offset DC.
//!
//! Tandanya diambil dari **paritas posisi tulis**, bukan dari flag yang
//! dibalik-balik. Kalau tandanya state yang di-reset tiap blok, pola tandanya
//! akan berbeda antara render 128-frame dan 1024-frame — dan itu langsung
//! mematahkan `null_test_block_size_invariance`, yang justru satu-satunya alat
//! yang membuat bounce-vs-realtime punya arti. Posisi tulis monoton dan
//! panjang buffer pangkat dua (genap), jadi paritasnya deterministik terhadap
//! posisi sample absolut.

use crate::resample::hermite4;
use crate::ANTI_DENORM;

/// Pangkat dua terkecil yang >= `n`. `ceil_pow2(0) == 1`.
pub const fn ceil_pow2(n: usize) -> usize {
    let mut p: usize = 1;
    while p < n {
        // Berhenti sebelum overflow; buffer sebesar ini tidak akan pernah ada,
        // tapi `render_block` tidak boleh panic karena overflow di debug build.
        if p > usize::MAX / 2 {
            return p;
        }
        p <<= 1;
    }
    p
}

/// Pangkat dua terbesar yang <= `n`. `floor_pow2(0) == 0`.
pub const fn floor_pow2(n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    let mut p: usize = 1;
    while p <= n / 2 {
        p <<= 1;
    }
    p
}

/// View ring buffer dengan pembacaan fraksional. Mono.
///
/// Efek stereo memasang dua `Delay` dari dua paruh region arena-nya.
pub struct Delay<'a> {
    buf: &'a mut [f32],
    mask: usize,
    w: usize,
}

impl<'a> Delay<'a> {
    /// Pasang view pada `mem`, melanjutkan dari posisi tulis `w`.
    ///
    /// Hanya bagian pangkat-dua terbesar dari `mem` yang dipakai; sisanya
    /// diabaikan. Mengembalikan `None` kalau `mem` kosong — pemanggil di jalur
    /// render menanganinya dengan `else { return }`, bukan dengan `unwrap`.
    #[inline]
    pub fn attach(mem: &'a mut [f32], w: usize) -> Option<Self> {
        let n = floor_pow2(mem.len());
        if n == 0 {
            return None;
        }
        let mask = n - 1;
        Some(Delay {
            buf: &mut mem[..n],
            mask,
            w: w & mask,
        })
    }

    /// Panjang efektif (pangkat dua).
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.mask + 1
    }

    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        false
    }

    /// Delay terbesar yang masih menyisakan keempat tap hermite bermakna.
    #[inline(always)]
    pub fn max_delay(&self) -> f32 {
        // Butuh tap di delay i-1 .. i+2, jadi i <= mask-2.
        (self.mask as f32) - 2.0
    }

    /// Posisi tulis, untuk disimpan node antar blok.
    #[inline(always)]
    pub fn write_pos(&self) -> usize {
        self.w
    }

    /// Tulis satu sample dan majukan posisi tulis.
    #[inline(always)]
    pub fn push(&mut self, x: f32) {
        // Tanda dari paritas posisi tulis — lihat catatan modul.
        let anti = if self.w & 1 == 0 {
            ANTI_DENORM
        } else {
            -ANTI_DENORM
        };
        self.buf[self.w] = x + anti;
        self.w = (self.w + 1) & self.mask;
    }

    /// Baca pada delay bulat `d` sample. `d == 0` = sample terakhir ditulis.
    #[inline(always)]
    pub fn read_int(&self, d: usize) -> f32 {
        self.buf[self.w.wrapping_sub(1 + d) & self.mask]
    }

    /// Baca pada delay pecahan `d` sample, interpolasi cubic Hermite.
    ///
    /// `d` di-clamp ke `[1, max_delay()]`: batas bawah supaya tap `i-1` tetap
    /// ada, batas atas supaya tap `i+2` tidak melingkari buffer dan membaca
    /// sample yang baru saja ditulis.
    ///
    /// Clamp-nya ditulis tangan, bukan `clampf`, dan itu disengaja: bentuk
    /// `if x < lo {lo} else if x > hi {hi} else {x}` MELOLOSKAN NaN (kedua
    /// perbandingan false), lalu `t` jadi NaN dan hermite mengeluarkan NaN —
    /// yang di loop feedback bersifat permanen. Bentuk di bawah menguji
    /// `d > 1.0`, yang false untuk NaN, jadi NaN jatuh ke batas bawah.
    #[inline(always)]
    pub fn read_frac(&self, d: f32) -> f32 {
        let max = self.max_delay();
        let d = if d > 1.0 {
            if d > max {
                max
            } else {
                d
            }
        } else {
            1.0
        };
        let i = d as usize;
        let t = d - (i as f32);
        let k = self.w.wrapping_sub(1 + i) & self.mask;
        hermite4(
            self.buf[(k + 1) & self.mask],
            self.buf[k],
            self.buf[k.wrapping_sub(1) & self.mask],
            self.buf[k.wrapping_sub(2) & self.mask],
            t,
        )
    }

    /// Tulis lalu baca — urutan yang dipakai semua efek feedback.
    #[inline(always)]
    pub fn tick(&mut self, x: f32, d: f32) -> f32 {
        self.push(x);
        self.read_frac(d)
    }

    /// Nolkan seluruh isi. NON-RT (dipanggil saat reset/seek).
    pub fn clear(&mut self) {
        for s in self.buf.iter_mut() {
            *s = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pow2_helpers_are_exact() {
        assert_eq!(ceil_pow2(0), 1);
        assert_eq!(ceil_pow2(1), 1);
        assert_eq!(ceil_pow2(5), 8);
        assert_eq!(ceil_pow2(1024), 1024);
        assert_eq!(floor_pow2(0), 0);
        assert_eq!(floor_pow2(5), 4);
        assert_eq!(floor_pow2(1024), 1024);
        assert_eq!(floor_pow2(1023), 512);
    }

    #[test]
    fn read_int_zero_is_the_last_sample_written() {
        let mut mem = [0.0f32; 16];
        let mut d = Delay::attach(&mut mem, 0).unwrap();
        d.push(0.25);
        assert_eq!(d.read_int(0), 0.25 + ANTI_DENORM);
        d.push(0.5);
        assert_eq!(d.read_int(0), 0.5 - ANTI_DENORM);
        assert_eq!(d.read_int(1), 0.25 + ANTI_DENORM);
    }

    /// Non-pangkat-dua dipotong, bukan bikin panic.
    #[test]
    fn attach_truncates_to_power_of_two() {
        let mut mem = [0.0f32; 100];
        let d = Delay::attach(&mut mem, 0).unwrap();
        assert_eq!(d.len(), 64);
    }

    #[test]
    fn attach_on_empty_memory_is_none_not_panic() {
        let mut mem: [f32; 0] = [];
        assert!(Delay::attach(&mut mem, 0).is_none());
    }

    /// Hermite eksak pada sinyal linear — cerminan
    /// `resample::hermite_is_exact_on_linear_ramp`, tapi lewat jalur ring +
    /// mask, yang justru bagian yang bisa salah indeks.
    #[test]
    fn read_frac_is_exact_on_a_linear_ramp() {
        let mut mem = [0.0f32; 256];
        let mut d = Delay::attach(&mut mem, 0).unwrap();
        // Ramp: sample ke-n bernilai n.
        for n in 0..200 {
            d.push(n as f32);
        }
        // Sample terakhir (delay 0) bernilai 199, jadi delay `x` = 199 - x.
        for &delay in &[1.0f32, 1.5, 2.25, 7.75, 40.5] {
            let got = d.read_frac(delay);
            let want = 199.0 - delay;
            assert!(
                (got - want).abs() < 1e-3,
                "delay {delay}: dapat {got}, harusnya {want}"
            );
        }
    }

    /// Buffer melingkar penuh berkali-kali tanpa kehilangan keselarasan.
    #[test]
    fn ring_wraps_without_losing_alignment() {
        let mut mem = [0.0f32; 8];
        let mut d = Delay::attach(&mut mem, 0).unwrap();
        for n in 0..1000 {
            d.push(n as f32);
        }
        for delay in 0..8usize {
            assert!(
                (d.read_int(delay) - (999.0 - delay as f32)).abs() < 1e-3,
                "delay {delay} setelah 1000 push"
            );
        }
    }

    /// `render_block` tidak boleh panic. Delay ekstrem, negatif, dan NaN
    /// semuanya harus menghasilkan angka finite tanpa keluar batas.
    #[test]
    fn extreme_delays_never_panic_and_stay_finite() {
        let mut mem = [0.0f32; 64];
        let mut d = Delay::attach(&mut mem, 0).unwrap();
        for n in 0..100 {
            d.push((n % 7) as f32);
        }
        for &x in &[
            -1.0e9f32,
            -1.0,
            0.0,
            1.0e9,
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
        ] {
            assert!(d.read_frac(x).is_finite(), "read_frac({x})");
        }
    }

    /// INI tes yang menjaga null-test tetap valid: pola tanda anti-denormal
    /// harus bergantung pada posisi sample absolut, bukan pada di mana batas
    /// blok kebetulan jatuh. Kalau tidak, render 128-frame dan 1024-frame
    /// menghasilkan bit yang berbeda dan kegagalannya nyaris tak terlacak.
    #[test]
    fn anti_denormal_pattern_is_block_size_independent() {
        let input: [f32; 64] = core::array::from_fn(|i| (i as f32) * 0.01);

        let mut mem_a = [0.0f32; 64];
        let mut w = 0usize;
        {
            let mut d = Delay::attach(&mut mem_a, w).unwrap();
            for &x in input.iter() {
                d.push(x);
            }
            w = d.write_pos();
        }
        assert_eq!(w, 0);

        // Sekarang input yang sama, tapi dipecah jadi empat "blok" — persis
        // yang dilakukan engine saat memecah sub-blok di event.
        let mut mem_b = [0.0f32; 64];
        let mut w_b = 0usize;
        for chunk in input.chunks(16) {
            let mut d = Delay::attach(&mut mem_b, w_b).unwrap();
            for &x in chunk {
                d.push(x);
            }
            w_b = d.write_pos();
        }

        assert_eq!(mem_a, mem_b, "isi buffer bergantung ukuran blok");
    }
}
