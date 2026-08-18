//! Tes deteksi tempo pada materi sintetis dengan BPM yang SUDAH DIKETAHUI.
//!
//! Kenapa sintetis dan bukan file audio: sebuah tes yang butuh MP3 di repo
//! hanya bisa gagal dengan cara yang tidak bisa didiagnosis ("kenapa 128.4?").
//! Sinyal yang dibangkitkan di sini punya kebenaran mutlak — kalau tesnya gagal,
//! yang salah pasti algoritmanya.
//!
//! Materinya dibuat menyerupai apa yang benar-benar sulit: kick di setiap
//! ketukan (band bawah), hi-hat di setiap 1/8 (band atas, jadi ada godaan
//! tempo-dobel), snare di ketukan 2 dan 4 (godaan tempo-separuh), plus dinamika
//! keras/lirih supaya jalur log di ODF ikut teruji.

use daw_analysis::{detect_bpm, BpmEstimate};

const SR: f32 = 48_000.0;

/// Derau deterministik — LCG. `rand` tidak dipakai supaya hasil tes identik di
/// setiap mesin; deteksi tempo yang lulus di CI tapi gagal di laptop karena
/// benihnya berbeda adalah tes yang tidak berguna.
struct Lcg(u32);
impl Lcg {
    fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((self.0 >> 8) as f32 / 8_388_608.0) - 1.0
    }
}

/// Tambahkan bunyi berpeluruh eksponensial di `at` detik.
///
/// `bright` membedakan hi-hat dari snare: derau dibedakan (beda antar-sample),
/// yang memiringkan spektrumnya +6 dB/oktaf. Ini BUKAN kosmetik. Derau putih
/// polos punya energi penuh sampai ke 55 Hz, jadi hi-hat sintetis akan memicu
/// keenam band ODF sekaligus dan menghasilkan flux LEBIH BESAR dari kick —
/// membuat materi uji jadi grid 1/8 yang seragam, yang secara musik memang
/// ambigu (170 dengan 1/8 vs 113 dengan triplet). Hi-hat sungguhan hampir tidak
/// punya low-end; tanpa kemiringan ini yang diuji bukan musik, melainkan
/// artefak generator.
fn hit(
    buf: &mut [f32],
    at_sec: f32,
    freq: f32,
    decay_sec: f32,
    amp: f32,
    noise: Option<(&mut Lcg, bool)>,
) {
    let start = (at_sec * SR) as usize;
    let len = (decay_sec * 4.0 * SR) as usize;
    let k = 1.0 / (decay_sec * SR);
    match noise {
        Some((rng, bright)) => {
            let mut prev = 0.0f32;
            for i in 0..len {
                let n = start + i;
                if n >= buf.len() {
                    break;
                }
                let env = libm::expf(-(i as f32) * k);
                let raw = rng.next_f32();
                let v = if bright { 0.5 * (raw - prev) } else { raw };
                prev = raw;
                buf[n] += amp * env * v;
            }
        }
        None => {
            for i in 0..len {
                let n = start + i;
                if n >= buf.len() {
                    break;
                }
                let env = libm::expf(-(i as f32) * k);
                let ph = 2.0 * core::f32::consts::PI * freq * (i as f32 / SR);
                buf[n] += amp * env * libm::sinf(ph);
            }
        }
    }
}

/// Pola LURUS: kick di tiap ketukan, hi-hat di tiap 1/8, tanpa backbeat.
///
/// Dipakai untuk menguji penanganan oktaf secara bersih. Tidak ada asimetri
/// antar-ketukan di sini, jadi satu-satunya kandidat saingan adalah kelipatan
/// dan pembagi periode — persis yang harus diselesaikan sisir + prior.
fn straight(bpm: f32, secs: f32) -> Vec<f32> {
    let mut buf = vec![0.0f32; (secs * SR) as usize];
    let mut rng = Lcg(0x2222_3333);
    let beat = 60.0 / bpm;
    let mut b = 0usize;
    while (b as f32) * beat < secs {
        let t = b as f32 * beat;
        hit(&mut buf, t, 55.0, 0.09, 0.9, None);
        hit(
            &mut buf,
            t + beat * 0.5,
            0.0,
            0.012,
            0.22,
            Some((&mut rng, true)),
        );
        b += 1;
    }
    buf
}

/// Groove empat-per-empat lengkap pada `bpm`, panjang `secs`.
fn groove(bpm: f32, secs: f32) -> Vec<f32> {
    let mut buf = vec![0.0f32; (secs * SR) as usize];
    let mut rng = Lcg(0x1234_5678);
    let beat = 60.0 / bpm;
    let mut b = 0usize;
    loop {
        let t = b as f32 * beat;
        if t >= secs {
            break;
        }
        // Dinamika: delapan bar lirih, delapan bar keras. Menguji bahwa selisih
        // log di ODF membuat kedua bagian menyumbang setara.
        let loud = if (b / 32) % 2 == 0 { 0.35 } else { 1.0 };

        hit(&mut buf, t, 55.0, 0.09, 0.9 * loud, None); // kick
        if b % 4 == 2 {
            hit(&mut buf, t, 220.0, 0.05, 0.5 * loud, None); // snare tonal
            hit(&mut buf, t, 0.0, 0.04, 0.4 * loud, Some((&mut rng, false))); // + derau
        }
        // Hi-hat di 1/8 — sumber godaan tempo dobel.
        hit(
            &mut buf,
            t + beat * 0.5,
            0.0,
            0.012,
            0.22 * loud,
            Some((&mut rng, true)),
        );
        b += 1;
    }
    buf
}

fn detect(buf: &[f32]) -> BpmEstimate {
    detect_bpm(buf, &[], SR).expect("materi cukup panjang, harus ada hasil")
}

#[test]
fn mengenali_tempo_umum_dalam_toleransi_setengah_bpm() {
    // Rentang di mana backbeat dan ketukan sepakat secara perseptual. Untuk
    // tempo di atas ~150 dengan backbeat, lihat `pola_half_time_ambigu`.
    for &bpm in &[90.0f32, 100.0, 120.0, 128.0, 140.0] {
        let est = detect(&groove(bpm, 40.0));
        assert!(
            (est.bpm - bpm).abs() < 0.5,
            "bpm {bpm}: terdeteksi {} (conf {})",
            est.bpm,
            est.confidence
        );
        assert!(
            est.confidence > 0.2,
            "bpm {bpm}: keyakinan terlalu rendah ({})",
            est.confidence
        );
    }
}

#[test]
fn tidak_terkecoh_jadi_dobel_atau_separuh() {
    let est = detect(&groove(128.0, 40.0));
    assert!(
        (est.bpm - 64.0).abs() > 4.0 && (est.bpm - 256.0).abs() > 4.0,
        "terkunci ke oktaf yang salah: {}",
        est.bpm
    );
}

#[test]
fn stereo_sama_dengan_mono() {
    let mono = groove(128.0, 40.0);
    let a = detect_bpm(&mono, &[], SR).unwrap();
    let b = detect_bpm(&mono, &mono, SR).unwrap();
    assert!((a.bpm - b.bpm).abs() < 0.01, "{} vs {}", a.bpm, b.bpm);
}

#[test]
fn derau_putih_murni_tidak_boleh_terdengar_yakin() {
    let mut rng = Lcg(99);
    let buf: Vec<f32> = (0..(40.0 * SR) as usize)
        .map(|_| rng.next_f32() * 0.3)
        .collect();
    // Angka BPM apa pun boleh keluar — yang TIDAK boleh adalah mengaku yakin.
    // Materi tanpa ketukan harus terbaca sebagai "tidak tahu" di UI.
    let est = detect_bpm(&buf, &[], SR).unwrap();
    // 0.1 = ambang yang benar-benar dipakai UI. Derau putih yang diukur lewat
    // artefak WASM mencetak 0.015, jadi margin-nya nyata dan bukan kebetulan.
    assert!(
        est.confidence < 0.1,
        "derau putih dinyatakan {} BPM dengan keyakinan {}",
        est.bpm,
        est.confidence
    );
}

#[test]
fn senyap_dan_materi_pendek_mengembalikan_none() {
    assert!(detect_bpm(&vec![0.0; (40.0 * SR) as usize], &[], SR).is_none());
    // 4 detik: di bawah MIN_SECONDS.
    assert!(detect_bpm(&groove(120.0, 4.0), &[], SR).is_none());
    assert!(detect_bpm(&[], &[], SR).is_none());
    assert!(detect_bpm(&groove(120.0, 40.0), &[], 0.0).is_none());
}

#[test]
fn fase_ketukan_menunjuk_ke_ketukan_pertama() {
    // Groove dimulai tepat di t=0, jadi offset harus mendekati 0 — atau
    // mendekati satu periode penuh (ekuivalen secara fase).
    let est = detect(&groove(120.0, 40.0));
    let period = 60.0 / 120.0;
    let off = est.beat_offset_sec % period;
    let dist = off.min(period - off);
    assert!(
        dist < 0.03,
        "offset {} (period {period})",
        est.beat_offset_sec
    );
}

#[test]
fn sample_rate_lain_memberi_bpm_yang_sama() {
    // 44.1 kHz membuat hop ODF tidak bulat (220.5 → 221). Kalau laju frame
    // nominal dipakai alih-alih laju sebenarnya, BPM akan bergeser ~0.2%.
    const SR2: f32 = 44_100.0;
    let bpm = 128.0;
    let beat = 60.0 / bpm;
    let secs = 40.0;
    let mut buf = vec![0.0f32; (secs * SR2) as usize];
    let mut b = 0usize;
    while (b as f32) * beat < secs {
        let start = ((b as f32) * beat * SR2) as usize;
        let len = (0.09 * 4.0 * SR2) as usize;
        for i in 0..len {
            let n = start + i;
            if n >= buf.len() {
                break;
            }
            let env = (-(i as f32) / (0.09 * SR2)).exp();
            let ph = 2.0 * core::f32::consts::PI * 55.0 * (i as f32 / SR2);
            buf[n] += 0.9 * env * ph.sin();
        }
        b += 1;
    }
    let est = detect_bpm(&buf, &[], SR2).unwrap();
    assert!(
        (est.bpm - bpm).abs() < 0.6,
        "44.1k: {} (conf {})",
        est.bpm,
        est.confidence
    );
}

#[test]
fn tempo_cepat_terbaca_benar_pada_pola_lurus() {
    // Tanpa backbeat, 150–180 BPM tidak punya tafsir separuh yang sah, jadi di
    // sini deteksinya memang WAJIB tepat. Kalau tes ini jatuh, yang rusak
    // adalah penanganan oktaf — bukan ambiguitas musik.
    for &bpm in &[150.0f32, 170.0, 180.0] {
        let est = detect(&straight(bpm, 40.0));
        assert!(
            (est.bpm - bpm).abs() < 0.8,
            "bpm {bpm}: terdeteksi {} (conf {})",
            est.bpm,
            est.confidence
        );
    }
}

#[test]
fn pola_half_time_terurai_ke_tempo_ketukan() {
    // Kick tiap ketukan pada 170 BPM DENGAN snare tiap 2 ketukan adalah "half-
    // time feel": periode 2-ketukan JUSTRU lebih mirip-dirinya-sendiri karena
    // snare-nya berselang-seling, jadi autokorelasi mentah memilih 85. Yang
    // membalikkannya adalah hukuman subdivisi — grid 85 BPM melewatkan kick di
    // tengah tiap periodenya, dan 170 BPM adalah tempo yang masuk akal.
    //
    // Tetap dicatat: 85 bukan jawaban yang "salah" secara musik, dan karena itu
    // UI menyediakan ×2 / ÷2. Yang diuji di sini adalah bahwa tebakan PERTAMA
    // jatuh pada tempo ketukan, bukan pada backbeat-nya.
    let est = detect(&groove(170.0, 40.0));
    assert!(
        (est.bpm - 170.0).abs() < 2.0,
        "diharapkan ~170 (atau 85 kalau hukuman subdivisi dilonggarkan): {} conf {}",
        est.bpm,
        est.confidence
    );
}
