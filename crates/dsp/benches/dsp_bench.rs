//! Benchmark criterion untuk blok DSP yang ada di jalur render.
//!
//! Angka native bukan angka WASM (WASM biasanya 2–4× lebih lambat), tapi
//! benchmark ini dipakai sebagai **gate regresi** di CI: naik >10% = build
//! merah (docs/01 §1c).

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use daw_dsp::{
    add_scaled, add_scaled_ramp, copy_scaled, peak, rms, Biquad, Coeffs, CompParams, Compressor,
    Detector, FilterKind, FracCursor, Smoother,
};

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;

fn make_signal(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SR).sin() * 0.5)
        .collect()
}

fn bench_biquad(c: &mut Criterion) {
    let mut g = c.benchmark_group("biquad");
    for &n in &[128usize, 1024] {
        g.throughput(Throughput::Elements(n as u64));
        g.bench_with_input(BenchmarkId::new("process", n), &n, |b, &n| {
            let co = Coeffs::design(FilterKind::Peaking, SR, 1_000.0, 1.0, 6.0);
            let mut bq = Biquad::new();
            let sig = make_signal(n);
            let mut buf = sig.clone();
            b.iter(|| {
                buf.copy_from_slice(&sig);
                bq.process(black_box(&mut buf), black_box(&co));
            });
        });
    }
    // Rantai 4 band × 2 channel — bentuk EQ track sebenarnya.
    g.bench_function("eq4_stereo_128", |b| {
        let coeffs = [
            Coeffs::design(FilterKind::HighPass, SR, 80.0, 0.707, 0.0),
            Coeffs::design(FilterKind::LowShelf, SR, 200.0, 0.707, 3.0),
            Coeffs::design(FilterKind::Peaking, SR, 1_000.0, 1.4, -4.0),
            Coeffs::design(FilterKind::HighShelf, SR, 8_000.0, 0.707, 2.0),
        ];
        let mut bq = [[Biquad::new(); 4]; 2];
        let sig = make_signal(BLOCK);
        let mut l = sig.clone();
        let mut r = sig.clone();
        b.iter(|| {
            l.copy_from_slice(&sig);
            r.copy_from_slice(&sig);
            for (band, co) in coeffs.iter().enumerate() {
                bq[0][band].process(&mut l, co);
                bq[1][band].process(&mut r, co);
            }
            black_box((&l, &r));
        });
    });
    g.finish();
}

fn bench_compressor(c: &mut Criterion) {
    let mut g = c.benchmark_group("compressor");
    for det in [Detector::Peak, Detector::Rms] {
        let name = if det == Detector::Peak { "peak" } else { "rms" };
        g.throughput(Throughput::Elements(BLOCK as u64));
        g.bench_function(name, |b| {
            let mut comp = Compressor::new(SR);
            comp.set_params(&CompParams {
                threshold_db: -18.0,
                ratio: 4.0,
                knee_db: 6.0,
                attack_ms: 5.0,
                release_ms: 80.0,
                makeup_db: 3.0,
                detector: det,
                auto_makeup: false,
            });
            let sig = make_signal(BLOCK);
            let mut l = sig.clone();
            let mut r = sig.clone();
            b.iter(|| {
                l.copy_from_slice(&sig);
                r.copy_from_slice(&sig);
                black_box(comp.process(&mut l, &mut r));
            });
        });
    }
    g.finish();
}

fn bench_mix(c: &mut Criterion) {
    let mut g = c.benchmark_group("mix");
    for &n in &[128usize, 1024] {
        g.throughput(Throughput::Elements(n as u64));
        let sig = make_signal(n);

        g.bench_with_input(BenchmarkId::new("add_scaled", n), &n, |b, &n| {
            let mut dst = vec![0.0f32; n];
            b.iter(|| add_scaled(black_box(&mut dst), black_box(&sig), 0.7));
        });
        g.bench_with_input(BenchmarkId::new("add_scaled_ramp", n), &n, |b, &n| {
            let mut dst = vec![0.0f32; n];
            b.iter(|| add_scaled_ramp(black_box(&mut dst), black_box(&sig), 0.2, 0.9));
        });
        g.bench_with_input(BenchmarkId::new("copy_scaled", n), &n, |b, &n| {
            let mut dst = vec![0.0f32; n];
            b.iter(|| copy_scaled(black_box(&mut dst), black_box(&sig), 0.7));
        });
        g.bench_with_input(BenchmarkId::new("peak", n), &n, |b, _| {
            b.iter(|| black_box(peak(black_box(&sig))))
        });
        g.bench_with_input(BenchmarkId::new("rms", n), &n, |b, _| {
            b.iter(|| black_box(rms(black_box(&sig))))
        });
    }

    // Loop mixing realistis: 32 track disum ke master dengan gain ramp.
    g.bench_function("sum_32_tracks_128", |b| {
        let tracks: Vec<Vec<f32>> = (0..32).map(|_| make_signal(BLOCK)).collect();
        let mut master = vec![0.0f32; BLOCK];
        b.iter(|| {
            for (i, t) in tracks.iter().enumerate() {
                let g0 = 0.5 + i as f32 * 0.001;
                add_scaled_ramp(&mut master, t, g0, g0 + 0.01);
            }
            black_box(&master);
        });
    });
    g.finish();
}

fn bench_smoother_and_resample(c: &mut Criterion) {
    let mut g = c.benchmark_group("misc");
    g.bench_function("smoother_128", |b| {
        let mut s = Smoother::new(SR, 5.0, 0.0);
        s.set_target(1.0);
        b.iter(|| {
            let mut acc = 0.0f32;
            for _ in 0..BLOCK {
                acc += s.next();
            }
            s.flush_denormal();
            black_box(acc)
        });
    });
    g.bench_function("hermite_resample_128", |b| {
        let src = make_signal(4096);
        let mut out = vec![0.0f32; BLOCK];
        b.iter(|| {
            let mut cur = FracCursor::new(100.0, 1.0594631);
            for o in out.iter_mut() {
                *o = cur.read(&src);
                cur.advance();
            }
            black_box(&out);
        });
    });
    g.finish();
}

criterion_group!(
    benches,
    bench_biquad,
    bench_compressor,
    bench_mix,
    bench_smoother_and_resample
);
criterion_main!(benches);
