//! Benchmark criterion untuk blok DSP yang ada di jalur render.
//!
//! Angka native bukan angka WASM (WASM biasanya 2–4× lebih lambat), tapi
//! benchmark ini dipakai sebagai **gate regresi** di CI: naik >10% = build
//! merah (docs/01 §1c).

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use daw_dsp::{
    add_scaled, add_scaled_ramp, copy_scaled, peak, rms, Biquad, Coeffs, CompParams, Compressor,
    DcBlock, Delay, Detector, Fdn8, FilterKind, FracCursor, Lfo, LfoShape, OnePoleLp, Smoother,
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

/// Primitif FX baru, diukur pada bentuk yang SAMA dengan `eq4_stereo_128`.
///
/// Itu bukan kebetulan: docs/02 memberi anggaran "32 track × (EQ4 + kompresor)
/// ≈ 35–45% satu core", jadi EQ4 stereo per 128 frame adalah satu-satunya
/// satuan yang bisa dipakai menerjemahkan angka bench jadi anggaran CPU.
/// Rasio terhadap bench itulah yang memvalidasi tabel biaya di rencana FX —
/// kalau REVERB ternyata 8× EQ4 alih-alih ~2.6×, keputusan "reverb hanya di
/// send bus" perlu ditinjau ulang dengan angka, bukan dengan aritmetika.
fn bench_fx_primitives(c: &mut Criterion) {
    let mut g = c.benchmark_group("fx_primitives");
    g.throughput(Throughput::Elements(BLOCK as u64));

    // Pembacaan fraksional murni — dasar SPIRAL/ECHO/FLANGER/PITCH.
    g.bench_function("delay_read_frac_mono_128", |b| {
        let mut mem = vec![0.0f32; 4096];
        let sig = make_signal(BLOCK);
        let mut w = 0usize;
        b.iter(|| {
            let mut line = Delay::attach(&mut mem, w).unwrap();
            let mut acc = 0.0f32;
            for (i, x) in sig.iter().enumerate() {
                acc += line.tick(black_box(*x), 1000.5 + i as f32 * 0.01);
            }
            w = line.write_pos();
            black_box(acc)
        });
    });

    // Bentuk ECHO/SPIRAL sesungguhnya: delay + damping + DC block + feedback,
    // stereo.
    g.bench_function("echo_core_stereo_128", |b| {
        let mut mem_l = vec![0.0f32; 1 << 17];
        let mut mem_r = vec![0.0f32; 1 << 17];
        let mut lp = [OnePoleLp::with_cutoff(SR, 6_000.0); 2];
        let mut dc = [DcBlock::with_rate(SR); 2];
        let sig = make_signal(BLOCK);
        let (mut wl, mut wr) = (0usize, 0usize);
        let (mut fl, mut fr) = (0.0f32, 0.0f32);
        b.iter(|| {
            let mut ll = Delay::attach(&mut mem_l, wl).unwrap();
            for x in sig.iter() {
                let y = ll.tick(black_box(*x) + fl, 12_000.0);
                fl = dc[0].tick(lp[0].tick(y)) * 0.5;
            }
            wl = ll.write_pos();
            let mut lr = Delay::attach(&mut mem_r, wr).unwrap();
            for x in sig.iter() {
                let y = lr.tick(black_box(*x) + fr, 12_000.0);
                fr = dc[1].tick(lp[1].tick(y)) * 0.5;
            }
            wr = lr.write_pos();
            black_box((fl, fr))
        });
    });

    // FLANGER: delay pendek yang disapu LFO, dua kanal beda fase 90°.
    g.bench_function("flanger_core_stereo_128", |b| {
        let mut mem_l = vec![0.0f32; 1024];
        let mut mem_r = vec![0.0f32; 1024];
        let mut lfo = Lfo::new();
        lfo.set_rate(SR, 0.25);
        let sig = make_signal(BLOCK);
        let (mut wl, mut wr) = (0usize, 0usize);
        b.iter(|| {
            let phase0 = lfo.phase();
            let mut ll = Delay::attach(&mut mem_l, wl).unwrap();
            let mut acc = 0.0f32;
            for x in sig.iter() {
                let d = 100.0 + lfo.next(LfoShape::Triangle) * 90.0;
                acc += ll.tick(black_box(*x), d);
            }
            wl = ll.write_pos();
            // Kanal kanan mengulang fase yang sama dengan offset 90°.
            let mut side = Lfo::new();
            side.set_rate(SR, 0.25);
            side.set_phase_turns(0.0);
            let _ = phase0;
            let mut lr = Delay::attach(&mut mem_r, wr).unwrap();
            for x in sig.iter() {
                let d = 100.0 + side.peek_at(daw_dsp::QUARTER_TURN, LfoShape::Triangle) * 90.0;
                side.next(LfoShape::Triangle);
                acc += lr.tick(black_box(*x), d);
            }
            wr = lr.write_pos();
            black_box(acc)
        });
    });

    // REVERB: delapan line, damping, modulasi, campur Householder.
    g.bench_function("fdn8_stereo_128", |b| {
        let mut f = Fdn8::new(SR);
        let mut mem = vec![0.0f32; daw_dsp::fdn::mem_frames(SR)];
        let sig = make_signal(BLOCK);
        b.iter(|| {
            let mut acc = 0.0f32;
            for x in sig.iter() {
                let (l, r) = f.tick(&mut mem, black_box(*x), black_box(-*x));
                acc += l + r;
            }
            black_box(acc)
        });
    });

    g.finish();
}

criterion_group!(
    benches,
    bench_biquad,
    bench_compressor,
    bench_mix,
    bench_smoother_and_resample,
    bench_fx_primitives
);
criterion_main!(benches);
