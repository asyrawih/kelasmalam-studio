//! Benchmark gate CI (docs/01 §1c §4): 32 track stereo dengan EQ 4-band +
//! kompresor dan 2 send, blok 128 frame.
//!
//! Target spesifikasi: < 1.3 ms per blok di WASM. Native ≈ 2–4× lebih cepat,
//! jadi target native ~0.4–0.5 ms. Regresi > 10% = build merah.

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use daw_engine::snapshot::{BusDesc, ClipDesc, Project, SendDesc, TrackDesc};
use daw_engine::voice::Asset;
use daw_engine::Engine;
use daw_rt::MAX_TRACKS;

const SR: u32 = 48_000;
const BLOCK: usize = 128;

fn asset_pcm(frames: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(frames * 2);
    for c in 0..2 {
        for i in 0..frames {
            let ph = (i as f32 / SR as f32) * 220.0 * (1.0 + c as f32 * 0.01);
            v.push((ph * core::f32::consts::TAU).sin() * 0.3);
        }
    }
    v
}

fn target_project() -> Project {
    let mut p = Project {
        sample_rate: SR,
        ..Default::default()
    };
    p.buses.push(BusDesc::default()); // master
    p.buses.push(BusDesc {
        dest: Some(0),
        ..Default::default()
    }); // reverb send
    p.buses.push(BusDesc {
        dest: Some(0),
        ..Default::default()
    }); // delay send

    for t in 0..MAX_TRACKS {
        let mut td = TrackDesc {
            gain_db: -12.0,
            pan: (t as f32 / MAX_TRACKS as f32) * 2.0 - 1.0,
            dest_bus: 0,
            ..Default::default()
        };
        for (i, b) in td.eq.iter_mut().enumerate() {
            b.enabled = true;
            b.kind = [2u8, 4, 4, 3][i];
            b.freq_hz = [80.0, 400.0, 2500.0, 9000.0][i];
            b.q = 0.8;
            b.gain_db = 2.5;
        }
        td.comp.enabled = true;
        td.comp.threshold_db = -20.0;
        td.comp.ratio = 4.0;
        td.sends.push(SendDesc {
            bus: 1,
            amount: 0.25,
        });
        td.sends.push(SendDesc {
            bus: 2,
            amount: 0.15,
        });
        p.tracks.push(td);
        p.clips.push(ClipDesc {
            track: t as u16,
            asset: 0,
            start: 0,
            len: 48_000 * 60,
            offset: 0,
            gain_db: 0.0,
            ..Default::default()
        });
    }
    p
}

fn bench_render(c: &mut Criterion) {
    let frames = 48_000;
    let pcm = asset_pcm(frames);
    let mut engine = Engine::new(SR, BLOCK);
    // SAFETY: `pcm` hidup selama benchmark berjalan.
    unsafe {
        engine.register_asset(
            0,
            Asset {
                data: pcm.as_ptr(),
                frames,
                channels: 2,
                sample_rate: SR,
            },
        );
    }
    engine.load_project(target_project()).expect("plan valid");
    engine.play();

    let mut out_l = vec![0.0f32; BLOCK];
    let mut out_r = vec![0.0f32; BLOCK];
    // Pemanasan: plan baru di-swap di blok pertama, dan envelope/IIR mencapai
    // steady-state — supaya angka benchmark bukan angka blok dingin.
    for _ in 0..1000 {
        engine.render_block(&mut out_l, &mut out_r);
    }

    let plan = engine.plan();
    println!(
        "plan: {} step, {} scratch stereo ({} KiB @{} frame)",
        plan.steps.len(),
        plan.buffer_count,
        plan.buffer_count as usize * 2 * BLOCK * 4 / 1024,
        BLOCK
    );

    let mut group = c.benchmark_group("render_block");
    group.throughput(criterion::Throughput::Elements(BLOCK as u64));
    group.bench_function("32tracks_eq_comp_2sends_128", |b| {
        b.iter_batched_ref(
            || (),
            |_| {
                engine.render_block(&mut out_l, &mut out_r);
                criterion::black_box(out_l[0])
            },
            BatchSize::SmallInput,
        )
    });
    group.finish();

    // Angka yang dibandingkan dengan budget 2.67 ms per blok (128 @ 48 kHz).
    println!("budget realtime per blok 128 @48k = 2.667 ms; target WASM < 1.3 ms");
}

criterion_group!(benches, bench_render);
criterion_main!(benches);
