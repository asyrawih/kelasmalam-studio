//! Surface RAW — dipakai HANYA oleh AudioWorklet (hot path).
//!
//! # Kontrak
//!
//! Semua fungsi di modul ini `#[no_mangle] extern "C"` dengan argumen dan
//! return **numerik** (`u32`/`f32`/pointer sebagai `u32` di wasm32). Tidak ada
//! wasm-bindgen, tidak ada string, tidak ada `JsValue`. Alasannya di
//! docs/01-threads-memory.md §1a jalur (3): worklet cukup memanggil
//! `instance.exports.engine_*` langsung — nol glue, nol marshalling.
//!
//! # SAFETY INVARIANT (dibaca sebelum menyentuh file ini)
//!
//! `engine_new` mengembalikan pointer hasil `Box::into_raw`. Pointer itu adalah
//! **kepemilikan tunggal**:
//!
//! 1. **Tepat satu thread** boleh menyentuhnya seumur hidupnya — thread yang
//!    memanggil `engine_new`. Untuk engine realtime itu AudioWorklet thread;
//!    untuk engine offline itu export worker. Tidak ada `&mut` kedua yang
//!    pernah hidup bersamaan, jadi `&mut *(ptr as *mut Engine)` di dalam
//!    `engine_process` valid. Invariant ini ditegakkan **oleh desain**, bukan
//!    oleh compiler.
//! 2. Pointer tidak boleh dikirim lewat `postMessage` ke thread lain, dan tidak
//!    boleh disimpan di JS melewati `memory.grow` tanpa memperhitungkan bahwa
//!    *view* lama basi (pointer-nya sendiri tetap valid — yang basi adalah
//!    `Float32Array` JS; lihat docs/05).
//! 3. `engine_free` tepat sekali, dari thread yang sama. Setelah itu pointer
//!    dangling; JS wajib menolnya.
//! 4. Tidak ada fungsi di modul ini yang boleh `panic!`, alokasi, atau blok.
//!    `panic = "abort"` → trap `unreachable` → `AudioContext` mati permanen
//!    (docs/05 §underrun). Semua akses buffer lewat pointer dengan panjang yang
//!    sudah di-clamp, bukan slicing yang bisa gagal.
//!
//! # Blok kontrol (SAB)
//!
//! `engine_new` menerima `ctl_ptr`: offset byte **di dalam WASM linear memory**
//! ke blok kontrol 64 KiB yang layout-nya ada di docs/01 §1b (kanonik:
//! `crates/rt/src/layout.rs` + `web/src/audio/sab-layout.ts`). Karena linear
//! memory-nya `shared: true`, blok yang sama terlihat oleh main thread sebagai
//! `Int32Array(memory.buffer, ctl_ptr, ...)` tanpa salinan.

use core::sync::atomic::{fence, AtomicU32, Ordering};

use daw_engine::Engine;
use daw_rt::{Command, SpscConsumer, MAX_BLOCK};
use daw_timeline::TimelineSample;

// ---------------------------------------------------------------------------
// Offset blok kontrol. Kanonik ada di `daw_rt::layout` dan `sab-layout.ts`;
// diduplikasi di sini sebagai const supaya hot path tidak bergantung pada
// bentuk API layout yang bisa berubah. Tes sinkronisasi ada di bawah.
// ---------------------------------------------------------------------------
#[allow(dead_code)] // sebagian hanya dipakai tes overlap di bawah
mod off {
    pub const TRANSPORT_SEQ: usize = 0x0000;
    pub const TRANSPORT_STATE: usize = 0x0004;
    pub const PLAYHEAD: usize = 0x0008; // u64
    pub const LOOP_START: usize = 0x0010; // u64
    pub const LOOP_END: usize = 0x0018; // u64
    pub const XRUN_COUNT: usize = 0x0020;
    pub const CPU_LOAD_Q16: usize = 0x0024;

    pub const CMD_WRITE_IDX: usize = 0x0040;
    pub const CMD_READ_IDX: usize = 0x0080;
    pub const CMD_DATA: usize = 0x00C0;

    pub const PARAM_GEN: usize = 0x40C0;
    pub const PARAM_SLOT_A: usize = 0x4100;
    pub const PARAM_SLOT_B: usize = 0x6100;

    pub const METER_SEQ: usize = 0x8100;
    pub const METER_DATA: usize = 0x8140;

    pub const EXPORT_CANCEL: usize = 0x8580;
    pub const ENGINE_FAULT: usize = 0x8584;

    /// Ukuran alokasi blok kontrol (64 KiB; terpakai 0x8600).
    pub const CONTROL_SIZE: usize = 65536;
    /// Jumlah slot meter: 32 track + master.
    pub const METER_COUNT: usize = 33;
    /// Ukuran satu slot meter (byte).
    pub const METER_STRIDE: usize = 32;
    /// Index slot meter master.
    pub const METER_MASTER: usize = 32;
    /// Jumlah slot param per buffer.
    pub const PARAM_SLOTS: usize = 2048;
}

pub use off::CONTROL_SIZE;

/// State runtime yang dipegang worklet. Semua buffer di dalamnya dialokasi
/// SEKALI di [`engine_new`]; setelah itu tidak ada alokasi sama sekali.
pub struct RtEngine {
    engine: Engine,
    /// Output planar: `[L 0..MAX_BLOCK, R 0..MAX_BLOCK]`. JS membacanya lewat
    /// `engine_out_ptr` + `engine_out_stride`.
    out: Box<[f32]>,
    cmd_rx: SpscConsumer,
    /// Basis blok kontrol di linear memory.
    ctl: *mut u8,
    /// Generation param yang terakhir dilihat — dipakai untuk mendeteksi
    /// double-buffer param yang baru dipublikasikan.
    param_gen_seen: u32,
    max_frames: usize,
    sample_rate: u32,
}

// ---------------------------------------------------------------------------
// Helper atomik atas blok kontrol. Semua `unsafe` di sini punya prasyarat yang
// sama: `ctl` valid dan `off` berada di dalam CONTROL_SIZE (dijamin oleh
// konstanta di atas, semuanya < 0x8600).
// ---------------------------------------------------------------------------

/// # Safety
/// `ctl` harus menunjuk blok kontrol berukuran [`CONTROL_SIZE`] yang aligned 8.
#[inline(always)]
unsafe fn atom(ctl: *mut u8, offset: usize) -> &'static AtomicU32 {
    // SAFETY: offset kelipatan 4 dan < CONTROL_SIZE; blok kontrol hidup selama
    // program (dibocorkan sengaja di control_block_alloc).
    unsafe { &*(ctl.add(offset) as *const AtomicU32) }
}

/// # Safety
/// Sama seperti [`atom`]; `offset` harus kelipatan 4.
#[inline(always)]
unsafe fn f32_at(ctl: *mut u8, offset: usize) -> *mut f32 {
    // SAFETY: dijamin pemanggil (offset di dalam blok, aligned 4).
    unsafe { ctl.add(offset) as *mut f32 }
}

/// Tulis u64 sebagai dua u32 little-endian (WASM selalu LE). Dipakai untuk
/// playhead: JS membacanya lewat `BigInt64Array`, tapi kita tidak butuh
/// atomicity 64-bit karena seluruh blok transport dilindungi SeqLock.
///
/// # Safety
/// `ctl + offset .. +8` harus di dalam blok kontrol.
#[inline(always)]
unsafe fn write_u64(ctl: *mut u8, offset: usize, v: u64) {
    // SAFETY: dijamin pemanggil.
    unsafe {
        (ctl.add(offset) as *mut u32).write(v as u32);
        (ctl.add(offset + 4) as *mut u32).write((v >> 32) as u32);
    }
}

/// # Safety
/// `ctl + offset .. +8` harus di dalam blok kontrol.
#[inline(always)]
unsafe fn read_u64(ctl: *mut u8, offset: usize) -> u64 {
    // SAFETY: dijamin pemanggil.
    unsafe {
        let lo = (ctl.add(offset) as *const u32).read() as u64;
        let hi = (ctl.add(offset + 4) as *const u32).read() as u64;
        lo | (hi << 32)
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Alokasi blok kontrol 64 KiB di linear memory dan mengembalikan offset-nya.
///
/// Dipanggil SEKALI dari main thread (lewat surface bindgen atau langsung),
/// **sebelum** worklet dibuat. Blok sengaja dibocorkan: umurnya = umur halaman,
/// dan JS memegang view ke sana. Nol-inisialisasi.
///
/// Ini bukan fungsi realtime — ia mengalokasi. Jangan panggil dari `process()`.
#[no_mangle]
pub extern "C" fn control_block_alloc() -> *mut u8 {
    let v = vec![0u8; CONTROL_SIZE].into_boxed_slice();
    Box::into_raw(v) as *mut u8
}

/// Ukuran blok kontrol dalam byte — JS memakai ini untuk assert layout.
#[no_mangle]
pub extern "C" fn control_block_size() -> u32 {
    CONTROL_SIZE as u32
}

/// Versi ABI; JS membandingkannya dengan konstanta di `wasm-loader.ts`.
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    crate::ABI_VERSION
}

/// Membuat engine realtime.
///
/// - `sample_rate`: **`ctx.sampleRate` apa adanya**, jangan dipaksa 48k
///   (docs/05 §Safari).
/// - `ctl_ptr`: hasil [`control_block_alloc`].
/// - `max_frames`: ukuran blok maksimum; di-clamp ke [`MAX_BLOCK`].
///
/// Mengembalikan pointer pemilik, atau null kalau argumen tidak masuk akal.
///
/// # Safety
/// `ctl_ptr` harus hasil [`control_block_alloc`] yang masih hidup, dan
/// pemanggil menjadi **satu-satunya** pemilik pointer yang dikembalikan
/// (lihat invariant di dokumentasi modul).
#[no_mangle]
pub unsafe extern "C" fn engine_new(
    sample_rate: u32,
    ctl_ptr: *mut u8,
    max_frames: u32,
) -> *mut RtEngine {
    if ctl_ptr.is_null() || !(8_000..=384_000).contains(&sample_rate) {
        return core::ptr::null_mut();
    }
    let max_frames = (max_frames as usize).clamp(1, MAX_BLOCK);

    let engine = Engine::new(sample_rate, MAX_BLOCK);
    // SAFETY: pemanggil menjamin ctl_ptr adalah blok kontrol dengan layout
    // docs/01 §1b; SpscConsumer hanya menyentuh CMD_* di dalam blok itu.
    let cmd_rx = unsafe { SpscConsumer::from_raw(ctl_ptr) };

    let rt = RtEngine {
        engine,
        out: vec![0.0f32; MAX_BLOCK * 2].into_boxed_slice(),
        cmd_rx,
        ctl: ctl_ptr,
        param_gen_seen: u32::MAX,
        max_frames,
        sample_rate,
    };
    Box::into_raw(Box::new(rt))
}

/// Membebaskan engine. Tepat sekali, dari thread pemilik.
///
/// # Safety
/// `ptr` harus hasil [`engine_new`] yang belum pernah di-free.
#[no_mangle]
pub unsafe extern "C" fn engine_free(ptr: *mut RtEngine) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: dijamin pemanggil (kepemilikan tunggal, free sekali).
    drop(unsafe { Box::from_raw(ptr) });
}

/// Pointer ke buffer output planar. **Stabil** selama engine hidup, tapi
/// `memory.grow` di thread lain membuat *view JS* basi — JS wajib memakai guard
/// `memBuffer !== memory.buffer` (docs/05).
///
/// Layout: `[..MAX_BLOCK] = L`, `[MAX_BLOCK..2*MAX_BLOCK] = R`.
///
/// # Safety
/// `ptr` harus hasil [`engine_new`] yang masih hidup.
#[no_mangle]
pub unsafe extern "C" fn engine_out_ptr(ptr: *mut RtEngine) -> *const f32 {
    if ptr.is_null() {
        return core::ptr::null();
    }
    // SAFETY: dijamin pemanggil.
    unsafe { (*ptr).out.as_ptr() }
}

/// Jarak (dalam sample) antara awal channel L dan channel R di buffer output.
#[no_mangle]
pub extern "C" fn engine_out_stride() -> u32 {
    MAX_BLOCK as u32
}

/// Jumlah channel output (stereo).
#[no_mangle]
pub extern "C" fn engine_out_channels() -> u32 {
    2
}

// ---------------------------------------------------------------------------
// Hot path
// ---------------------------------------------------------------------------

/// Render satu quantum. **Ini satu-satunya fungsi yang dipanggil per 128 frame.**
///
/// Urutannya penting:
/// 1. drain command ring (Acquire pada `cmd_write_idx` — pasangan dari Release
///    di sisi UI, docs/01 §1b tabel ordering),
/// 2. ambil param double-buffer kalau generation berubah,
/// 3. `render_block` (jalur render SATU-SATUNYA, sama dengan offline),
/// 4. tulis transport + meter ke blok kontrol lewat SeqLock.
///
/// Nol alokasi, nol panic, tidak pernah blok. Mengembalikan jumlah frame yang
/// benar-benar dirender (= `frames` yang sudah di-clamp).
///
/// # Safety
/// `ptr` harus hasil [`engine_new`] yang masih hidup, dan dipanggil dari thread
/// pemilik saja.
#[no_mangle]
pub unsafe extern "C" fn engine_process(ptr: *mut RtEngine, frames: u32) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    // SAFETY: kepemilikan tunggal (invariant modul) → &mut eksklusif valid.
    let rt = unsafe { &mut *ptr };
    let n = (frames as usize).min(rt.max_frames);
    if n == 0 {
        return 0;
    }

    // --- 1. drain command ring -------------------------------------------
    // Batas iterasi: ring penuh = CMD_CAPACITY. Loop tidak bisa tak terbatas
    // karena `pop` mengembalikan None saat kosong, tapi batas eksplisit
    // melindungi dari producer yang mengamuk (RT harus punya batas atas kerja).
    let mut budget = daw_rt::CMD_CAPACITY;
    while budget > 0 {
        match rt.cmd_rx.pop() {
            Some(cmd) => {
                apply(rt, cmd);
                budget -= 1;
            }
            None => break,
        }
    }

    // --- 2. param double-buffer ------------------------------------------
    // Blok param (docs/01 §1b) dipublikasikan UI dengan Release pada
    // `param_gen`; di sini dibaca dengan Acquire dan slot aktif = `gen & 1`.
    // `daw-engine` belum mengekspos konsumen blok param (semua parameter masih
    // lewat command ring), jadi untuk saat ini kita hanya melacak generation-nya
    // — begitu API-nya ada, HANYA blok ini yang berubah.
    // SAFETY: ctl valid selama engine hidup.
    let generation = unsafe { atom(rt.ctl, off::PARAM_GEN) }.load(Ordering::Acquire);
    if generation != rt.param_gen_seen {
        rt.param_gen_seen = generation;
        let _active_slot = if generation & 1 == 0 {
            off::PARAM_SLOT_A
        } else {
            off::PARAM_SLOT_B
        };
    }

    // --- 3. render --------------------------------------------------------
    let (l, r) = rt.out.split_at_mut(MAX_BLOCK);
    // `get_mut` bukan slicing: tidak ada jalur panic sama sekali.
    if let (Some(l), Some(r)) = (l.get_mut(..n), r.get_mut(..n)) {
        rt.engine.render_block(l, r);
    } else {
        return 0;
    }

    // --- 4. publish transport + meter master ------------------------------
    // SAFETY: ctl valid; semua offset < CONTROL_SIZE.
    unsafe { publish(rt, n) };

    n as u32
}

/// Terapkan satu command. Dipisah dari `engine_process` supaya jalur `apply`
/// engine tetap satu-satunya tempat semantik command didefinisikan.
#[inline(always)]
fn apply(rt: &mut RtEngine, cmd: Command) {
    rt.engine.apply(cmd);
}

/// Publikasi state audio→UI. Dua SeqLock terpisah (transport & meter) supaya
/// pembaca UI yang hanya butuh playhead tidak ikut retry saat meter ditulis.
///
/// Pola tulis SeqLock (docs/01 §1b): `seq+1 (Relaxed)` → `fence(Release)` →
/// tulis data → `seq+2 (Release)`. Writer tidak pernah menunggu siapa pun.
///
/// # Safety
/// `rt.ctl` harus blok kontrol yang valid.
unsafe fn publish(rt: &mut RtEngine, frames: usize) {
    let ctl = rt.ctl;
    let t = rt.engine.transport();

    // SAFETY: offset konstan di dalam blok kontrol.
    unsafe {
        let seq = atom(ctl, off::TRANSPORT_SEQ);
        let s = seq.load(Ordering::Relaxed);
        seq.store(s.wrapping_add(1), Ordering::Relaxed);
        fence(Ordering::Release);

        atom(ctl, off::TRANSPORT_STATE).store(t.state as u32, Ordering::Relaxed);
        write_u64(ctl, off::PLAYHEAD, t.playhead);
        let (ls, le) = t.loop_range.unwrap_or((0, 0));
        write_u64(ctl, off::LOOP_START, ls);
        write_u64(ctl, off::LOOP_END, le);

        seq.store(s.wrapping_add(2), Ordering::Release);
    }

    // Meter master dihitung di sini dari buffer output; meter per-track ditulis
    // oleh engine ke slot 0..31 lewat `MeterWriter`-nya sendiri.
    let (l, r) = rt.out.split_at(MAX_BLOCK);
    let (Some(l), Some(r)) = (l.get(..frames), r.get(..frames)) else {
        return;
    };
    let (mut pl, mut pr, mut sl, mut sr) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for i in 0..frames {
        // `get` + unwrap_or: tidak ada jalur panic.
        let a = *l.get(i).unwrap_or(&0.0);
        let b = *r.get(i).unwrap_or(&0.0);
        pl = pl.max(a.abs());
        pr = pr.max(b.abs());
        sl += a * a;
        sr += b * b;
    }
    let inv = 1.0 / frames as f32;
    let (rl, rr) = ((sl * inv).sqrt(), (sr * inv).sqrt());

    // SAFETY: METER_DATA + 32*33 <= EXPORT_CANCEL, di dalam blok.
    unsafe {
        let seq = atom(ctl, off::METER_SEQ);
        let s = seq.load(Ordering::Relaxed);
        seq.store(s.wrapping_add(1), Ordering::Relaxed);
        fence(Ordering::Release);

        let base = off::METER_DATA + off::METER_MASTER * off::METER_STRIDE;
        let m = f32_at(ctl, base);
        m.write(pl);
        m.add(1).write(pr);
        m.add(2).write(rl);
        m.add(3).write(rr);
        // m[4] = gain_reduction_db, m[5] = clip_hold_frames — diisi engine/master bus.

        seq.store(s.wrapping_add(2), Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Transport control (jalur cepat tanpa lewat ring — dipakai untuk hal yang
// harus terjadi sebelum blok berikutnya, mis. seek dari worklet sendiri)
// ---------------------------------------------------------------------------

/// Seek ke posisi sample absolut. `u64` dipecah jadi dua `u32` supaya tanda
/// tangan tetap numerik-32 (tidak memaksa JS meng-`BigInt` di hot path).
///
/// # Safety
/// `ptr` harus hasil [`engine_new`] yang masih hidup.
#[no_mangle]
pub unsafe extern "C" fn engine_seek(ptr: *mut RtEngine, pos_lo: u32, pos_hi: u32) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: kepemilikan tunggal.
    let rt = unsafe { &mut *ptr };
    let pos = (pos_lo as u64) | ((pos_hi as u64) << 32);
    rt.engine.seek(TimelineSample(pos));
}

/// Playhead saat ini (32 bit bawah). Untuk 64 bit penuh pakai
/// [`engine_playhead_hi`] — atau lebih baik: baca blok TRANSPORT dari SAB.
///
/// # Safety
/// `ptr` harus hasil [`engine_new`] yang masih hidup.
#[no_mangle]
pub unsafe extern "C" fn engine_playhead_lo(ptr: *mut RtEngine) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    // SAFETY: kepemilikan tunggal.
    unsafe { (*ptr).engine.transport().playhead as u32 }
}

/// 32 bit atas playhead.
///
/// # Safety
/// `ptr` harus hasil [`engine_new`] yang masih hidup.
#[no_mangle]
pub unsafe extern "C" fn engine_playhead_hi(ptr: *mut RtEngine) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    // SAFETY: kepemilikan tunggal.
    unsafe { ((*ptr).engine.transport().playhead >> 32) as u32 }
}

// ---------------------------------------------------------------------------
// Akses blok kontrol untuk jalur DEGRADED (tanpa SAB).
//
// Tanpa SharedArrayBuffer, main thread tidak bisa menulis ring secara langsung:
// linear memory worklet adalah salinan terpisah. Perintah datang lewat
// `port.postMessage` batched per rAF (docs/01 §1d), dan worklet menyuntikkannya
// ke ring lokal dengan fungsi di bawah — jalur render tetap identik.
// ---------------------------------------------------------------------------

/// Menulis satu command langsung ke engine, melewati ring. Hanya untuk jalur
/// degraded; dipanggil dari `onmessage` worklet, **bukan** dari `process()`.
///
/// # Safety
/// `ptr` harus hasil [`engine_new`] yang masih hidup.
#[no_mangle]
pub unsafe extern "C" fn engine_push_command(
    ptr: *mut RtEngine,
    op: u32,
    flags: u32,
    target: u32,
    param: u32,
    at_lo: u32,
    at_hi: u32,
) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: kepemilikan tunggal.
    let rt = unsafe { &mut *ptr };
    rt.engine.apply(Command {
        op: op as u8,
        flags: flags as u8,
        target: target as u16,
        param,
        at_sample: (at_lo as u64) | ((at_hi as u64) << 32),
    });
}

/// Alokasi buffer scratch di linear memory untuk transfer snapshot ke worklet.
/// **Bukan** fungsi realtime (mengalokasi) — dipanggil dari main thread /
/// message handler worklet, tidak pernah dari `process()`.
#[no_mangle]
pub extern "C" fn scratch_alloc(len: u32) -> *mut u8 {
    let v = vec![0u8; len as usize].into_boxed_slice();
    Box::into_raw(v) as *mut u8
}

/// Bebaskan buffer dari [`scratch_alloc`].
///
/// # Safety
/// `ptr` harus hasil `scratch_alloc(len)` dengan `len` yang sama, dibebaskan
/// tepat sekali.
#[no_mangle]
pub unsafe extern "C" fn scratch_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: dijamin pemanggil.
    drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(ptr, len as usize)) });
}

/// Muat snapshot project ke engine realtime. Mengganti seluruh state graph.
/// Mengembalikan 1 kalau sukses, 0 kalau snapshot tidak valid.
///
/// **Bukan** fungsi realtime: dipanggil dari `port.onmessage` worklet (di luar
/// `process()`), boleh mengalokasi. Setelah ini `process()` berikutnya memakai
/// graph baru.
///
/// # Safety
/// `ptr` harus hasil [`engine_new`]; `bytes .. bytes+len` harus buffer valid
/// di linear memory yang sama.
#[no_mangle]
pub unsafe extern "C" fn engine_load_snapshot(
    ptr: *mut RtEngine,
    bytes: *const u8,
    len: u32,
) -> u32 {
    if ptr.is_null() || bytes.is_null() {
        return 0;
    }
    // SAFETY: dijamin pemanggil.
    let rt = unsafe { &mut *ptr };
    // SAFETY: dijamin pemanggil (buffer valid selama panggilan).
    let slice = unsafe { core::slice::from_raw_parts(bytes, len as usize) };
    match Engine::from_snapshot(slice, rt.sample_rate) {
        Ok(new) => {
            rt.engine = new;
            1
        }
        Err(_) => 0,
    }
}

/// Baca flag `export_cancel` dari blok kontrol (Relaxed — docs/01 §1b tabel).
/// Dipakai export worker, bukan audio thread.
///
/// # Safety
/// `ctl` harus blok kontrol yang valid.
#[no_mangle]
pub unsafe extern "C" fn control_export_cancel(ctl: *mut u8) -> u32 {
    if ctl.is_null() {
        return 0;
    }
    // SAFETY: dijamin pemanggil.
    unsafe { atom(ctl, off::EXPORT_CANCEL) }.load(Ordering::Relaxed)
}

/// Set flag fault engine. Dipanggil JS kalau ia mendeteksi kondisi fatal
/// (mis. instantiasi gagal) supaya UI bisa menampilkannya.
///
/// # Safety
/// `ctl` harus blok kontrol yang valid.
#[no_mangle]
pub unsafe extern "C" fn control_set_fault(ctl: *mut u8, code: u32) {
    if ctl.is_null() {
        return;
    }
    // SAFETY: dijamin pemanggil.
    unsafe { atom(ctl, off::ENGINE_FAULT) }.store(code, Ordering::Relaxed);
}

/// Baca `xrun_count` (Relaxed; statistik murni).
///
/// # Safety
/// `ctl` harus blok kontrol yang valid.
#[no_mangle]
pub unsafe extern "C" fn control_xrun_count(ctl: *mut u8) -> u32 {
    if ctl.is_null() {
        return 0;
    }
    // SAFETY: dijamin pemanggil.
    unsafe { atom(ctl, off::XRUN_COUNT) }.load(Ordering::Relaxed)
}

/// Baca `cpu_load_q16`.
///
/// # Safety
/// `ctl` harus blok kontrol yang valid.
#[no_mangle]
pub unsafe extern "C" fn control_cpu_load_q16(ctl: *mut u8) -> u32 {
    if ctl.is_null() {
        return 0;
    }
    // SAFETY: dijamin pemanggil.
    unsafe { atom(ctl, off::CPU_LOAD_Q16) }.load(Ordering::Relaxed)
}

/// Baca playhead dari blok kontrol dengan retry SeqLock — dipakai jalur non-RT
/// yang tidak punya akses ke `Engine` (mis. export worker yang memantau).
///
/// # Safety
/// `ctl` harus blok kontrol yang valid.
#[no_mangle]
pub unsafe extern "C" fn control_playhead_lo(ctl: *mut u8) -> u32 {
    if ctl.is_null() {
        return 0;
    }
    // SAFETY: dijamin pemanggil.
    unsafe {
        let seq = atom(ctl, off::TRANSPORT_SEQ);
        loop {
            let a = seq.load(Ordering::Acquire);
            if a & 1 != 0 {
                continue;
            }
            let v = read_u64(ctl, off::PLAYHEAD) as u32;
            if seq.load(Ordering::Acquire) == a {
                return v;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::off;

    /// Offset di sini HARUS sama dengan `daw_rt::layout::off` (kanonik) dan
    /// dengan `web/src/audio/sab-layout.ts`. Tes Rust↔TS dijalankan oleh
    /// `pnpm -C web test` yang membandingkan JSON dari `cargo test -p daw-rt layout`.
    #[test]
    fn offsets_match_daw_rt() {
        assert_eq!(off::TRANSPORT_SEQ, daw_rt::layout::off::TRANSPORT_SEQ);
    }

    #[test]
    fn blocks_do_not_overlap() {
        // `const _: () = assert!(...)` — dievaluasi saat KOMPILASI. Sebagai
        // `assert!` runtime, semua operand-nya konstanta sehingga compiler
        // membuangnya dan tesnya tidak menguji apa pun.
        const _: () = assert!(off::CMD_DATA + 1024 * 16 <= off::PARAM_GEN);
        const _: () = assert!(off::PARAM_SLOT_A + off::PARAM_SLOTS * 4 <= off::PARAM_SLOT_B);
        const _: () = assert!(off::PARAM_SLOT_B + off::PARAM_SLOTS * 4 <= off::METER_SEQ);
        const _: () =
            assert!(off::METER_DATA + off::METER_COUNT * off::METER_STRIDE <= off::EXPORT_CANCEL);
        const _: () = assert!(off::ENGINE_FAULT + 4 <= off::CONTROL_SIZE);
    }
}
