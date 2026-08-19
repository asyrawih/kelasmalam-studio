//! Peta slot blok parameter — kontrak antara `useEngineCommands.ts` dan engine.
//!
//! ## Kenapa blok param, bukan command ring
//!
//! Fader dan knob menghasilkan nilai tiap pointermove. Ring cuma punya 1024
//! entri dan **membuang** command diam-diam saat penuh (`engine-client.ts`),
//! jadi menggeser fader cepat-cepat akan menjatuhkan sebagian nilainya tanpa
//! ada yang tahu. Blok param adalah double-buffer: UI menulis sebanyak apa pun,
//! lalu menerbitkan sekali per rAF. docs/09 M6 bahkan menuliskannya sebagai
//! kriteria uji — "geser fader secepat mungkin 10 detik → ring **tidak** penuh".
//!
//! ## Kenapa slot yang belum disentuh bernilai NaN, bukan nol
//!
//! `commitParams()` menulis SELURUH 2048 slot tiap kali terbit, bukan hanya
//! yang berubah. Kalau slot yang belum pernah disentuh UI bernilai nol dan
//! engine menerapkannya apa adanya, maka drag pertama pada satu fader akan
//! menyetel gain SEMUA track ke nol — seluruh project langsung senyap.
//!
//! Karena itu slot yang tidak dikemudikan UI bernilai **NaN**, yang dibaca
//! engine sebagai "tidak ada override": nilai dari snapshot atau command ring
//! yang berlaku. Sebuah slot baru mengambil alih setelah UI menulis angka
//! finite ke sana, dan sejak itu jalur `*Live`/`*Commit` menjaga keduanya
//! sinkron. Nol adalah nilai gain yang sah, jadi ia tidak bisa dipakai sebagai
//! penanda "kosong" — NaN bisa, dan tidak punya makna audio lain.
//!
//! ## Tata letak
//!
//! ```text
//!    0 ..  256  MIXER STRIP   track t → t*8   (+0 gain linear, +1 pan)
//!  256 ..  320  BUS STRIP     bus b   → 256 + b*8
//!  320 .. 1016  CADANGAN      (otomasi, metronom)
//! 1016 .. 1024  MASTER STRIP  (1016 = gain linear)
//! 1024 .. 2048  FX PARAM ARENA
//! ```
//!
//! Dua angka di dalamnya — `PARAMS_PER_TRACK = 8` dan `MASTER_PARAM_GAIN =
//! 1016` — sudah dipaku lebih dulu di `useEngineCommands.ts`, jadi keduanya
//! dipertahankan persis. Berkas TS itu bahkan menulis sendiri bahwa "tidak ada
//! cara mengeceknya otomatis"; [`param_map_json`] menghapus kalimat itu.

use daw_rt::layout::PARAM_SLOTS;

/// Slot per track. Dipaku oleh `useEngineCommands.ts`.
pub const PARAMS_PER_TRACK: usize = 8;
/// Offset gain (LINEAR, bukan dB) di dalam strip track.
pub const TRACK_PARAM_GAIN: usize = 0;
/// Offset pan (−1..+1).
pub const TRACK_PARAM_PAN: usize = 1;

/// Awal strip bus. Track memakai 32 × 8 = 256 slot pertama.
pub const BUS_PARAM_BASE: usize = 256;
/// Slot per bus, sama bentuknya dengan track.
pub const PARAMS_PER_BUS: usize = 8;

/// Awal wilayah cadangan (otomasi, metronom).
pub const RESERVED_BASE: usize = 320;

/// Strip master. Dipaku oleh `useEngineCommands.ts`.
pub const MASTER_PARAM_GAIN: usize = 1016;
/// Awal strip master.
pub const MASTER_BASE: usize = 1016;

/// Awal arena parameter FX.
pub const FX_PARAM_BASE: usize = 1024;
/// Kapasitas arena parameter FX.
pub const FX_PARAM_CAP: usize = PARAM_SLOTS - FX_PARAM_BASE;

/// Slot gain untuk track ke-`t`.
#[inline]
pub const fn track_gain_slot(t: usize) -> usize {
    t * PARAMS_PER_TRACK + TRACK_PARAM_GAIN
}

/// Slot pan untuk track ke-`t`.
#[inline]
pub const fn track_pan_slot(t: usize) -> usize {
    t * PARAMS_PER_TRACK + TRACK_PARAM_PAN
}

/// Slot gain untuk bus ke-`b`.
#[inline]
pub const fn bus_gain_slot(b: usize) -> usize {
    BUS_PARAM_BASE + b * PARAMS_PER_BUS + TRACK_PARAM_GAIN
}

/// Slot pan untuk bus ke-`b`.
#[inline]
pub const fn bus_pan_slot(b: usize) -> usize {
    BUS_PARAM_BASE + b * PARAMS_PER_BUS + TRACK_PARAM_PAN
}

/// Apakah nilai slot ini merupakan override yang berlaku.
///
/// NaN dan infinity berarti "tidak dikemudikan UI" — lihat catatan modul.
#[inline]
pub fn is_override(v: f32) -> bool {
    v.is_finite()
}

/// Peta slot dalam bentuk yang bisa dibaca mesin.
///
/// Dicetak oleh tes `print_param_map_json` dan dibandingkan CI dengan
/// `web/src/audio/param-map.ts` — pola yang sama persis dengan
/// `daw_rt::layout::layout_json` dan `sab-layout.test.ts`. `no_std` tanpa
/// `alloc`, jadi ini string literal; tes di bawah menjaga agar ia tidak pernah
/// menyimpang dari konstanta di atas.
pub fn param_map_json() -> &'static str {
    concat!(
        "{",
        "\"paramSlots\":2048,",
        "\"paramsPerTrack\":8,",
        "\"trackParamGain\":0,",
        "\"trackParamPan\":1,",
        "\"busParamBase\":256,",
        "\"paramsPerBus\":8,",
        "\"reservedBase\":320,",
        "\"masterBase\":1016,",
        "\"masterParamGain\":1016,",
        "\"fxParamBase\":1024,",
        "\"fxParamCap\":1024",
        "}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::MAX_BUSES;
    use daw_rt::MAX_TRACKS;

    /// JSON di atas ditulis tangan supaya bisa `no_std`; tes ini yang menjaga
    /// ia tidak berbohong. Kalau ada yang menggeser konstanta tanpa memperbarui
    /// JSON, tes ini gagal — dan JSON itulah yang dipakai CI untuk memverifikasi
    /// sisi TypeScript.
    #[test]
    fn json_matches_constants() {
        let j = param_map_json();
        for (key, value) in [
            ("paramSlots", PARAM_SLOTS),
            ("paramsPerTrack", PARAMS_PER_TRACK),
            ("trackParamGain", TRACK_PARAM_GAIN),
            ("trackParamPan", TRACK_PARAM_PAN),
            ("busParamBase", BUS_PARAM_BASE),
            ("paramsPerBus", PARAMS_PER_BUS),
            ("reservedBase", RESERVED_BASE),
            ("masterBase", MASTER_BASE),
            ("masterParamGain", MASTER_PARAM_GAIN),
            ("fxParamBase", FX_PARAM_BASE),
            ("fxParamCap", FX_PARAM_CAP),
        ] {
            let needle = alloc::format!("\"{key}\":{value}");
            assert!(j.contains(&needle), "JSON tidak memuat {needle}");
        }
    }

    /// Dicetak supaya CI bisa menangkapnya, persis seperti `print_layout_json`.
    #[test]
    fn print_param_map_json() {
        std::println!("{}", param_map_json());
    }

    /// Wilayah tidak boleh tumpang tindih: track penuh harus berhenti tepat
    /// sebelum bus, bus sebelum cadangan, dan seterusnya. Ini yang menangkap
    /// "tambah satu parameter per track" yang diam-diam memakan strip bus.
    // Clippy melihat `assert!(<ekspresi konstanta>)` dan menyimpulkan ia akan
    // dioptimasi habis. Yang dioptimasi habis hanya kasus BENARNYA — kalau
    // konstantanya bergeser sehingga ekspresinya salah, assert-nya tetap
    // meledak saat tes dijalankan, dan itu memang tugasnya di sini.
    //
    // (Bentuk `const _: () = assert!(...)` akan menangkapnya lebih awal lagi,
    // yaitu saat kompilasi. Itu peningkatan tersendiri dan sengaja tidak
    // dicampur ke sini, karena berarti memindahkan invarian keluar dari tes
    // yang mendokumentasikannya.)
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn regions_do_not_overlap() {
        assert_eq!(MAX_TRACKS * PARAMS_PER_TRACK, BUS_PARAM_BASE);
        assert!(BUS_PARAM_BASE + MAX_BUSES * PARAMS_PER_BUS <= RESERVED_BASE);
        assert!(RESERVED_BASE <= MASTER_BASE);
        assert!(MASTER_BASE < FX_PARAM_BASE);
        assert_eq!(FX_PARAM_BASE + FX_PARAM_CAP, PARAM_SLOTS);
    }

    /// Slot terakhir tiap wilayah harus muat.
    // Alasan sama dengan `regions_do_not_overlap` di atas.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn every_slot_stays_inside_its_region() {
        assert!(track_gain_slot(MAX_TRACKS - 1) < BUS_PARAM_BASE);
        assert!(track_pan_slot(MAX_TRACKS - 1) < BUS_PARAM_BASE);
        assert!(bus_gain_slot(MAX_BUSES - 1) < RESERVED_BASE);
        assert!(bus_pan_slot(MAX_BUSES - 1) < RESERVED_BASE);
        assert!(MASTER_PARAM_GAIN < PARAM_SLOTS);
    }

    /// Nilai yang belum disentuh UI tidak boleh dianggap override — kalau
    /// sebaliknya, drag pertama menyenyapkan seluruh project.
    #[test]
    fn only_finite_values_are_overrides() {
        assert!(!is_override(f32::NAN));
        assert!(!is_override(f32::INFINITY));
        assert!(!is_override(f32::NEG_INFINITY));
        // Nol adalah gain yang SAH, jadi ia harus tetap dianggap override.
        assert!(is_override(0.0));
        assert!(is_override(1.0));
        assert!(is_override(-1.0));
    }
}
