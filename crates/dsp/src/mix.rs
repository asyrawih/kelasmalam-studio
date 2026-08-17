//! Primitif mixing planar (satu slice = satu channel).
//!
//! Semua fungsi punya dua implementasi: skalar dan `simd128`
//! (`core::arch::wasm32`). WASM tidak punya runtime feature detection di dalam
//! modul — modul dengan instruksi SIMD **gagal validasi** di engine yang tidak
//! mendukungnya — jadi pemilihannya terjadi saat **build**
//! (`#[cfg(target_feature = "simd128")]`), dan JS memilih artefak mana yang
//! di-fetch (docs/02 §2b).
//!
//! Yang layak divektorisasi cuma yang tidak punya dependensi serial: summing,
//! ramp, dan reduksi peak/RMS. Biquad sengaja **tidak** — IIR punya
//! ketergantungan sample n → n-1.
//!
//! Kedua jalur dites saling-silang di modul `tests`: implementasi skalar selalu
//! ikut ter-compile (`scalar_impl`) supaya bisa jadi referensi kebenaran.

/// Panjang efektif dari sepasang slice. Jalur RT tidak boleh `panic`, jadi
/// ketidakcocokan panjang diselesaikan dengan memproses irisan yang sama-sama
/// ada, bukan dengan `assert_eq!`.
#[inline(always)]
fn common_len(a: usize, b: usize) -> usize {
    if a < b {
        a
    } else {
        b
    }
}

// ───────────────────────── implementasi skalar ─────────────────────────
//
// Selalu ter-compile (bukan di balik `cfg(not(simd128))`) supaya tes bisa
// membandingkannya dengan jalur SIMD di build yang sama.

// `allow(dead_code)`: di build WASM (yang selalu `+simd128`, lihat
// `.cargo/config.toml`) tidak ada satu pun pemanggil jalur skalar. Ia tetap
// di-compile dengan sengaja — sebagai referensi kebenaran yang dibandingkan
// jalur SIMD di tes, dan sebagai fallback untuk target tanpa simd128.
#[allow(dead_code)]
pub(crate) mod scalar_impl {
    use super::common_len;

    #[inline]
    pub fn add_scaled(dst: &mut [f32], src: &[f32], gain: f32) {
        let n = common_len(dst.len(), src.len());
        for i in 0..n {
            dst[i] += src[i] * gain;
        }
    }

    #[inline]
    pub fn add_scaled_ramp(dst: &mut [f32], src: &[f32], g0: f32, g1: f32) {
        let n = common_len(dst.len(), src.len());
        if n == 0 {
            return;
        }
        // Ramp linear per sample. `step` dihitung sekali di luar loop supaya
        // tidak ada pembagian di inner loop.
        let step = (g1 - g0) / n as f32;
        let mut g = g0;
        for i in 0..n {
            dst[i] += src[i] * g;
            g += step;
        }
    }

    #[inline]
    pub fn copy_scaled(dst: &mut [f32], src: &[f32], gain: f32) {
        let n = common_len(dst.len(), src.len());
        for i in 0..n {
            dst[i] = src[i] * gain;
        }
    }

    #[inline]
    pub fn clear(dst: &mut [f32]) {
        for v in dst.iter_mut() {
            *v = 0.0;
        }
    }

    #[inline]
    pub fn peak(buf: &[f32]) -> f32 {
        let mut m = 0.0f32;
        for &v in buf {
            let a = libm::fabsf(v);
            if a > m {
                m = a;
            }
        }
        m
    }

    #[inline]
    pub fn rms(buf: &[f32]) -> f32 {
        if buf.is_empty() {
            return 0.0;
        }
        // Akumulasi di f64: 1024 sample × f32 sudah cukup untuk kehilangan
        // ~3 bit terakhir kalau dijumlah di f32, dan meter yang meleset
        // 0.1 dB terlihat di UI.
        let mut acc = 0.0f64;
        for &v in buf {
            acc += (v as f64) * (v as f64);
        }
        libm::sqrt(acc / buf.len() as f64) as f32
    }
}

// ───────────────────────── implementasi SIMD128 ─────────────────────────

#[cfg(target_feature = "simd128")]
pub(crate) mod simd_impl {
    use super::common_len;
    use core::arch::wasm32::*;

    /// Jumlahkan 4 lane jadi satu skalar.
    #[inline(always)]
    fn hsum(v: v128) -> f32 {
        f32x4_extract_lane::<0>(v)
            + f32x4_extract_lane::<1>(v)
            + f32x4_extract_lane::<2>(v)
            + f32x4_extract_lane::<3>(v)
    }

    /// Maksimum 4 lane.
    #[inline(always)]
    fn hmax(v: v128) -> f32 {
        let a = f32x4_extract_lane::<0>(v);
        let b = f32x4_extract_lane::<1>(v);
        let c = f32x4_extract_lane::<2>(v);
        let d = f32x4_extract_lane::<3>(v);
        let ab = if a > b { a } else { b };
        let cd = if c > d { c } else { d };
        if ab > cd {
            ab
        } else {
            cd
        }
    }

    /// Muat 4 f32 dari slice. `v128_load` butuh pointer; kita sudah menjamin
    /// `i + 4 <= len` di pemanggil.
    ///
    /// # Safety
    /// `ptr` harus valid untuk membaca 16 byte.
    #[inline(always)]
    unsafe fn load4(ptr: *const f32) -> v128 {
        // v128_load tidak menuntut alignment 16 (WASM mengizinkan unaligned).
        unsafe { v128_load(ptr as *const v128) }
    }

    /// # Safety
    /// `ptr` harus valid untuk menulis 16 byte.
    #[inline(always)]
    unsafe fn store4(ptr: *mut f32, v: v128) {
        unsafe { v128_store(ptr as *mut v128, v) }
    }

    #[inline]
    pub fn add_scaled(dst: &mut [f32], src: &[f32], gain: f32) {
        let n = common_len(dst.len(), src.len());
        let g = f32x4_splat(gain);
        let chunks = n / 4;
        let dp = dst.as_mut_ptr();
        let sp = src.as_ptr();
        for i in 0..chunks {
            let off = i * 4;
            // SAFETY: off + 4 <= chunks*4 <= n <= min(dst.len(), src.len()).
            unsafe {
                let d = load4(dp.add(off));
                let s = load4(sp.add(off));
                store4(dp.add(off), f32x4_add(d, f32x4_mul(s, g)));
            }
        }
        for i in (chunks * 4)..n {
            dst[i] += src[i] * gain;
        }
    }

    #[inline]
    pub fn add_scaled_ramp(dst: &mut [f32], src: &[f32], g0: f32, g1: f32) {
        let n = common_len(dst.len(), src.len());
        if n == 0 {
            return;
        }
        let step = (g1 - g0) / n as f32;
        // Vektor gain awal: [g0, g0+s, g0+2s, g0+3s], lalu maju 4 langkah
        // sekaligus tiap iterasi.
        let mut gv = f32x4(g0, g0 + step, g0 + 2.0 * step, g0 + 3.0 * step);
        let stride = f32x4_splat(step * 4.0);
        let chunks = n / 4;
        let dp = dst.as_mut_ptr();
        let sp = src.as_ptr();
        for i in 0..chunks {
            let off = i * 4;
            // SAFETY: sama seperti add_scaled.
            unsafe {
                let d = load4(dp.add(off));
                let s = load4(sp.add(off));
                store4(dp.add(off), f32x4_add(d, f32x4_mul(s, gv)));
            }
            gv = f32x4_add(gv, stride);
        }
        let mut g = g0 + (chunks * 4) as f32 * step;
        for i in (chunks * 4)..n {
            dst[i] += src[i] * g;
            g += step;
        }
    }

    #[inline]
    pub fn copy_scaled(dst: &mut [f32], src: &[f32], gain: f32) {
        let n = common_len(dst.len(), src.len());
        let g = f32x4_splat(gain);
        let chunks = n / 4;
        let dp = dst.as_mut_ptr();
        let sp = src.as_ptr();
        for i in 0..chunks {
            let off = i * 4;
            // SAFETY: sama seperti add_scaled.
            unsafe {
                let s = load4(sp.add(off));
                store4(dp.add(off), f32x4_mul(s, g));
            }
        }
        for i in (chunks * 4)..n {
            dst[i] = src[i] * gain;
        }
    }

    #[inline]
    pub fn clear(dst: &mut [f32]) {
        let n = dst.len();
        let z = f32x4_splat(0.0);
        let chunks = n / 4;
        let dp = dst.as_mut_ptr();
        for i in 0..chunks {
            // SAFETY: i*4 + 4 <= n.
            unsafe { store4(dp.add(i * 4), z) }
        }
        for i in (chunks * 4)..n {
            dst[i] = 0.0;
        }
    }

    #[inline]
    pub fn peak(buf: &[f32]) -> f32 {
        let n = buf.len();
        let chunks = n / 4;
        let sp = buf.as_ptr();
        let mut acc = f32x4_splat(0.0);
        for i in 0..chunks {
            // SAFETY: i*4 + 4 <= n.
            let v = unsafe { load4(sp.add(i * 4)) };
            acc = f32x4_max(acc, f32x4_abs(v));
        }
        let mut m = hmax(acc);
        for i in (chunks * 4)..n {
            let a = libm::fabsf(buf[i]);
            if a > m {
                m = a;
            }
        }
        m
    }

    #[inline]
    pub fn rms(buf: &[f32]) -> f32 {
        let n = buf.len();
        if n == 0 {
            return 0.0;
        }
        let chunks = n / 4;
        let sp = buf.as_ptr();
        let mut acc = f32x4_splat(0.0);
        for i in 0..chunks {
            // SAFETY: i*4 + 4 <= n.
            let v = unsafe { load4(sp.add(i * 4)) };
            acc = f32x4_add(acc, f32x4_mul(v, v));
        }
        // Akumulasi lane di f32 lalu pindah ke f64 untuk pembagian akhir.
        // Empat akumulator paralel justru *mengurangi* error dibanding satu
        // akumulator skalar (pairwise-like summation).
        let mut total = hsum(acc) as f64;
        for i in (chunks * 4)..n {
            total += (buf[i] as f64) * (buf[i] as f64);
        }
        libm::sqrt(total / n as f64) as f32
    }
}

// ───────────────────────── API publik ─────────────────────────

macro_rules! dispatch {
    ($name:ident ( $($arg:ident : $ty:ty),* ) $(-> $ret:ty)?) => {
        #[cfg(target_feature = "simd128")]
        #[inline(always)]
        pub fn $name($($arg: $ty),*) $(-> $ret)? { simd_impl::$name($($arg),*) }

        #[cfg(not(target_feature = "simd128"))]
        #[inline(always)]
        pub fn $name($($arg: $ty),*) $(-> $ret)? { scalar_impl::$name($($arg),*) }
    };
}

dispatch!(add_scaled(dst: &mut [f32], src: &[f32], gain: f32));
dispatch!(add_scaled_ramp(dst: &mut [f32], src: &[f32], g0: f32, g1: f32));
dispatch!(copy_scaled(dst: &mut [f32], src: &[f32], gain: f32));
dispatch!(clear(dst: &mut [f32]));
dispatch!(peak(buf: &[f32]) -> f32);
dispatch!(rms(buf: &[f32]) -> f32);

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp_buf(n: usize) -> Vec<f32> {
        (0..n).map(|i| (i as f32 * 0.01).sin()).collect()
    }

    #[test]
    fn add_scaled_matches_reference() {
        for n in [0usize, 1, 3, 4, 7, 128, 129] {
            let src = ramp_buf(n);
            let mut a: Vec<f32> = (0..n).map(|i| i as f32 * 0.5).collect();
            let mut b = a.clone();
            scalar_impl::add_scaled(&mut a, &src, 0.75);
            add_scaled(&mut b, &src, 0.75);
            for i in 0..n {
                assert!((a[i] - b[i]).abs() < 1e-6, "n={n} i={i}");
            }
        }
    }

    #[test]
    fn copy_scaled_and_clear() {
        for n in [0usize, 1, 5, 64, 130] {
            let src = ramp_buf(n);
            let mut a = vec![9.0f32; n];
            let mut b = vec![9.0f32; n];
            scalar_impl::copy_scaled(&mut a, &src, -0.5);
            copy_scaled(&mut b, &src, -0.5);
            assert_eq!(a, b);
            clear(&mut b);
            assert!(b.iter().all(|v| *v == 0.0));
        }
    }

    #[test]
    fn ramp_endpoints() {
        let n = 64usize;
        let src = vec![1.0f32; n];
        let mut d = vec![0.0f32; n];
        add_scaled_ramp(&mut d, &src, 0.0, 1.0);
        assert!((d[0] - 0.0).abs() < 1e-6);
        // Sample terakhir = g0 + (n-1)*step, step = 1/n.
        assert!((d[n - 1] - (n - 1) as f32 / n as f32).abs() < 1e-5);
        // Monoton naik.
        for i in 1..n {
            assert!(d[i] >= d[i - 1]);
        }
    }

    #[test]
    fn ramp_matches_reference() {
        for n in [1usize, 3, 4, 9, 128, 131] {
            let src = ramp_buf(n);
            let mut a = vec![0.0f32; n];
            let mut b = vec![0.0f32; n];
            scalar_impl::add_scaled_ramp(&mut a, &src, 0.25, 0.9);
            add_scaled_ramp(&mut b, &src, 0.25, 0.9);
            for i in 0..n {
                assert!((a[i] - b[i]).abs() < 1e-5, "n={n} i={i}: {} vs {}", a[i], b[i]);
            }
        }
    }

    #[test]
    fn peak_and_rms_match_reference() {
        for n in [0usize, 1, 3, 4, 100, 128, 129] {
            let mut src = ramp_buf(n);
            if n > 5 {
                src[5] = -2.5;
            }
            assert!((peak(&src) - scalar_impl::peak(&src)).abs() < 1e-6, "n={n}");
            assert!((rms(&src) - scalar_impl::rms(&src)).abs() < 1e-6, "n={n}");
        }
    }

    #[test]
    fn peak_rms_known_values() {
        let dc = vec![0.5f32; 256];
        assert!((peak(&dc) - 0.5).abs() < 1e-6);
        assert!((rms(&dc) - 0.5).abs() < 1e-6);

        // Sinus penuh: RMS = 1/sqrt(2).
        let n = 4096;
        let sine: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * i as f32 / n as f32).sin())
            .collect();
        assert!((rms(&sine) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-3);
        assert!((peak(&sine) - 1.0).abs() < 1e-2);
    }

    #[test]
    fn mismatched_lengths_do_not_panic() {
        let src = vec![1.0f32; 8];
        let mut dst = vec![0.0f32; 32];
        add_scaled(&mut dst, &src, 1.0);
        copy_scaled(&mut dst, &src, 1.0);
        add_scaled_ramp(&mut dst, &src, 0.0, 1.0);
        let mut small = vec![0.0f32; 3];
        add_scaled(&mut small, &src, 1.0);
    }

    #[test]
    fn empty_is_zero() {
        let e: Vec<f32> = Vec::new();
        assert_eq!(peak(&e), 0.0);
        assert_eq!(rms(&e), 0.0);
    }
}
