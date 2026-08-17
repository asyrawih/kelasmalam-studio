//! Bukti bahwa primitif RT tidak mengalokasi.
//!
//! Jalankan dengan: `cargo test -p daw-rt --features rt-guard --test no_alloc`
//!
//! Tes ini memasang [`RtGuardAlloc`] sebagai global allocator untuk seluruh
//! binary tes, lalu menjalankan operasi-operasi yang di produksi berada di
//! dalam `render_block` di dalam `rt_section!`. Kalau salah satunya
//! mengalokasi — sekarang atau setelah refactor kapan pun di masa depan —
//! allocator akan panic dan tes ini merah.

#![cfg(feature = "rt-guard")]

use daw_rt::rt_guard::RtGuardAlloc;
use daw_rt::{rt_section, Command, Pool, SeqWriter, SpscConsumer, SpscProducer};

#[global_allocator]
static ALLOC: RtGuardAlloc<std::alloc::System> = RtGuardAlloc::new(std::alloc::System);

#[repr(align(64))]
struct Sab([u8; daw_rt::SAB_SIZE]);

#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct Voice {
    pos: u64,
    gain: f32,
    done: bool,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct MeterFrame {
    peak_l: f32,
    peak_r: f32,
    rms_l: f32,
    rms_r: f32,
    gain_reduction_db: f32,
    clip_hold_frames: u32,
    _pad: u64,
}

#[test]
fn ring_pop_does_not_allocate() {
    // Semua alokasi terjadi DI LUAR section — ini fase init engine.
    let mut sab = Box::new(Sab([0u8; daw_rt::SAB_SIZE]));
    let base = sab.0.as_mut_ptr();
    // SAFETY: satu producer + satu consumer untuk base ini, hidup selama tes.
    let mut prod = unsafe { SpscProducer::from_raw(base) };
    // SAFETY: idem.
    let mut cons = unsafe { SpscConsumer::from_raw(base) };

    for i in 0..256u32 {
        assert!(prod.push(Command::new(1, i as u16, i, i as u64)));
    }

    let popped = rt_section! {
        let mut n = 0usize;
        // `drain` dengan limit — bentuk yang persis dipakai engine di awal
        // setiap blok.
        n += cons.drain(64, |_cmd| true);
        while cons.pop().is_some() {
            n += 1;
        }
        n
    };
    assert_eq!(popped, 256);
}

#[test]
fn pool_operations_do_not_allocate() {
    let mut pool: Pool<Voice, 256> = Pool::new(); // alokasi struct: di luar section

    rt_section! {
        for i in 0..256u64 {
            let h = pool.alloc_with(Voice { pos: i, gain: 1.0, done: i % 3 == 0 })
                .expect("pool harus muat 256");
            let _ = pool.get(h);
        }
        // Iterasi + mutasi + panen — persis yang dilakukan render_block.
        pool.for_each_active(|_, v| { v.pos += 128; });
        let mut live = 0usize;
        for _h in pool.iter_active() { live += 1; }
        assert_eq!(live, 256);
        pool.retain(|_, v| !v.done);
        pool.clear();
    }

    assert_eq!(pool.len(), 0);
    assert_eq!(pool.free_count(), 256);
}

#[test]
fn seqlock_write_does_not_allocate() {
    let mut seq = Box::new(0u32);
    let mut data = Box::new(MeterFrame::default());
    let seq_ptr: *mut u32 = &mut *seq;
    let data_ptr: *mut MeterFrame = &mut *data;
    // SAFETY: satu writer untuk pasangan pointer ini, hidup selama tes.
    let mut w = unsafe { SeqWriter::from_raw(seq_ptr, data_ptr) };

    rt_section! {
        for i in 0..1000u32 {
            w.write(&MeterFrame {
                peak_l: i as f32 * 0.001,
                peak_r: i as f32 * 0.002,
                ..Default::default()
            });
        }
    }
    assert_eq!(*seq, 2000);
}

/// Tes negatif: guard-nya sendiri harus benar-benar mendeteksi alokasi.
/// Kalau tes ini hijau padahal `expected` tidak terjadi, guard-nya bohong dan
/// semua tes di atas jadi tidak bernilai.
#[test]
#[should_panic(expected = "rt_section")]
fn guard_actually_catches_allocation() {
    rt_section! {
        let v: Vec<u8> = Vec::with_capacity(1024);
        std::hint::black_box(&v);
    }
}
