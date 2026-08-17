//! Tes export: round-trip kuantisasi, dither yang tidak bergantung sinyal
//! (ada di dither.rs), dan kesetaraan byte antara streaming dan sekali-jalan.

use std::io::Cursor;

use crate::dither::Tpdf;
use crate::wav::*;

fn test_signal(n: usize) -> (Vec<f32>, Vec<f32>) {
    let mut l = Vec::with_capacity(n);
    let mut r = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / 48_000.0;
        l.push((t * 440.0 * core::f32::consts::TAU).sin() * 0.8);
        r.push((t * 311.0 * core::f32::consts::TAU).sin() * 0.4);
    }
    (l, r)
}

fn spec(format: WavFormat) -> WavSpec {
    WavSpec {
        sample_rate: 48_000,
        channels: 2,
        format,
    }
}

fn decode(bytes: &[u8]) -> (Vec<f32>, Vec<f32>, hound::WavSpec) {
    let mut rd = hound::WavReader::new(Cursor::new(bytes)).expect("header valid");
    let s = rd.spec();
    let mut l = Vec::new();
    let mut r = Vec::new();
    match s.sample_format {
        hound::SampleFormat::Float => {
            for (i, v) in rd.samples::<f32>().enumerate() {
                let v = v.unwrap();
                if i % 2 == 0 {
                    l.push(v)
                } else {
                    r.push(v)
                }
            }
        }
        hound::SampleFormat::Int => {
            let scale = match s.bits_per_sample {
                16 => 32767.0,
                24 => 8_388_607.0,
                _ => 2147483647.0,
            };
            for (i, v) in rd.samples::<i32>().enumerate() {
                let v = v.unwrap() as f32 / scale;
                if i % 2 == 0 {
                    l.push(v)
                } else {
                    r.push(v)
                }
            }
        }
    }
    (l, r, s)
}

/// Round-trip: f32 dikenal → encode → decode dengan hound → nilainya harus
/// kembali dalam batas error kuantisasi yang diharapkan.
#[test]
fn roundtrip_pcm16() {
    let (l, r) = test_signal(4096);
    let bytes = encode_all(&[&l, &r], spec(WavFormat::Pcm16), DitherSettings::default());
    let (dl, dr, s) = decode(&bytes);
    assert_eq!(s.bits_per_sample, 16);
    assert_eq!(s.channels, 2);
    assert_eq!(dl.len(), l.len());
    // 1 LSB = 1/32767; dither TPDF menambah sampai ±1 LSB lagi → toleransi 2 LSB.
    let tol = 2.5 / 32767.0;
    for i in 0..l.len() {
        assert!((dl[i] - l[i]).abs() < tol, "L@{i}: {} vs {}", dl[i], l[i]);
        assert!((dr[i] - r[i]).abs() < tol, "R@{i}");
    }
}

#[test]
fn roundtrip_pcm24() {
    let (l, r) = test_signal(4096);
    let bytes = encode_all(&[&l, &r], spec(WavFormat::Pcm24), DitherSettings::default());
    let (dl, dr, s) = decode(&bytes);
    assert_eq!(s.bits_per_sample, 24);
    // Dither MATI untuk 24-bit secara default → error murni kuantisasi ≤ 0.5 LSB.
    let tol = 1.0 / 8_388_607.0;
    for i in 0..l.len() {
        assert!((dl[i] - l[i]).abs() < tol, "L@{i}");
        assert!((dr[i] - r[i]).abs() < tol, "R@{i}");
    }
}

#[test]
fn roundtrip_float32_is_bit_exact() {
    let (l, r) = test_signal(4096);
    let bytes = encode_all(&[&l, &r], spec(WavFormat::Float32), DitherSettings::default());
    let (dl, dr, s) = decode(&bytes);
    assert_eq!(s.sample_format, hound::SampleFormat::Float);
    // f32 tidak pernah di-dither dan tidak dikuantisasi → identik bit-per-bit.
    for i in 0..l.len() {
        assert_eq!(dl[i], l[i], "L@{i}");
        assert_eq!(dr[i], r[i], "R@{i}");
    }
}

#[test]
fn i24_packing_is_little_endian_and_sign_correct() {
    let l = vec![-1.0f32, 1.0, 0.0];
    let r = vec![-1.0f32, 1.0, 0.0];
    let bytes = encode_all(&[&l, &r], spec(WavFormat::Pcm24), DitherSettings::default());
    let data = &bytes[44..];
    // Sample pertama = -8388607 (clamp) → 0x800001 little-endian.
    assert_eq!(&data[0..3], &[0x01, 0x00, 0x80]);
    // Sample kedua (channel R, juga -1.0) sama.
    assert_eq!(&data[3..6], &[0x01, 0x00, 0x80]);
    // Full scale positif = 0x7FFFFF.
    assert_eq!(&data[6..9], &[0xFF, 0xFF, 0x7F]);
    // Nol.
    assert_eq!(&data[12..15], &[0x00, 0x00, 0x00]);
}

/// Chunk streaming yang disambung harus BYTE-IDENTIK dengan tulisan sekali jalan.
#[test]
fn streaming_chunks_equal_single_shot() {
    for format in [WavFormat::Pcm16, WavFormat::Pcm24, WavFormat::Float32] {
        let (l, r) = test_signal(200_000);
        let sp = spec(format);
        let ds = DitherSettings::default();
        let single = encode_all(&[&l, &r], sp, ds);

        // Chunk kecil (64 KiB) supaya banyak batas chunk terlewati di tes.
        let mut w = WavStreamWriter::with_chunk_size(sp, ds, 64 * 1024);
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&w.placeholder_header());
        let mut off = 0;
        while off < l.len() {
            let n = 1024.min(l.len() - off);
            w.write_planar(&[&l[off..off + n], &r[off..off + n]]);
            off += n;
            if w.poll_chunk().is_some() {
                let c = w.poll_chunk().unwrap().to_vec();
                out.extend_from_slice(&c);
                w.release_chunk();
            }
        }
        out.extend_from_slice(w.finish());
        // Patch header di akhir, setelah panjang total diketahui.
        out[0..44].copy_from_slice(&w.patch_header());

        assert_eq!(out.len(), single.len(), "{format:?} panjang");
        assert!(out == single, "{format:?} byte berbeda");
        // Dan hound tetap bisa membacanya.
        let (dl, _, _) = decode(&out);
        assert_eq!(dl.len(), l.len());
    }
}

/// Setelah chunk pertama, `release_chunk()` mempertahankan kapasitas → tidak ada
/// realokasi lagi (docs/03 §3b langkah 2).
#[test]
fn streaming_does_not_reallocate_after_first_chunk() {
    let (l, r) = test_signal(400_000);
    let mut w = WavStreamWriter::with_chunk_size(
        spec(WavFormat::Pcm24),
        DitherSettings::default(),
        64 * 1024,
    );
    let mut off = 0;
    while off < l.len() {
        let n = 1024.min(l.len() - off);
        w.write_planar(&[&l[off..off + n], &r[off..off + n]]);
        off += n;
        if w.poll_chunk().is_some() {
            w.release_chunk();
        }
    }
    assert_eq!(w.grow_events(), 0, "Vec chunk tumbuh {} kali", w.grow_events());
}

/// Export byte-reproducible: seed yang sama → file yang sama persis.
#[test]
fn dithered_export_is_byte_reproducible() {
    let (l, r) = test_signal(20_000);
    let ds = DitherSettings {
        dither_16: true,
        dither_24: false,
        seed: 0xABCD_1234_5678_9F01,
    };
    let a = encode_all(&[&l, &r], spec(WavFormat::Pcm16), ds);
    let b = encode_all(&[&l, &r], spec(WavFormat::Pcm16), ds);
    assert_eq!(a, b);
    let c = encode_all(
        &[&l, &r],
        spec(WavFormat::Pcm16),
        DitherSettings { seed: 1, ..ds },
    );
    assert_ne!(a, c, "seed berbeda harus menghasilkan noise dither berbeda");
}

#[test]
fn hound_path_decodes_to_the_same_values() {
    let (l, r) = test_signal(2048);
    let ds = DitherSettings {
        dither_16: false,
        ..Default::default()
    };
    let mine = encode_all(&[&l, &r], spec(WavFormat::Pcm16), ds);
    let theirs = encode_all_hound(&[&l, &r], spec(WavFormat::Pcm16), ds).unwrap();
    let (a, _, _) = decode(&mine);
    let (b, _, _) = decode(&theirs);
    assert_eq!(a, b);
}

#[test]
fn dither_never_applies_to_float32() {
    let mut d = Tpdf::new(1);
    let _ = d.next();
    let (l, r) = test_signal(64);
    let with = DitherSettings {
        dither_16: true,
        dither_24: true,
        seed: 5,
    };
    let a = encode_all(&[&l, &r], spec(WavFormat::Float32), with);
    let b = encode_all(
        &[&l, &r],
        spec(WavFormat::Float32),
        DitherSettings {
            seed: 999_999,
            ..with
        },
    );
    assert_eq!(a, b, "f32 tidak boleh terpengaruh setelan dither");
}

// ----------------------------------------------------------------- offline

mod offline_tests {
    use crate::offline::OfflineRenderer;
    use daw_engine::snapshot::{BusDesc, ClipDesc, Project, TrackDesc};
    use daw_engine::voice::Asset;
    use daw_engine::Engine;
    use daw_timeline::TimelineSample;

    fn engine_with_tone(pcm: &[f32], frames: usize) -> Engine {
        let mut p = Project {
            sample_rate: 48_000,
            ..Default::default()
        };
        p.buses.push(BusDesc::default());
        p.tracks.push(TrackDesc {
            dest_bus: 0,
            ..Default::default()
        });
        p.clips.push(ClipDesc {
            track: 0,
            asset: 0,
            start: 0,
            len: frames as u64,
            ..Default::default()
        });
        let mut e = Engine::new(48_000, 128);
        // SAFETY: pemanggil menjaga `pcm` tetap hidup selama engine dipakai.
        unsafe {
            e.register_asset(
                0,
                Asset {
                    data: pcm.as_ptr(),
                    frames,
                    channels: 1,
                    sample_rate: 48_000,
                },
            );
        }
        e.load_project(p).unwrap();
        e
    }

    #[test]
    fn offline_render_counts_frames_and_finishes() {
        let frames = 48_000;
        let pcm: Vec<f32> = (0..frames)
            .map(|i| ((i as f32 / 48_000.0) * 440.0 * core::f32::consts::TAU).sin() * 0.5)
            .collect();
        let e = engine_with_tone(&pcm, frames);
        let total = 20_000u64;
        let mut r = OfflineRenderer::new(e, TimelineSample(0), TimelineSample(total));
        assert_eq!(r.total_frames(), total);

        let mut l = vec![0.0f32; 128 * 100];
        let mut rr = vec![0.0f32; 128 * 100];
        let mut acc = 0u64;
        loop {
            let n = r.render_batch(100, &mut l, &mut rr);
            if n == 0 {
                break;
            }
            acc += n as u64;
        }
        assert_eq!(acc, total);
        assert_eq!(r.rendered_frames(), total);
        assert!(r.is_finished());
        assert!((r.progress() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cancellation_stops_rendering() {
        let frames = 48_000;
        let pcm = vec![0.25f32; frames];
        let e = engine_with_tone(&pcm, frames);
        let mut r = OfflineRenderer::new(e, TimelineSample(0), TimelineSample(200_000));
        let mut l = vec![0.0f32; 128 * 100];
        let mut rr = vec![0.0f32; 128 * 100];

        let n1 = r.render_batch(100, &mut l, &mut rr);
        assert!(n1 > 0);
        r.request_cancel();
        assert_eq!(r.render_batch(100, &mut l, &mut rr), 0);
        assert!(r.rendered_frames() < r.total_frames());
    }

    /// Offline HARUS memakai `Engine::render_block` yang sama: hasil render
    /// batch = hasil render blok-per-blok manual, sample-identik.
    #[test]
    fn offline_matches_direct_render_block() {
        let frames = 48_000;
        let pcm: Vec<f32> = (0..frames).map(|i| (i % 97) as f32 / 97.0 - 0.5).collect();
        let total = 12_800usize;

        let e1 = engine_with_tone(&pcm, frames);
        let mut r = OfflineRenderer::new(e1, TimelineSample(0), TimelineSample(total as u64));
        let mut al = vec![0.0f32; total];
        let mut ar = vec![0.0f32; total];
        let n = r.render_batch(100, &mut al, &mut ar);
        assert_eq!(n, total);

        let mut e2 = engine_with_tone(&pcm, frames);
        e2.seek(TimelineSample(0));
        e2.play();
        let mut bl = vec![0.0f32; total];
        let mut br = vec![0.0f32; total];
        let mut off = 0;
        while off < total {
            e2.render_block(&mut bl[off..off + 128], &mut br[off..off + 128]);
            off += 128;
        }
        for i in 0..total {
            assert_eq!(al[i], bl[i], "@{i}");
        }
    }
}

/// Tes FLAC.
///
/// Yang dibuktikan di sini bukan "flacenc benar" (itu urusan crate-nya), tapi
/// dua hal yang MILIK KITA dan bisa rusak diam-diam: (1) writer streaming
/// menghasilkan byte yang identik dengan encode sekali-jalan pustaka — artinya
/// pemotongan blok kita tidak menggeser apa pun, dan (2) header placeholder dan
/// header final sama panjang, syarat mutlak agar penukaran part pertama Blob di
/// `run-export.ts` tidak merusak file.
mod flac_tests {
    use crate::flac::*;
    use crate::wav::{encode_all as wav_encode_all, DitherSettings, WavFormat, WavSpec};

    use flacenc::bitsink::MemSink;
    use flacenc::component::BitRepr;
    use flacenc::config;
    use flacenc::encode_with_fixed_block_size;
    use flacenc::error::Verify;
    use flacenc::source::MemSource;

    fn signal(n: usize) -> (Vec<f32>, Vec<f32>) {
        super::test_signal(n)
    }

    fn spec24() -> FlacSpec {
        FlacSpec {
            sample_rate: 48_000,
            channels: 2,
            bits: FlacBits::Pcm24,
        }
    }

    /// Dither dimatikan di seluruh tes ini: dither menambahkan noise acak, dan
    /// perbandingan byte-per-byte hanya bermakna kalau encoder deterministik.
    fn no_dither() -> DitherSettings {
        DitherSettings {
            dither_16: false,
            dither_24: false,
            seed: 1,
        }
    }

    #[test]
    fn header_is_valid_flac_and_fixed_length() {
        let (l, r) = signal(1000);
        let bytes = encode_all(&[&l, &r], spec24(), no_dither()).unwrap();
        assert_eq!(&bytes[0..4], b"fLaC");
        // last-metadata-block + type 0 (STREAMINFO), panjang 34.
        assert_eq!(bytes[4], 0x80);
        assert_eq!(&bytes[5..8], &[0, 0, 34]);

        let mut w = FlacStreamWriter::new(spec24(), no_dither()).unwrap();
        let placeholder = w.placeholder_header().unwrap();
        w.write_planar(&[&l, &r]).unwrap();
        w.finish().unwrap();
        let final_header = w.patch_header().unwrap();
        assert_eq!(placeholder.len(), HEADER_BYTES);
        assert_eq!(final_header.len(), placeholder.len());
        // Placeholder benar-benar KOSONG isinya; kalau tidak, file yang ditulis
        // sebelum patch akan mengklaim panjang yang salah.
        assert_ne!(placeholder, final_header);
    }

    #[test]
    fn total_samples_and_channels_land_in_streaminfo() {
        let (l, r) = signal(5000);
        let bytes = encode_all(&[&l, &r], spec24(), no_dither()).unwrap();
        // STREAMINFO mulai di byte 8. total_samples = 36 bit terakhir sebelum md5.
        let si = &bytes[8..42];
        let sr = (u32::from(si[10]) << 12) | (u32::from(si[11]) << 4) | (u32::from(si[12]) >> 4);
        assert_eq!(sr, 48_000);
        let channels = ((si[12] >> 1) & 0b111) + 1;
        assert_eq!(channels, 2);
        let total = ((u64::from(si[13]) & 0x0F) << 32)
            | (u64::from(si[14]) << 24)
            | (u64::from(si[15]) << 16)
            | (u64::from(si[16]) << 8)
            | u64::from(si[17]);
        assert_eq!(total, 5000);
        // md5 tidak boleh nol: itu yang membuktikan Context ikut diisi.
        assert_ne!(&bytes[26..42], &[0u8; 16]);
    }

    /// Memotong input jadi banyak panggilan `write_planar` TIDAK boleh mengubah
    /// satu byte pun. Ini yang gampang rusak: batas blok FLAC (4096) tidak ada
    /// hubungannya dengan batas batch render (12800).
    #[test]
    fn streaming_equals_one_shot() {
        let (l, r) = signal(20_000);
        let one_shot = encode_all(&[&l, &r], spec24(), no_dither()).unwrap();

        let mut w = FlacStreamWriter::with_chunk_size(spec24(), no_dither(), usize::MAX).unwrap();
        let mut body = Vec::new();
        let mut off = 0;
        // Ukuran batch yang sengaja bukan kelipatan 4096.
        for step in [1000usize, 4095, 4097, 128, 333] {
            loop {
                if off >= l.len() {
                    break;
                }
                let end = (off + step).min(l.len());
                w.write_planar(&[&l[off..end], &r[off..end]]).unwrap();
                off = end;
                break;
            }
        }
        while off < l.len() {
            let end = (off + 4096).min(l.len());
            w.write_planar(&[&l[off..end], &r[off..end]]).unwrap();
            off = end;
        }
        body.extend_from_slice(w.finish().unwrap());
        let mut streamed = w.patch_header().unwrap();
        streamed.extend_from_slice(&body);

        assert_eq!(streamed.len(), one_shot.len());
        assert_eq!(streamed, one_shot);
    }

    /// Pembanding independen: byte kita harus sama dengan yang dihasilkan jalur
    /// resmi flacenc untuk sample yang sama. Kalau ini gagal, salah satu dari
    /// penomoran frame / pengisian Context / framing metadata kita salah.
    #[test]
    fn matches_flacenc_reference_encoder() {
        let (l, r) = signal(12_000);
        let ours = encode_all(&[&l, &r], spec24(), no_dither()).unwrap();

        // Kuantisasi yang SAMA dengan yang dipakai writer kita.
        let mut interleaved = Vec::with_capacity(l.len() * 2);
        for i in 0..l.len() {
            for c in [&l, &r] {
                interleaved.push(crate::dither::quantize(
                    c[i],
                    8_388_607.0,
                    -8_388_608.0,
                    8_388_607.0,
                    None,
                ));
            }
        }
        let src = MemSource::from_samples(&interleaved, 2, 24, 48_000);
        let stream = encode_with_fixed_block_size(
            &config::Encoder::default().into_verified().unwrap(),
            src,
            BLOCK_SIZE,
        )
        .unwrap();
        let mut sink = MemSink::<u8>::new();
        stream.write(&mut sink).unwrap();
        assert_eq!(ours, sink.into_inner());
    }

    /// Alasan seluruh fitur ini ada: file harus benar-benar lebih kecil.
    #[test]
    fn flac_is_smaller_than_wav_for_the_same_signal() {
        let (l, r) = signal(48_000);
        let flac = encode_all(&[&l, &r], spec24(), no_dither()).unwrap();
        let wav = wav_encode_all(
            &[&l, &r],
            WavSpec {
                sample_rate: 48_000,
                channels: 2,
                format: WavFormat::Pcm24,
            },
            no_dither(),
        );
        assert!(
            flac.len() < wav.len(),
            "flac {} byte tidak lebih kecil dari wav {} byte",
            flac.len(),
            wav.len()
        );
    }
}
