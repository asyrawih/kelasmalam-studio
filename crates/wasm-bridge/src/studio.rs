//! PEMETAAN model UI (`web/src/studio/model.ts`) → model engine
//! (`daw_engine::snapshot::Project`). **Satu-satunya** tempat pemetaan ini
//! hidup.
//!
//! Kenapa di Rust dan bukan di TypeScript: snapshot engine adalah postcard,
//! sebuah format biner yang tata letaknya ditentukan oleh definisi tipe Rust —
//! menuliskannya dari TS berarti menyalin ulang tata letak itu dengan tangan,
//! dan setiap `#[derive(Serialize)]` yang berubah di masa depan akan merusak
//! export secara diam-diam. Yang dikirim TS adalah JSON dengan nama field
//! miliknya sendiri; serde yang menerjemahkan.
//!
//! Kenapa ada dua nama untuk hal yang sama: UI dan engine dikembangkan
//! terpisah. Daftar selisihnya, dan apa yang dilakukan terhadap masing-masing:
//!
//! | UI                    | Engine                | Perlakuan |
//! |---|---|---|
//! | `lane`                | `track`               | nama saja |
//! | `lane.speedRatio`     | `ClipDesc.speed`      | varispeed lane disebar ke tiap clip-nya (engine tidak punya speed per track) |
//! | transport `speed`     | —                     | dilipat ke `speed` clip DAN ke skala posisi/panjang timeline (lihat `Mapping::transport_speed`) |
//! | `mute` + `solo`       | `TrackDesc.mute`      | solo global dilipat jadi mute efektif — engine tidak punya opcode solo |
//! | `fadeInMs/fadeOutMs`  | `fade_in/out` sample  | ms → sample, dibagi transport speed (fade diukur di waktu timeline) |
//! | `fadeCurve`           | `ClipDesc.fade_curve` | didukung penuh sejak equal-power masuk engine (`voice::fade_gain`) |
//! | EQ 4 band parametrik  | `TrackDesc.eq`        | `lowshelf/peaking/highshelf` → `daw_dsp::FilterKind` |
//! | `gainDb`              | `gain_db`             | sama-sama dB, tidak ada konversi |
//! | `masterGainDb`        | `buses[0].gain_db`    | fader master (⑮ docs/07): satu-satunya gain SESUDAH semua track dijumlahkan |
//! | —                     | `pan`, `sends`, `comp`| UI belum punya; `sends`/`comp` netral, `pan` tengah + dikompensasi (lihat `CENTER_PAN_COMPENSATION_DB`) |
//!
//! Apa pun yang TIDAK bisa dinyatakan engine dilaporkan lewat
//! [`Mapping::warnings`], bukan dibuang diam-diam: export yang berbeda dari
//! preview tanpa memberi tahu adalah kegagalan yang paling mahal untuk
//! ditemukan user (docs/03).

use daw_engine::snapshot::{
    BusDesc, ClipDesc, EqBandSettings, Project, TrackDesc, EQ_BANDS, FADE_EQUAL_POWER, FADE_LINEAR,
};

use serde::Deserialize;

/// `daw_dsp::FilterKind` sebagai angka (urutannya adalah kontraknya —
/// `EqBandSettings::kind` menyimpan diskriminan enum itu apa adanya).
const KIND_LOW_SHELF: u8 = 2;
const KIND_HIGH_SHELF: u8 = 3;
const KIND_PEAKING: u8 = 4;

/// Kompensasi hukum pan equal-power engine di posisi TENGAH.
///
/// `daw_engine::track::pan_gains(0.0)` menghasilkan `(1/√2, 1/√2)` — turun
/// 3,01 dB, yang memang benar untuk hukum pan equal-power dan memang yang
/// diinginkan begitu sebuah track bisa di-pan. Masalahnya: UI belum punya
/// kontrol pan sama sekali, dan preview (Web Audio) tidak memasang node panner
/// apa pun. Tanpa kompensasi ini file hasil export akan 3 dB LEBIH PELAN dari
/// yang barusan didengar user — selisih yang jelas terdengar, dan yang akan
/// ditafsirkan sebagai "export-nya rusak".
///
/// HAPUS konstanta ini begitu UI punya kontrol pan sungguhan: saat itu hukum
/// pan harus terdengar apa adanya, dan preview yang harus menyusul.
const CENTER_PAN_COMPENSATION_DB: f32 = 3.010_3;

/// Batas amplify master — cerminan `MIN/MAX_MASTER_GAIN_DB` di `model.ts`.
///
/// Slider UI sudah menjepitnya, jadi nilai di luar rentang ini hanya bisa
/// datang dari project yang disunting tangan atau dari versi UI lain. Di-clamp
/// dan DILAPORKAN, bukan dipakai apa adanya: `masterGainDb: 60` akan menghasilkan
/// file yang rusak total, dan file rusak tanpa keterangan adalah kegagalan
/// termahal yang bisa kita kirim.
const MIN_MASTER_GAIN_DB: f32 = -24.0;
const MAX_MASTER_GAIN_DB: f32 = 12.0;

// ---------------------------------------------------------------------------
// Bentuk JSON — cerminan `web/src/studio/model.ts`
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProjectJson {
    pub sample_rate: u32,
    /// Kecepatan transport (0.5 … 2). Export menulis file di JAM DINDING, jadi
    /// transport 2× menghasilkan file separuh panjang — persis seperti preview.
    #[serde(default = "one_f64")]
    pub speed: f64,
    /// Amplify master (dB). Panel AMPLIFY di UI memasangnya sebagai satu
    /// GainNode yang dilewati SEMUA lane sebelum destination; di sini ia jadi
    /// fader bus master, yang di `build_plan` dieksekusi tepat setelah seluruh
    /// track dijumlahkan ke akumulator master (⑮ docs/07 §7a). Titiknya sama,
    /// jadi file hasil export selevel dengan yang barusan didengar.
    #[serde(default)]
    pub master_gain_db: f32,
    #[serde(default)]
    pub lanes: Vec<LaneJson>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneJson {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub solo: bool,
    #[serde(default)]
    pub gain_db: f32,
    #[serde(default = "one_f64")]
    pub speed_ratio: f64,
    #[serde(default)]
    pub eq: EqJson,
    #[serde(default)]
    pub clips: Vec<ClipJson>,
}

#[derive(Debug, Default, Deserialize)]
pub struct EqJson {
    #[serde(default)]
    pub bands: Vec<EqBandJson>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBandJson {
    /// `lowshelf` | `peaking` | `highshelf` — sama persis dengan
    /// `BiquadFilterType` Web Audio, jadi UI tidak perlu memetakan apa pun.
    #[serde(default)]
    pub kind: String,
    #[serde(default = "default_freq")]
    pub freq: f32,
    #[serde(default = "default_q")]
    pub q: f32,
    #[serde(default)]
    pub gain_db: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipJson {
    #[serde(default)]
    pub id: String,
    /// Id asset yang HARUS sudah didaftarkan lewat `OfflineRender::registerAsset`.
    pub asset_id: u32,
    /// Posisi mulai di timeline (sample, ruang timeline sebelum transport speed).
    pub start: f64,
    /// Panjang di timeline (sample).
    pub len: f64,
    /// Trim-in di dalam source (sample, ruang SOURCE).
    #[serde(default)]
    pub source_start: f64,
    #[serde(default)]
    pub gain_db: f32,
    #[serde(default)]
    pub fade_in_ms: f64,
    #[serde(default)]
    pub fade_out_ms: f64,
    /// `linear` | `equalPower`.
    #[serde(default)]
    pub fade_curve: String,
}

fn one_f64() -> f64 {
    1.0
}
fn default_freq() -> f32 {
    1000.0
}
fn default_q() -> f32 {
    0.707
}

// ---------------------------------------------------------------------------
// Hasil pemetaan
// ---------------------------------------------------------------------------

/// Project engine + catatan tentang apa yang TIDAK bisa dipetakan utuh.
pub struct Mapping {
    pub project: Project,
    /// Selisih nyata antara yang didengar user dan yang akan ditulis ke file.
    /// Kosong = export identik dengan preview.
    pub warnings: Vec<String>,
}

/// Batas nilai yang sama dengan `clampEqBand` di `model.ts` — nilai dari
/// project lama atau drag yang meleset tidak boleh membuat biquad meledak.
fn clamp_band(b: &EqBandJson) -> EqBandSettings {
    let kind = match b.kind.as_str() {
        "lowshelf" => KIND_LOW_SHELF,
        "highshelf" => KIND_HIGH_SHELF,
        _ => KIND_PEAKING,
    };
    let freq = if b.freq.is_finite() { b.freq } else { 20.0 };
    let q = if b.q.is_finite() { b.q } else { 1.0 };
    let gain_db = if b.gain_db.is_finite() { b.gain_db } else { 0.0 };
    EqBandSettings {
        kind,
        freq_hz: freq.clamp(20.0, 20_000.0),
        q: q.clamp(0.1, 18.0),
        gain_db: gain_db.clamp(-18.0, 18.0),
        // Band selalu AKTIF, termasuk yang 0 dB. Preview juga selalu merangkai
        // keempat BiquadFilterNode-nya; mematikan yang 0 dB di sini akan
        // menghilangkan pergeseran fasa yang sudah ikut terdengar di preview.
        enabled: true,
    }
}

fn nonneg(x: f64) -> f64 {
    if x.is_finite() && x > 0.0 {
        x
    } else {
        0.0
    }
}

/// Petakan JSON studio → `Project` engine.
///
/// `end_sample` (ruang OUTPUT, sesudah transport speed) dipakai hanya untuk
/// membuang clip yang seluruhnya di luar rentang render.
pub fn map_project(src: &StudioProjectJson) -> Result<Mapping, String> {
    let mut warnings: Vec<String> = Vec::new();

    let sample_rate = if src.sample_rate == 0 {
        48_000
    } else {
        src.sample_rate
    };
    // Transport speed melipat DUA hal sekaligus: ruang waktu output mengerut
    // (`1/speed`) dan pembacaan source mempercepat (`×speed`). Keduanya harus
    // konsisten atau clip akan mulai di tempat yang benar tapi berbunyi salah.
    let tspeed = if src.speed.is_finite() && src.speed > 0.0 {
        src.speed
    } else {
        1.0
    };

    // Satu bus master. UI belum punya bus/group sama sekali.
    //
    // Amplify master masuk sebagai fader bus ini. Tidak ada perkalian ke gain
    // tiap track: menyebarnya ke track akan diterapkan SEBELUM insert chain
    // track dan mengubah cara kompresor bereaksi — bukan yang didengar user di
    // preview, tempat gain-nya duduk sesudah semuanya.
    let master_gain_db = if src.master_gain_db.is_finite() {
        src.master_gain_db
    } else {
        0.0
    };
    if master_gain_db < MIN_MASTER_GAIN_DB || master_gain_db > MAX_MASTER_GAIN_DB {
        warnings.push(format!(
            "Amplify master {master_gain_db:.1} dB di luar rentang {MIN_MASTER_GAIN_DB:.0}…{MAX_MASTER_GAIN_DB:.0} dB; dipotong ke batas."
        ));
    }
    let buses = vec![BusDesc {
        gain_db: master_gain_db.clamp(MIN_MASTER_GAIN_DB, MAX_MASTER_GAIN_DB),
        ..BusDesc::default()
    }];
    let mut tracks: Vec<TrackDesc> = Vec::new();
    let mut clips: Vec<ClipDesc> = Vec::new();

    // Solo global: kalau ADA lane yang solo, lane tanpa solo terhitung mute.
    // Ini `isAudible()` di model.ts, ditulis ulang di sini karena engine tidak
    // punya konsep solo — dan lipatan ini HARUS terjadi sebelum snapshot,
    // bukan sesudahnya.
    let any_solo = src.lanes.iter().any(|l| l.solo);

    for lane in &src.lanes {
        if tracks.len() >= u16::MAX as usize {
            break;
        }
        let track_index = tracks.len() as u16;
        let audible = !lane.mute && (!any_solo || lane.solo);

        let mut eq = [EqBandSettings::default(); EQ_BANDS];
        if lane.eq.bands.len() > EQ_BANDS {
            warnings.push(format!(
                "Lane \"{}\" punya {} band EQ; engine hanya memproses {} band pertama.",
                lane.id,
                lane.eq.bands.len(),
                EQ_BANDS
            ));
        }
        for (i, b) in lane.eq.bands.iter().take(EQ_BANDS).enumerate() {
            eq[i] = clamp_band(b);
        }

        tracks.push(TrackDesc {
            gain_db: if lane.gain_db.is_finite() {
                lane.gain_db + CENTER_PAN_COMPENSATION_DB
            } else {
                CENTER_PAN_COMPENSATION_DB
            },
            // UI belum punya kontrol pan; netral, bukan tebakan.
            pan: 0.0,
            mute: !audible,
            // Solo sudah dilipat ke `mute` di atas — menyalakannya di sini lagi
            // akan menghitungnya dua kali.
            solo: false,
            dest_bus: 0,
            sends: Vec::new(),
            eq,
            comp: Default::default(),
        });

        if !audible {
            // Track tetap ada (indeksnya dipakai clip lane lain? tidak — tapi
            // membuangnya akan menggeser indeks track dan merusak pemetaan),
            // clip-nya yang tidak dijadwalkan.
            continue;
        }

        let lane_ratio = if lane.speed_ratio.is_finite() && lane.speed_ratio > 0.0 {
            lane.speed_ratio.clamp(0.25, 4.0)
        } else {
            1.0
        };
        // Kecepatan efektif = lane × transport (docs/07 §8d).
        let speed = lane_ratio * tspeed;

        for clip in &lane.clips {
            if clip.asset_id > u16::MAX as u32 {
                warnings.push(format!(
                    "Clip \"{}\" memakai asset id {} di luar jangkauan engine; dilewati.",
                    clip.id, clip.asset_id
                ));
                continue;
            }
            let len_tl = nonneg(clip.len);
            if len_tl < 1.0 {
                continue;
            }
            // Ruang timeline → ruang output. Pembulatan dilakukan SEKALI, di
            // sini, supaya posisi dan panjang tidak pernah saling berselisih
            // satu sample (aturan 4 docs/00: posisi selalu integer sample).
            let start_out = (nonneg(clip.start) / tspeed).round() as u64;
            let end_out = ((nonneg(clip.start) + len_tl) / tspeed).round() as u64;
            let len_out = end_out.saturating_sub(start_out);
            if len_out == 0 {
                continue;
            }

            let fade_curve = if clip.fade_curve == "linear" {
                FADE_LINEAR
            } else {
                // Default UI adalah equalPower; project lama tanpa field ini
                // pun dinormalkan ke sana (`normalizeClipFade`).
                FADE_EQUAL_POWER
            };
            // Fade disimpan di waktu TIMELINE, jadi transport 2× membuat fade
            // 4 detik selesai dalam 2 detik file — sama seperti preview.
            let to_samples = |ms: f64| -> u64 {
                let s = (nonneg(ms) / 1000.0) * sample_rate as f64 / tspeed;
                s.round().max(0.0) as u64
            };
            let mut fade_in = to_samples(clip.fade_in_ms);
            let mut fade_out = to_samples(clip.fade_out_ms);
            // Fade tidak boleh saling menimpa: engine mengalikan kedua amplop,
            // dan dua fade yang tumpang tindih akan menekan bagian tengah clip
            // sampai jauh di bawah nilai yang digambar UI.
            if fade_in + fade_out > len_out {
                let over = fade_in + fade_out - len_out;
                let cut = over.min(fade_out);
                fade_out -= cut;
                fade_in = fade_in.saturating_sub(over - cut);
            }

            clips.push(ClipDesc {
                track: track_index,
                asset: clip.asset_id as u16,
                start: start_out,
                len: len_out,
                offset: nonneg(clip.source_start).round() as u64,
                gain_db: if clip.gain_db.is_finite() {
                    clip.gain_db
                } else {
                    0.0
                },
                fade_in,
                fade_out,
                fade_curve,
                speed,
            });
        }
    }

    if clips.is_empty() {
        return Err("Tidak ada clip yang terdengar untuk di-render.".to_owned());
    }

    Ok(Mapping {
        project: Project {
            sample_rate,
            tracks,
            buses,
            clips,
            // Loop TIDAK ikut ke export: user meminta satu file sepanjang
            // timeline, bukan satu file yang mengulang selamanya.
            loop_range: None,
        },
        warnings,
    })
}

/// Parse JSON → `Mapping`. Dipisah dari [`map_project`] supaya tes bisa
/// membangun struct langsung tanpa lewat string.
pub fn mapping_from_json(json: &str) -> Result<Mapping, String> {
    let parsed: StudioProjectJson =
        serde_json::from_str(json).map_err(|e| format!("JSON project tidak valid: {e}"))?;
    map_project(&parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn project_json(speed: f64) -> String {
        format!(
            r#"{{
              "sampleRate": {SR},
              "speed": {speed},
              "lanes": [
                {{
                  "id": "lane-a", "mute": false, "solo": false, "gainDb": -3,
                  "speedRatio": 2,
                  "eq": {{ "bands": [
                    {{ "kind": "lowshelf",  "freq": 90,    "q": 0.7, "gainDb": 6 }},
                    {{ "kind": "peaking",   "freq": 620,   "q": 1.0, "gainDb": -2 }},
                    {{ "kind": "peaking",   "freq": 3800,  "q": 1.2, "gainDb": 0 }},
                    {{ "kind": "highshelf", "freq": 11000, "q": 0.7, "gainDb": 3 }}
                  ] }},
                  "clips": [
                    {{
                      "id": "c1", "assetId": 0,
                      "start": 48000, "len": 96000, "sourceStart": 1200,
                      "gainDb": -1.5,
                      "fadeInMs": 500, "fadeOutMs": 250, "fadeCurve": "equalPower"
                    }}
                  ]
                }},
                {{
                  "id": "lane-b", "mute": true, "solo": false, "gainDb": 0,
                  "speedRatio": 1, "eq": {{ "bands": [] }},
                  "clips": [
                    {{ "id": "c2", "assetId": 1, "start": 0, "len": 4800,
                       "fadeCurve": "linear" }}
                  ]
                }}
              ]
            }}"#
        )
    }

    #[test]
    fn maps_lanes_fades_speed_and_eq() {
        let m = mapping_from_json(&project_json(1.0)).unwrap();
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
        let p = &m.project;
        assert_eq!(p.sample_rate, SR);
        assert_eq!(p.tracks.len(), 2);
        assert_eq!(p.buses.len(), 1);
        assert_eq!(p.master_bus(), Some(0));

        // Lane mute tidak menyumbang clip, tapi track-nya tetap ada supaya
        // indeks track lain tidak bergeser.
        assert_eq!(p.clips.len(), 1);
        assert!(p.tracks[1].mute);
        assert!(!p.tracks[0].mute);
        assert!((p.tracks[0].gain_db - (-3.0 + CENTER_PAN_COMPENSATION_DB)).abs() < 1e-4);

        // EQ: kind Web Audio → diskriminan FilterKind, urutan dipertahankan.
        assert_eq!(p.tracks[0].eq[0].kind, KIND_LOW_SHELF);
        assert_eq!(p.tracks[0].eq[0].freq_hz, 90.0);
        assert_eq!(p.tracks[0].eq[0].gain_db, 6.0);
        assert_eq!(p.tracks[0].eq[1].kind, KIND_PEAKING);
        assert_eq!(p.tracks[0].eq[3].kind, KIND_HIGH_SHELF);
        assert!(p.tracks[0].eq.iter().all(|b| b.enabled));

        let c = p.clips[0];
        assert_eq!(c.track, 0);
        assert_eq!(c.asset, 0);
        assert_eq!(c.start, 48_000);
        assert_eq!(c.len, 96_000);
        assert_eq!(c.offset, 1_200);
        assert_eq!(c.gain_db, -1.5);
        assert_eq!(c.fade_curve, FADE_EQUAL_POWER);
        assert_eq!(c.fade_in, 24_000); // 500 ms @48k
        assert_eq!(c.fade_out, 12_000);
        assert_eq!(c.speed, 2.0); // speedRatio lane × transport 1×
    }

    #[test]
    fn transport_speed_shrinks_timeline_and_speeds_up_source() {
        let m = mapping_from_json(&project_json(2.0)).unwrap();
        let c = m.project.clips[0];
        // Ruang output separuh: posisi DAN panjang ikut mengerut.
        assert_eq!(c.start, 24_000);
        assert_eq!(c.len, 48_000);
        // Fade diukur di waktu timeline → di file jadi separuh.
        assert_eq!(c.fade_in, 12_000);
        assert_eq!(c.fade_out, 6_000);
        // Baca source dua kali lebih cepat lagi: lane 2× × transport 2×.
        assert_eq!(c.speed, 4.0);
    }

    #[test]
    fn overlapping_fades_are_trimmed_to_clip_length() {
        let json = r#"{
          "sampleRate": 48000, "speed": 1,
          "lanes": [{ "id": "l", "clips": [
            { "id": "c", "assetId": 0, "start": 0, "len": 48000,
              "fadeInMs": 900, "fadeOutMs": 900 }
          ] }]
        }"#;
        let c = mapping_from_json(json).unwrap().project.clips[0];
        assert_eq!(c.len, 48_000);
        assert!(c.fade_in + c.fade_out <= c.len);
        // Yang dipotong adalah fade-out lebih dulu.
        assert_eq!(c.fade_in, 43_200);
        assert_eq!(c.fade_out, 4_800);
    }

    #[test]
    fn solo_is_folded_into_mute() {
        let json = r#"{
          "sampleRate": 48000, "speed": 1,
          "lanes": [
            { "id": "a", "solo": true,  "clips": [
                { "id": "c1", "assetId": 0, "start": 0, "len": 4800 } ] },
            { "id": "b", "solo": false, "clips": [
                { "id": "c2", "assetId": 1, "start": 0, "len": 4800 } ] }
          ]
        }"#;
        let m = mapping_from_json(json).unwrap();
        assert!(!m.project.tracks[0].mute);
        assert!(m.project.tracks[1].mute);
        assert!(m.project.tracks.iter().all(|t| !t.solo));
        assert_eq!(m.project.clips.len(), 1);
    }

    #[test]
    fn survives_postcard_roundtrip() {
        let m = mapping_from_json(&project_json(1.5)).unwrap();
        let bytes = m.project.to_bytes().unwrap();
        assert_eq!(Project::from_bytes(&bytes).unwrap(), m.project);
    }

    #[test]
    fn nothing_audible_is_an_error_not_an_empty_file() {
        let json = r#"{ "sampleRate": 48000, "lanes": [
          { "id": "a", "mute": true, "clips": [
            { "id": "c", "assetId": 0, "start": 0, "len": 4800 } ] } ] }"#;
        assert!(mapping_from_json(json).is_err());
    }

    /// Tes yang paling penting di file ini: JSON studio benar-benar sampai ke
    /// AUDIO. Ia menjalankan jalur export sungguhan — mapping → snapshot →
    /// `Engine::from_snapshot` → `register_asset` → `OfflineRenderer` — dan
    /// memeriksa bahwa hasilnya berbunyi.
    ///
    /// Kenapa ini layak ada: kegagalan paling mungkin di jalur ini BUKAN panic
    /// melainkan SENYAP. Snapshot yang benar tanpa asset terdaftar menghasilkan
    /// file berisi nol tanpa satu pun error, dan tidak ada tes lain di repo yang
    /// akan menangkapnya.
    #[test]
    fn json_to_audio_end_to_end_actually_makes_sound() {
        use daw_engine::voice::Asset;
        use daw_engine::Engine;
        use daw_export::OfflineRenderer;
        use daw_timeline::TimelineSample;

        let json = r#"{
          "sampleRate": 48000, "speed": 1,
          "lanes": [{ "id": "l", "gainDb": 0, "speedRatio": 1,
            "clips": [{ "id": "c", "assetId": 0, "start": 0, "len": 24000,
                        "fadeInMs": 10, "fadeOutMs": 10, "fadeCurve": "equalPower" }] }]
        }"#;
        let mapping = mapping_from_json(json).unwrap();
        let bytes = mapping.project.to_bytes().unwrap();

        let mut engine = Engine::from_snapshot(&bytes, 48_000).unwrap();

        // DC 0.5 di kedua channel: gampang diperiksa, dan fade apa pun akan
        // terlihat sebagai penyimpangan dari 0.5.
        let frames = 48_000usize;
        let pcm: Vec<f32> = vec![0.5f32; frames * 2];
        // SAFETY: `pcm` hidup lebih lama dari `renderer` di scope ini dan tidak
        // pernah dimutasi setelah didaftarkan.
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

        let mut renderer =
            OfflineRenderer::new(engine, TimelineSample(0), TimelineSample(24_000));
        let mut l = vec![0.0f32; 24_000];
        let mut r = vec![0.0f32; 24_000];
        let n = renderer.render_batch(1000, &mut l, &mut r);
        assert_eq!(n, 24_000, "renderer harus menghasilkan seluruh clip");

        // Ada bunyi sama sekali — inilah yang gagal kalau asset tidak terdaftar.
        let peak = l.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(peak > 0.4, "output senyap (peak {peak}) — asset tidak sampai ke engine");

        // LEVEL harus sama dengan preview, bukan 3 dB lebih pelan: hukum pan
        // equal-power engine di tengah menurunkan 3,01 dB, sementara preview
        // Web Audio tidak punya panner sama sekali. Kalau assert ini pecah
        // karena 0.354, kompensasinya hilang — dan tidak ada yang akan
        // menyadarinya selain dari telinga.
        // Bagian TENGAH clip harus utuh 0.5 (di luar jangkauan fade).
        assert!((l[12_000] - 0.5).abs() < 1e-3, "tengah clip = {}", l[12_000]);
        assert!((r[12_000] - 0.5).abs() < 1e-3);

        // Tepi-tepinya harus jauh lebih pelan: fade user + micro-fade wajib.
        assert!(l[0].abs() < 0.05, "awal clip tidak di-fade: {}", l[0]);
        assert!(l[23_999].abs() < 0.05, "akhir clip tidak di-fade: {}", l[23_999]);
    }

    /// Amplify master → fader bus master. Bukan ke gain track: kalau ia bocor
    /// ke sana, mix dengan 2 lane akan naik dua kali dan tidak ada yang
    /// menyadarinya sampai file-nya didengar.
    #[test]
    fn master_gain_lands_on_the_master_bus_only() {
        let json = r#"{
          "sampleRate": 48000, "speed": 1, "masterGainDb": -6,
          "lanes": [
            { "id": "a", "gainDb": 0, "clips": [
              { "id": "c1", "assetId": 0, "start": 0, "len": 4800 } ] },
            { "id": "b", "gainDb": 0, "clips": [
              { "id": "c2", "assetId": 1, "start": 0, "len": 4800 } ] }
          ] }"#;
        let m = mapping_from_json(json).unwrap();
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
        assert_eq!(m.project.master_bus(), Some(0));
        assert_eq!(m.project.buses[0].gain_db, -6.0);
        // Gain track hanya berisi kompensasi pan — amplify TIDAK ikut ke sini.
        for t in &m.project.tracks {
            assert!((t.gain_db - CENTER_PAN_COMPENSATION_DB).abs() < 1e-4);
        }
        // Dan ia harus selamat menyeberang postcard, karena itulah yang
        // sebenarnya dikirim ke engine.
        let back = Project::from_bytes(&m.project.to_bytes().unwrap()).unwrap();
        assert_eq!(back.buses[0].gain_db, -6.0);
    }

    #[test]
    fn master_gain_defaults_to_unity_and_is_clamped_with_a_warning() {
        // Project lama tanpa field ini sama sekali → 0 dB, bukan senyap.
        let none = mapping_from_json(&project_json(1.0)).unwrap();
        assert_eq!(none.project.buses[0].gain_db, 0.0);

        let hot = r#"{ "sampleRate": 48000, "masterGainDb": 60, "lanes": [
          { "id": "a", "clips": [{ "id": "c", "assetId": 0, "start": 0, "len": 4800 }] } ] }"#;
        let m = mapping_from_json(hot).unwrap();
        assert_eq!(m.project.buses[0].gain_db, MAX_MASTER_GAIN_DB);
        assert_eq!(m.warnings.len(), 1);
        assert!(m.warnings[0].contains("Amplify master"));

        let cold = r#"{ "sampleRate": 48000, "masterGainDb": -400, "lanes": [
          { "id": "a", "clips": [{ "id": "c", "assetId": 0, "start": 0, "len": 4800 }] } ] }"#;
        let m = mapping_from_json(cold).unwrap();
        assert_eq!(m.project.buses[0].gain_db, MIN_MASTER_GAIN_DB);
        assert_eq!(m.warnings.len(), 1);
    }

    /// Yang sebenarnya dipertaruhkan: bukan angka di snapshot, tapi AMPLITUDO
    /// yang keluar dari `render_block`. Tes ini me-render project yang sama dua
    /// kali dengan amplify berbeda dan membandingkan sample di tengah clip —
    /// satu-satunya cara membuktikan fader master benar-benar dieksekusi
    /// sesudah track dijumlahkan, dan bukan diabaikan diam-diam.
    #[test]
    fn render_block_output_scales_by_master_gain() {
        fn mid_sample(master_db: f64) -> f32 {
            use daw_engine::voice::Asset;
            use daw_engine::Engine;
            use daw_export::OfflineRenderer;
            use daw_timeline::TimelineSample;

            let json = format!(
                r#"{{ "sampleRate": 48000, "speed": 1, "masterGainDb": {master_db},
                  "lanes": [{{ "id": "l", "gainDb": 0, "speedRatio": 1,
                    "clips": [{{ "id": "c", "assetId": 0, "start": 0, "len": 24000,
                                 "fadeInMs": 10, "fadeOutMs": 10 }}] }}] }}"#
            );
            let bytes = mapping_from_json(&json).unwrap().project.to_bytes().unwrap();
            let mut engine = Engine::from_snapshot(&bytes, 48_000).unwrap();

            let frames = 48_000usize;
            let pcm: Vec<f32> = vec![0.5f32; frames * 2];
            // SAFETY: `pcm` hidup sampai akhir fungsi dan tidak pernah dimutasi
            // setelah didaftarkan.
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
            let mut renderer =
                OfflineRenderer::new(engine, TimelineSample(0), TimelineSample(24_000));
            let mut l = vec![0.0f32; 24_000];
            let mut r = vec![0.0f32; 24_000];
            assert_eq!(renderer.render_batch(1000, &mut l, &mut r), 24_000);
            l[12_000]
        }

        let unity = mid_sample(0.0);
        assert!((unity - 0.5).abs() < 1e-3, "0 dB harus netral: {unity}");

        // -6,02 dB = tepat setengah amplitudo.
        let half = mid_sample(-6.020_6);
        assert!((half - unity * 0.5).abs() < 2e-3, "-6 dB → {half}, unity {unity}");

        // Batas atas panel: +12 dB atas material 0,5 = 1,99 — jauh DI ATAS
        // 0 dBFS, dengan sengaja. Tidak ada limiter maupun soft-clip di jalur
        // ini, dan engine memang harus melewatkannya apa adanya (f32 tidak
        // clip; DAC dan encoder integer yang clip). Kalau assert ini pecah di
        // ~1.0, ada yang diam-diam menjepit di master — dan panel Amplify
        // sedang menjanjikan sebaliknya ke user.
        let loud = mid_sample(MAX_MASTER_GAIN_DB as f64);
        assert!((loud - unity * 3.981_07).abs() < 5e-3, "+12 dB → {loud}, unity {unity}");
        assert!(loud > 1.5, "master boost tidak boleh dijepit diam-diam: {loud}");
    }

    #[test]
    fn extra_eq_bands_are_reported_not_dropped_silently() {
        let json = r#"{
          "sampleRate": 48000,
          "lanes": [{ "id": "a", "eq": { "bands": [
            {"kind":"peaking"},{"kind":"peaking"},{"kind":"peaking"},
            {"kind":"peaking"},{"kind":"peaking"}
          ] }, "clips": [
            { "id": "c", "assetId": 0, "start": 0, "len": 4800 } ] }] }"#;
        let m = mapping_from_json(json).unwrap();
        assert_eq!(m.warnings.len(), 1);
        assert!(m.warnings[0].contains("band EQ"));
    }
}
