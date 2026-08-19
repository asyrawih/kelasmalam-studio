//! Tes konformans yang mengiterasi seluruh [`CATALOG`].
//!
//! Ini berkas yang membuat menambah efek jadi murah. Tanpanya, tiap efek baru
//! menuntut penulisnya mengingat sendiri enam invarian yang tidak kelihatan
//! dari kode efeknya — dan yang keenam pasti terlewat. Dengan berkas ini,
//! satu baris di `fx_registry!` langsung menyeret efek barunya ke seluruh
//! rangkaian uji di bawah.
//!
//! Ditulis SEBELUM efek-efeknya ada, dan itu disengaja: harness yang ditulis
//! setelah implementasi cenderung menguji apa yang kebetulan sudah bekerja.

use alloc::vec;
use alloc::vec::Vec;

use super::arena::{FxArena, MemHandle};
use super::registry::{FxKind, FxNode, CATALOG};
use super::ParamCtx;

/// Sample rate yang harus dilewati semua efek. Engine memvalidasi
/// `8_000..=384_000` dan tidak pernah memaksa 48 kHz (docs/05 §Safari), jadi
/// menguji satu sample rate saja akan melewatkan pembagian-nol di ujungnya.
const RATES: [f32; 4] = [8_000.0, 48_000.0, 96_000.0, 384_000.0];

/// Sinyal uji deterministik — bukan `rand`, karena jalur render harus
/// reproducible dan tes yang acak tidak bisa dipakai membandingkan bit.
fn signal(n: usize, seed: f32) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let t = i as f32;
            0.5 * libm::sinf(t * 0.037 + seed) + 0.4 * libm::sinf(t * 0.211 + seed * 2.0)
        })
        .collect()
}

/// Bandingkan dua buffer dan laporkan HANYA sample pertama yang berbeda.
///
/// `assert_eq!` pada dua `Vec<f32>` sepanjang seribu mencetak kedua isinya
/// secara utuh — puluhan ribu angka yang menenggelamkan informasi yang
/// sebenarnya dicari, yaitu di mana penyimpangannya mulai.
fn assert_first_diff(id: &str, what: &str, a: &[f32], b: &[f32]) {
    assert_eq!(a.len(), b.len(), "{id}: {what} — panjang berbeda");
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        assert!(
            x.to_bits() == y.to_bits(),
            "{id}: {what} — menyimpang mulai sample {i}: {x} vs {y}"
        );
    }
}

/// Bangun satu node beserta region arenanya, sesuai memori yang dideklarasikan.
fn spawn(kind: FxKind, sr: f32) -> (FxNode, FxArena, MemHandle) {
    let need = kind.mem_frames(sr);
    // Dialokasi PAS sebesar yang diminta efeknya — kalau ia membaca melewati
    // batas itu, tes memori di bawah yang menangkapnya.
    let mut arena = FxArena::new(need);
    let mem = arena.alloc(need).expect("arena sesuai mem_frames");
    let node = {
        let block = arena.block(mem);
        FxNode::make(kind, sr, block)
    };
    (node, arena, mem)
}

/// Parameter default efek, dalam bentuk yang dibaca `ParamCtx`.
fn default_params(kind: FxKind) -> Vec<f32> {
    kind.desc().params.iter().map(|p| p.default).collect()
}

/// **Invarian paling penting di berkas ini.**
///
/// `process` wajib resumable: memecah satu blok jadi beberapa sub-blok harus
/// menghasilkan bit yang sama persis dengan satu panggilan utuh. Engine memecah
/// sub-blok di setiap event ber-timestamp dan di batas loop, sementara render
/// offline memakai blok 1024 dan realtime memakai 128 — jadi efek yang tidak
/// resumable membuat hasil export berbeda dari yang terdengar, dan
/// `null_test_block_size_invariance` berhenti bermakna.
///
/// Mode kegagalan yang paling sering: apa pun yang dihitung "sekali per
/// panggilan `process`" alih-alih per sample — pencacah crossfade, refresh
/// koefisien, langkah LFO, atau pembuangan denormal.
#[test]
fn every_effect_is_resumable_across_sub_blocks() {
    const N: usize = 1024;
    for kind in FxKind::ALL {
        let sr = 48_000.0;
        let params = default_params(*kind);
        let ctx = ParamCtx::new(&params, sr, sr * 0.5);

        let src_l = signal(N, 0.0);
        let src_r = signal(N, 1.7);

        // Satu blok penuh.
        let (mut whole, mut wa, wm) = spawn(*kind, sr);
        let mut wl = src_l.clone();
        let mut wr = src_r.clone();
        whole.begin_block(wa.block(wm));
        whole.prepare(&ctx);
        whole.process(wa.block(wm), &mut wl, &mut wr);

        // Blok yang sama, dipecah delapan.
        let (mut split, mut sa, sm) = spawn(*kind, sr);
        let mut sl = src_l.clone();
        let mut sr_buf = src_r.clone();
        split.begin_block(sa.block(sm));
        split.prepare(&ctx);
        for c in 0..8 {
            let a = c * 128;
            let b = a + 128;
            split.process(sa.block(sm), &mut sl[a..b], &mut sr_buf[a..b]);
        }

        let id = kind.desc().id;
        assert_first_diff(id, "kiri, blok dipecah 8×128", &wl, &sl);
        assert_first_diff(id, "kanan, blok dipecah 8×128", &wr, &sr_buf);
    }
}

/// Senyap masuk ke efek yang bersih harus menghasilkan senyap keluar.
///
/// Efek berekor (delay, reverb) boleh berdenging SETELAH ada sinyal, tapi tidak
/// boleh membangkitkan apa pun dari keadaan nol. Yang ditangkap di sini:
/// injeksi anti-denormal yang bocor ke keluaran, offset DC, dan osilator yang
/// menjumlah alih-alih memodulasi.
#[test]
fn silence_in_is_silence_out_from_a_clean_state() {
    for kind in FxKind::ALL {
        let sr = 48_000.0;
        let params = default_params(*kind);
        let ctx = ParamCtx::new(&params, sr, sr * 0.5);
        let (mut node, mut arena, mem) = spawn(*kind, sr);

        let mut worst = 0.0f32;
        for _ in 0..64 {
            let mut l = vec![0.0f32; 128];
            let mut r = vec![0.0f32; 128];
            node.begin_block(arena.block(mem));
            node.prepare(&ctx);
            node.process(arena.block(mem), &mut l, &mut r);
            node.end_block(arena.block(mem));
            for v in l.iter().chain(r.iter()) {
                worst = worst.max(v.abs());
            }
        }
        // −120 dBFS: jauh di bawah dengar, tapi cukup ketat untuk menangkap
        // kebocoran DC atau anti-denormal yang tidak sengaja terdengar.
        assert!(
            worst < 1.0e-6,
            "{}: membangkitkan {worst} dari senyap",
            kind.desc().id
        );
    }
}

/// Tidak ada kombinasi parameter yang boleh menghasilkan NaN atau infinity.
///
/// NaN di jalur render bersifat permanen: sekali masuk ke state IIR atau ke
/// isi delay line, efek itu mengeluarkan NaN selamanya — dan karena
/// `render_block` juga tidak boleh `panic`, tidak ada jaring lain.
///
/// Tiap parameter disapu dari min ke max sementara yang lain di default, lalu
/// diuji juga di ketiga titik ekstrem sekaligus.
#[test]
fn no_parameter_setting_produces_nan() {
    for kind in FxKind::ALL {
        let desc = kind.desc();
        for sr in RATES {
            let base = default_params(*kind);

            // Semua-min, semua-default, semua-max.
            let mut combos: Vec<Vec<f32>> = vec![
                desc.params.iter().map(|p| p.min).collect(),
                base.clone(),
                desc.params.iter().map(|p| p.max).collect(),
            ];
            // Lalu tiap parameter satu per satu, disapu.
            for i in 0..desc.params.len() {
                for step in 0..=4 {
                    let mut c = base.clone();
                    c[i] = desc.params[i].from_norm(step as f32 / 4.0);
                    combos.push(c);
                }
            }

            for combo in combos {
                let (mut node, mut arena, mem) = spawn(*kind, sr);
                let ctx = ParamCtx::new(&combo, sr, sr * 0.5);
                let mut l = signal(256, 0.3);
                let mut r = signal(256, 2.1);
                node.begin_block(arena.block(mem));
                node.prepare(&ctx);
                node.process(arena.block(mem), &mut l, &mut r);
                node.end_block(arena.block(mem));
                for (i, v) in l.iter().chain(r.iter()).enumerate() {
                    assert!(
                        v.is_finite(),
                        "{} @ {sr} Hz: sample {i} = {v} untuk {combo:?}",
                        desc.id
                    );
                }
            }
        }
    }
}

/// Efek tidak boleh membaca atau menulis di luar memori yang dideklarasikannya.
///
/// Arena di sini dialokasi PAS sebesar `mem_frames`, jadi kelebihan satu sample
/// pun akan keluar batas. Di Rust itu berarti panic — dan panic di
/// `render_block` dilarang (docs/01 §1c), jadi tes ini menegakkan aturannya.
#[test]
fn every_effect_stays_inside_its_declared_memory() {
    for kind in FxKind::ALL {
        for sr in RATES {
            let params = default_params(*kind);
            let ctx = ParamCtx::new(&params, sr, sr * 0.5);
            let (mut node, mut arena, mem) = spawn(*kind, sr);
            assert_eq!(
                arena.capacity(),
                kind.mem_frames(sr),
                "{}: arena tidak sesuai mem_frames",
                kind.desc().id
            );
            for _ in 0..16 {
                let mut l = signal(128, 0.9);
                let mut r = signal(128, 1.3);
                node.begin_block(arena.block(mem));
                node.prepare(&ctx);
                node.process(arena.block(mem), &mut l, &mut r);
                node.end_block(arena.block(mem));
            }
        }
    }
}

/// `reset` harus benar-benar mengembalikan efek ke keadaan awal.
///
/// Dipakai saat seek, loop wrap, dan pergantian plan. Kalau ada state yang
/// tertinggal, sebuah render yang dimulai dari seek akan berbeda dari render
/// yang dimulai bersih di posisi yang sama — dan null-test bounce-vs-realtime
/// gagal secara intermiten, hanya pada project yang di-seek.
#[test]
fn reset_returns_an_effect_to_its_initial_state() {
    const N: usize = 512;
    for kind in FxKind::ALL {
        let sr = 48_000.0;
        let params = default_params(*kind);
        let ctx = ParamCtx::new(&params, sr, sr * 0.5);

        let run = |node: &mut FxNode, arena: &mut FxArena, mem: MemHandle| -> Vec<f32> {
            let mut l = signal(N, 0.5);
            let mut r = signal(N, 1.1);
            node.begin_block(arena.block(mem));
            node.prepare(&ctx);
            node.process(arena.block(mem), &mut l, &mut r);
            node.end_block(arena.block(mem));
            l.extend_from_slice(&r);
            l
        };

        let (mut fresh, mut fa, fm) = spawn(*kind, sr);
        let first = run(&mut fresh, &mut fa, fm);

        // Instance kedua dipanaskan dulu dengan materi lain, lalu di-reset.
        let (mut reused, mut ra, rm) = spawn(*kind, sr);
        for _ in 0..8 {
            let mut l = signal(N, 3.3);
            let mut r = signal(N, 4.7);
            reused.begin_block(ra.block(rm));
            reused.prepare(&ctx);
            reused.process(ra.block(rm), &mut l, &mut r);
            reused.end_block(ra.block(rm));
        }
        reused.reset(ra.block(rm));
        let after_reset = run(&mut reused, &mut ra, rm);

        assert_first_diff(
            kind.desc().id,
            "reset menyisakan state",
            &first,
            &after_reset,
        );
    }
}

/// Deskriptor harus konsisten — dan cukup kecil untuk dikirim ke UI.
#[test]
fn descriptors_are_within_budget() {
    for d in CATALOG {
        assert!(d.is_valid(), "{}: deskriptor tidak valid", d.id);
        assert!(
            d.params.len() <= 32,
            "{}: {} parameter, di atas 32 — knob-nya tidak akan muat di panel",
            d.id,
            d.params.len()
        );
    }
}

/// Ekor yang dilaporkan harus fungsi murni dari parameter dan sample rate —
/// bukan hasil pengukuran energi.
///
/// Kalau ia mengukur energi, nilainya bergantung pada slice yang kebetulan
/// diberikan pemanggil, jadi ambangnya dilewati di sample yang berbeda antara
/// render 128-frame dan 1024-frame. Chain per-clip lalu dibebaskan pada waktu
/// yang berbeda, urutan iterasi voice berubah, dan null-test gagal — secara
/// intermiten, hanya pada project yang punya ekor.
#[test]
fn tail_frames_does_not_depend_on_what_was_processed() {
    for kind in FxKind::ALL {
        let sr = 48_000.0;
        let params = default_params(*kind);
        let ctx = ParamCtx::new(&params, sr, sr * 0.5);
        let (mut node, mut arena, mem) = spawn(*kind, sr);
        let before = node.tail_frames(sr);

        for _ in 0..32 {
            let mut l = signal(128, 0.2);
            let mut r = signal(128, 0.8);
            node.begin_block(arena.block(mem));
            node.prepare(&ctx);
            node.process(arena.block(mem), &mut l, &mut r);
            node.end_block(arena.block(mem));
        }
        assert_eq!(
            before,
            node.tail_frames(sr),
            "{}: tail_frames berubah setelah memproses audio",
            kind.desc().id
        );

        // Dan ia harus konsisten dengan yang diiklankan deskriptor.
        let cap = (kind.desc().max_tail_ms as f32 * 0.001 * sr) as u32;
        assert!(
            node.tail_frames(sr) <= cap.max(1),
            "{}: ekor {} frame melebihi max_tail_ms yang dideklarasikan",
            kind.desc().id,
            node.tail_frames(sr)
        );
    }
}
