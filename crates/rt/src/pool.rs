//! Pool berkapasitas tetap dengan free-stack + active list.
//!
//! Ini adalah pola voice-pool dari docs/01 §1c. Yang dibutuhkan engine:
//! - **Nol alokasi setelah konstruksi.** Semua storage inline di dalam struct,
//!   jadi tidak ada `Box`/`Vec` sama sekali dan crate ini tetap `no_std` tanpa
//!   `alloc`. Kapasitas jadi parameter const-generic, bukan argumen runtime —
//!   ukuran pool memang diketahui saat init (`MAX_VOICES = 256`).
//! - **O(1) alloc dan free.** Free-stack memberi alloc O(1). Untuk free O(1)
//!   kita simpan posisi tiap entri di dalam `active` (`active_pos`), lalu
//!   hapus dengan swap-remove — tanpa itu, `free` harus memindai `active`
//!   secara linear dan biayanya jadi O(n) tepat saat banyak voice berbunyi.
//! - **Iterasi atas entri aktif** yang padat (bukan memindai 256 slot untuk
//!   menemukan 3 yang hidup).
//!
//! Kalau pool habis, [`Pool::alloc`] mengembalikan `None`. Engine yang
//! memutuskan kebijakannya (voice stealing dengan micro-fade 2 ms) — pool
//! sendiri tidak pernah "berusaha lebih keras", karena satu-satunya cara
//! berusaha lebih keras adalah mengalokasi.

/// Handle ke entri pool. `u16` cukup untuk `MAX_VOICES = 256` dan membuat
/// struct pemanggil tetap kecil.
pub type Handle = u16;

/// Nilai penanda "tidak ada".
const NONE_POS: u16 = u16::MAX;

/// Pool berkapasitas `N`.
pub struct Pool<T, const N: usize> {
    slots: [T; N],
    /// Stack index yang bebas. Isi valid: `free[..free_len]`.
    free: [Handle; N],
    free_len: usize,
    /// Daftar index aktif yang padat. Isi valid: `active[..active_len]`.
    active: [Handle; N],
    active_len: usize,
    /// Posisi tiap slot di dalam `active`, atau [`NONE_POS`] kalau tidak aktif.
    /// Inilah yang membuat `free` jadi O(1).
    active_pos: [u16; N],
}

impl<T: Copy + Default, const N: usize> Default for Pool<T, N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Copy + Default, const N: usize> Pool<T, N> {
    /// Konstruksi. **Satu-satunya** titik di mana memori pool disentuh secara
    /// masal; setelah ini tidak ada lagi inisialisasi berbiaya O(N).
    pub fn new() -> Self {
        // Const-assert: handle bertipe u16, jadi N tidak boleh melebihi
        // u16::MAX - 1 (satu nilai dipakai sebagai NONE_POS).
        assert!(N < u16::MAX as usize, "kapasitas pool melebihi u16");

        let mut free = [0 as Handle; N];
        // Isi free-stack terbalik supaya alokasi pertama mengambil index 0 —
        // enak dibaca saat debugging, dan urutan slot mengikuti urutan voice.
        let mut i = 0usize;
        while i < N {
            free[i] = (N - 1 - i) as Handle;
            i += 1;
        }

        Pool {
            slots: [T::default(); N],
            free,
            free_len: N,
            active: [0 as Handle; N],
            active_len: 0,
            active_pos: [NONE_POS; N],
        }
    }

    /// Kapasitas total.
    #[inline(always)]
    pub const fn capacity(&self) -> usize {
        N
    }

    /// Jumlah entri aktif.
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.active_len
    }

    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.active_len == 0
    }

    /// Jumlah slot yang masih bebas.
    #[inline(always)]
    pub fn free_count(&self) -> usize {
        self.free_len
    }

    #[inline(always)]
    pub fn is_active(&self, h: Handle) -> bool {
        match self.active_pos.get(h as usize) {
            Some(p) => *p != NONE_POS,
            None => false,
        }
    }

    /// Ambil satu slot. O(1). `None` = pool habis (engine → voice stealing).
    #[inline]
    pub fn alloc(&mut self) -> Option<Handle> {
        if self.free_len == 0 {
            return None;
        }
        self.free_len -= 1;
        let h = *self.free.get(self.free_len)?;

        // Tambahkan ke daftar aktif dan catat posisinya.
        let pos = self.active_len;
        *self.active.get_mut(pos)? = h;
        *self.active_pos.get_mut(h as usize)? = pos as u16;
        self.active_len += 1;
        Some(h)
    }

    /// Ambil slot lalu inisialisasi isinya.
    #[inline]
    pub fn alloc_with(&mut self, value: T) -> Option<Handle> {
        let h = self.alloc()?;
        *self.slots.get_mut(h as usize)? = value;
        Some(h)
    }

    /// Kembalikan slot. O(1) lewat swap-remove pada `active`.
    ///
    /// Memanggilnya dua kali untuk handle yang sama tidak berbahaya (dan tidak
    /// merusak free-stack): handle yang sudah bebas langsung diabaikan.
    #[inline]
    pub fn free(&mut self, h: Handle) -> bool {
        let idx = h as usize;
        let pos = match self.active_pos.get(idx) {
            Some(p) if *p != NONE_POS => *p as usize,
            _ => return false,
        };

        let last = self.active_len - 1;
        if pos != last {
            // Pindahkan entri terakhir ke lubang yang ditinggalkan.
            let moved = match self.active.get(last) {
                Some(v) => *v,
                None => return false,
            };
            if let Some(slot) = self.active.get_mut(pos) {
                *slot = moved;
            }
            if let Some(p) = self.active_pos.get_mut(moved as usize) {
                *p = pos as u16;
            }
        }
        self.active_len = last;

        if let Some(p) = self.active_pos.get_mut(idx) {
            *p = NONE_POS;
        }
        if let Some(slot) = self.free.get_mut(self.free_len) {
            *slot = h;
        }
        self.free_len += 1;
        true
    }

    /// Bebaskan semua entri. O(jumlah aktif), bukan O(N).
    pub fn clear(&mut self) {
        while self.active_len > 0 {
            let h = match self.active.get(self.active_len - 1) {
                Some(v) => *v,
                None => break,
            };
            self.free(h);
        }
    }

    #[inline(always)]
    pub fn get(&self, h: Handle) -> Option<&T> {
        if self.is_active(h) {
            self.slots.get(h as usize)
        } else {
            None
        }
    }

    #[inline(always)]
    pub fn get_mut(&mut self, h: Handle) -> Option<&mut T> {
        if self.is_active(h) {
            self.slots.get_mut(h as usize)
        } else {
            None
        }
    }

    /// Handle-handle yang aktif, padat dan tanpa alokasi.
    ///
    /// Urutannya **tidak** dijamin stabil (swap-remove mengacaknya). Engine
    /// tidak boleh bergantung pada urutan voice; kalau butuh urutan (mis. untuk
    /// memilih voice tertua saat stealing), simpan timestamp di dalam `T`.
    #[inline]
    pub fn iter_active(&self) -> impl Iterator<Item = Handle> + '_ {
        self.active.iter().take(self.active_len).copied()
    }

    /// Iterasi `(handle, &T)` atas entri aktif.
    #[inline]
    pub fn iter(&self) -> impl Iterator<Item = (Handle, &T)> + '_ {
        self.active
            .iter()
            .take(self.active_len)
            .filter_map(move |&h| self.slots.get(h as usize).map(|v| (h, v)))
    }

    /// Jalankan `f` untuk tiap entri aktif dengan akses `&mut`.
    ///
    /// Bentuk callback dipakai alih-alih `iter_mut()` karena meminjam
    /// `self.slots` secara mutable sambil membaca `self.active` tidak bisa
    /// diekspresikan sebagai iterator aman tanpa `unsafe`. Ini jalur RT — lebih
    /// baik satu closure daripada satu blok `unsafe`.
    #[inline]
    pub fn for_each_active<F: FnMut(Handle, &mut T)>(&mut self, mut f: F) {
        for i in 0..self.active_len {
            let h = match self.active.get(i) {
                Some(v) => *v,
                None => break,
            };
            if let Some(slot) = self.slots.get_mut(h as usize) {
                f(h, slot);
            }
        }
    }

    /// Buang entri aktif yang `pred`-nya `false`. O(jumlah aktif).
    ///
    /// Dipakai engine untuk memanen voice yang sudah selesai berbunyi, sekali
    /// per blok.
    pub fn retain<F: FnMut(Handle, &T) -> bool>(&mut self, mut pred: F) {
        let mut i = 0usize;
        while i < self.active_len {
            let h = match self.active.get(i) {
                Some(v) => *v,
                None => break,
            };
            let keep = match self.slots.get(h as usize) {
                Some(v) => pred(h, v),
                None => false,
            };
            if keep {
                i += 1;
            } else {
                // `free` melakukan swap-remove, jadi posisi `i` sekarang berisi
                // entri baru — jangan naikkan `i`.
                self.free(h);
            }
        }
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Default, Debug, PartialEq)]
    struct Voice {
        id: u32,
        gain: f32,
    }

    type P = Pool<Voice, 8>;

    #[test]
    fn alloc_until_full_then_none() {
        let mut p = P::new();
        assert_eq!(p.capacity(), 8);
        assert_eq!(p.free_count(), 8);
        let mut hs = Vec::new();
        for i in 0..8 {
            let h = p.alloc().expect("should alloc");
            p.get_mut(h).unwrap().id = i;
            hs.push(h);
        }
        assert_eq!(p.len(), 8);
        assert_eq!(p.free_count(), 0);
        assert!(p.alloc().is_none());
        // Semua handle unik.
        hs.sort_unstable();
        hs.dedup();
        assert_eq!(hs.len(), 8);
    }

    #[test]
    fn free_makes_slot_reusable() {
        let mut p = P::new();
        let a = p.alloc().unwrap();
        let b = p.alloc().unwrap();
        assert!(p.free(a));
        assert_eq!(p.len(), 1);
        assert!(!p.is_active(a));
        assert!(p.is_active(b));
        assert!(p.get(a).is_none());
        let c = p.alloc().unwrap();
        assert_eq!(c, a); // slot yang sama dipakai ulang
        assert_eq!(p.len(), 2);
    }

    #[test]
    fn double_free_is_harmless() {
        let mut p = P::new();
        let a = p.alloc().unwrap();
        assert!(p.free(a));
        assert!(!p.free(a));
        assert_eq!(p.free_count(), 8);
        // Free-stack tidak rusak: masih bisa alloc penuh.
        for _ in 0..8 {
            assert!(p.alloc().is_some());
        }
        assert!(p.alloc().is_none());
    }

    #[test]
    fn iter_active_matches_allocations() {
        let mut p = P::new();
        let hs: Vec<Handle> = (0..5).map(|_| p.alloc().unwrap()).collect();
        p.free(hs[1]);
        p.free(hs[3]);
        let mut got: Vec<Handle> = p.iter_active().collect();
        got.sort_unstable();
        let mut want = vec![hs[0], hs[2], hs[4]];
        want.sort_unstable();
        assert_eq!(got, want);
        assert_eq!(p.iter().count(), 3);
    }

    #[test]
    fn for_each_active_can_mutate() {
        let mut p = P::new();
        for i in 0..4u32 {
            let h = p.alloc_with(Voice { id: i, gain: 0.0 }).unwrap();
            assert_eq!(p.get(h).unwrap().id, i);
        }
        p.for_each_active(|_, v| v.gain = 1.0);
        assert!(p.iter().all(|(_, v)| v.gain == 1.0));
    }

    #[test]
    fn retain_drops_finished_voices() {
        let mut p = P::new();
        for i in 0..8u32 {
            p.alloc_with(Voice {
                id: i,
                gain: i as f32,
            })
            .unwrap();
        }
        p.retain(|_, v| v.id % 2 == 0);
        assert_eq!(p.len(), 4);
        assert!(p.iter().all(|(_, v)| v.id % 2 == 0));
        // Slot yang dibebaskan benar-benar kembali ke free-stack.
        assert_eq!(p.free_count(), 4);
    }

    #[test]
    fn clear_returns_everything() {
        let mut p = P::new();
        for _ in 0..8 {
            p.alloc().unwrap();
        }
        p.clear();
        assert!(p.is_empty());
        assert_eq!(p.free_count(), 8);
        assert_eq!(p.iter_active().count(), 0);
    }

    #[test]
    fn churn_keeps_invariants() {
        let mut p: Pool<Voice, 32> = Pool::new();
        let mut live: Vec<Handle> = Vec::new();
        // Pola pseudo-acak deterministik.
        let mut x = 12345u32;
        for _ in 0..10_000 {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            if x % 2 == 0 || live.is_empty() {
                if let Some(h) = p.alloc() {
                    live.push(h);
                }
            } else {
                let i = (x as usize / 7) % live.len();
                let h = live.swap_remove(i);
                assert!(p.free(h));
            }
            assert_eq!(p.len(), live.len());
            assert_eq!(p.len() + p.free_count(), 32);
            for &h in &live {
                assert!(p.is_active(h));
            }
        }
    }
}
