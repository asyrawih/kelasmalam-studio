//! Guard alokasi untuk membuktikan jalur render benar-benar bebas alokasi.
//!
//! Modul ini hanya ada di balik fitur `rt-guard` dan **tidak pernah ikut ke
//! build produksi**. Idenya sederhana dan dijelaskan di docs/01 §1c:
//!
//! 1. Pasang global allocator pembungkus.
//! 2. [`rt_section!`] menyalakan sebuah flag selama scope-nya.
//! 3. Kalau ada alokasi terjadi saat flag menyala, allocator itu **panic**.
//!
//! Kenapa ini perlu padahal sudah ada review kode: alokasi bisa masuk lewat
//! jalur yang sangat tidak kentara — `collect()` yang lolos review, `format!`
//! di dalam `debug_assert!`, `Vec` yang tumbuh di dalam dependensi, atau
//! monomorfisasi yang diam-diam memakai `Box`. Di WASM biayanya bukan cuma
//! lambat: allocator bisa memicu `memory.grow`, yang **meng-invalidasi semua
//! `TypedArray` view di sisi JS** (docs/05) — bug yang tampil sebagai output
//! senyap acak, bukan sebagai crash.
//!
//! # Cara pakai
//!
//! ```ignore
//! # use daw_rt::{rt_section, rt_guard::RtGuardAlloc};
//! #[global_allocator]
//! static ALLOC: RtGuardAlloc<std::alloc::System> = RtGuardAlloc::new(std::alloc::System);
//!
//! #[test]
//! fn render_block_does_not_allocate() {
//!     let mut engine = Engine::new(48_000, 128);   // alokasi di sini: boleh
//!     rt_section! {
//!         engine.render_block(&mut l, &mut r);     // alokasi di sini: panic
//!     }
//! }
//! ```
//!
//! # Batasan
//!
//! Flag-nya **thread-local**, jadi guard hanya mengawasi thread yang sedang
//! menjalankan `rt_section!` — persis yang kita mau, karena thread lain
//! (main/worker) memang boleh mengalokasi kapan saja.

use core::alloc::{GlobalAlloc, Layout};
use core::cell::Cell;
use core::sync::atomic::{AtomicUsize, Ordering};

std::thread_local! {
    /// Kedalaman nesting `rt_section!`. Counter, bukan bool, supaya section
    /// bersarang (mis. `render_block` memanggil helper yang juga di-guard)
    /// tidak "membuka kunci" lebih awal saat yang dalam selesai.
    static RT_DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// Jumlah pelanggaran yang terdeteksi. Dipakai oleh tes yang tidak ingin
/// panic (mis. saat mengukur, bukan menegakkan).
static VIOLATIONS: AtomicUsize = AtomicUsize::new(0);

/// Kalau `true`, pelanggaran hanya dihitung, tidak panic.
static COUNT_ONLY: AtomicUsize = AtomicUsize::new(0);

/// `true` kalau thread ini sedang berada di dalam `rt_section!`.
#[inline]
pub fn in_rt_section() -> bool {
    RT_DEPTH.with(|d| d.get() > 0)
}

/// Jumlah pelanggaran yang tercatat sejak awal proses.
pub fn violations() -> usize {
    VIOLATIONS.load(Ordering::Relaxed)
}

/// Nolkan penghitung pelanggaran.
pub fn reset_violations() {
    VIOLATIONS.store(0, Ordering::Relaxed);
}

/// Mode "hitung saja": alokasi di dalam `rt_section!` dicatat tapi tidak panic.
pub fn set_count_only(v: bool) {
    COUNT_ONLY.store(usize::from(v), Ordering::Relaxed);
}

/// RAII penanda section. Dipakai lewat [`rt_section!`], jarang langsung.
///
/// Kenapa RAII dan bukan sepasang fungsi enter/exit: kalau tes yang di-guard
/// gagal dengan `panic!` (dan unwind), flag harus tetap dimatikan — kalau tidak,
/// setiap alokasi berikutnya di thread itu ikut meledak dan pesan errornya
/// menyesatkan.
pub struct RtSection {
    // Tidak bisa dipindah antar thread: flag-nya thread-local.
    _not_send: core::marker::PhantomData<*const ()>,
}

impl RtSection {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        RT_DEPTH.with(|d| d.set(d.get() + 1));
        RtSection {
            _not_send: core::marker::PhantomData,
        }
    }
}

impl Drop for RtSection {
    fn drop(&mut self) {
        RT_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
    }
}

/// Jalankan blok di dalam section RT.
///
/// ```ignore
/// rt_section! {
///     engine.render_block(&mut l, &mut r);
/// }
/// ```
#[macro_export]
macro_rules! rt_section {
    ($($body:tt)*) => {{
        let __rt_guard = $crate::rt_guard::RtSection::new();
        let __rt_result = { $($body)* };
        drop(__rt_guard);
        __rt_result
    }};
}

/// Global allocator pembungkus.
///
/// Membungkus allocator lain (biasanya `std::alloc::System`) supaya proyek
/// tetap bisa memilih allocator produksinya sendiri.
pub struct RtGuardAlloc<A: GlobalAlloc> {
    inner: A,
}

impl<A: GlobalAlloc> RtGuardAlloc<A> {
    pub const fn new(inner: A) -> Self {
        RtGuardAlloc { inner }
    }
}

/// Titik pemeriksaan bersama untuk semua entry point allocator.
#[inline]
fn check(what: &str, size: usize) {
    // Penting: pemeriksaan ini sendiri tidak boleh mengalokasi, kalau tidak
    // ia akan memanggil dirinya sendiri secara rekursif tanpa henti.
    // `Cell::get` dan `AtomicUsize` keduanya bebas alokasi; pesan panic-nya
    // memakai literal + argumen `&str`/`usize` yang di-format oleh
    // infrastruktur panic, di luar section (depth sudah dinolkan dulu).
    if !in_rt_section() {
        return;
    }
    VIOLATIONS.fetch_add(1, Ordering::Relaxed);
    if COUNT_ONLY.load(Ordering::Relaxed) != 0 {
        return;
    }
    // Matikan flag sebelum panic: formatter panic sendiri mengalokasi, dan
    // tanpa ini kita akan panic di dalam panic (abort tanpa pesan).
    RT_DEPTH.with(|d| d.set(0));
    panic!("alokasi ({what}, {size} byte) terjadi di dalam rt_section!");
}

// SAFETY: semua metode meneruskan ke allocator dalam tanpa mengubah kontraknya;
// yang ditambahkan hanya pemeriksaan flag yang tidak menyentuh memori heap.
unsafe impl<A: GlobalAlloc> GlobalAlloc for RtGuardAlloc<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        check("alloc", layout.size());
        // SAFETY: layout diteruskan apa adanya dari pemanggil.
        unsafe { self.inner.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // Dealloc juga dilarang: `free` mengambil lock allocator yang sama,
        // dan di WASM bisa memicu konsolidasi heap. `drop` yang tak sengaja
        // di jalur RT itu bug yang sama seriusnya dengan `Vec::push`.
        check("dealloc", layout.size());
        // SAFETY: ptr/layout diteruskan apa adanya dari pemanggil.
        unsafe { self.inner.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        check("alloc_zeroed", layout.size());
        // SAFETY: diteruskan apa adanya.
        unsafe { self.inner.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        check("realloc", new_size);
        // SAFETY: diteruskan apa adanya.
        unsafe { self.inner.realloc(ptr, layout, new_size) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depth_tracking_is_balanced() {
        assert!(!in_rt_section());
        {
            let _a = RtSection::new();
            assert!(in_rt_section());
            {
                let _b = RtSection::new();
                assert!(in_rt_section());
            }
            // Section dalam selesai, tapi yang luar masih aktif.
            assert!(in_rt_section());
        }
        assert!(!in_rt_section());
    }

    #[test]
    fn macro_returns_value_and_closes_section() {
        let v = rt_section! { 1 + 2 };
        assert_eq!(v, 3);
        assert!(!in_rt_section());
    }

    #[test]
    fn section_closes_after_unwind() {
        let r = std::panic::catch_unwind(|| {
            let _s = RtSection::new();
            panic!("boom");
        });
        assert!(r.is_err());
        assert!(!in_rt_section(), "flag harus mati walau ada unwind");
    }
}
