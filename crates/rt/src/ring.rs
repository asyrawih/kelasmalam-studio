//! Ring SPSC (single-producer single-consumer) di atas shared memory.
//!
//! Producer = UI/main thread (atau JS langsung lewat `Atomics`).
//! Consumer = audio thread.
//!
//! Sifat yang wajib: **wait-free di sisi consumer**. Kalau ring kosong, audio
//! thread langsung dapat `None` dan lanjut render — ia tidak pernah menunggu
//! siapa pun (docs/01 §1b, "Kenapa `Atomics.wait` HARAM di audio thread").

use core::sync::atomic::{AtomicU32, Ordering};

use crate::layout::{off, CMD_CAPACITY, CMD_ENTRY_SIZE};

/// Satu perintah dari UI ke audio thread. **Persis 16 byte**, `repr(C)`,
/// supaya sisi JS bisa menulisnya dengan `DataView` memakai offset tetap.
///
/// Tata letak (harus cocok dengan `web/src/audio/sab-layout.ts`):
/// ```text
/// +0  u8   op
/// +1  u8   flags
/// +2  u16  target
/// +4  u32  param       (payload f32/u32 di-overlap lewat helper di bawah)
/// +8  u64  at_sample   (0 = ASAP)
/// ```
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Command {
    pub op: u8,
    pub flags: u8,
    pub target: u16,
    pub param: u32,
    pub at_sample: u64,
}

// `at_sample` ada di offset 8 dan bertipe u64, jadi struct-nya align 8 dan
// ukurannya genap 16 — tidak ada padding tersembunyi yang bisa membuat sisi JS
// dan sisi Rust berbeda pandangan.
const _: () = {
    assert!(core::mem::size_of::<Command>() == CMD_ENTRY_SIZE);
    assert!(core::mem::align_of::<Command>() == 8);
};

impl Command {
    pub const fn new(op: u8, target: u16, param: u32, at_sample: u64) -> Self {
        Command {
            op,
            flags: 0,
            target,
            param,
            at_sample,
        }
    }

    /// Baca `param` sebagai `f32` (payload gain/pan/dsb).
    ///
    /// Reinterpretasi bit, bukan konversi — ini union yang disebut docs/01 §1b.
    #[inline(always)]
    pub fn param_f32(&self) -> f32 {
        f32::from_bits(self.param)
    }

    /// Tulis payload `f32` ke `param`.
    #[inline(always)]
    pub fn set_param_f32(&mut self, v: f32) {
        self.param = v.to_bits();
    }
}

impl Default for Command {
    fn default() -> Self {
        Command::new(0, 0, 0, 0)
    }
}

/// Mask index. Kapasitas pangkat dua sudah dipastikan di `layout.rs`, jadi
/// `idx & MASK` adalah modulo yang benar tanpa pembagian.
const MASK: u32 = (CMD_CAPACITY - 1) as u32;

/// Bagian bersama antara producer dan consumer.
///
/// Index disimpan sebagai counter **monoton naik** (tidak di-wrap saat
/// disimpan), baru di-mask saat dipakai sebagai index. Ini yang membuat
/// "kosong" (`w == r`) dan "penuh" (`w - r == CAPACITY`) bisa dibedakan tanpa
/// mengorbankan satu slot — dan `u32` wrap-around tetap benar karena
/// `wrapping_sub` menghitung selisih dengan benar melewati batas.
struct Shared {
    write: *const AtomicU32,
    read: *const AtomicU32,
    data: *mut Command,
}

impl Shared {
    /// # Safety
    /// `base` harus menunjuk ke awal SAB kontrol dengan layout dari
    /// [`crate::layout`], hidup selama program, dan tidak dipindah.
    unsafe fn from_raw(base: *mut u8) -> Self {
        // SAFETY: dijamin pemanggil. Offset-offset ini 4/16-byte aligned
        // menurut const-assert di layout.rs.
        unsafe {
            Shared {
                write: base.add(off::CMD_WRITE_IDX) as *const AtomicU32,
                read: base.add(off::CMD_READ_IDX) as *const AtomicU32,
                data: base.add(off::CMD_DATA) as *mut Command,
            }
        }
    }

    #[inline(always)]
    fn write_idx(&self) -> &AtomicU32 {
        // SAFETY: pointer berasal dari `from_raw` yang kontraknya menjamin
        // validitas seumur hidup program.
        unsafe { &*self.write }
    }

    #[inline(always)]
    fn read_idx(&self) -> &AtomicU32 {
        // SAFETY: sama seperti di atas.
        unsafe { &*self.read }
    }
}

/// Ujung tulis. Dipakai sisi non-RT (main thread Rust); JS juga boleh jadi
/// producer selama ia memakai ordering yang sama.
pub struct SpscProducer {
    s: Shared,
    /// Cache index baca terakhir yang terlihat. Menghindari `load` atomic
    /// setiap kali `push` dipanggil saat ring masih jelas longgar.
    cached_read: u32,
}

// SPSC: masing-masing ujung dipegang tepat satu thread. Memindahkan ujungnya
// antar thread aman; membagikannya tidak (karena itu `Send` tapi bukan `Sync`).
unsafe impl Send for SpscProducer {}
unsafe impl Send for SpscConsumer {}

impl SpscProducer {
    /// # Safety
    /// `base` harus menunjuk ke shared memory dengan layout dari
    /// [`crate::layout`], dan **hanya satu** `SpscProducer` yang boleh ada
    /// untuk `base` tersebut.
    pub unsafe fn from_raw(base: *mut u8) -> Self {
        // SAFETY: kontrak diteruskan ke pemanggil.
        let s = unsafe { Shared::from_raw(base) };
        let cached_read = s.read_idx().load(Ordering::Acquire);
        SpscProducer { s, cached_read }
    }

    /// Jumlah slot yang masih bisa diisi.
    pub fn free_slots(&mut self) -> usize {
        let w = self.s.write_idx().load(Ordering::Relaxed);
        // Acquire: lihat catatan di `push`.
        self.cached_read = self.s.read_idx().load(Ordering::Acquire);
        CMD_CAPACITY - w.wrapping_sub(self.cached_read) as usize
    }

    /// Masukkan satu command. `false` = ring penuh (command **dibuang**,
    /// bukan diblokir — pemanggil yang memutuskan mau retry atau lapor).
    pub fn push(&mut self, cmd: Command) -> bool {
        let w = self.s.write_idx().load(Ordering::Relaxed);
        // Relaxed cukup untuk membaca index kita sendiri: hanya thread ini
        // yang pernah menulisnya, jadi tidak ada yang perlu di-sinkronkan.

        if w.wrapping_sub(self.cached_read) as usize >= CMD_CAPACITY {
            // Cache bilang penuh — cek ulang ke sumbernya.
            //
            // ORDERING: Acquire.
            // Ini pasangan dari `store(Release)` consumer pada `cmd_read_idx`.
            // Tanpa Acquire di sini, producer bisa melihat read_idx sudah maju
            // (slot "bebas") tapi belum tentu melihat bahwa consumer sudah
            // selesai *membaca* payload slot itu — CPU boleh menunda pembacaan
            // consumer melewati store index-nya. Akibatnya producer menimpa
            // slot yang masih dibaca audio thread → command korup.
            self.cached_read = self.s.read_idx().load(Ordering::Acquire);
            if w.wrapping_sub(self.cached_read) as usize >= CMD_CAPACITY {
                return false;
            }
        }

        let slot = (w & MASK) as usize;
        // SAFETY: slot < CMD_CAPACITY, dan `data` menunjuk ke array
        // CMD_CAPACITY entri. Hanya producer yang menulis slot ini, dan slot
        // ini dipastikan bebas oleh pengecekan di atas.
        unsafe {
            self.s.data.add(slot).write(cmd);
        }

        // ORDERING: Release.
        // Ini yang mem-publish payload di atas. Tanpa Release, prosesor/compiler
        // boleh memindahkan store index ke *sebelum* store payload; audio thread
        // lalu melihat index maju, membaca slot, dan mendapat isi lama/sampah.
        // Ini kelas bug paling menyakitkan: benar 99.9% waktu, korup sesekali.
        self.s.write_idx().store(w.wrapping_add(1), Ordering::Release);
        true
    }
}

/// Ujung baca. Dipegang **hanya** oleh audio thread.
pub struct SpscConsumer {
    s: Shared,
    /// Cache index tulis terakhir yang terlihat, supaya `pop` beruntun dalam
    /// satu blok tidak melakukan atomic load berulang kali.
    cached_write: u32,
}

impl SpscConsumer {
    /// # Safety
    /// `base` harus menunjuk ke shared memory dengan layout dari
    /// [`crate::layout`], dan **hanya satu** `SpscConsumer` yang boleh ada
    /// untuk `base` tersebut.
    pub unsafe fn from_raw(base: *mut u8) -> Self {
        // SAFETY: kontrak diteruskan ke pemanggil.
        let s = unsafe { Shared::from_raw(base) };
        SpscConsumer {
            s,
            cached_write: 0,
        }
    }

    /// Ambil satu command, atau `None` kalau kosong.
    ///
    /// **Wait-free**: tidak ada loop tak berbatas, tidak ada blocking, tidak
    /// ada alokasi. Inilah kenapa ia boleh dipanggil dari `render_block`.
    pub fn pop(&mut self) -> Option<Command> {
        let r = self.s.read_idx().load(Ordering::Relaxed);
        // Relaxed: read_idx hanya ditulis oleh thread ini.

        if r == self.cached_write {
            // ORDERING: Acquire.
            // Pasangan dari `store(Release)` producer pada `cmd_write_idx`.
            // Acquire menjamin bahwa setelah kita melihat index maju, semua
            // penulisan producer *sebelum* store itu — yaitu payload command —
            // juga terlihat oleh kita. Tanpa Acquire, kita bisa membaca slot
            // yang belum ter-flush dan memproses sampah sebagai command
            // (mis. `op` acak → efek acak di engine).
            self.cached_write = self.s.write_idx().load(Ordering::Acquire);
            if r == self.cached_write {
                return None;
            }
        }

        let slot = (r & MASK) as usize;
        // SAFETY: slot < CMD_CAPACITY; slot ini berisi command yang sudah
        // di-publish producer (dijamin oleh Acquire di atas).
        let cmd = unsafe { self.s.data.add(slot).read() };

        // ORDERING: Release.
        // Mem-publish "slot ini sudah selesai kubaca, boleh ditimpa". Tanpa
        // Release, store index boleh dipindah ke *sebelum* pembacaan payload
        // di atas; producer lalu menimpa slot yang isinya belum sempat kita
        // baca. Ini adalah sisi cermin dari Release di `push`.
        self.s.read_idx().store(r.wrapping_add(1), Ordering::Release);
        Some(cmd)
    }

    /// Jumlah command yang menunggu (perkiraan; bisa bertambah kapan saja).
    pub fn len(&mut self) -> usize {
        let r = self.s.read_idx().load(Ordering::Relaxed);
        self.cached_write = self.s.write_idx().load(Ordering::Acquire);
        self.cached_write.wrapping_sub(r) as usize
    }

    pub fn is_empty(&mut self) -> bool {
        self.len() == 0
    }

    /// Drain sampai `limit` command atau sampai `f` mengembalikan `false`.
    ///
    /// `limit` ada supaya satu burst command dari UI (mis. load project) tidak
    /// pernah membuat satu callback audio melewati deadline-nya. Sisanya
    /// diproses di blok berikutnya — telat 2.7 ms jauh lebih baik daripada
    /// xrun.
    pub fn drain<F: FnMut(Command) -> bool>(&mut self, limit: usize, mut f: F) -> usize {
        let mut n = 0;
        while n < limit {
            match self.pop() {
                Some(c) => {
                    n += 1;
                    if !f(c) {
                        break;
                    }
                }
                None => break,
            }
        }
        n
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::layout::SAB_SIZE;

    /// Buffer uji dengan alignment yang sama dengan SAB sungguhan.
    #[repr(align(64))]
    struct Sab([u8; SAB_SIZE]);

    fn new_sab() -> Box<Sab> {
        Box::new(Sab([0u8; SAB_SIZE]))
    }

    #[test]
    fn command_is_16_bytes() {
        assert_eq!(core::mem::size_of::<Command>(), 16);
        assert_eq!(core::mem::align_of::<Command>(), 8);
    }

    #[test]
    fn param_f32_roundtrip() {
        let mut c = Command::new(3, 7, 0, 128);
        c.set_param_f32(-0.75);
        assert_eq!(c.param_f32(), -0.75);
    }

    #[test]
    fn push_pop_fifo() {
        let mut sab = new_sab();
        let base = sab.0.as_mut_ptr();
        // SAFETY: satu producer + satu consumer, buffer hidup selama tes.
        let (mut p, mut c) = unsafe { (SpscProducer::from_raw(base), SpscConsumer::from_raw(base)) };

        assert!(c.pop().is_none());
        for i in 0..100u32 {
            assert!(p.push(Command::new(1, i as u16, i, i as u64)));
        }
        for i in 0..100u32 {
            let cmd = c.pop().expect("should have command");
            assert_eq!(cmd.target, i as u16);
            assert_eq!(cmd.param, i);
            assert_eq!(cmd.at_sample, i as u64);
        }
        assert!(c.pop().is_none());
    }

    #[test]
    fn full_ring_rejects_without_blocking() {
        let mut sab = new_sab();
        let base = sab.0.as_mut_ptr();
        // SAFETY: lihat di atas.
        let (mut p, mut c) = unsafe { (SpscProducer::from_raw(base), SpscConsumer::from_raw(base)) };

        for i in 0..CMD_CAPACITY {
            assert!(p.push(Command::new(1, i as u16, 0, 0)), "i = {i}");
        }
        // Penuh → tolak, tidak menunggu.
        assert!(!p.push(Command::new(1, 0, 0, 0)));
        // Satu pop membebaskan tepat satu slot.
        assert!(c.pop().is_some());
        assert!(p.push(Command::new(1, 0xBEEF, 0, 0)));
        assert!(!p.push(Command::new(1, 0, 0, 0)));
    }

    #[test]
    fn wraps_around_many_times() {
        let mut sab = new_sab();
        let base = sab.0.as_mut_ptr();
        // SAFETY: lihat di atas.
        let (mut p, mut c) = unsafe { (SpscProducer::from_raw(base), SpscConsumer::from_raw(base)) };

        for round in 0..10u32 {
            for i in 0..CMD_CAPACITY as u32 {
                assert!(p.push(Command::new(2, 0, round * 10_000 + i, 0)));
            }
            for i in 0..CMD_CAPACITY as u32 {
                assert_eq!(c.pop().unwrap().param, round * 10_000 + i);
            }
        }
    }

    #[test]
    fn drain_respects_limit() {
        let mut sab = new_sab();
        let base = sab.0.as_mut_ptr();
        // SAFETY: lihat di atas.
        let (mut p, mut c) = unsafe { (SpscProducer::from_raw(base), SpscConsumer::from_raw(base)) };

        for i in 0..50u32 {
            p.push(Command::new(1, 0, i, 0));
        }
        let mut seen = Vec::new();
        let n = c.drain(10, |cmd| {
            seen.push(cmd.param);
            true
        });
        assert_eq!(n, 10);
        assert_eq!(seen, (0..10u32).collect::<Vec<_>>());
        assert_eq!(c.len(), 40);
    }

    #[test]
    fn drain_stops_when_callback_returns_false() {
        let mut sab = new_sab();
        let base = sab.0.as_mut_ptr();
        // SAFETY: lihat di atas.
        let (mut p, mut c) = unsafe { (SpscProducer::from_raw(base), SpscConsumer::from_raw(base)) };
        for i in 0..10u32 {
            p.push(Command::new(1, 0, i, 0));
        }
        let n = c.drain(100, |cmd| cmd.param < 3);
        assert_eq!(n, 4); // 0,1,2 lanjut; 3 memutus setelah dikonsumsi
        assert_eq!(c.len(), 6);
    }

    #[test]
    fn cross_thread_spsc() {
        use std::sync::atomic::{AtomicBool, Ordering as O};
        use std::sync::Arc;

        const N: u32 = 200_000;
        let mut sab = new_sab();
        let base = sab.0.as_mut_ptr() as usize;
        let done = Arc::new(AtomicBool::new(false));

        let d2 = done.clone();
        let producer = std::thread::spawn(move || {
            // SAFETY: hanya thread ini yang memegang ujung tulis.
            let mut p = unsafe { SpscProducer::from_raw(base as *mut u8) };
            let mut i = 0u32;
            while i < N {
                if p.push(Command::new(1, 0, i, i as u64)) {
                    i += 1;
                } else {
                    std::hint::spin_loop();
                }
            }
            d2.store(true, O::Release);
        });

        // SAFETY: hanya thread ini yang memegang ujung baca.
        let mut c = unsafe { SpscConsumer::from_raw(base as *mut u8) };
        let mut expect = 0u32;
        while expect < N {
            match c.pop() {
                // Urutan FIFO harus terjaga persis, tanpa duplikat/lompatan.
                Some(cmd) => {
                    assert_eq!(cmd.param, expect);
                    assert_eq!(cmd.at_sample, expect as u64);
                    expect += 1;
                }
                None => std::hint::spin_loop(),
            }
        }
        producer.join().unwrap();
        assert!(done.load(O::Acquire));
        drop(sab);
    }
}
