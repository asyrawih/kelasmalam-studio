//! Snapshot project: serde + postcard.
//!
//! KENAPA di-serialize dan bukan di-share (docs/03 §3a): engine punya state DSP
//! yang BEREVOLUSI (s1/s2 biquad, envelope kompresor, isi delay line, posisi
//! fractional cursor, nilai smoother). Dua thread yang memproses blok dari state
//! yang sama tidak menghasilkan "sedikit beda" — hasilnya rusak dan
//! non-deterministik, dan reverb tail playback realtime akan bocor ke export.
//! Membuatnya thread-safe berarti menaruh lock di state DSP → melanggar 1c.
//! Jadi yang dikirim ke worker export hanyalah MODEL project (puluhan KB), dan
//! worker membangun instance Engine-nya sendiri dari situ. Asset PCM tetap
//! di-share read-only lewat shared linear memory.
//!
//! Format: postcard (binary, no_std-friendly, tanpa `std::fmt`, jauh lebih kecil
//! dari JSON di jalur WASM). JSON hanya dipakai untuk file project di disk.

use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// Batas atas send per track (dialokasi sekali di Engine::new).
pub const MAX_SENDS: usize = 4;
/// Batas atas bus (send bus + group bus + master).
pub const MAX_BUSES: usize = 8;
/// Jumlah band EQ per unit.
pub const EQ_BANDS: usize = 4;

#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EqBandSettings {
    /// Sama urutannya dengan `daw_dsp::FilterKind`.
    pub kind: u8,
    pub freq_hz: f32,
    pub q: f32,
    pub gain_db: f32,
    pub enabled: bool,
}

impl Default for EqBandSettings {
    fn default() -> Self {
        EqBandSettings {
            kind: 4, // Peaking
            freq_hz: 1000.0,
            q: 0.707,
            gain_db: 0.0,
            enabled: false,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CompSettings {
    pub threshold_db: f32,
    pub ratio: f32,
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    /// 0 = Peak, 1 = Rms.
    pub detector: u8,
    pub auto_makeup: bool,
    pub enabled: bool,
}

impl Default for CompSettings {
    fn default() -> Self {
        CompSettings {
            threshold_db: -18.0,
            ratio: 3.0,
            knee_db: 6.0,
            attack_ms: 10.0,
            release_ms: 120.0,
            makeup_db: 0.0,
            detector: 0,
            auto_makeup: false,
            enabled: false,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SendDesc {
    pub bus: u16,
    pub amount: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackDesc {
    pub gain_db: f32,
    /// -1.0 = kiri penuh, 0.0 = tengah, +1.0 = kanan penuh.
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    /// Indeks bus tujuan (biasanya master).
    pub dest_bus: u16,
    pub sends: Vec<SendDesc>,
    pub eq: [EqBandSettings; EQ_BANDS],
    pub comp: CompSettings,
}

impl Default for TrackDesc {
    fn default() -> Self {
        TrackDesc {
            gain_db: 0.0,
            pan: 0.0,
            mute: false,
            solo: false,
            dest_bus: 0,
            sends: Vec::new(),
            eq: [EqBandSettings::default(); EQ_BANDS],
            comp: CompSettings::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BusDesc {
    pub gain_db: f32,
    pub pan: f32,
    /// `None` = master (tujuan akhir).
    pub dest: Option<u16>,
    pub eq: [EqBandSettings; EQ_BANDS],
    pub comp: CompSettings,
}

impl Default for BusDesc {
    fn default() -> Self {
        BusDesc {
            gain_db: 0.0,
            pan: 0.0,
            dest: None,
            eq: [EqBandSettings::default(); EQ_BANDS],
            comp: CompSettings::default(),
        }
    }
}

/// Satu clip audio di timeline. SEMUA posisi integer sample (aturan 4 docs/00).
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClipDesc {
    pub track: u16,
    pub asset: u16,
    /// Posisi mulai di timeline (TimelineSample).
    pub start: u64,
    /// Panjang di timeline (sample).
    pub len: u64,
    /// Offset ke dalam asset (SourceSample).
    pub offset: u64,
    pub gain_db: f32,
    /// Fade in/out yang diminta user (sample). Engine SELALU menambah
    /// micro-fade 2–5 ms di kedua tepi meskipun nilainya 0.
    pub fade_in: u64,
    pub fade_out: u64,
    /// Bentuk kurva untuk KEDUA fade clip: 0 = linear, 1 = equal-power
    /// (`sin(t·π/2)`). Bukan kosmetik — dua fade linear yang saling silang
    /// menjumlahkan amplitudo, dan karena loudness mengikuti DAYA, di tengah
    /// transisi dayanya jadi 2×0.5² = 0.5 (turun ~3 dB) dan terdengar melubang.
    /// UI menjadikan equal-power default untuk clip baru, jadi engine harus
    /// bisa menyatakannya — kalau tidak, file hasil export akan berbeda dari
    /// yang didengar user tepat di titik yang paling diperhatikannya.
    pub fade_curve: u8,
    /// Rasio baca source per sample timeline (1.0 = normal). Resampling
    /// memakai cubic Hermite (daw_dsp::hermite4).
    pub speed: f64,
}

/// Nilai sah untuk [`ClipDesc::fade_curve`].
pub const FADE_LINEAR: u8 = 0;
pub const FADE_EQUAL_POWER: u8 = 1;

impl Default for ClipDesc {
    fn default() -> Self {
        ClipDesc {
            track: 0,
            asset: 0,
            start: 0,
            len: 0,
            offset: 0,
            gain_db: 0.0,
            fade_in: 0,
            fade_out: 0,
            fade_curve: FADE_LINEAR,
            speed: 1.0,
        }
    }
}

/// Seluruh state project yang relevan untuk engine. Inilah yang dikirim ke
/// worker export lewat postMessage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Project {
    pub sample_rate: u32,
    pub tracks: Vec<TrackDesc>,
    /// `buses[0]` konvensinya master, tapi yang menentukan adalah `dest == None`.
    pub buses: Vec<BusDesc>,
    pub clips: Vec<ClipDesc>,
    pub loop_range: Option<(u64, u64)>,
}

impl Project {
    /// Indeks bus master = bus pertama tanpa tujuan.
    pub fn master_bus(&self) -> Option<u16> {
        self.buses
            .iter()
            .position(|b| b.dest.is_none())
            .map(|i| i as u16)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, postcard::Error> {
        postcard::to_allocvec(self)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Project, postcard::Error> {
        postcard::from_bytes(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postcard_roundtrip() {
        let mut p = Project {
            sample_rate: 48_000,
            buses: alloc::vec![BusDesc::default()],
            ..Default::default()
        };
        p.tracks.push(TrackDesc {
            gain_db: -3.0,
            pan: 0.25,
            sends: alloc::vec![SendDesc {
                bus: 0,
                amount: 0.5
            }],
            ..Default::default()
        });
        p.clips.push(ClipDesc {
            len: 48_000,
            ..Default::default()
        });
        let bytes = p.to_bytes().unwrap();
        let back = Project::from_bytes(&bytes).unwrap();
        assert_eq!(p, back);
    }
}
