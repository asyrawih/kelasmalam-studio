//! Peta memori SharedArrayBuffer kontrol (docs/01 §1b).
//!
//! SAB ini **terpisah** dari WASM linear memory: isinya cuma index, flag, dan
//! meter — bukan audio. Ukurannya 64 KiB, dan setiap blok dimulai di kelipatan
//! 64 byte (satu cache line).
//!
//! Kenapa 64-byte align itu wajib dan bukan kosmetik: kalau dua field yang
//! ditulis oleh dua thread berbeda berbagi cache line, setiap tulis membatalkan
//! cache line thread lain (cache-line ping-pong). Di audio thread — yang punya
//! deadline keras 2.67 ms — itu muncul sebagai jitter yang tidak terjelaskan.
//! Karena itu `cmd_write_idx` (ditulis UI) dan `cmd_read_idx` (ditulis audio)
//! sengaja dipisah 64 byte penuh meski masing-masing hanya 4 byte.
//!
//! Peta ini kanonik di **dua** tempat yang harus sinkron:
//! file ini dan `web/src/audio/sab-layout.ts`. [`layout_json`] mengeluarkan
//! versi mesin-bacanya supaya CI bisa membandingkan keduanya.

/// Ukuran cache line yang diasumsikan.
pub const CACHE_LINE: usize = 64;

/// Ukuran SAB yang dialokasi JS. Isi terpakai hanya sampai [`USED_END`];
/// sisanya cadangan supaya penambahan field tidak mengubah ukuran alokasi.
pub const SAB_SIZE: usize = 65_536;

/// Kapasitas ring command, **harus** pangkat dua (index dibungkus dengan mask).
pub const CMD_CAPACITY: usize = 1024;
/// Ukuran satu entri command dalam byte.
pub const CMD_ENTRY_SIZE: usize = 16;
/// Jumlah slot parameter per buffer (double-buffer A/B).
pub const PARAM_SLOTS: usize = 2048;
/// 32 track + 1 master.
pub const METER_COUNT: usize = 33;
/// Ukuran satu entri meter dalam byte.
pub const METER_ENTRY_SIZE: usize = 32;

/// Offset byte semua field di dalam SAB kontrol.
pub mod off {
    use super::*;

    // ── BLOCK 0: TRANSPORT STATE (audio → UI, SeqLock) ──
    pub const TRANSPORT_BASE: usize = 0x0000;
    /// SeqLock sequence; ganjil = sedang ditulis.
    pub const TRANSPORT_SEQ: usize = 0x0000;
    /// 0 = stop, 1 = play, 2 = record.
    pub const TRANSPORT_STATE: usize = 0x0004;
    pub const TRANSPORT_PLAYHEAD: usize = 0x0008;
    pub const TRANSPORT_LOOP_START: usize = 0x0010;
    pub const TRANSPORT_LOOP_END: usize = 0x0018;
    pub const TRANSPORT_XRUN_COUNT: usize = 0x0020;
    /// Fraksi deadline yang terpakai, format Q16.
    pub const TRANSPORT_CPU_LOAD_Q16: usize = 0x0024;
    pub const TRANSPORT_SIZE: usize = 0x0040;

    // ── BLOCK 1: COMMAND RING (UI → audio, SPSC) ──
    pub const CMD_BASE: usize = 0x0040;
    /// Ditulis UI, dibaca audio.
    pub const CMD_WRITE_IDX: usize = 0x0040;
    /// Ditulis audio, dibaca UI. Sengaja satu cache line penuh dari write_idx.
    pub const CMD_READ_IDX: usize = 0x0080;
    pub const CMD_DATA: usize = 0x00C0;
    pub const CMD_DATA_SIZE: usize = CMD_CAPACITY * CMD_ENTRY_SIZE; // 16384
    pub const CMD_END: usize = CMD_DATA + CMD_DATA_SIZE; // 0x40C0

    // ── BLOCK 2: PARAM BLOCK (UI → audio, double-buffer) ──
    pub const PARAM_BASE: usize = 0x40C0;
    /// Generation counter. Slot aktif = `gen & 1`.
    pub const PARAM_GEN: usize = 0x40C0;
    pub const PARAM_SLOT_A: usize = 0x4100;
    pub const PARAM_SLOT_B: usize = 0x6100;
    pub const PARAM_SLOT_SIZE: usize = PARAM_SLOTS * 4; // 8192
    pub const PARAM_END: usize = PARAM_SLOT_B + PARAM_SLOT_SIZE; // 0x8100

    // ── BLOCK 3: METER FEEDBACK (audio → UI, SeqLock) ──
    pub const METER_BASE: usize = 0x8100;
    pub const METER_SEQ: usize = 0x8100;
    pub const METER_DATA: usize = 0x8140;
    pub const METER_DATA_SIZE: usize = METER_COUNT * METER_ENTRY_SIZE; // 1056

    // Offset field di dalam satu entri meter (relatif ke awal entri).
    pub const METER_FIELD_PEAK_L: usize = 0;
    pub const METER_FIELD_PEAK_R: usize = 4;
    pub const METER_FIELD_RMS_L: usize = 8;
    pub const METER_FIELD_RMS_R: usize = 12;
    pub const METER_FIELD_GAIN_REDUCTION_DB: usize = 16;
    pub const METER_FIELD_CLIP_HOLD_FRAMES: usize = 20;
    // 24..32 = padding ke 32 B.

    // ── BLOCK 4: FLAGS ──
    pub const FLAGS_BASE: usize = 0x8580;
    /// Ditulis UI, dibaca export worker.
    pub const EXPORT_CANCEL: usize = 0x8580;
    /// Ditulis engine saat fault; dibaca UI untuk menampilkan recovery.
    pub const PANIC_FLAG: usize = 0x8584;
    pub const FLAGS_END: usize = 0x8600;
}

/// Byte terakhir yang dipakai; sisanya sampai [`SAB_SIZE`] adalah cadangan.
pub const USED_END: usize = off::FLAGS_END; // 0x8600 = 34304

// ───────────────────── assertion waktu-kompilasi ─────────────────────
//
// Ini bukan tes; ini bagian dari definisi. Kalau ada yang menggeser satu
// konstanta dan merusak alignment atau membuat dua blok tumpang tindih,
// crate ini **tidak akan compile**. Jauh lebih baik daripada bug jitter yang
// baru terlihat di produksi.

/// Semua awal blok harus 64-byte aligned (anti false sharing).
const _: () = {
    assert!(off::TRANSPORT_BASE % CACHE_LINE == 0);
    assert!(off::CMD_BASE % CACHE_LINE == 0);
    assert!(off::CMD_WRITE_IDX % CACHE_LINE == 0);
    assert!(off::CMD_READ_IDX % CACHE_LINE == 0);
    assert!(off::CMD_DATA % CACHE_LINE == 0);
    assert!(off::PARAM_BASE % CACHE_LINE == 0);
    assert!(off::PARAM_GEN % CACHE_LINE == 0);
    assert!(off::PARAM_SLOT_A % CACHE_LINE == 0);
    assert!(off::PARAM_SLOT_B % CACHE_LINE == 0);
    assert!(off::METER_BASE % CACHE_LINE == 0);
    assert!(off::METER_SEQ % CACHE_LINE == 0);
    assert!(off::METER_DATA % CACHE_LINE == 0);
    assert!(off::FLAGS_BASE % CACHE_LINE == 0);
    assert!(off::FLAGS_END % CACHE_LINE == 0);
};

/// `cmd_write_idx` dan `cmd_read_idx` ditulis oleh thread berbeda → wajib beda
/// cache line, bukan sekadar beda alamat.
const _: () = {
    assert!(off::CMD_READ_IDX - off::CMD_WRITE_IDX >= CACHE_LINE);
    assert!(off::CMD_DATA - off::CMD_READ_IDX >= CACHE_LINE);
};

/// Blok tidak boleh tumpang tindih, dan urutannya harus monoton naik.
const _: () = {
    assert!(off::TRANSPORT_BASE + off::TRANSPORT_SIZE <= off::CMD_BASE);
    assert!(off::CMD_END <= off::PARAM_BASE);
    assert!(off::PARAM_SLOT_A + off::PARAM_SLOT_SIZE <= off::PARAM_SLOT_B);
    assert!(off::PARAM_END <= off::METER_BASE);
    assert!(off::METER_DATA + off::METER_DATA_SIZE <= off::FLAGS_BASE);
    assert!(off::FLAGS_END <= SAB_SIZE);
};

/// Field di dalam blok transport harus muat dan tidak saling menimpa.
const _: () = {
    assert!(off::TRANSPORT_SEQ + 4 <= off::TRANSPORT_STATE);
    assert!(off::TRANSPORT_STATE + 4 <= off::TRANSPORT_PLAYHEAD);
    assert!(off::TRANSPORT_PLAYHEAD + 8 <= off::TRANSPORT_LOOP_START);
    assert!(off::TRANSPORT_LOOP_START + 8 <= off::TRANSPORT_LOOP_END);
    assert!(off::TRANSPORT_LOOP_END + 8 <= off::TRANSPORT_XRUN_COUNT);
    assert!(off::TRANSPORT_XRUN_COUNT + 4 <= off::TRANSPORT_CPU_LOAD_Q16);
    assert!(off::TRANSPORT_CPU_LOAD_Q16 + 4 <= off::TRANSPORT_BASE + off::TRANSPORT_SIZE);
    // u64 harus 8-byte aligned supaya `Atomics` BigInt64 di JS legal.
    assert!(off::TRANSPORT_PLAYHEAD % 8 == 0);
    assert!(off::TRANSPORT_LOOP_START % 8 == 0);
    assert!(off::TRANSPORT_LOOP_END % 8 == 0);
};

/// Ring butuh kapasitas pangkat dua supaya `idx & mask` sah sebagai modulo.
const _: () = {
    assert!(CMD_CAPACITY.is_power_of_two());
    assert!(CMD_ENTRY_SIZE == 16);
    assert!(METER_ENTRY_SIZE == 32);
    assert!(off::FLAGS_BASE + 8 <= off::FLAGS_END);
    assert!(off::EXPORT_CANCEL + 4 <= off::PANIC_FLAG);
};

/// Entri command harus 16-byte aligned supaya field `u64 at_sample` di
/// dalamnya (offset 8) juga 8-byte aligned di semua slot.
const _: () = {
    assert!(off::CMD_DATA % 16 == 0);
    assert!(CMD_ENTRY_SIZE % 8 == 0);
};

/// JSON offset kanonik, untuk dibandingkan CI dengan
/// `web/src/audio/sab-layout.ts`.
///
/// String ini di-hardcode (bukan di-format saat runtime) supaya crate tetap
/// `no_std` tanpa `alloc`. Tes `layout_json_matches_constants` di bawah
/// memastikan ia tidak pernah menyimpang dari konstanta di atas.
pub fn layout_json() -> &'static str {
    concat!(
        "{",
        "\"sabSize\":65536,",
        "\"cacheLine\":64,",
        "\"cmdCapacity\":1024,",
        "\"cmdEntrySize\":16,",
        "\"paramSlots\":2048,",
        "\"meterCount\":33,",
        "\"meterEntrySize\":32,",
        "\"usedEnd\":34304,",
        "\"off\":{",
        "\"TRANSPORT_SEQ\":0,",
        "\"TRANSPORT_STATE\":4,",
        "\"TRANSPORT_PLAYHEAD\":8,",
        "\"TRANSPORT_LOOP_START\":16,",
        "\"TRANSPORT_LOOP_END\":24,",
        "\"TRANSPORT_XRUN_COUNT\":32,",
        "\"TRANSPORT_CPU_LOAD_Q16\":36,",
        "\"CMD_WRITE_IDX\":64,",
        "\"CMD_READ_IDX\":128,",
        "\"CMD_DATA\":192,",
        "\"CMD_END\":16576,",
        "\"PARAM_GEN\":16576,",
        "\"PARAM_SLOT_A\":16640,",
        "\"PARAM_SLOT_B\":24832,",
        "\"PARAM_END\":33024,",
        "\"METER_SEQ\":33024,",
        "\"METER_DATA\":33088,",
        "\"METER_FIELD_PEAK_L\":0,",
        "\"METER_FIELD_PEAK_R\":4,",
        "\"METER_FIELD_RMS_L\":8,",
        "\"METER_FIELD_RMS_R\":12,",
        "\"METER_FIELD_GAIN_REDUCTION_DB\":16,",
        "\"METER_FIELD_CLIP_HOLD_FRAMES\":20,",
        "\"EXPORT_CANCEL\":34176,",
        "\"PANIC_FLAG\":34180,",
        "\"FLAGS_END\":34304",
        "}}"
    )
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    /// Membangun ulang JSON dari konstanta dan membandingkannya dengan literal
    /// di [`layout_json`]. Kalau ada yang menggeser offset tanpa memperbarui
    /// JSON, tes ini gagal — dan JSON itulah yang dipakai CI untuk mem-verifikasi
    /// `web/src/audio/sab-layout.ts`.
    #[test]
    fn layout_json_matches_constants() {
        let expected = format!(
            concat!(
                "{{",
                "\"sabSize\":{},\"cacheLine\":{},\"cmdCapacity\":{},",
                "\"cmdEntrySize\":{},\"paramSlots\":{},\"meterCount\":{},",
                "\"meterEntrySize\":{},\"usedEnd\":{},",
                "\"off\":{{",
                "\"TRANSPORT_SEQ\":{},\"TRANSPORT_STATE\":{},\"TRANSPORT_PLAYHEAD\":{},",
                "\"TRANSPORT_LOOP_START\":{},\"TRANSPORT_LOOP_END\":{},",
                "\"TRANSPORT_XRUN_COUNT\":{},\"TRANSPORT_CPU_LOAD_Q16\":{},",
                "\"CMD_WRITE_IDX\":{},\"CMD_READ_IDX\":{},\"CMD_DATA\":{},\"CMD_END\":{},",
                "\"PARAM_GEN\":{},\"PARAM_SLOT_A\":{},\"PARAM_SLOT_B\":{},\"PARAM_END\":{},",
                "\"METER_SEQ\":{},\"METER_DATA\":{},",
                "\"METER_FIELD_PEAK_L\":{},\"METER_FIELD_PEAK_R\":{},",
                "\"METER_FIELD_RMS_L\":{},\"METER_FIELD_RMS_R\":{},",
                "\"METER_FIELD_GAIN_REDUCTION_DB\":{},\"METER_FIELD_CLIP_HOLD_FRAMES\":{},",
                "\"EXPORT_CANCEL\":{},\"PANIC_FLAG\":{},\"FLAGS_END\":{}",
                "}}}}"
            ),
            SAB_SIZE,
            CACHE_LINE,
            CMD_CAPACITY,
            CMD_ENTRY_SIZE,
            PARAM_SLOTS,
            METER_COUNT,
            METER_ENTRY_SIZE,
            USED_END,
            off::TRANSPORT_SEQ,
            off::TRANSPORT_STATE,
            off::TRANSPORT_PLAYHEAD,
            off::TRANSPORT_LOOP_START,
            off::TRANSPORT_LOOP_END,
            off::TRANSPORT_XRUN_COUNT,
            off::TRANSPORT_CPU_LOAD_Q16,
            off::CMD_WRITE_IDX,
            off::CMD_READ_IDX,
            off::CMD_DATA,
            off::CMD_END,
            off::PARAM_GEN,
            off::PARAM_SLOT_A,
            off::PARAM_SLOT_B,
            off::PARAM_END,
            off::METER_SEQ,
            off::METER_DATA,
            off::METER_FIELD_PEAK_L,
            off::METER_FIELD_PEAK_R,
            off::METER_FIELD_RMS_L,
            off::METER_FIELD_RMS_R,
            off::METER_FIELD_GAIN_REDUCTION_DB,
            off::METER_FIELD_CLIP_HOLD_FRAMES,
            off::EXPORT_CANCEL,
            off::PANIC_FLAG,
            off::FLAGS_END,
        );
        assert_eq!(layout_json(), expected);
    }

    /// `cargo test -p daw-rt -- --nocapture print_layout_json` mencetak JSON
    /// yang dikonsumsi CI untuk diff dengan sisi TypeScript.
    #[test]
    fn print_layout_json() {
        println!("{}", layout_json());
    }

    #[test]
    fn documented_offsets_from_docs_01() {
        // Angka-angka ini disalin langsung dari tabel docs/01 §1b.
        assert_eq!(off::TRANSPORT_SEQ, 0x0000);
        assert_eq!(off::CMD_WRITE_IDX, 0x0040);
        assert_eq!(off::CMD_READ_IDX, 0x0080);
        assert_eq!(off::CMD_DATA, 0x00C0);
        assert_eq!(off::PARAM_GEN, 0x40C0);
        assert_eq!(off::PARAM_SLOT_A, 0x4100);
        assert_eq!(off::PARAM_SLOT_B, 0x6100);
        assert_eq!(off::METER_SEQ, 0x8100);
        assert_eq!(off::METER_DATA, 0x8140);
        assert_eq!(off::EXPORT_CANCEL, 0x8580);
        assert_eq!(off::PANIC_FLAG, 0x8584);
        assert_eq!(USED_END, 0x8600);
    }
}
