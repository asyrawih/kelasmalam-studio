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
    // Rak ikut dipensiunkan bersama plan: panjangnya ikut project, jadi ia
    // juga tidak boleh di-drop di audio thread.
    let rack = crate::fx::FxRack::new(crate::graph::TOTAL_UNITS, 48_000.0);
    f.engine.install_config(RenderConfig { plan, rack }).ok();
    let mut l = alloc::vec![0.0f32; 128];
    let mut r = alloc::vec![0.0f32; 128];
    f.engine.render_block(&mut l, &mut r);
    assert_eq!(f.engine.plan().generation, 99);
    // Plan lama menunggu diambil sisi non-RT — bukan di-drop di render_block.
    assert!(f.engine.take_retired().is_some());
}

// ── Blok parameter ────────────────────────────────────────────────────────

use crate::fx::params;

/// Blok param penuh NaN, seperti keadaannya sebelum UI menyentuh apa pun.
fn empty_param_block() -> Vec<f32> {
    alloc::vec![f32::NAN; daw_rt::layout::PARAM_SLOTS]
}

fn rms(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let s: f64 = v.iter().map(|x| (*x as f64) * (*x as f64)).sum();
    (s / v.len() as f64).sqrt() as f32
}

/// INI tes yang menahan bug paling mahal di jalur ini.
///
/// `commitParams()` menulis SELURUH 2048 slot tiap terbit, bukan hanya yang
/// berubah. Kalau slot yang belum pernah disentuh diperlakukan sebagai nilai
/// yang sah, maka drag pertama pada SATU fader akan menyetel gain semua track
/// dan bus ke nol — seluruh project langsung senyap, dan penyebabnya tidak
/// terlihat di mana pun.
#[test]
fn untouched_param_slots_change_nothing() {
    let mut a = build(4, true, true, 128);
    let mut b = build(4, true, true, 128);

    let (al, ar) = render_all(&mut a, 8192, 128);

    b.engine.latch_params(&empty_param_block());
    let (bl, br) = render_all(&mut b, 8192, 128);

    assert_eq!(al, bl, "slot kosong mengubah kanal kiri");
    assert_eq!(ar, br, "slot kosong mengubah kanal kanan");
}

/// Dan ini yang membuktikan bug-nya benar-benar diperbaiki: sebelum ada
/// konsumen blok param di Rust, `setFaderLive` menulis ke SAB dan nilainya
/// dibuang — menggeser fader saat berbunyi tidak mengubah apa pun.
#[test]
fn param_block_gain_actually_changes_the_audio() {
    let mut base = build(1, false, false, 128);
    let (bl, _) = render_all(&mut base, 8192, 128);

    let mut quiet = build(1, false, false, 128);
    let mut block = empty_param_block();
    block[params::track_gain_slot(0)] = 0.1;
    quiet.engine.latch_params(&block);
    let (ql, _) = render_all(&mut quiet, 8192, 128);

    // Diukur setelah smoother 5 ms settle, jadi yang dibandingkan level tetap.
    let a = rms(&bl[4096..]);
    let q = rms(&ql[4096..]);
    assert!(a > 1.0e-4, "referensi senyap, tes tidak bermakna");
    assert!(q < a * 0.5, "gain tidak diterapkan: {a} -> {q}");
}

/// Nol adalah gain yang SAH. Kalau ia dipakai sebagai penanda "slot kosong",
/// user tidak akan pernah bisa menarik fader sampai habis.
#[test]
fn zero_is_a_real_gain_not_an_empty_marker() {
    let mut f = build(1, false, false, 128);
    let mut block = empty_param_block();
    block[params::track_gain_slot(0)] = 0.0;
    f.engine.latch_params(&block);
    let (l, r) = render_all(&mut f, 8192, 128);
    assert!(rms(&l[4096..]) < 1.0e-5, "gain 0 tidak menyenyapkan kiri");
    assert!(rms(&r[4096..]) < 1.0e-5, "gain 0 tidak menyenyapkan kanan");
}

/// Master punya slotnya sendiri di ujung atas blok DAN slot bus biasa, karena
/// master memang sebuah bus. Yang dikemudikan UI adalah slot master, jadi ia
/// yang harus menang.
#[test]
fn master_slot_wins_over_the_bus_slot() {
    let mut f = build(1, false, false, 128);
    let mut block = empty_param_block();
    block[params::bus_gain_slot(0)] = 1.0;
    block[params::MASTER_PARAM_GAIN] = 0.0;
    f.engine.latch_params(&block);
    let (l, _) = render_all(&mut f, 8192, 128);
    assert!(rms(&l[4096..]) < 1.0e-5, "slot master kalah oleh slot bus");
}

/// Nilai yang masuk harus di-ramp, bukan dipasang langsung — kalau langsung,
/// menggeser fader cepat terdengar sebagai deretan klik.
#[test]
fn gain_changes_ramp_instead_of_stepping() {
    let mut f = build(1, false, false, 128);
    render_all(&mut f, 4096, 128);

    let mut block = empty_param_block();
    block[params::track_gain_slot(0)] = 0.0;
    f.engine.latch_params(&block);

    let (l, _) = render_all(&mut f, 512, 128);
    // Kalau gain dipasang langsung, sample pertama sesudahnya sudah nol dan
    // lompatannya besar. Dengan ramp, penurunannya bertahap.
    let head = rms(&l[..64]);
    let tail = rms(&l[448..]);
    assert!(head > tail, "tidak turun sama sekali: {head} -> {tail}");
    assert!(head > 1.0e-4, "turun seketika, bukan di-ramp: {head}");
}

// ── Insert chain user (track & master) ────────────────────────────────────

use crate::snapshot::FxSlotDesc;

/// RMS setelah rerata dibuang.
///
/// Aset uji sengaja ber-DC 0.5 (lihat `make_asset`), jadi RMS polos didominasi
/// komponen DC dan nyaris tidak bergerak walau lowpass memotong seluruh nada.
/// Yang menunjukkan kerja filter adalah energi AC-nya.
fn ac_rms(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mean = v.iter().map(|x| *x as f64).sum::<f64>() / v.len() as f64;
    let s: f64 = v.iter().map(|x| (*x as f64 - mean).powi(2)).sum();
    (s / v.len() as f64).sqrt() as f32
}

/// Parameter EQ dengan band 1 sebagai lowpass tajam, sisanya mati.
/// Urutannya mengikuti `Eq4::DESC.params`: [kind, freq, q, gain, on] × 4.
fn eq_lowpass_params(freq: f32) -> Vec<f32> {
    let mut v = alloc::vec![0.0f32; 20];
    v[0] = 0.0; // LowPass
    v[1] = freq;
    v[2] = 0.707;
    v[3] = 0.0;
    v[4] = 1.0; // on
    for b in 1..4 {
        let o = b * 5;
        v[o] = 4.0; // Peaking
        v[o + 1] = 1_000.0;
        v[o + 2] = 0.707;
        v[o + 3] = 0.0;
        v[o + 4] = 0.0; // off
    }
    v
}

fn with_track_chain(chain: Vec<FxSlotDesc>) -> Fixture {
    let mut f = build(1, false, false, 128);
    let mut p = f.engine.project().clone();
    p.tracks[0].chain = chain;
    f.engine.load_project(p).expect("plan valid");
    f.engine.play();
    f
}

fn with_master_chain(chain: Vec<FxSlotDesc>) -> Fixture {
    let mut f = build(1, false, false, 128);
    let mut p = f.engine.project().clone();
    p.buses[0].chain = chain;
    f.engine.load_project(p).expect("plan valid");
    f.engine.play();
    f
}

/// Chain yang ter-mapping dengan benar tapi tidak pernah DIEKSEKUSI
/// menghasilkan audio yang valid sempurna dan tidak terfilter sempurna —
/// tidak ada error di mana pun. Ini tes yang membuat `Step::Fx` yang kelewat
/// jadi terlihat.
#[test]
fn a_track_chain_actually_changes_the_audio() {
    let mut plain = with_track_chain(Vec::new());
    let (pl, _) = render_all(&mut plain, 8192, 128);

    let mut filtered = with_track_chain(alloc::vec![FxSlotDesc {
        kind: 0, // EQ
        bypass: false,
        params: eq_lowpass_params(120.0),
    }]);
    let (fl, _) = render_all(&mut filtered, 8192, 128);

    let a = ac_rms(&pl[4096..]);
    let b = ac_rms(&fl[4096..]);
    assert!(a > 1.0e-3, "referensi senyap, tes tidak bermakna");
    assert!(
        b < a * 0.5,
        "lowpass 120 Hz pada materi 220 Hz tidak mengubah apa pun: {a} -> {b}"
    );
}

/// Master adalah bus, jadi master FX lewat jalur emisi yang sama persis.
#[test]
fn a_master_chain_actually_changes_the_audio() {
    let mut plain = with_master_chain(Vec::new());
    let (pl, _) = render_all(&mut plain, 8192, 128);

    let mut filtered = with_master_chain(alloc::vec![FxSlotDesc {
        kind: 0,
        bypass: false,
        params: eq_lowpass_params(120.0),
    }]);
    let (fl, _) = render_all(&mut filtered, 8192, 128);

    let a = ac_rms(&pl[4096..]);
    let b = ac_rms(&fl[4096..]);
    assert!(a > 1.0e-3);
    assert!(b < a * 0.5, "master chain tidak dieksekusi: {a} -> {b}");
}

/// Efek yang dipasang dalam keadaan bypass harus melewatkan sinyal apa adanya.
#[test]
fn a_bypassed_chain_effect_passes_signal_through() {
    let mut plain = with_track_chain(Vec::new());
    let (pl, _) = render_all(&mut plain, 8192, 128);

    let mut bypassed = with_track_chain(alloc::vec![FxSlotDesc {
        kind: 0,
        bypass: true,
        params: eq_lowpass_params(120.0),
    }]);
    let (bl, _) = render_all(&mut bypassed, 8192, 128);

    let a = ac_rms(&pl[4096..]);
    let b = ac_rms(&bl[4096..]);
    assert!(
        (a - b).abs() < a * 0.02,
        "bypass tidak transparan: {a} vs {b}"
    );
}

/// Chain kosong tidak boleh mengubah apa pun — kalau berubah, berarti ada node
/// yang diemit padahal tidak ada efek terpasang.
#[test]
fn an_empty_chain_is_bit_identical_to_no_chain() {
    let mut a = build(2, true, true, 128);
    let (al, ar) = render_all(&mut a, 4096, 128);

    let mut b = build(2, true, true, 128);
    let p = b.engine.project().clone();
    b.engine.load_project(p).expect("plan valid");
    b.engine.play();
    let (bl, br) = render_all(&mut b, 4096, 128);

    assert_eq!(al, bl);
    assert_eq!(ar, br);
}

/// Invarian yang menjadi alasan `plan_chains` ada: plan dan rak harus sepakat
/// soal penomoran node. Kalau tidak, `Step::Fx { node }` menjalankan efek yang
/// berbeda dari yang dimaksud — tanpa error apa pun.
#[test]
fn the_plan_and_the_rack_agree_on_node_numbering() {
    let chain = alloc::vec![
        FxSlotDesc { kind: 0, bypass: false, params: eq_lowpass_params(500.0) },
        FxSlotDesc { kind: 1, bypass: false, params: alloc::vec![-24.0, 8.0, 6.0, 10.0, 120.0, 0.0, 0.0, 0.0, 1.0] },
    ];
    let mut f = with_track_chain(chain);
    // `install_config` menunda swap ke awal blok berikutnya, jadi konfigurasi
    // baru belum terpasang sampai satu blok benar-benar dirender.
    render_all(&mut f, 128, 128);

    let layout = crate::fx::plan_chains(f.engine.project()).unwrap();
    assert_eq!(layout.entries.len(), 2);

    // Tiap node yang disebut plan harus ada di rak.
    let rack_len = f.engine.rack().len();
    assert_eq!(rack_len, layout.total_nodes());
    for step in f.engine.plan().steps.iter() {
        if let crate::plan::Step::Fx { node, .. } = *step {
            assert!(
                (node as usize) < rack_len,
                "plan menyebut node {node}, rak cuma punya {rack_len}"
            );
        }
    }
    // Dan tiap entri chain harus benar-benar diemit sebagai step.
    for e in &layout.entries {
        assert!(
            f.engine.plan().steps.iter().any(
                |s| matches!(*s, crate::plan::Step::Fx { node, .. } if node == e.node)
            ),
            "entri chain node {} tidak pernah diemit",
            e.node
        );
    }
}

/// Chain harus selamat lewat postcard — kalau tidak, apa yang di-export berbeda
/// dari apa yang dimuat.
#[test]
fn chains_survive_a_postcard_roundtrip() {
    let f = with_track_chain(alloc::vec![FxSlotDesc {
        kind: 0,
        bypass: true,
        params: eq_lowpass_params(333.0),
    }]);
    let p = f.engine.project().clone();
    let bytes = p.to_bytes().expect("serialisasi");
    let back = Project::from_bytes(&bytes).expect("deserialisasi");
    assert_eq!(p, back);
    assert_eq!(back.tracks[0].chain.len(), 1);
    assert!(back.tracks[0].chain[0].bypass);
    assert_eq!(back.tracks[0].chain[0].params.len(), 20);
}
