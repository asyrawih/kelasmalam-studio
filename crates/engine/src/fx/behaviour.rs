//! Tes perilaku per-efek.
//!
//! Tes konformans di `conformance.rs` menjamin STRUKTURNYA — resumable, bebas
//! NaN, tidak keluar batas memori, reset bersih. Yang tidak dijaminnya adalah
//! apakah efeknya melakukan hal yang namanya menjanjikan: sebuah ECHO yang
//! meloloskan sinyal apa adanya lolos seluruh tes konformans dengan gemilang.

use alloc::vec;
use alloc::vec::Vec;

use super::arena::FxArena;
use super::registry::{FxKind, FxNode};
use super::ParamCtx;

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;

/// Satu efek beserta arenanya, siap dijalankan blok demi blok.
struct Rig {
    node: FxNode,
    arena: FxArena,
    mem: super::arena::MemHandle,
    params: Vec<f32>,
}

impl Rig {
    fn new(kind: FxKind) -> Self {
        let need = kind.mem_frames(SR);
        let mut arena = FxArena::new(need);
        let mem = arena.alloc(need).expect("arena cukup");
        let node = {
            let block = arena.block(mem);
            FxNode::make(kind, SR, block)
        };
        let params = kind.desc().params.iter().map(|p| p.default).collect();
        Rig {
            node,
            arena,
            mem,
            params,
        }
    }

    fn set(&mut self, id: &str, v: f32) {
        let desc = self.node.desc();
        if let Some(i) = desc.param_index(id) {
            self.params[i] = v;
        } else {
            panic!("parameter `{id}` tidak ada di {}", desc.id);
        }
    }

    /// Jalankan satu blok, kembalikan kanal kiri.
    fn block(&mut self, input: &[f32]) -> Vec<f32> {
        let mut l = input.to_vec();
        let mut r = input.to_vec();
        let ctx = ParamCtx::new(&self.params, SR, SR * 0.5);
        let mem = self.arena.block(self.mem);
        self.node.begin_block(mem);
        self.node.prepare(&ctx);
        self.node.process(mem, &mut l, &mut r);
        self.node.end_block(mem);
        l
    }

    /// Jalankan input panjang, dipotong per blok.
    ///
    /// Input harus KONTINU. Memberi potongan yang dimulai ulang dari fase 0
    /// tiap blok membuat sinyalnya sendiri diskontinu, dan hitungan perlintasan
    /// nol lalu mengukur cacat buatan tes — bukan efeknya.
    fn run(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(input.len());
        for chunk in input.chunks(BLOCK) {
            out.extend_from_slice(&self.block(chunk));
        }
        out
    }

    /// Jalankan `blocks` blok senyap dan kumpulkan keluarannya.
    fn silence(&mut self, blocks: usize) -> Vec<f32> {
        let zero = vec![0.0f32; BLOCK];
        let mut out = Vec::new();
        for _ in 0..blocks {
            out.extend_from_slice(&self.block(&zero));
        }
        out
    }
}

fn sine(hz: f32, n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| libm::sinf(core::f32::consts::TAU * hz * i as f32 / SR) * 0.5)
        .collect()
}

fn peak(v: &[f32]) -> f32 {
    v.iter().fold(0.0f32, |a, b| a.max(b.abs()))
}

fn rms(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let s: f64 = v.iter().map(|x| (*x as f64) * (*x as f64)).sum();
    (s / v.len() as f64).sqrt() as f32
}

/// Jumlah perlintasan nol — proksi frekuensi yang cukup untuk sinus.
fn zero_crossings(v: &[f32]) -> usize {
    let mut n = 0;
    for w in v.windows(2) {
        if (w[0] <= 0.0) != (w[1] <= 0.0) {
            n += 1;
        }
    }
    n
}

// ── ECHO ──────────────────────────────────────────────────────────────────

/// Repeat harus muncul TEPAT di waktu yang diminta. Ini yang membedakan echo
/// dari sekadar sinyal yang lewat.
#[test]
fn echo_repeats_at_the_requested_time() {
    let mut rig = Rig::new(FxKind::Echo);
    let delay_ms = 100.0;
    rig.set("time", delay_ms);
    rig.set("feedback", 0.0);
    rig.set("mix", 1.0);

    // Impuls tunggal, lalu senyap.
    let mut imp = vec![0.0f32; BLOCK];
    imp[0] = 1.0;
    let mut out = rig.block(&imp);
    out.extend(rig.silence(80));

    let want = (delay_ms * 0.001 * SR) as usize;
    let (mut best, mut best_at) = (0.0f32, 0usize);
    for (i, v) in out.iter().enumerate() {
        if v.abs() > best {
            best = v.abs();
            best_at = i;
        }
    }
    assert!(best > 0.2, "tidak ada repeat sama sekali (puncak {best})");
    let err = (best_at as i64 - want as i64).abs();
    assert!(err < 64, "repeat di sample {best_at}, seharusnya ~{want}");
}

/// Ekor HARUS terus berbunyi setelah input dipotong — itu seluruh alasan
/// `Step::Fx` selalu diemit dan kenapa bypass meredam input, bukan keluaran.
#[test]
fn echo_tail_survives_the_input_being_cut() {
    let mut rig = Rig::new(FxKind::Echo);
    rig.set("time", 60.0);
    rig.set("feedback", 0.8);
    rig.set("mix", 1.0);

    // Setengah detik materi, lalu dua detik senyap. Jendelanya harus jauh
    // lebih panjang dari satu putaran delay: pada 60 ms dan fb 0.8, dua ratus
    // milidetik pertama baru berisi tiga repeat dan bisa saja lebih keras dari
    // repeat sebelumnya.
    rig.run(&sine(440.0, (SR * 0.5) as usize));
    let tail = rig.silence((SR * 2.0) as usize / BLOCK);

    let early = rms(&tail[..(SR * 0.1) as usize]);
    let late = rms(&tail[(SR * 1.5) as usize..]);
    assert!(early > 0.02, "ekor langsung mati: {early}");
    assert!(late < early * 0.5, "ekor tidak meluruh: {early} -> {late}");
}

// ── SPIRAL ────────────────────────────────────────────────────────────────

/// Menggerakkan TIME saat ekor berbunyi harus menggeser NADA-nya. Kalau tidak,
/// yang dibangun cuma echo dengan nama lain.
#[test]
fn spiral_shifts_pitch_while_the_time_is_moving() {
    fn tail_crossings(move_time: bool) -> usize {
        let mut rig = Rig::new(FxKind::Spiral);
        // Delay pendek: dengan 200 ms, repeat pertama baru tiba jauh setelah
        // jendela dengar tes ini berakhir, dan yang terukur cuma senyap.
        rig.set("time", 40.0);
        rig.set("feedback", 0.92);
        rig.set("mix", 1.0);
        rig.set("glide", 40.0);

        rig.run(&sine(440.0, (SR * 0.3) as usize));

        let mut out = Vec::new();
        let steps = 60;
        for i in 0..steps {
            if move_time {
                // Delay MENGECIL → materi diputar lebih cepat → nada naik.
                rig.set("time", 40.0 - 30.0 * (i as f32 / steps as f32));
            }
            out.extend(rig.silence(4));
        }
        zero_crossings(&out[BLOCK * 8..])
    }

    let still = tail_crossings(false);
    let moving = tail_crossings(true);
    assert!(still > 0, "ekor diam tidak berbunyi sama sekali");
    assert!(
        moving > still + still / 10,
        "menggerakkan TIME tidak menggeser nada: {still} -> {moving} perlintasan"
    );
}

// ── FLANGER ───────────────────────────────────────────────────────────────

/// Depth nol harus menghasilkan comb DIAM; depth penuh harus membuat
/// keluarannya bergerak. Yang diuji: modulasinya benar-benar termodulasi.
#[test]
fn flanger_only_moves_when_depth_is_nonzero() {
    fn envelope_spread(depth: f32) -> f32 {
        let mut rig = Rig::new(FxKind::Flanger);
        rig.set("depth", depth);
        rig.set("rate", 8.0);
        rig.set("feedback", 0.7);
        rig.set("mix", 1.0);
        let src = sine(1_000.0, BLOCK);
        let mut mins = f32::MAX;
        let mut maxs = 0.0f32;
        for i in 0..60 {
            let out = rig.block(&src);
            if i >= 10 {
                let p = peak(&out);
                mins = mins.min(p);
                maxs = maxs.max(p);
            }
        }
        maxs - mins
    }

    let still = envelope_spread(0.0);
    let moving = envelope_spread(4.0);
    assert!(moving > still * 3.0 + 0.01, "flanger tidak menyapu: {still} vs {moving}");
}

// ── REVERB ────────────────────────────────────────────────────────────────

#[test]
fn reverb_tail_decays_and_outlasts_a_short_input() {
    let mut rig = Rig::new(FxKind::Reverb);
    rig.set("decay", 2_000.0);
    rig.set("mix", 1.0);
    rig.set("predelay", 0.0);

    let src = sine(440.0, BLOCK);
    for _ in 0..8 {
        rig.block(&src);
    }
    let tail = rig.silence(200);
    let early = rms(&tail[..BLOCK * 10]);
    let late = rms(&tail[BLOCK * 180..]);
    assert!(early > 0.005, "reverb tidak menghasilkan ekor: {early}");
    assert!(late < early * 0.7, "ekor tidak meluruh: {early} -> {late}");
    assert!(tail.iter().all(|v| v.is_finite()));
}

/// Decay panjang harus benar-benar lebih panjang dari decay pendek.
#[test]
fn reverb_decay_parameter_changes_the_tail_length() {
    fn tail_energy(decay_ms: f32) -> f32 {
        let mut rig = Rig::new(FxKind::Reverb);
        rig.set("decay", decay_ms);
        rig.set("mix", 1.0);
        let src = sine(440.0, BLOCK);
        for _ in 0..8 {
            rig.block(&src);
        }
        let tail = rig.silence(120);
        rms(&tail[BLOCK * 100..])
    }
    let short = tail_energy(400.0);
    let long = tail_energy(8_000.0);
    assert!(long > short * 2.0, "decay tidak berpengaruh: {short} vs {long}");
}

// ── PITCH ─────────────────────────────────────────────────────────────────

/// Naik satu oktaf harus menggandakan frekuensinya. Ini satu-satunya tes yang
/// benar-benar membuktikan penggeser nadanya menggeser nada.
#[test]
fn pitch_up_one_octave_doubles_the_frequency() {
    let mut rig = Rig::new(FxKind::Pitch);
    rig.set("semitones", 12.0);
    rig.set("mix", 1.0);
    rig.set("feedback", 0.0);

    // Sinus KONTINU: potongan yang di-restart tiap blok menambahkan
    // diskontinuitas yang ikut terhitung sebagai perlintasan nol.
    let out = rig.run(&sine(440.0, (SR * 0.5) as usize));
    let settled = &out[(SR * 0.2) as usize..];
    let want = zero_crossings(&sine(880.0, settled.len()));
    let got = zero_crossings(settled);
    let ratio = got as f32 / want as f32;
    assert!(
        (ratio - 1.0).abs() < 0.15,
        "dapat {got} perlintasan, referensi murni {want}"
    );
}


#[test]
fn pitch_down_one_octave_halves_the_frequency() {
    let mut rig = Rig::new(FxKind::Pitch);
    rig.set("semitones", -12.0);
    rig.set("mix", 1.0);
    rig.set("feedback", 0.0);

    // Sinus KONTINU: potongan yang di-restart tiap blok menambahkan
    // diskontinuitas yang ikut terhitung sebagai perlintasan nol.
    let out = rig.run(&sine(880.0, (SR * 0.5) as usize));
    let settled = &out[(SR * 0.2) as usize..];
    let want = zero_crossings(&sine(440.0, settled.len()));
    let got = zero_crossings(settled);
    let ratio = got as f32 / want as f32;
    assert!(
        (ratio - 1.0).abs() < 0.15,
        "dapat {got} perlintasan, referensi murni {want}"
    );
}


/// Nol semitone harus melewatkan nada apa adanya.
#[test]
fn pitch_at_zero_leaves_the_frequency_alone() {
    let mut rig = Rig::new(FxKind::Pitch);
    rig.set("semitones", 0.0);
    rig.set("mix", 1.0);
    let out = rig.run(&sine(440.0, (SR * 0.4) as usize));
    let settled = &out[(SR * 0.15) as usize..];
    let want = zero_crossings(&sine(440.0, settled.len()));
    let got = zero_crossings(settled);
    assert!(
        (got as f32 / want as f32 - 1.0).abs() < 0.1,
        "0 st mengubah nada: {got} vs {want}"
    );
}


// ── FILTER (lihat juga tes di filter.rs) ──────────────────────────────────

#[test]
fn filter_knob_direction_matches_its_name() {
    let mut lp = Rig::new(FxKind::Filter);
    lp.set("knob", -0.9);
    let mut out = Vec::new();
    let src = sine(6_000.0, BLOCK);
    for i in 0..40 {
        let b = lp.block(&src);
        if i >= 20 {
            out.extend_from_slice(&b);
        }
    }
    assert!(peak(&out) < 0.15, "putar kiri tidak meredam 6 kHz");
}
