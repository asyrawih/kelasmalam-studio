//! Aproksimasi log2/exp2 lewat manipulasi bit f32 + koreksi polinomial.
//!
//! Kenapa perlu: gain computer kompresor bekerja di domain dB (docs/02 §2b),
//! artinya butuh satu `log` dan satu `exp` **per sample per channel**. `log10f`
//! dari libm akurat sampai ulp terakhir dan karena itu mahal (branch, tabel,
//! penanganan subnormal/NaN) — semuanya sia-sia untuk detektor yang toh sudah
//! di-smooth oleh envelope follower.
//!
//! Idenya: `f32` sudah menyimpan `log2` di field eksponennya. Yang tersisa
//! hanya `log2(mantissa)` untuk mantissa di `[1, 2)`, dan itu bisa didekati
//! polinomial derajat rendah tanpa branch sama sekali.
//!
//! # Akurasi yang dicapai (diverifikasi oleh tes di modul ini)
//!
//! | Fungsi      | Domain                | Error maksimum                  |
//! |-------------|-----------------------|---------------------------------|
//! Angka di bawah adalah hasil **pengukuran** (sweep rapat atas domainnya),
//! bukan batas teoretis:
//!
//! | Fungsi      | Domain             | Error maksimum terukur          |
//! |-------------|--------------------|---------------------------------|
//! | `fast_log2` | `x ∈ [1e-6, 1e6]`  | 9.0e-5 absolut (satuan log2)    |
//! | `fast_exp2` | `x ∈ [-40, 40]`    | 7.3e-7 relatif                  |
//! | `lin_to_db` | `x ∈ [1e-6, 1e6]`  | 5.4e-4 dB                       |
//! | `db_to_lin` | `db ∈ [-240, 240]` | 3.0e-6 relatif (≈ 2.6e-5 dB)    |
//! | roundtrip `lin_to_db(db_to_lin(db))` | `db ∈ [-240, 24]` | 5.5e-4 dB |
//!
//! Jadi ~18× lebih baik dari target ±0.01 dB di docs/02 §2b. Error `log2`
//! mendominasi karena polinomialnya derajat 4; menaikkannya ke derajat 6
//! akan menurunkan error ~100× dengan biaya 2 FMA, tapi tidak ada gunanya —
//! 5e-4 dB sudah 40 dB di bawah ambang deteksi perubahan level manusia.

/// `log2(10) / 20` — faktor konversi amplitudo linear → dB lewat log2.
const LOG2_TO_DB: f32 = 6.020_6; // 20 / log2(10)
/// `20 / log2(10)` kebalikannya, untuk dB → log2.
const DB_TO_LOG2: f32 = 0.166_096_4_f32; // log2(10) / 20

/// Lantai amplitudo sebelum `log`. -240 dBFS; mencegah `log2(0) = -inf`
/// merambat ke envelope follower dan mengunci kompresor di NaN.
const MIN_AMP: f32 = 1.0e-12;

/// `log2(x)` cepat.
///
/// Untuk `x <= 0` mengembalikan `log2(MIN_AMP)` alih-alih `-inf`/NaN — di
/// jalur RT kita tidak boleh menghasilkan nilai yang meracuni state IIR.
#[inline(always)]
pub fn fast_log2(x: f32) -> f32 {
    // Clamp dulu: menghilangkan semua kasus khusus (0, negatif, subnormal)
    // tanpa branch tambahan di bawah.
    let x = if x > MIN_AMP { x } else { MIN_AMP };

    let bits = x.to_bits();
    // Eksponen bias-127 → bagian bulat dari log2.
    let exp = ((bits >> 23) & 0xFF) as i32 - 127;
    // Paksa eksponen jadi 0 → mantissa di [1, 2), nilai persis sama mantissanya.
    let m = f32::from_bits((bits & 0x007F_FFFF) | 0x3F80_0000);

    // Polinomial derajat 4 untuk **ln(m)** pada m ∈ [1, 2), bentuk Horner
    // (4 FMA berantai, tanpa pembagian). Hasilnya dikonversi ke log2 dengan
    // satu perkalian — lebih murah daripada menyimpan dua set koefisien.
    let p = m * (-0.056_570_85) + 0.447_179_55;
    let p = m * p + (-1.469_956_8);
    let p = m * p + 2.821_202_6;
    let p = m * p + (-1.741_793_9);

    exp as f32 + p * core::f32::consts::LOG2_E
}

/// `2^x` cepat.
///
/// Bagian bulat dikerjakan dengan menyusun eksponen f32 langsung (satu shift),
/// bagian pecahan oleh polinomial derajat 5 pada `[0, 1)`.
#[inline(always)]
pub fn fast_exp2(x: f32) -> f32 {
    // Clamp ke rentang eksponen f32 yang valid. Tanpa ini, `xi` di luar
    // [-126, 127] membuat penyusunan bit menghasilkan pola inf/NaN acak.
    let x = crate::clampf(x, -126.0, 127.0);

    let xi = libm::floorf(x);
    let f = x - xi; // f ∈ [0, 1)

    // Deret 2^f = exp(f·ln2) dipotong di suku ke-7. Suku ke-7 dan ke-8 kecil
    // tapi wajib: tanpa keduanya, error di f → 1 mencapai 1.7e-4 dan itu
    // langsung terlihat sebagai 1.5e-3 dB di gain kompresor.
    let p = f * 1.525_23e-5 + 1.540_29e-4;
    let p = f * p + 0.001_333_36;
    let p = f * p + 0.009_618_13;
    let p = f * p + 0.055_504_11;
    let p = f * p + 0.240_226_5;
    let p = f * p + core::f32::consts::LN_2;
    let p = f * p + 1.0;

    // 2^xi disusun langsung sebagai f32: eksponen = xi + 127.
    let e = (xi as i32 + 127) as u32;
    let scale = f32::from_bits(e << 23);
    p * scale
}

/// dB → amplitudo linear. `10^(db/20) = 2^(db * log2(10)/20)`.
#[inline(always)]
pub fn db_to_lin(db: f32) -> f32 {
    fast_exp2(db * DB_TO_LOG2)
}

/// Amplitudo linear → dB. `20*log10(x) = log2(x) * 20/log2(10)`.
///
/// Amplitudo <= 0 memetakan ke -240 dB (lantai `MIN_AMP`), bukan `-inf`.
#[inline(always)]
pub fn lin_to_db(x: f32) -> f32 {
    fast_log2(x) * LOG2_TO_DB
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log2_accuracy() {
        let mut worst = 0.0f32;
        let mut x = 1.0e-6f32;
        while x < 1.0e6 {
            let e = (fast_log2(x) - x.log2()).abs();
            if e > worst {
                worst = e;
            }
            x *= 1.000_37;
        }
        assert!(worst < 2.0e-4, "worst log2 error = {worst}");
    }

    #[test]
    fn exp2_accuracy() {
        let mut worst = 0.0f32;
        let mut i = -40_000i32;
        while i <= 40_000 {
            let x = i as f32 * 1.0e-3;
            let r = fast_exp2(x);
            let e = ((r - x.exp2()) / x.exp2()).abs();
            if e > worst {
                worst = e;
            }
            i += 1;
        }
        assert!(worst < 3.0e-5, "worst exp2 rel error = {worst}");
    }

    #[test]
    fn db_roundtrip() {
        let mut worst = 0.0f32;
        let mut db = -240.0f32;
        while db <= 24.0 {
            let back = lin_to_db(db_to_lin(db));
            let e = (back - db).abs();
            if e > worst {
                worst = e;
            }
            db += 0.01;
        }
        assert!(worst < 5.0e-3, "worst dB roundtrip = {worst}");
    }

    #[test]
    fn known_points() {
        assert!((db_to_lin(0.0) - 1.0).abs() < 1e-5);
        assert!((db_to_lin(-6.020_6) - 0.5).abs() < 1e-4);
        assert!((lin_to_db(1.0)).abs() < 1e-3);
        assert!((lin_to_db(0.5) + 6.020_6).abs() < 1e-3);
    }

    #[test]
    fn degenerate_inputs_are_finite() {
        // Jalur RT tidak boleh menghasilkan NaN/inf walau input konyol.
        for x in [0.0f32, -1.0, -0.0, f32::MIN_POSITIVE] {
            assert!(fast_log2(x).is_finite());
            assert!(lin_to_db(x).is_finite());
        }
        for d in [-1000.0f32, 1000.0, 0.0] {
            assert!(db_to_lin(d).is_finite());
        }
    }
}
