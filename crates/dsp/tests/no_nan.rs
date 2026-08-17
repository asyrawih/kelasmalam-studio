//! Property test: **tidak satu pun** fungsi di `daw-dsp` boleh menghasilkan
//! NaN atau infinity untuk input yang finite.
//!
//! Kenapa ini penting sampai perlu tes sendiri: NaN di engine audio bersifat
//! menular dan permanen. Satu NaN masuk ke state IIR (`s1`/`s2`) atau ke
//! envelope kompresor, dan filter itu mengeluarkan NaN selamanya — sampai
//! `reset()` yang tidak pernah dipanggil. Di mixer, NaN itu lalu menyebar ke
//! master bus dan seluruh output jadi senyap (atau, lebih buruk, jadi noise
//! penuh skala di sebagian hardware). Karena render path juga tidak boleh
//! `panic`, tidak ada jaring pengaman lain selain "jangan pernah menghasilkan
//! NaN sejak awal".

use daw_dsp::*;
use proptest::prelude::*;

/// f32 finite dalam rentang yang masuk akal untuk audio dan parameter.
fn finite_f32() -> impl Strategy<Value = f32> {
    prop_oneof![
        // Rentang audio normal.
        (-4.0f32..4.0),
        // Ekstrem (clipping berat, gain aneh).
        (-1.0e6f32..1.0e6),
        // Dekat nol / denormal.
        (-1.0e-20f32..1.0e-20),
    ]
}

fn finite_block() -> impl Strategy<Value = Vec<f32>> {
    prop::collection::vec(finite_f32(), 1..=64)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn fastmath_never_nan(x in finite_f32()) {
        prop_assert!(fast_log2(x).is_finite(), "fast_log2({x})");
        prop_assert!(fast_exp2(x).is_finite(), "fast_exp2({x})");
        prop_assert!(db_to_lin(x).is_finite(), "db_to_lin({x})");
        prop_assert!(lin_to_db(x).is_finite(), "lin_to_db({x})");
    }

    #[test]
    fn smoother_never_nan(
        tau in 0.0f32..1000.0,
        init in finite_f32(),
        target in finite_f32(),
        sr in 8000.0f32..192000.0,
    ) {
        let mut s = Smoother::new(sr, tau, init);
        s.set_target(target);
        for _ in 0..2048 {
            prop_assert!(s.next().is_finite());
        }
        s.flush_denormal();
        prop_assert!(s.current().is_finite());
    }

    #[test]
    fn biquad_design_never_nan(
        kind_idx in 0usize..8,
        freq in -100.0f32..100_000.0,
        q in -1.0f32..100.0,
        gain in -100.0f32..100.0,
        sr in 8000.0f32..192000.0,
    ) {
        const KINDS: [FilterKind; 8] = [
            FilterKind::LowPass, FilterKind::HighPass, FilterKind::LowShelf,
            FilterKind::HighShelf, FilterKind::Peaking, FilterKind::Notch,
            FilterKind::AllPass, FilterKind::BandPass,
        ];
        let c = Coeffs::design(KINDS[kind_idx], sr, freq, q, gain);
        prop_assert!(c.b0.is_finite() && c.b1.is_finite() && c.b2.is_finite());
        prop_assert!(c.a1.is_finite() && c.a2.is_finite());
    }

    #[test]
    fn biquad_process_never_nan(
        kind_idx in 0usize..8,
        freq in 10.0f32..20_000.0,
        q in 0.1f32..20.0,
        gain in -24.0f32..24.0,
        block in finite_block(),
    ) {
        const KINDS: [FilterKind; 8] = [
            FilterKind::LowPass, FilterKind::HighPass, FilterKind::LowShelf,
            FilterKind::HighShelf, FilterKind::Peaking, FilterKind::Notch,
            FilterKind::AllPass, FilterKind::BandPass,
        ];
        let c = Coeffs::design(KINDS[kind_idx], 48_000.0, freq, q, gain);
        let mut bq = Biquad::new();
        // Input di-clamp ke rentang audio: filter resonan yang diberi input
        // 1e6 memang bisa overflow f32 secara sah, dan itu bukan bug.
        let mut block: Vec<f32> = block.iter().copied().map(clamp_audio).collect();
        for _ in 0..8 {
            bq.process(&mut block, &c);
            for v in &block {
                prop_assert!(v.is_finite(), "biquad emitted {v}");
            }
            for v in block.iter_mut() {
                *v = clamp_audio(*v);
            }
        }
    }

    #[test]
    fn compressor_never_nan(
        thr in -96.0f32..24.0,
        ratio in 0.1f32..1000.0,
        knee in 0.0f32..48.0,
        att in 0.0f32..500.0,
        rel in 0.0f32..2000.0,
        makeup in -24.0f32..24.0,
        rms_det in any::<bool>(),
        auto in any::<bool>(),
        block in finite_block(),
    ) {
        let mut comp = Compressor::new(48_000.0);
        comp.set_params(&CompParams {
            threshold_db: thr,
            ratio,
            knee_db: knee,
            attack_ms: att,
            release_ms: rel,
            makeup_db: makeup,
            detector: if rms_det { Detector::Rms } else { Detector::Peak },
            auto_makeup: auto,
        });
        let mut l = block.clone();
        let mut r: Vec<f32> = block.iter().map(|v| v * 0.5).collect();
        for _ in 0..4 {
            let gr = comp.process(&mut l, &mut r);
            prop_assert!(gr.is_finite() && gr >= 0.0, "gr = {gr}");
            for v in l.iter().chain(r.iter()) {
                prop_assert!(v.is_finite(), "compressor emitted {v}");
            }
            l.copy_from_slice(&block);
            for (i, v) in r.iter_mut().enumerate() { *v = block[i] * 0.5; }
        }
    }

    #[test]
    fn mix_never_nan(
        a in finite_block(),
        b in finite_block(),
        g0 in -100.0f32..100.0,
        g1 in -100.0f32..100.0,
    ) {
        let mut dst = a.clone();
        add_scaled(&mut dst, &b, g0);
        prop_assert!(dst.iter().all(|v| v.is_finite()));

        let mut dst = a.clone();
        add_scaled_ramp(&mut dst, &b, g0, g1);
        prop_assert!(dst.iter().all(|v| v.is_finite()));

        let mut dst = a.clone();
        copy_scaled(&mut dst, &b, g0);
        prop_assert!(dst.iter().all(|v| v.is_finite()));

        prop_assert!(peak(&a).is_finite() && peak(&a) >= 0.0);
        prop_assert!(rms(&a).is_finite() && rms(&a) >= 0.0);

        let mut dst = a.clone();
        clear(&mut dst);
        prop_assert!(dst.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn hermite_never_nan(
        ym1 in finite_f32(), y0 in finite_f32(), y1 in finite_f32(), y2 in finite_f32(),
        t in 0.0f32..1.0,
    ) {
        prop_assert!(hermite4(ym1, y0, y1, y2, t).is_finite());
    }

    #[test]
    fn read_hermite_never_nan(
        src in finite_block(),
        pos in -1.0e9f64..1.0e9,
        ratio in -100.0f64..100.0,
    ) {
        let mut cur = FracCursor::new(pos, ratio);
        for _ in 0..64 {
            let v = cur.read(&src);
            prop_assert!(v.is_finite(), "read_hermite gave {v} at {}", cur.pos);
            cur.advance();
        }
        prop_assert!(cur.read_hermite(&src, pos).is_finite());
    }

    /// Peak selalu >= |sample| mana pun, dan RMS selalu <= peak.
    #[test]
    fn meter_invariants(buf in finite_block()) {
        let p = peak(&buf);
        let r = rms(&buf);
        for v in &buf {
            prop_assert!(p >= v.abs() - 1e-6);
        }
        prop_assert!(r <= p + 1e-3, "rms {r} > peak {p}");
    }
}

/// Batasi nilai supaya filter resonan pada input ekstrem tidak menghasilkan
/// `inf` yang sebenarnya benar secara matematis (overflow f32 pada Q=20 dan
/// input 1e6 adalah perilaku IIR yang wajar, bukan bug).
fn clamp_audio(x: f32) -> f32 {
    x.clamp(-4.0, 4.0)
}
