//! Tes engine: null test ukuran blok, zero-alloc di jalur render, dan bukti
//! micro-fade menghilangkan diskontinuitas tepi clip.

use super::*;
use crate::snapshot::{BusDesc, ClipDesc, SendDesc, TrackDesc};

/// Asset uji: gelombang gigi gergaji + DC, sengaja TIDAK melewati nol di tepi
/// supaya tepi clip benar-benar diskontinu tanpa micro-fade.
fn make_asset(frames: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(frames * 2);
    for c in 0..2 {
        for i in 0..frames {
            // DC offset 0.5 + sinus halus: interiornya mulus, tapi TEPI clip
            // (dari senyap ke 0.9) benar-benar diskontinu tanpa micro-fade.
            let ph = i as f32 / 48_000.0 * 220.0 * core::f32::consts::TAU;
            v.push(0.5 + 0.4 * ph.sin() + c as f32 * 0.01);
        }
    }
    v
}

struct Fixture {
    engine: Engine,
    _pcm: Vec<f32>,
}

fn build(tracks: usize, with_fx: bool, sends: bool, max_frames: usize) -> Fixture {
    let frames = 96_000;
    let pcm = make_asset(frames);
    let mut p = Project {
        sample_rate: 48_000,
        ..Default::default()
    };
    p.buses.push(BusDesc::default()); // 0 = master
    if sends {
        p.buses.push(BusDesc {
            dest: Some(0),
            ..Default::default()
        });
        p.buses.push(BusDesc {
            dest: Some(0),
            ..Default::default()
        });
    }
    for t in 0..tracks {
        let mut td = TrackDesc {
            gain_db: -6.0,
            pan: (t as f32 / tracks as f32) * 2.0 - 1.0,
            dest_bus: 0,
            ..Default::default()
        };
        if with_fx {
            for (i, b) in td.eq.iter_mut().enumerate() {
                b.enabled = true;
                b.freq_hz = 120.0 * (i as f32 + 1.0) * 3.0;
                b.gain_db = 2.0;
                b.q = 0.9;
            }
            td.comp.enabled = true;
        }
        if sends {
            td.sends.push(SendDesc {
                bus: 1,
                amount: 0.2,
            });
            td.sends.push(SendDesc {
                bus: 2,
                amount: 0.1,
            });
        }
        p.tracks.push(td);
        // Dua clip berurutan dengan sedikit celah → dua tepi masuk & dua keluar.
        p.clips.push(ClipDesc {
            track: t as u16,
            asset: 0,
            start: 1000 + t as u64 * 37,
            len: 20_000,
            offset: 0,
            gain_db: 0.0,
            ..Default::default()
        });
        p.clips.push(ClipDesc {
            track: t as u16,
            asset: 0,
            start: 30_000 + t as u64 * 11,
            len: 20_000,
            offset: 5_000,
            gain_db: -3.0,
            ..Default::default()
        });
    }

    let mut engine = Engine::new(48_000, max_frames);
    // SAFETY: `pcm` hidup selama `Fixture` hidup, dan tidak pernah dimutasi.
    unsafe {
        engine.register_asset(
            0,
            Asset {
                data: pcm.as_ptr(),
                frames,
                channels: 2,
                sample_rate: 48_000,
            },
        );
    }
    engine.load_project(p).expect("plan valid");
    engine.play();
    Fixture { engine, _pcm: pcm }
}

fn render_all(f: &mut Fixture, total: usize, block: usize) -> (Vec<f32>, Vec<f32>) {
    let mut l = Vec::new();
    let mut r = Vec::new();
    l.resize(total, 0.0);
    r.resize(total, 0.0);
    let mut off = 0;
    while off < total {
        let n = block.min(total - off);
        let (bl, br) = (&mut l[off..off + n], &mut r[off..off + n]);
        f.engine.render_block(bl, br);
        off += n;
    }
    (l, r)
}

/// NULL TEST: blok 128 vs blok 1024 harus menghasilkan output identik.
/// Ini yang membuktikan sub-blok split benar-benar sample-accurate — clip start
/// dan event tidak "menempel" ke batas blok.
#[test]
fn null_test_block_size_invariance_pure_mix() {
    let total = 64_000;
    let (a_l, a_r) = render_all(&mut build(8, false, true, 1024), total, 128);
    let (b_l, b_r) = render_all(&mut build(8, false, true, 1024), total, 1024);
    for i in 0..total {
        assert_eq!(a_l[i], b_l[i], "L mismatch @{i}");
        assert_eq!(a_r[i], b_r[i], "R mismatch @{i}");
    }
}

/// Versi dengan EQ + kompresor. Toleransi kecil (bukan nol) DISENGAJA: guard
/// denormal di-flush sekali per blok (docs/02 §2b), jadi titik flush-nya berbeda
/// antara 128 dan 1024 frame. Selisihnya berada di level denormal (~1e-30),
/// jauh di bawah LSB 24-bit; yang tidak boleh terjadi adalah pergeseran waktu.
#[test]
fn null_test_block_size_invariance_with_fx() {
    let total = 64_000;
    let (a_l, a_r) = render_all(&mut build(8, true, true, 1024), total, 128);
    let (b_l, b_r) = render_all(&mut build(8, true, true, 1024), total, 1024);
    for i in 0..total {
        assert!(
            (a_l[i] - b_l[i]).abs() < 1e-6,
            "L @{i}: {} {}",
            a_l[i],
            b_l[i]
        );
        assert!(
            (a_r[i] - b_r[i]).abs() < 1e-6,
            "R @{i}: {} {}",
            a_r[i],
            b_r[i]
        );
    }
}

/// Micro-fade otomatis di setiap tepi clip: tidak boleh ada lompatan
/// sample-ke-sample yang besar di sekitar batas clip.
#[test]
fn clip_edges_have_no_discontinuity() {
    let mut f = build(1, false, false, 512);
    let total = 60_000;
    let (l, _r) = render_all(&mut f, total, 512);

    // 3 ms micro-fade @48k = 144 sample → lompatan maksimum per sample kira-kira
    // amplitudo/144. Ambang 0.02 memberi margin besar tapi tetap menangkap
    // klik sungguhan (tepi tanpa fade akan melompat ~0.45).
    const THRESHOLD: f32 = 0.02;
    let mut worst = 0.0f32;
    let mut worst_at = 0usize;
    for i in 1..total {
        let d = (l[i] - l[i - 1]).abs();
        if d > worst {
            worst = d;
            worst_at = i;
        }
    }
    assert!(
        worst < THRESHOLD,
        "diskontinuitas {worst} di sample {worst_at} — micro-fade tidak bekerja"
    );
    // Dan pastikan tesnya bermakna: memang ada audio.
    assert!(l.iter().any(|x| x.abs() > 0.05));
}

/// Penjaga alokasi dari daw-rt: allocator pembungkus yang mencatat/meledak
/// kalau ada alokasi ATAU dealloc di dalam `rt_section!`.
#[cfg(feature = "rt-guard")]
#[global_allocator]
static ALLOC: daw_rt::rt_guard::RtGuardAlloc<std::alloc::System> =
    daw_rt::rt_guard::RtGuardAlloc::new(std::alloc::System);

/// Jalur render 32 track PENUH (EQ + kompresor + 2 send) tidak boleh
/// mengalokasi maupun men-dealloc sama sekali.
/// Jalankan: `cargo test -p daw-engine --features rt-guard`.
#[test]
#[cfg(feature = "rt-guard")]
fn render_block_does_not_allocate() {
    let mut f = build(daw_rt::MAX_TRACKS, true, true, 128);
    let mut l = alloc::vec![0.0f32; 128];
    let mut r = alloc::vec![0.0f32; 128];
    // Blok pemanasan DI LUAR penjaga: di sinilah plan baru di-swap dan voice
    // pertama dinyalakan, dan `Engine::new` memang boleh mengalokasi.
    for _ in 0..4 {
        f.engine.render_block(&mut l, &mut r);
    }

    daw_rt::rt_guard::reset_violations();
    daw_rt::rt_section! {
        for _ in 0..200 {
            f.engine.render_block(&mut l, &mut r);
        }
    }
    assert_eq!(daw_rt::rt_guard::violations(), 0);
}

/// Snapshot → engine kedua (jalur export) harus menghasilkan audio yang sama
/// persis dengan engine pertama. Ini yang membuat export deterministik.
#[test]
fn snapshot_roundtrip_renders_identically() {
    let mut a = build(4, true, true, 256);
    let bytes = a.engine.snapshot().unwrap();

    let frames = 96_000;
    let pcm = make_asset(frames);
    let mut b = Engine::from_snapshot(&bytes, 48_000).unwrap();
    // SAFETY: `pcm` hidup sampai akhir tes.
    unsafe {
        b.register_asset(
            0,
            Asset {
                data: pcm.as_ptr(),
                frames,
                channels: 2,
                sample_rate: 48_000,
            },
        );
    }
    b.play();

    let total = 16_000;
    let (a_l, _) = render_all(&mut a, total, 256);
    let mut bl = alloc::vec![0.0f32; total];
    let mut br = alloc::vec![0.0f32; total];
    let mut off = 0;
    while off < total {
        let n = 256.min(total - off);
        b.render_block(&mut bl[off..off + n], &mut br[off..off + n]);
        off += n;
    }
    for i in 0..total {
        assert!((a_l[i] - bl[i]).abs() < 1e-6, "@{i}");
    }
}

#[test]
fn loop_wrap_returns_to_loop_start() {
    let mut f = build(1, false, false, 128);
    f.engine.transport.loop_range = Some((0, 5_000));
    f.engine.loop_enabled = true;
    f.engine.seek(TimelineSample(4_900));
    f.engine.play();
    let mut l = alloc::vec![0.0f32; 256];
    let mut r = alloc::vec![0.0f32; 256];
    f.engine.render_block(&mut l, &mut r);
    assert!(
        f.engine.transport().playhead < 5_000,
        "playhead = {}",
        f.engine.transport().playhead
    );
}

#[test]
fn retired_plans_are_dropped_off_the_render_thread() {
    let mut f = build(2, false, false, 128);
    let p = f.engine.project().clone();
    let plan = crate::graph::build_plan(&p, 99).unwrap();
    f.engine.install_plan(plan).ok();
    let mut l = alloc::vec![0.0f32; 128];
    let mut r = alloc::vec![0.0f32; 128];
    f.engine.render_block(&mut l, &mut r);
    assert_eq!(f.engine.plan().generation, 99);
    // Plan lama menunggu diambil sisi non-RT — bukan di-drop di render_block.
    assert!(f.engine.take_retired().is_some());
}
