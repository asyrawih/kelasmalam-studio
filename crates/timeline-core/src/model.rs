//! Model project — **single source of truth**.
//!
//! Struktur di file ini adalah satu-satunya representasi kebenaran tentang
//! "apa isi lagu ini". React memegang *mirror* read-only-nya; export worker
//! memegang *snapshot* postcard-nya; audio thread memegang `ProcessPlan` yang
//! diturunkan darinya. Ketiganya derived — kalau berbeda, yang di sini yang benar.
//!
//! Serialisasi: `serde` derive. Dua format, satu tipe:
//! - **postcard** untuk snapshot ke worker (binary, no_std, kecil, cepat),
//! - **JSON** untuk file project di disk (lihat `schema/project.schema.json`).
//!
//! Semua ID adalah newtype `u64` yang di-generate monoton oleh
//! [`Project::next_id`]. Bukan index array — index bergeser saat delete, dan
//! undo yang menyimpan index akan menunjuk ke clip yang salah.

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::coords::{ClipGeometry, SourceSample, TimelineSample};
use crate::tempo::TempoMap;

/// Versi format file project. Naikkan setiap kali ada perubahan yang tidak
/// backward-compatible; [`Project::migrate`] yang menanganinya.
pub const PROJECT_VERSION: u32 = 1;

macro_rules! id_type {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(
            Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub u64);

        impl $name {
            pub const NONE: Self = Self(0);
            #[inline]
            pub const fn new(v: u64) -> Self {
                Self(v)
            }
            #[inline]
            pub const fn raw(self) -> u64 {
                self.0
            }
            #[inline]
            pub const fn is_none(self) -> bool {
                self.0 == 0
            }
        }
    };
}

id_type!(AssetId, "Referensi ke PCM di asset pool (WASM linear memory / OPFS).");
id_type!(ClipId, "Identitas clip, stabil sepanjang hidup project.");
id_type!(TrackId, "Identitas track.");
id_type!(BusId, "Identitas bus (termasuk master).");
id_type!(SendId, "Identitas send.");
id_type!(FxId, "Identitas instance efek di dalam sebuah insert chain.");

// -------------------------------------------------------------------------
// Fade
// -------------------------------------------------------------------------

/// Bentuk kurva fade.
///
/// Kenapa bukan cuma "linear": crossfade dua sinyal **tidak berkorelasi**
/// (mis. dua take berbeda) menjaga daya konstan dengan kurva `sin/cos`
/// (equal-power), sedangkan dua sinyal **berkorelasi** (potongan dari take yang
/// sama) menjaga amplitudo konstan dengan kurva linear. Salah pilih = terdengar
/// sebagai lubang volume atau bump di tengah crossfade. Jadi keduanya perlu ada,
/// dan default-nya beda per konteks (lihat `docs/06`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum FadeCurve {
    /// Amplitudo linear. Default untuk fade in/out biasa dan untuk crossfade
    /// material berkorelasi.
    #[default]
    Linear,
    /// `sin/cos` — daya konstan. Default untuk crossfade material tak berkorelasi.
    EqualPower,
    /// Kurva eksponensial "S". Rasanya paling natural untuk fade panjang (>1 s).
    SCurve,
    /// Logaritmik (cepat di awal).
    Logarithmic,
    /// Eksponensial (lambat di awal).
    Exponential,
}

/// Spesifikasi satu fade.
///
/// `len_timeline` diukur di **timeline space**, bukan source space. Alasannya
/// tegas: user menggambar handle fade di layar, dan layar adalah timeline space.
/// Kalau disimpan di source space, mengubah `speed_ratio` clip akan mengubah
/// durasi fade yang terlihat — perilaku yang tidak ada seorang pun harapkan.
#[derive(Copy, Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct FadeSpec {
    /// Panjang fade dalam TIMELINE sample. 0 = tanpa fade eksplisit (engine
    /// tetap menerapkan micro-fade, lihat [`crate::MICRO_FADE_MS`]).
    pub len_timeline: u64,
    pub curve: FadeCurve,
}

impl FadeSpec {
    pub const NONE: Self = Self { len_timeline: 0, curve: FadeCurve::Linear };

    pub const fn new(len_timeline: u64, curve: FadeCurve) -> Self {
        Self { len_timeline, curve }
    }

    #[inline]
    pub const fn is_none(&self) -> bool {
        self.len_timeline == 0
    }
}

// -------------------------------------------------------------------------
// Clip
// -------------------------------------------------------------------------

/// Satu region audio di timeline.
///
/// **Clip tidak memiliki sample.** Ia memiliki referensi (`asset_id`) plus
/// jendela (`source_start`/`source_len`) plus transform (`gain`, fade,
/// `speed_ratio`). Semua editing memutasi angka-angka ini; buffer PCM di asset
/// pool tidak pernah tersentuh. Itulah non-destructive editing — bukan fitur,
/// melainkan konsekuensi dari struktur data ini.
///
/// Field di luar sketsa awal (`docs`/prompt Bagian 6a) dan alasannya:
///
/// | Field | Kenapa ada |
/// |---|---|
/// | `id` | Undo/redo menyimpan referensi; index array bergeser saat delete |
/// | `track` | Denormalisasi. Hit-test & undo butuh tahu pemiliknya tanpa scan |
/// | `gain_db` | Nilai kanonik disimpan dB, `gain` linear adalah cache turunan |
/// | `mute` | Mute per-clip dipakai saat comping take; bukan gain 0 (gain 0 hilang saat undo taper) |
/// | `loop_count` | Clip yang di-loop tidak perlu duplikasi N clip |
/// | `name`/`color` | Murni UI, tapi harus ikut tersimpan di file project |
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub id: ClipId,
    pub track: TrackId,
    pub asset_id: AssetId,

    /// Offset trim-in di dalam asset (SOURCE sample).
    pub source_start: SourceSample,
    /// Panjang region source yang dipakai (SOURCE sample). Selalu > 0.
    pub source_len: u64,
    /// Posisi di timeline (TIMELINE sample).
    pub timeline_pos: TimelineSample,

    /// Clip gain dalam dB — ini nilai kanoniknya. UI menampilkan dB, otomasi
    /// meng-interpolasi dB, file project menyimpan dB. Linear hanya turunan
    /// (lihat [`Clip::gain_linear`]), supaya -inf dB tetap representable dan
    /// round-trip dB→linear→dB tidak kehilangan digit.
    pub gain_db: f32,

    pub fade_in: FadeSpec,
    pub fade_out: FadeSpec,

    /// Lihat Bagian 8. `1.0` = kecepatan asli. `> 1.0` = lebih cepat & lebih
    /// pendek di timeline. Bersama `warp` menentukan varispeed vs time-stretch.
    pub speed_ratio: f64,
    /// `false` = varispeed (pitch ikut berubah, mode "tape"). `true` = pitch
    /// dipertahankan (time-stretch, fase 2 — lihat `docs/07` §8c).
    #[serde(default)]
    pub warp: bool,

    #[serde(default)]
    pub mute: bool,
    /// Berapa kali region diulang. 1 = sekali. Panjang timeline dikali ini.
    #[serde(default = "one_u32")]
    pub loop_count: u32,

    /// Efek per-clip. Kosong di MVP (lihat rekomendasi `docs/06` §6e), tapi
    /// field-nya ada sejak versi 1 supaya tidak butuh migrasi nanti.
    #[serde(default)]
    pub insert_chain: Vec<FxId>,

    #[serde(default)]
    pub name: String,
    /// Index ke palet warna di design system, bukan RGB — supaya tema bisa ganti.
    #[serde(default)]
    pub color: u8,
}

fn one_u32() -> u32 {
    1
}

impl Clip {
    pub fn new(id: ClipId, track: TrackId, asset_id: AssetId, at: TimelineSample, source_len: u64) -> Self {
        Self {
            id,
            track,
            asset_id,
            source_start: SourceSample::new(0),
            source_len: source_len.max(1),
            timeline_pos: at,
            gain_db: 0.0,
            fade_in: FadeSpec::NONE,
            fade_out: FadeSpec::NONE,
            speed_ratio: 1.0,
            warp: false,
            mute: false,
            loop_count: 1,
            insert_chain: Vec::new(),
            name: String::new(),
            color: 0,
        }
    }

    /// Geometri untuk konversi space. Satu-satunya jembatan ke [`crate::coords`].
    #[inline]
    pub fn geometry(&self) -> ClipGeometry {
        ClipGeometry {
            timeline_pos: self.timeline_pos,
            source_start: self.source_start,
            source_len: self.source_len,
            speed_ratio: self.speed_ratio,
        }
    }

    /// Panjang total di timeline, sudah memperhitungkan `speed_ratio` dan loop.
    #[inline]
    pub fn timeline_len(&self) -> u64 {
        self.geometry().timeline_len() * self.loop_count.max(1) as u64
    }

    #[inline]
    pub fn timeline_end(&self) -> TimelineSample {
        self.timeline_pos.offset(self.timeline_len())
    }

    #[inline]
    pub fn contains(&self, t: TimelineSample) -> bool {
        t >= self.timeline_pos && t < self.timeline_end()
    }

    /// Gain linear. Konversi dilakukan di sini, bukan disimpan, supaya tidak
    /// ada dua sumber kebenaran yang bisa desinkron.
    #[inline]
    pub fn gain_linear(&self) -> f32 {
        if self.mute || self.gain_db <= -96.0 {
            0.0
        } else {
            // 10^(db/20). Di jalur non-RT, `powf` boleh; engine memakai
            // `daw_dsp::fastmath::db_to_lin` di jalur render.
            db_to_lin(self.gain_db)
        }
    }

    /// Apakah dua fade saling tumpang tindih (clip terlalu pendek untuk keduanya).
    #[inline]
    pub fn fades_overlap(&self) -> bool {
        self.fade_in.len_timeline + self.fade_out.len_timeline > self.timeline_len()
    }

    /// Potong fade supaya muat di panjang clip sekarang. Dipanggil setiap kali
    /// trim/split mengubah panjang — lihat `docs/06` §6a "trim melewati fade".
    pub(crate) fn clamp_fades(&mut self) {
        let len = self.timeline_len();
        if self.fade_in.len_timeline > len {
            self.fade_in.len_timeline = len;
        }
        if self.fade_out.len_timeline > len {
            self.fade_out.len_timeline = len;
        }
        // Kalau keduanya masih tabrakan, kecilkan proporsional. Alternatifnya
        // (menolak edit) lebih menyebalkan daripada fade yang mengecil sendiri.
        let total = self.fade_in.len_timeline + self.fade_out.len_timeline;
        if total > len && total > 0 {
            let fi = self.fade_in.len_timeline as u128 * len as u128 / total as u128;
            self.fade_in.len_timeline = fi as u64;
            self.fade_out.len_timeline = len - fi as u64;
        }
    }
}

/// `db → linear` tanpa `std` (no_std tidak punya `f32::powf`).
///
/// `10^(db/20) = e^(db * ln10/20)`. Deret Taylor exp cukup akurat untuk rentang
/// yang kita pakai (-96..+24 dB) karena kita mereduksi eksponen ke `[0,1)` dulu.
/// Ini jalur non-RT (UI/serialisasi); engine memakai versi cepat di `daw-dsp`.
fn db_to_lin(db: f32) -> f32 {
    let x = db as f64 * (2.302_585_092_994_046 / 20.0);
    exp_f64(x) as f32
}

/// `linear → db`, inverse dari [`db_to_lin`]. Dipakai UI untuk menampilkan meter.
pub fn lin_to_db(x: f32) -> f32 {
    if x <= 1e-7 {
        return -140.0;
    }
    (ln_f64(x as f64) * (20.0 / 2.302_585_092_994_046)) as f32
}

fn exp_f64(x: f64) -> f64 {
    // Reduksi: e^x = 2^k * e^r, r ∈ [-ln2/2, ln2/2]
    let k = (x * core::f64::consts::LOG2_E + if x >= 0.0 { 0.5 } else { -0.5 }) as i32;
    let r = x - k as f64 * core::f64::consts::LN_2;
    let mut term = 1.0f64;
    let mut sum = 1.0f64;
    for n in 1..14 {
        term *= r / n as f64;
        sum += term;
    }
    sum * pow2i(k)
}

fn pow2i(k: i32) -> f64 {
    let mut r = 1.0f64;
    let (mut n, base) = if k >= 0 { (k, 2.0f64) } else { (-k, 0.5f64) };
    let mut b = base;
    while n > 0 {
        if n & 1 == 1 {
            r *= b;
        }
        b *= b;
        n >>= 1;
    }
    r
}

fn ln_f64(x: f64) -> f64 {
    // Pisahkan mantissa/eksponen lewat bit, lalu atanh series di [√½, √2).
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i32 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > core::f64::consts::SQRT_2 {
        m *= 0.5;
        e += 1;
    }
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut term = z;
    let mut sum = z;
    for n in 1..12 {
        term *= z2;
        sum += term / (2 * n + 1) as f64;
    }
    2.0 * sum + e as f64 * core::f64::consts::LN_2
}

// -------------------------------------------------------------------------
// Track / Send / Bus
// -------------------------------------------------------------------------

/// Send dari track ke bus. **Selalu post-fader di MVP** (lihat `docs/07`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Send {
    pub id: SendId,
    pub dest: BusId,
    /// Level send dalam dB. `-inf` = mati.
    pub amount_db: f32,
    /// `false` = post-fader (default), `true` = pre-fader.
    #[serde(default)]
    pub pre_fader: bool,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub name: String,
    /// Diurutkan berdasarkan `timeline_pos`; invariant dijaga `edit`.
    pub clips: Vec<Clip>,
    pub insert_chain: Vec<FxId>,
    pub sends: Vec<Send>,
    /// Tujuan utama. Biasanya master.
    pub output: BusId,

    pub fader_db: f32,
    /// -1.0 = kiri penuh, 0.0 = tengah, +1.0 = kanan penuh.
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    /// Rekam-arm; ikut disimpan supaya session bisa dilanjutkan.
    #[serde(default)]
    pub record_arm: bool,
    #[serde(default)]
    pub color: u8,
    /// Tinggi lane di UI (CSS px). UI state, tapi bagian dari "dokumen".
    #[serde(default = "default_track_height")]
    pub height_px: f32,
    #[serde(default)]
    pub automation: Vec<Automation>,
}

fn default_track_height() -> f32 {
    88.0
}

impl Track {
    pub fn new(id: TrackId, name: impl Into<String>, output: BusId) -> Self {
        Self {
            id,
            name: name.into(),
            clips: Vec::new(),
            insert_chain: Vec::new(),
            sends: Vec::new(),
            output,
            fader_db: 0.0,
            pan: 0.0,
            mute: false,
            solo: false,
            record_arm: false,
            color: 0,
            height_px: default_track_height(),
            automation: Vec::new(),
        }
    }

    pub fn clip_index(&self, id: ClipId) -> Option<usize> {
        self.clips.iter().position(|c| c.id == id)
    }

    pub fn clip(&self, id: ClipId) -> Option<&Clip> {
        self.clips.iter().find(|c| c.id == id)
    }

    pub fn clip_mut(&mut self, id: ClipId) -> Option<&mut Clip> {
        self.clips.iter_mut().find(|c| c.id == id)
    }

    /// Kembalikan invariant urutan setelah move/insert.
    pub(crate) fn sort_clips(&mut self) {
        self.clips.sort_by_key(|c| c.timeline_pos);
    }

    /// Clip yang bersinggungan dengan `[from, to)` — dasar virtualisasi viewport.
    pub fn clips_in_range(&self, from: TimelineSample, to: TimelineSample) -> impl Iterator<Item = &Clip> {
        self.clips
            .iter()
            .filter(move |c| c.timeline_end() > from && c.timeline_pos < to)
    }
}

/// Bus penjumlah. Master adalah bus juga — tidak ada tipe khusus, supaya
/// `render_block` tidak butuh cabang untuk master.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bus {
    pub id: BusId,
    pub name: String,
    pub insert_chain: Vec<FxId>,
    pub fader_db: f32,
    pub pan: f32,
    pub mute: bool,
    /// `None` = ini master (output ke DAC/file).
    pub output: Option<BusId>,
    #[serde(default)]
    pub automation: Vec<Automation>,
}

impl Bus {
    pub fn master(id: BusId) -> Self {
        Self {
            id,
            name: String::new(),
            insert_chain: Vec::new(),
            fader_db: 0.0,
            pan: 0.0,
            mute: false,
            output: None,
            automation: Vec::new(),
        }
    }
}

// -------------------------------------------------------------------------
// Automation
// -------------------------------------------------------------------------

/// Apa yang di-otomasi. Enum, bukan string: string berarti lookup + alokasi di
/// jalur yang dibaca setiap kali plan dibangun ulang.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParamTarget {
    TrackFader(TrackId),
    TrackPan(TrackId),
    TrackMute(TrackId),
    SendAmount(SendId),
    BusFader(BusId),
    ClipGain(ClipId),
    ClipSpeed(ClipId),
    /// Parameter ke-`n` dari instance efek.
    FxParam(FxId, u16),
    /// Master varispeed global (lihat `docs/07` §8d).
    MasterSpeed,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum CurveKind {
    /// Tahan nilai sampai titik berikutnya (untuk parameter diskrit: mute, bypass).
    Hold,
    #[default]
    Linear,
    /// Bezier satu-handle; `tension` di titik awal segmen.
    Curve,
}

#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutomationPoint {
    pub at: TimelineSample,
    /// Nilai dalam **satuan natural parameter** (dB untuk fader, -1..1 untuk pan).
    /// Bukan 0..1 ternormalisasi: normalisasi membuat file project tidak bisa
    /// dibaca manusia dan bikin perubahan rentang parameter jadi breaking change.
    pub value: f32,
    pub curve: CurveKind,
    /// -1..1, hanya dipakai kalau `curve == Curve`.
    #[serde(default)]
    pub tension: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Automation {
    pub target: ParamTarget,
    /// Tersortir naik berdasarkan `at`.
    pub points: Vec<AutomationPoint>,
    #[serde(default)]
    pub enabled: bool,
}

impl Automation {
    /// Nilai di posisi `t`. Interpolasi linear; `Curve` di-approx linear di sini
    /// (engine yang menghitung bezier-nya saat membangun ramp segment).
    pub fn value_at(&self, t: TimelineSample) -> Option<f32> {
        if self.points.is_empty() {
            return None;
        }
        let i = match self.points.binary_search_by_key(&t, |p| p.at) {
            Ok(i) => return Some(self.points[i].value),
            Err(0) => return Some(self.points[0].value),
            Err(i) => i - 1,
        };
        let a = self.points[i];
        let Some(&b) = self.points.get(i + 1) else {
            return Some(a.value);
        };
        if a.curve == CurveKind::Hold {
            return Some(a.value);
        }
        let span = b.at.distance_from(a.at);
        if span == 0 {
            return Some(b.value);
        }
        let x = t.distance_from(a.at) as f32 / span as f32;
        Some(a.value + (b.value - a.value) * x)
    }
}

// -------------------------------------------------------------------------
// Project
// -------------------------------------------------------------------------

/// Metadata asset di pool. Sample-nya sendiri hidup di WASM linear memory
/// (atau di OPFS kalau sudah di-evict) — lihat `docs/06` §6a.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssetRef {
    pub id: AssetId,
    /// Nama file asli, untuk relink kalau asset hilang.
    pub name: String,
    /// Hash isi (BLAKE3 dipotong 8 byte). Dua import file yang sama → satu asset.
    pub content_hash: u64,
    pub channels: u16,
    /// Panjang setelah resample ke sample rate project.
    pub frames: u64,
    /// Sample rate **asli** file, sebelum resample import-time. Disimpan supaya
    /// bisa dilaporkan ke user dan supaya re-import bisa dideteksi.
    pub source_sample_rate: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    /// Selalu ditulis sebagai [`PROJECT_VERSION`]; dibaca apa adanya lalu
    /// di-upgrade oleh [`Project::migrate`].
    pub version: u32,
    pub name: String,
    /// Sample rate project. Semua asset di-resample ke sini saat import.
    pub sample_rate: u32,
    pub tempo_map: TempoMap,
    pub tracks: Vec<Track>,
    /// Bus non-master (reverb/delay return, group).
    pub buses: Vec<Bus>,
    pub master: Bus,
    pub assets: Vec<AssetRef>,
    /// Varispeed global. Lihat `docs/07` §8d.
    #[serde(default = "one_f64")]
    pub master_speed: f64,
    /// Rentang loop transport.
    #[serde(default)]
    pub loop_range: Option<(TimelineSample, TimelineSample)>,
    /// Counter ID monoton. Ikut di-serialize — kalau tidak, load lalu tambah clip
    /// akan menghasilkan ID yang bentrok dengan clip yang sudah ada.
    #[serde(default)]
    next_id: u64,
}

fn one_f64() -> f64 {
    1.0
}

/// Kesalahan saat memuat/memigrasi file project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MigrationError {
    /// File dari versi yang lebih baru dari aplikasi ini.
    TooNew { found: u32, supported: u32 },
    /// Versi lama yang jalur migrasinya sudah dihapus.
    Unsupported { found: u32 },
}

impl Project {
    pub fn new(name: impl Into<String>, sample_rate: u32) -> Self {
        let master_id = BusId::new(1);
        Self {
            version: PROJECT_VERSION,
            name: name.into(),
            sample_rate,
            tempo_map: TempoMap::constant(120.0, sample_rate),
            tracks: Vec::new(),
            buses: Vec::new(),
            master: Bus::master(master_id),
            assets: Vec::new(),
            master_speed: 1.0,
            loop_range: None,
            next_id: 2,
        }
    }

    /// ID unik berikutnya. Monoton, tidak pernah dipakai ulang — termasuk untuk
    /// clip yang sudah dihapus, supaya undo yang menghidupkan kembali clip lama
    /// tidak pernah bentrok dengan clip baru.
    pub fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    pub fn track(&self, id: TrackId) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    pub fn track_mut(&mut self, id: TrackId) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }

    /// Cari clip di seluruh project. O(track × clip) — dipakai di jalur edit
    /// (frekuensi: puluhan per detik saat drag), bukan di jalur render.
    pub fn find_clip(&self, id: ClipId) -> Option<(TrackId, &Clip)> {
        for t in &self.tracks {
            if let Some(c) = t.clip(id) {
                return Some((t.id, c));
            }
        }
        None
    }

    pub fn find_clip_mut(&mut self, id: ClipId) -> Option<&mut Clip> {
        for t in &mut self.tracks {
            if let Some(i) = t.clip_index(id) {
                return Some(&mut t.clips[i]);
            }
        }
        None
    }

    /// Sample terakhir yang punya isi — batas default untuk export.
    pub fn content_end(&self) -> TimelineSample {
        let mut end = TimelineSample::new(0);
        for t in &self.tracks {
            for c in &t.clips {
                if c.timeline_end() > end {
                    end = c.timeline_end();
                }
            }
        }
        end
    }

    /// Berapa clip yang memakai `asset` — dasar refcounting asset pool.
    ///
    /// Refcount **dihitung**, tidak disimpan. Counter tersimpan bisa bocor
    /// (undo/redo yang lupa decrement = asset yang tidak pernah dibebaskan);
    /// menghitung ulang saat GC berjalan (bukan per-edit) selalu benar dan
    /// biayanya tidak ada artinya dibanding decode.
    pub fn asset_refcount(&self, asset: AssetId) -> usize {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .filter(|c| c.asset_id == asset)
            .count()
    }

    /// Asset yang tidak lagi direferensi clip mana pun — kandidat eviction.
    ///
    /// Catatan penting: asset dengan refcount 0 **tidak boleh langsung
    /// dibebaskan**. Undo bisa menghidupkan kembali clip yang memakainya. Yang
    /// benar: pin selama masih ada di history undo, dan evict ke OPFS (bukan
    /// hapus) saat budget memori terlampaui. Lihat `docs/06` §6a.
    pub fn unreferenced_assets(&self) -> Vec<AssetId> {
        self.assets
            .iter()
            .map(|a| a.id)
            .filter(|id| self.asset_refcount(*id) == 0)
            .collect()
    }

    /// Hook migrasi versi file.
    ///
    /// Dipanggil tepat setelah deserialisasi, sebelum data dipakai. Bentuknya
    /// tangga `while version < PROJECT_VERSION` supaya file v1 bisa naik ke v5
    /// lewat rantai v1→v2→v3→v4→v5 tanpa satu pun fungsi migrasi yang perlu
    /// tahu tentang versi lain selain tetangganya.
    pub fn migrate(&mut self) -> Result<(), MigrationError> {
        if self.version > PROJECT_VERSION {
            return Err(MigrationError::TooNew { found: self.version, supported: PROJECT_VERSION });
        }
        while self.version < PROJECT_VERSION {
            match self.version {
                // 0 => { self.migrate_v0_to_v1(); self.version = 1; }
                v => return Err(MigrationError::Unsupported { found: v }),
            }
        }
        self.normalize();
        Ok(())
    }

    /// Pulihkan semua invariant setelah load: jangkar tempo untuk sample rate
    /// device saat ini, urutan clip, `next_id` yang tidak bentrok, ratio waras.
    pub fn normalize(&mut self) {
        let sr = self.sample_rate.max(1);
        self.tempo_map.rebuild_anchors(sr);
        let mut max_id = self.next_id;
        for t in &mut self.tracks {
            max_id = max_id.max(t.id.raw());
            for c in &mut t.clips {
                max_id = max_id.max(c.id.raw());
                if c.source_len == 0 {
                    c.source_len = 1;
                }
                if c.loop_count == 0 {
                    c.loop_count = 1;
                }
                if !(c.speed_ratio.is_finite() && c.speed_ratio > 1e-6 && c.speed_ratio < 1e6) {
                    c.speed_ratio = 1.0;
                }
                c.clamp_fades();
            }
            t.sort_clips();
        }
        if !(self.master_speed.is_finite() && self.master_speed > 1e-6) {
            self.master_speed = 1.0;
        }
        self.next_id = max_id;
    }

    /// `effective_ratio = clip_ratio × master_ratio` — lihat `docs/07` §8d.
    #[inline]
    pub fn effective_ratio(&self, clip: &Clip) -> f64 {
        clip.speed_ratio * self.master_speed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_lin_roundtrip() {
        for db in [-96.0f32, -60.0, -12.0, -6.0, -3.0, 0.0, 6.0, 12.0] {
            let lin = db_to_lin(db);
            let back = lin_to_db(lin);
            assert!((back - db).abs() < 0.01, "db={db} lin={lin} back={back}");
        }
        assert!((db_to_lin(0.0) - 1.0).abs() < 1e-5);
        assert!((db_to_lin(-6.0) - 0.501_187).abs() < 1e-4);
        assert!((db_to_lin(6.0) - 1.995_262).abs() < 1e-3);
    }

    #[test]
    fn muted_clip_is_silent() {
        let mut c = Clip::new(ClipId::new(1), TrackId::new(1), AssetId::new(1), TimelineSample::new(0), 1000);
        c.mute = true;
        assert_eq!(c.gain_linear(), 0.0);
    }

    #[test]
    fn clamp_fades_shrinks_proportionally() {
        let mut c = Clip::new(ClipId::new(1), TrackId::new(1), AssetId::new(1), TimelineSample::new(0), 1000);
        c.fade_in = FadeSpec::new(800, FadeCurve::Linear);
        c.fade_out = FadeSpec::new(800, FadeCurve::Linear);
        c.clamp_fades();
        assert_eq!(c.fade_in.len_timeline + c.fade_out.len_timeline, 1000);
        assert!(!c.fades_overlap());
    }

    #[test]
    fn migrate_rejects_future_versions() {
        let mut p = Project::new("x", 48_000);
        p.version = 99;
        assert_eq!(p.migrate(), Err(MigrationError::TooNew { found: 99, supported: PROJECT_VERSION }));
    }

    #[test]
    fn normalize_repairs_broken_ratio_and_ids() {
        let mut p = Project::new("x", 48_000);
        let tid = TrackId::new(10);
        let mut t = Track::new(tid, "t", p.master.id);
        let mut c = Clip::new(ClipId::new(77), tid, AssetId::new(1), TimelineSample::new(0), 1000);
        c.speed_ratio = 0.0;
        t.clips.push(c);
        p.tracks.push(t);
        p.normalize();
        assert_eq!(p.tracks[0].clips[0].speed_ratio, 1.0);
        assert!(p.next_id() > 77);
    }

    #[test]
    fn automation_interpolates() {
        let a = Automation {
            target: ParamTarget::MasterSpeed,
            points: alloc::vec![
                AutomationPoint { at: TimelineSample::new(0), value: 0.0, curve: CurveKind::Linear, tension: 0.0 },
                AutomationPoint { at: TimelineSample::new(100), value: 10.0, curve: CurveKind::Linear, tension: 0.0 },
            ],
            enabled: true,
        };
        assert_eq!(a.value_at(TimelineSample::new(50)), Some(5.0));
        assert_eq!(a.value_at(TimelineSample::new(500)), Some(10.0));
    }
}
