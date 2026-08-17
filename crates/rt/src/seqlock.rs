//! SeqLock untuk data audio→UI (transport state, meter).
//!
//! # Kenapa SeqLock dan bukan mutex atau double-buffer
//!
//! Pola datanya sangat khas: **satu penulis (audio thread) yang sering, banyak
//! pembaca (UI) yang boleh gagal**. UI menggambar 60×/detik; kalau satu frame
//! membaca meter yang sedang ditulis, ia cukup mengulang beberapa nanodetik
//! kemudian — tidak ada yang hilang. Sebaliknya, audio thread punya deadline
//! keras dan **tidak boleh menunggu siapa pun**.
//!
//! SeqLock memberi persis itu:
//! - **Writer tidak pernah blok.** Ia menaikkan `seq` jadi ganjil, menulis,
//!   lalu menaikkannya jadi genap. Tidak ada kondisi apa pun yang membuatnya
//!   menunggu. Kalau ia menunggu — misalnya karena reader memegang lock —
//!   maka reader (thread prioritas normal, bisa di-preempt OS kapan saja atau
//!   sedang GC) akan menahan audio thread; itu **priority inversion**, penyakit
//!   klasik audio realtime, dan hasilnya dijamin xrun (docs/01 §1b).
//! - **Reader retry.** Baca `seq`, baca data, baca `seq` lagi. Kalau berubah
//!   atau ganjil → ulangi. Reader-lah yang membayar biaya kontensi, dan itu
//!   benar karena reader-lah yang punya kelonggaran waktu.
//!
//! Konsekuensi yang harus diterima: reader bisa gagal berkali-kali kalau writer
//! sangat sering menulis. Karena itu [`SeqReader::read`] punya batas percobaan
//! dan mengembalikan `None` — UI memakai nilai frame sebelumnya. Tidak ada
//! loop tak terbatas di mana pun.

use core::sync::atomic::{fence, AtomicU32, Ordering};

/// Batas percobaan default reader sebelum menyerah untuk frame ini.
pub const DEFAULT_READ_ATTEMPTS: u32 = 64;

/// Ujung tulis — **hanya** audio thread.
///
/// `T: Copy` karena data disalin utuh; tidak ada `Drop` yang bisa jalan di
/// audio thread.
pub struct SeqWriter<T: Copy> {
    seq: *const AtomicU32,
    data: *mut T,
}

/// Ujung baca — UI/worker. Boleh ada banyak.
pub struct SeqReader<T: Copy> {
    seq: *const AtomicU32,
    data: *const T,
}

// Kedua ujung hanya menyimpan pointer ke shared memory; memindahkannya antar
// thread aman. `SeqReader` juga `Sync` karena banyak reader memang diizinkan.
unsafe impl<T: Copy + Send> Send for SeqWriter<T> {}
unsafe impl<T: Copy + Send> Send for SeqReader<T> {}
unsafe impl<T: Copy + Send> Sync for SeqReader<T> {}

impl<T: Copy> SeqWriter<T> {
    /// # Safety
    /// - `seq` harus menunjuk ke `AtomicU32` yang valid & 4-byte aligned.
    /// - `data` harus menunjuk ke `T` yang valid & ter-align, hidup selama
    ///   program.
    /// - **Hanya satu** `SeqWriter` yang boleh ada untuk pasangan pointer ini.
    pub unsafe fn from_raw(seq: *mut u32, data: *mut T) -> Self {
        SeqWriter {
            seq: seq as *const AtomicU32,
            data,
        }
    }

    #[inline(always)]
    fn seq(&self) -> &AtomicU32 {
        // SAFETY: dijamin oleh kontrak `from_raw`.
        unsafe { &*self.seq }
    }

    /// Tulis satu nilai. Tidak pernah menunggu, tidak pernah alokasi.
    ///
    /// Urutan operasinya penting dan mengikuti tabel docs/01 §1b:
    /// 1. `store(seq + 1, Relaxed)` — tandai "sedang ditulis" (ganjil).
    /// 2. `fence(Release)` — cegah penulisan data di bawah dipindah ke *atas*
    ///    penanda ganjil. Tanpa ini, reader bisa melihat `seq` masih genap
    ///    sementara data sudah setengah berubah, dan ia akan menerima data
    ///    robek itu sebagai valid.
    /// 3. tulis data.
    /// 4. `store(seq + 2, Release)` — publikasi. Release di sini memastikan
    ///    semua penulisan data terlihat *sebelum* reader melihat seq genap yang
    ///    baru.
    #[inline]
    pub fn write(&mut self, value: &T) {
        let s = self.seq().load(Ordering::Relaxed);
        // Relaxed cukup: hanya writer ini yang pernah menulis `seq`.
        self.seq().store(s.wrapping_add(1), Ordering::Relaxed);

        // Langkah 2 — lihat doc di atas.
        fence(Ordering::Release);

        // SAFETY: writer tunggal, pointer valid per kontrak `from_raw`.
        // `write_volatile` dipakai supaya compiler tidak menggabungkan atau
        // menghapus penulisan ini (dari sudut pandangnya, tidak ada yang
        // membaca `*self.data`).
        unsafe {
            core::ptr::write_volatile(self.data, *value);
        }

        self.seq().store(s.wrapping_add(2), Ordering::Release);
    }

    /// Nilai `seq` sekarang (untuk diagnostik/tes).
    #[inline]
    pub fn sequence(&self) -> u32 {
        self.seq().load(Ordering::Relaxed)
    }
}

impl<T: Copy> SeqReader<T> {
    /// # Safety
    /// - `seq` dan `data` harus menunjuk ke lokasi yang sama dengan
    ///   [`SeqWriter`] pasangannya dan hidup selama program.
    pub unsafe fn from_raw(seq: *const u32, data: *const T) -> Self {
        SeqReader {
            seq: seq as *const AtomicU32,
            data,
        }
    }

    #[inline(always)]
    fn seq(&self) -> &AtomicU32 {
        // SAFETY: dijamin oleh kontrak `from_raw`.
        unsafe { &*self.seq }
    }

    /// Coba baca dengan batas percobaan default.
    #[inline]
    pub fn read(&self) -> Option<T> {
        self.read_with_attempts(DEFAULT_READ_ATTEMPTS)
    }

    /// Coba baca, maksimal `attempts` kali.
    ///
    /// `None` berarti writer sedang sangat sibuk; pemanggil memakai nilai lama.
    /// Sengaja **tidak** ada varian yang memutar selamanya: kalau writer mati
    /// tepat setelah menaikkan seq jadi ganjil (mis. engine fault), loop tak
    /// terbatas akan membekukan UI juga.
    pub fn read_with_attempts(&self, attempts: u32) -> Option<T> {
        for _ in 0..attempts {
            let s1 = self.seq().load(Ordering::Acquire);
            if s1 & 1 != 0 {
                // Ganjil = writer sedang di tengah penulisan. Jangan dibaca.
                core::hint::spin_loop();
                continue;
            }

            // SAFETY: pointer valid per kontrak; `read_volatile` mencegah
            // compiler meng-cache atau memecah pembacaan ini.
            let v = unsafe { core::ptr::read_volatile(self.data) };

            // Fence Acquire memastikan pembacaan data di atas tidak dipindah
            // ke *bawah* pembacaan `seq` kedua. Tanpa ini, verifikasi seq
            // menjadi tidak berarti: kita bisa memvalidasi seq lalu baru
            // membaca data yang sudah berubah.
            fence(Ordering::Acquire);
            let s2 = self.seq().load(Ordering::Relaxed);

            if s1 == s2 {
                return Some(v);
            }
            core::hint::spin_loop();
        }
        None
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[repr(C, align(64))]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct Meter {
        peak_l: f32,
        peak_r: f32,
        rms_l: f32,
        rms_r: f32,
    }

    struct Cell {
        seq: u32,
        data: Meter,
    }

    fn cell() -> Box<Cell> {
        Box::new(Cell {
            seq: 0,
            data: Meter {
                peak_l: 0.0,
                peak_r: 0.0,
                rms_l: 0.0,
                rms_r: 0.0,
            },
        })
    }

    #[test]
    fn write_then_read() {
        let mut c = cell();
        let seq_ptr = core::ptr::addr_of_mut!(c.seq);
        let data_ptr = core::ptr::addr_of_mut!(c.data);
        // SAFETY: satu writer, satu reader, buffer hidup selama tes.
        let mut w = unsafe { SeqWriter::from_raw(seq_ptr, data_ptr) };
        // SAFETY: menunjuk ke lokasi yang sama dengan writer di atas.
        let r = unsafe { SeqReader::from_raw(seq_ptr as *const u32, data_ptr as *const Meter) };
        let v = Meter {
            peak_l: 0.5,
            peak_r: 0.25,
            rms_l: 0.1,
            rms_r: 0.2,
        };
        w.write(&v);
        assert_eq!(r.read(), Some(v));
        // seq harus genap setelah penulisan selesai.
        assert_eq!(w.sequence() % 2, 0);
        assert_eq!(w.sequence(), 2);
    }

    #[test]
    fn reader_gives_up_on_odd_sequence() {
        let mut c = cell();
        // Simulasikan writer yang berhenti di tengah penulisan.
        c.seq = 1;
        let seq_ptr = core::ptr::addr_of!(c.seq);
        let data_ptr = core::ptr::addr_of!(c.data);
        // SAFETY: pointer valid selama `c` hidup; tidak ada writer aktif.
        let r = unsafe { SeqReader::from_raw(seq_ptr, data_ptr) };
        assert!(r.read_with_attempts(8).is_none());
    }

    #[test]
    fn concurrent_reader_never_sees_torn_value() {
        use std::sync::atomic::{AtomicBool, Ordering as O};
        use std::sync::Arc;

        // Invariant yang diuji: keempat field selalu berasal dari penulisan
        // yang sama (peak_r == peak_l * 2, dst). Nilai yang robek akan
        // melanggar relasi itu.
        let mut c = cell();
        let seq_ptr = core::ptr::addr_of_mut!(c.seq) as usize;
        let data_ptr = core::ptr::addr_of_mut!(c.data) as usize;

        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();

        let writer = std::thread::spawn(move || {
            // SAFETY: hanya thread ini yang memegang ujung tulis.
            let mut w = unsafe { SeqWriter::from_raw(seq_ptr as *mut u32, data_ptr as *mut Meter) };
            let mut i = 0u32;
            while !stop2.load(O::Relaxed) {
                let a = (i % 1000) as f32;
                w.write(&Meter {
                    peak_l: a,
                    peak_r: a * 2.0,
                    rms_l: a * 3.0,
                    rms_r: a * 4.0,
                });
                i = i.wrapping_add(1);
            }
        });

        // SAFETY: reader boleh banyak; hanya membaca.
        let r = unsafe { SeqReader::from_raw(seq_ptr as *const u32, data_ptr as *const Meter) };
        let mut ok = 0usize;
        for _ in 0..200_000 {
            if let Some(v) = r.read() {
                assert_eq!(v.peak_r, v.peak_l * 2.0);
                assert_eq!(v.rms_l, v.peak_l * 3.0);
                assert_eq!(v.rms_r, v.peak_l * 4.0);
                ok += 1;
            }
        }
        stop.store(true, O::Relaxed);
        writer.join().unwrap();
        // Reader harus berhasil setidaknya sekali-sekali; kalau nol, berarti
        // ada yang salah dengan protokolnya, bukan sekadar kontensi.
        assert!(ok > 0);
    }
}
