//! Arena memori FX — satu blok besar, dibagi sekali, tidak pernah dialokasi
//! ulang di jalur render.
//!
//! ## Kenapa arena dan bukan `Box` per efek
//!
//! ECHO butuh 2 detik delay stereo, REVERB butuh delapan line. Kalau tiap node
//! memiliki `Box<[f32]>`-nya sendiri, maka menambah efek berarti memanggil
//! alokator — dan satu-satunya tempat itu bisa terjadi adalah saat snapshot
//! dimuat, yang di AudioWorklet berarti **di thread audio**. Lebih buruk lagi,
//! alokasi besar bisa memicu `memory.grow`, yang menginvalidasi setiap
//! `Float32Array` yang dipegang main thread (docs/05) — gejalanya muncul jauh
//! dari penyebabnya, sebagai view sepanjang nol yang tidak melempar apa pun.
//!
//! Dengan arena, seluruh memori FX diminta SEKALI di `Engine::new`. Menyusun
//! ulang chain cuma memindahkan penunjuk di dalamnya.
//!
//! ## Kenapa anggarannya byte, bukan detik
//!
//! Sample rate divalidasi `8_000..=384_000`. Anggaran "8 detik" berarti 8× lebih
//! besar di 384 kHz daripada di 48 kHz untuk hasil musikal yang sama persis —
//! yaitu membayar delapan kali lipat untuk tidak mendapat apa-apa. Anggaran
//! byte tetap membuat konsekuensinya jujur: di sample rate tinggi, jumlah efek
//! delay yang muat memang lebih sedikit, dan itu dilaporkan sebagai peringatan
//! saat plan dibangun — bukan sebagai glitch saat diputar.

use alloc::boxed::Box;
use alloc::vec;

/// Anggaran bawaan: 16 MiB. Muat ~8 ECHO + 4 REVERB pada 48 kHz.
pub const FX_ARENA_BYTES: usize = 16 * 1024 * 1024;

/// Anggaran bawaan dalam f32.
pub const FX_ARENA_FLOATS: usize = FX_ARENA_BYTES / 4;

/// Rujukan ke satu region arena. `Copy` dan 8 byte, jadi murah disimpan di node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct MemHandle {
    off: u32,
    len: u32,
}

impl MemHandle {
    /// Region kosong, untuk efek yang tidak butuh memori (EQ, kompresor,
    /// FILTER). `block()` mengembalikan slice kosong dan efeknya mengabaikannya.
    pub const EMPTY: MemHandle = MemHandle { off: 0, len: 0 };

    #[inline]
    pub fn len(&self) -> usize {
        self.len as usize
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

/// Alokator bump. Tidak ada `free` per region — seluruh arena di-`reset` saat
/// chain disusun ulang, dan itu satu-satunya siklus hidup yang dibutuhkan.
pub struct FxArena {
    mem: Box<[f32]>,
    used: usize,
}

impl FxArena {
    /// Alokasi arena. NON-RT — dipanggil sekali di `Engine::new`.
    pub fn new(floats: usize) -> Self {
        FxArena {
            mem: vec![0.0f32; floats].into_boxed_slice(),
            used: 0,
        }
    }

    /// Arena kosong, untuk konfigurasi yang tidak memakai efek berbasis memori.
    pub fn empty() -> Self {
        FxArena {
            mem: Box::default(),
            used: 0,
        }
    }

    #[inline]
    pub fn capacity(&self) -> usize {
        self.mem.len()
    }

    #[inline]
    pub fn used(&self) -> usize {
        self.used
    }

    #[inline]
    pub fn remaining(&self) -> usize {
        self.mem.len() - self.used
    }

    /// Ambil region sepanjang `n`. NON-RT.
    ///
    /// Mengembalikan `None` kalau anggaran habis. Pemanggilnya (`plan_chains`)
    /// menerjemahkan itu jadi `PlanError::OutOfFxMemory`, yang ditolak sebelum
    /// plan dipasang dan muncul sebagai peringatan di UI — persis preseden
    /// `PlanError::OutOfBuffers`. Yang TIDAK boleh terjadi adalah alokasi
    /// dadakan di jalur render.
    pub fn alloc(&mut self, n: usize) -> Option<MemHandle> {
        if n == 0 {
            return Some(MemHandle::EMPTY);
        }
        if n > self.remaining() {
            return None;
        }
        let off = self.used;
        // Region diberikan dalam keadaan bersih: efek yang dipasang di tengah
        // pemutaran tidak boleh mewarisi ekor efek sebelumnya di alamat yang
        // sama. Ini non-RT, jadi biayanya tidak masuk anggaran blok.
        for s in self.mem[off..off + n].iter_mut() {
            *s = 0.0;
        }
        self.used += n;
        Some(MemHandle {
            off: off as u32,
            len: n as u32,
        })
    }

    /// Kosongkan seluruh arena. Semua `MemHandle` lama jadi tidak berlaku —
    /// pemanggil wajib membuang rack lamanya pada saat yang sama.
    pub fn reset(&mut self) {
        self.used = 0;
    }

    /// Slice untuk satu region. RT-safe: satu pemeriksaan batas, tanpa panic.
    ///
    /// Handle yang tidak valid menghasilkan slice kosong, bukan panic — efek
    /// menanganinya lewat `Delay::attach(..)` yang mengembalikan `None`.
    #[inline]
    pub fn block(&mut self, h: MemHandle) -> &mut [f32] {
        let off = h.off as usize;
        let end = off + h.len as usize;
        if h.len == 0 || end > self.mem.len() {
            return &mut [];
        }
        &mut self.mem[off..end]
    }

    /// Versi baca-saja, untuk tes dan pemeriksaan.
    #[inline]
    pub fn block_ref(&self, h: MemHandle) -> &[f32] {
        let off = h.off as usize;
        let end = off + h.len as usize;
        if h.len == 0 || end > self.mem.len() {
            return &[];
        }
        &self.mem[off..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocations_are_disjoint_and_correctly_sized() {
        let mut a = FxArena::new(1000);
        let h1 = a.alloc(100).unwrap();
        let h2 = a.alloc(250).unwrap();
        assert_eq!(a.block(h1).len(), 100);
        assert_eq!(a.block(h2).len(), 250);
        assert_eq!(a.used(), 350);

        // Tulis lewat satu handle, pastikan yang lain tidak ikut berubah.
        for s in a.block(h1).iter_mut() {
            *s = 1.0;
        }
        assert!(a.block_ref(h2).iter().all(|v| *v == 0.0));
        assert!(a.block_ref(h1).iter().all(|v| *v == 1.0));
    }

    /// Kehabisan anggaran adalah hasil yang sah, bukan panic — itu yang membuat
    /// kegagalannya bisa dilaporkan ke user sebelum audio jalan.
    #[test]
    fn over_budget_returns_none_not_panic() {
        let mut a = FxArena::new(100);
        assert!(a.alloc(60).is_some());
        assert!(a.alloc(60).is_none());
        // Dan arena tetap utuh setelah penolakan.
        assert_eq!(a.used(), 60);
        assert!(a.alloc(40).is_some());
        assert_eq!(a.remaining(), 0);
    }

    #[test]
    fn zero_length_allocation_is_the_empty_handle() {
        let mut a = FxArena::new(10);
        let h = a.alloc(0).unwrap();
        assert_eq!(h, MemHandle::EMPTY);
        assert!(h.is_empty());
        assert!(a.block(h).is_empty());
        assert_eq!(a.used(), 0);
    }

    /// Region baru harus bersih walaupun alamatnya bekas dipakai — kalau tidak,
    /// mengganti efek di tengah lagu akan menyalakan ekor efek sebelumnya.
    #[test]
    fn reset_hands_back_clean_memory() {
        let mut a = FxArena::new(64);
        let h = a.alloc(32).unwrap();
        for s in a.block(h).iter_mut() {
            *s = 7.0;
        }
        a.reset();
        assert_eq!(a.used(), 0);
        let h2 = a.alloc(32).unwrap();
        assert!(
            a.block_ref(h2).iter().all(|v| *v == 0.0),
            "region bekas masih menyimpan data lama"
        );
    }

    #[test]
    fn invalid_handle_yields_empty_slice_not_panic() {
        let mut a = FxArena::new(16);
        let bogus = MemHandle {
            off: 1000,
            len: 10,
        };
        assert!(a.block(bogus).is_empty());
        assert!(a.block_ref(bogus).is_empty());
    }

    #[test]
    fn empty_arena_refuses_everything_gracefully() {
        let mut a = FxArena::empty();
        assert_eq!(a.capacity(), 0);
        assert!(a.alloc(0).is_some());
        assert!(a.alloc(1).is_none());
    }

    /// Anggaran bawaan harus sesuai angka yang tertulis di rencana.
    #[test]
    fn default_budget_is_sixteen_mib() {
        assert_eq!(FX_ARENA_FLOATS, 4_194_304);
        assert_eq!(FX_ARENA_FLOATS * 4, 16 * 1024 * 1024);
    }
}
