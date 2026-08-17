//! Utilitas kecil yang harus tersedia di `no_std`.
//!
//! `f32::sqrt` hidup di `std`, bukan `core` (ia lowering ke intrinsic yang
//! butuh libm untuk target tanpa instruksi sqrt). Karena kita `no_std` dan
//! tidak mau menambah dependensi, kita pakai invers-akar bit-trick + Newton.
//! Dipakai HANYA di luar inner loop (saat pan berubah), jadi biayanya nol.

/// Akar kuadrat deterministik, akurasi ~1e-6 relatif untuk x > 0.
#[inline]
pub fn sqrt(x: f32) -> f32 {
    if !(x > 0.0) {
        return 0.0;
    }
    // Estimasi awal lewat manipulasi eksponen (bagi eksponen dengan 2).
    let mut y = f32::from_bits((x.to_bits() >> 1) + 0x1fc0_0000);
    // Tiga iterasi Newton untuk y = sqrt(x): y = (y + x/y) / 2.
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqrt_matches_std() {
        for i in 0..1000 {
            let x = i as f32 * 0.01;
            let got = sqrt(x);
            let want = x.sqrt();
            assert!((got - want).abs() <= 1e-5 * (1.0 + want), "x={x} {got} {want}");
        }
        assert_eq!(sqrt(0.0), 0.0);
        assert_eq!(sqrt(-1.0), 0.0);
    }
}
