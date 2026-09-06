//! Klien Roblox Open Cloud — port `backend/src/roblox/open-cloud.ts`
//! (docs/21 §1e) ke Rust, supaya desktop mengunggah LANGSUNG ke
//! `apis.roblox.com` tanpa Worker: di sini tidak ada CORS, dan API key duduk
//! di keychain OS, bukan di halaman.
//!
//! Kontraknya (create.roblox.com/docs/cloud/guides/usage-assets):
//!
//! ```text
//! POST {base}/assets/v1/assets          multipart: `request` (JSON) + `fileContent`
//!   → 200 { "path": "operations/{id}", "operationId": "...", "done": false }
//! GET  {base}/assets/v1/operations/{id}
//!   → { "done": true, "response": { "assetId": "123", … } }  atau  { "done": false }
//! ```
//!
//! Keduanya memakai header `x-api-key`.
//!
//! ## Bentuk hasil = bentuk yang dikembalikan Worker
//!
//! `runner.ts` tetap dipakai apa adanya; yang diganti hanya `Transport`
//! (docs/21 §1e). Karena itu tiap kegagalan di sini membawa tiga hal yang sama
//! dengan `OpenCloudResult` di TS — `status()`, `code()`, dan kalimat untuk
//! user lewat `Display` — dan kalimatnya disalin persis dari `describeFailure`.
//!
//! ## Unggahan TIDAK ditunggu sampai selesai di sini
//!
//! Roblox mengembalikan operasi, bukan asset: byte-nya diterima lalu
//! dimoderasi secara asinkron, dan itu bisa makan menit. Jadi
//! [`create_audio_asset`] mengembalikan `operation_id`, dan yang menanyakan
//! "sudah selesai belum" adalah `roblox_operation_poll` lewat
//! [`get_operation`] — status MODERASI di antrean memang ada untuk fase ini.
//!
//! ## Modul ini murni HTTP
//!
//! Tidak ada SQLite, tidak ada keychain, tidak ada Tauri. Command
//! `roblox_upload_start` yang membaca byte dari `tracks/<hash>`, mengambil
//! API key dari keychain, dan menerbitkan event `daw://roblox-progress`; modul
//! ini hanya menerima `&[u8]` dan sebuah closure progres.
//!
//! ## Utang: progres unggah masih KASAR (docs/21 §5)
//!
//! `progress(sent, total)` hanya dipanggil dua kali: `(0, total)` sebelum
//! byte pertama berangkat dan `(total, total)` begitu Roblox menjawab. Bar
//! yang jujur "sedang mengirim" lebih baik daripada bar yang mengarang angka,
//! dan rencananya (stream per chunk 256 KB) mentok di satu hal: `reqwest`
//! hanya menerima badan streaming lewat `Body::wrap_stream` (butuh trait
//! `futures_core::TryStream`) atau `Body::wrap` (butuh trait
//! `http_body::Body`), dan tidak satu pun crate itu menjadi dependensi
//! langsung `daw-desktop-host` — Rust tidak mengizinkan mengimplementasi trait
//! dari crate yang tidak dideklarasikan di `Cargo.toml`. Perbaikannya kecil
//! dan terlokalisasi: tambahkan `futures-core` ke crate ini, tulis satu
//! `Stream` yang memotong `Vec<u8>` per 256 KB dan memanggil `progress` di
//! tiap `poll_next`, lalu ganti `Part::bytes` dengan
//! `Part::stream_with_length(Body::wrap_stream(..), total)` supaya
//! `Content-Length` tetap terhitung. Tidak ada yang lain yang perlu berubah.
//!
//! ## JSON dibaca dengan pembaca kecil tulisan tangan
//!
//! Crate ini tidak membawa `serde_json`, dan respons Roblox yang dibaca hanya
//! belasan field bertipe string/bool/angka. Pembaca di modul [`json`] cukup
//! untuk itu (objek, larik, string dengan escape, angka, literal), dengan
//! angka disimpan sebagai teks aslinya — `assetId` kadang datang sebagai angka,
//! dan menyimpannya sebagai teks berarti tidak ada presisi yang hilang di
//! id yang lebih besar dari 2^53.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use reqwest::header::{HeaderValue, ACCEPT};
use reqwest::multipart::{Form, Part};
use reqwest::Method;

/// Basis API Open Cloud produksi.
pub const DEFAULT_BASE: &str = "https://apis.roblox.com";

/// Batas waktu satu panggilan ke Roblox — sama dengan `DEFAULT_TIMEOUT_MS`
/// di TS. Berlaku untuk seluruh permintaan termasuk mengirim badan, jadi
/// pemanggil yang mengunggah di koneksi lambat boleh menaikkannya.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

// ── Batas Roblox (salinan `backend/src/roblox/limits.ts`) ───────────────────
//
// Angka-angka ini juga ada di `web/src/roblox/model.ts` dan `limits.ts`.
// Disalin, bukan dibaca dari sana: crate Rust tidak bisa meng-import TS, dan
// yang menjaga ketiganya tetap sama adalah tes. Kalau salah satu berubah,
// ubah semuanya.

/// 20 MB per unggahan — batas Open Cloud, bukan batas kami.
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// 7 menit. Ditegakkan Roblox, bukan di sini — mengukurnya berarti mendekode
/// audio, untuk menjawab pertanyaan yang toh dijawab Roblox beberapa detik
/// kemudian.
pub const MAX_SECONDS: u32 = 7 * 60;
pub const MAX_NAME_LEN: usize = 50;
pub const MAX_DESC_LEN: usize = 1000;
/// Ekstensi yang diterima. Open Cloud sebetulnya juga menerima `.wav` dan
/// `.flac`; daftar ini sengaja SAMA dengan yang diterima UI supaya tidak ada
/// berkas yang lolos di satu sisi lalu ditolak di sisi lain.
pub const AUDIO_EXTS: [&str; 2] = [".mp3", ".ogg"];

/// Ekstensi berkas dalam huruf kecil, termasuk titik. `""` kalau tidak ada
/// (atau kalau titiknya di awal nama, seperti `.bashrc`).
pub fn ext_of(file_name: &str) -> String {
    match file_name.rfind('.') {
        Some(0) | None => String::new(),
        Some(dot) => file_name[dot..].to_ascii_lowercase(),
    }
}

/// MIME yang dikirim ke Roblox untuk nama berkas ini; `None` kalau
/// ekstensinya tidak ada di [`AUDIO_EXTS`].
pub fn mime_of(file_name: &str) -> Option<&'static str> {
    match ext_of(file_name).as_str() {
        ".mp3" => Some("audio/mpeg"),
        ".ogg" => Some("audio/ogg"),
        _ => None,
    }
}

// ── Tipe publik ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct OpenCloudConfig {
    /// Basis API. Slash di ujung dibuang saat dipakai — lihat [`normalize_base`].
    pub base: String,
    /// API key milik USER, diteruskan apa adanya. Tidak pernah dilog.
    pub api_key: String,
    /// Batas waktu satu panggilan ke Roblox.
    pub timeout: Duration,
}

impl OpenCloudConfig {
    /// Konfigurasi produksi: [`DEFAULT_BASE`] + [`DEFAULT_TIMEOUT`].
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            base: DEFAULT_BASE.to_owned(),
            api_key: api_key.into(),
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreatorKind {
    User,
    Group,
}

impl CreatorKind {
    /// `"user"` / `"group"` — nilai yang sama dengan `creatorKind` di TS dan
    /// di kolom `roblox_upload.creator_kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Group => "group",
        }
    }
}

impl fmt::Display for CreatorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CreatorKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "user" => Ok(Self::User),
            "group" => Ok(Self::Group),
            other => Err(format!("jenis pemilik tidak dikenal: {other:?}")),
        }
    }
}

/// Status moderasi — nilai teksnya (`as_str`) huruf kecil, persis
/// `RobloxModerationState` di `web/src/platform/local-commands.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationState {
    Reviewing,
    Approved,
    Rejected,
}

impl ModerationState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reviewing => "reviewing",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    /// Dari nilai yang dikirim Roblox (`MODERATION_STATE_APPROVED`, dan
    /// kadang `Approved` telanjang): yang dibandingkan hanya EKORNYA, huruf
    /// kecil, supaya kedua ejaan itu — dan yang berikutnya — sama-sama dibaca.
    pub fn from_roblox(raw: &str) -> Option<Self> {
        let lower = raw.to_ascii_lowercase();
        if lower.ends_with("approved") {
            Some(Self::Approved)
        } else if lower.ends_with("rejected") {
            Some(Self::Rejected)
        } else if lower.ends_with("reviewing") {
            Some(Self::Reviewing)
        } else {
            None
        }
    }
}

impl fmt::Display for ModerationState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ModerationState {
    type Err = String;

    /// Hanya ejaan huruf kecil yang diterima: ini pembacaan dari kolom/IPC
    /// kita sendiri, bukan dari Roblox — untuk itu ada [`Self::from_roblox`].
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "reviewing" => Ok(Self::Reviewing),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            other => Err(format!("status moderasi tidak dikenal: {other:?}")),
        }
    }
}

/// Satu unggahan. Byte-nya dipinjam: 20 MB tidak perlu disalin hanya untuk
/// dipanggil — salinan satu kali ke badan multipart terjadi di dalam.
#[derive(Debug, Clone, Copy)]
pub struct CreateAudioInput<'a> {
    pub bytes: &'a [u8],
    pub file_name: &'a str,
    pub mime: &'a str,
    pub name: &'a str,
    pub description: &'a str,
    pub creator_kind: CreatorKind,
    pub creator_id: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedOperation {
    pub operation_id: String,
    pub done: bool,
    /// Terisi kalau Roblox kebetulan sudah selesai saat itu juga.
    pub asset_id: Option<String>,
    pub moderation_state: Option<ModerationState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationState {
    pub done: bool,
    pub asset_id: Option<String>,
    pub moderation_state: Option<ModerationState>,
}

/// Kegagalan satu panggilan. `Display` adalah kalimat untuk user; `status()`
/// dan `code()` melengkapinya jadi tiga serangkai yang sama dengan
/// `OpenCloudResult` gagal di TS, supaya `createDesktopTransport` tinggal
/// meneruskan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCloudError {
    /// Input ditolak SEBELUM dikirim (port `upload-request.ts`): format,
    /// ukuran, nama, deskripsi, pemilik. Status 400.
    Invalid { code: String, message: String },
    /// Roblox menjawab bukan 2xx. `message` sudah berbentuk kalimat yang bisa
    /// dikerjakan user — lihat [`describe_failure`].
    Http {
        status: u16,
        code: String,
        message: String,
    },
    /// Operasi `done` tapi membawa `error` — jalur audio yang ditolak
    /// moderasi. Status 422; BUKAN "selesai tanpa assetId".
    OperationFailed { code: String, message: String },
    /// Roblox tidak menjawab dalam `secs` detik. Status 504, kode `WAKTU_HABIS`.
    Timeout { secs: u64 },
    /// DNS/TLS/koneksi. Status 504, kode `JARINGAN`.
    Transport(String),
    /// Roblox menjawab 2xx tapi badannya bukan JSON atau tidak menyebut apa
    /// yang kita butuhkan. Status 502, kode `BALASAN_TIDAK_DIKENALI`.
    Malformed(String),
}

impl OpenCloudError {
    /// Status HTTP yang akan dikembalikan Worker untuk kegagalan ini.
    pub fn status(&self) -> u16 {
        match self {
            Self::Invalid { .. } => 400,
            Self::Http { status, .. } => *status,
            Self::OperationFailed { .. } => 422,
            Self::Timeout { .. } | Self::Transport(_) => 504,
            Self::Malformed(_) => 502,
        }
    }

    /// Kode mesin — yang dicocokkan `runner.ts`, bukan yang dibaca user.
    pub fn code(&self) -> &str {
        match self {
            Self::Invalid { code, .. }
            | Self::Http { code, .. }
            | Self::OperationFailed { code, .. } => code,
            Self::Timeout { .. } => "WAKTU_HABIS",
            Self::Transport(_) => "JARINGAN",
            Self::Malformed(_) => "BALASAN_TIDAK_DIKENALI",
        }
    }
}

impl fmt::Display for OpenCloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid { message, .. }
            | Self::Http { message, .. }
            | Self::OperationFailed { message, .. }
            | Self::Malformed(message) => f.write_str(message),
            Self::Timeout { secs } => write!(f, "Roblox tidak menjawab dalam {secs} detik"),
            Self::Transport(detail) => write!(f, "tidak bisa menghubungi Roblox: {detail}"),
        }
    }
}

impl std::error::Error for OpenCloudError {}

// ── API ─────────────────────────────────────────────────────────────────────

/// Buang slash di ujung supaya `{base}/assets/...` tidak jadi `//assets`.
pub fn normalize_base(base: &str) -> &str {
    base.trim_end_matches('/')
}

/// Validasi ulang satu unggahan — port `parseUpload` di `upload-request.ts`,
/// minus pembacaan FormData. Validasi di UI adalah bantuan untuk user; yang
/// di sini adalah penjaga: [`create_audio_asset`] memanggilnya sendiri, jadi
/// tidak ada yang sampai ke Roblox tanpa lolos dari sini. Kode dan kalimatnya
/// sama dengan TS supaya UI tidak perlu tahu dari sisi mana penolakannya.
pub fn validate_input(input: &CreateAudioInput<'_>) -> Result<(), OpenCloudError> {
    let bad = |code: &str, message: String| {
        Err(OpenCloudError::Invalid {
            code: code.to_owned(),
            message,
        })
    };

    if input.file_name.is_empty() {
        return bad(
            "NAMA_BERKAS_HILANG",
            "nama berkas tidak ikut terkirim".into(),
        );
    }
    let ext = ext_of(input.file_name);
    if !AUDIO_EXTS.contains(&ext.as_str()) {
        let shown = if ext.is_empty() { "?" } else { ext.as_str() };
        return bad(
            "FORMAT",
            format!("format {shown} tidak didukung — pakai MP3 atau OGG"),
        );
    }
    let size = input.bytes.len() as u64;
    if size > MAX_BYTES {
        return bad(
            "UKURAN",
            format!("berkas {size} byte melewati batas {MAX_BYTES} byte"),
        );
    }
    if size == 0 {
        return bad("KOSONG", "berkasnya kosong".into());
    }

    let name = input.name.trim();
    if name.is_empty() {
        return bad("NAMA_KOSONG", "nama asset wajib diisi".into());
    }
    let name_len = name.chars().count();
    if name_len > MAX_NAME_LEN {
        return bad(
            "NAMA_PANJANG",
            format!("nama {name_len} karakter, maksimum {MAX_NAME_LEN}"),
        );
    }
    let desc_len = input.description.chars().count();
    if desc_len > MAX_DESC_LEN {
        return bad(
            "DESKRIPSI_PANJANG",
            format!("deskripsi {desc_len} karakter, maksimum {MAX_DESC_LEN}"),
        );
    }

    let creator_id = input.creator_id.trim();
    if creator_id.is_empty() {
        return bad("PEMILIK", "ID pemilik belum diisi".into());
    }
    if !creator_id.bytes().all(|b| b.is_ascii_digit()) {
        return bad("PEMILIK", "ID pemilik harus angka".into());
    }
    Ok(())
}

/// Tambahkan baris terakhir `Genre: <kategori> / <genre>` ke deskripsi
/// (docs/21 §1d, §3d) tanpa pernah melewati [`MAX_DESC_LEN`].
///
/// Kalau tidak muat, yang dipotong DESKRIPSI, bukan baris genre: seluruh
/// gunanya baris ini adalah supaya genre terlihat di Creator Hub, dan baris
/// genre yang terpotong jadi `Genre: Musik / Lo` lebih buruk daripada
/// deskripsi yang kehilangan kalimat terakhirnya. Nama kategori/genre ditulis
/// user dan tidak dibatasi di sini, jadi kalau barisnya sendiri > 1000 ia
/// tetap dipotong — batasnya mutlak, Roblox yang menolak kalau tidak.
///
/// Kategori atau genre kosong → deskripsi dikembalikan tanpa baris (dipotong
/// ke batas): baris `Genre:  / ` tidak menginformasikan apa-apa.
pub fn describe_with_genre(description: &str, category: &str, genre: &str) -> String {
    let take = |s: &str, n: usize| -> String { s.chars().take(n).collect() };
    let desc = description.trim_end();
    let (category, genre) = (category.trim(), genre.trim());
    if category.is_empty() || genre.is_empty() {
        return take(desc, MAX_DESC_LEN).trim_end().to_owned();
    }

    let line = take(&format!("Genre: {category} / {genre}"), MAX_DESC_LEN);
    if desc.is_empty() {
        return line;
    }
    // +1 untuk '\n' pemisah.
    let room = MAX_DESC_LEN.saturating_sub(line.chars().count() + 1);
    if room == 0 {
        return line;
    }
    let cut = if desc.chars().count() > room {
        take(desc, room).trim_end().to_owned()
    } else {
        desc.to_owned()
    };
    if cut.is_empty() {
        return line;
    }
    format!("{cut}\n{line}")
}

/// Kirim satu berkas audio; hasilnya operasi yang harus di-poll.
///
/// Bagian `request` dikirim sebagai field TEKS multipart (tanpa `filename`),
/// persis padanan `--form 'request="{...}"'` di dokumentasi Roblox. Ini bukan
/// selera: bagian metadata yang membawa `filename` dibaca Roblox sebagai
/// unggahan berkas alih-alih nilai form, dan balasannya "badan request
/// kosong" tanpa petunjuk lain. `Content-Type` beserta boundary-nya milik
/// `reqwest` — menuliskannya sendiri menghasilkan boundary yang tidak cocok
/// dengan badan yang benar-benar dikirim.
///
/// `progress(sent, total)` — lihat "Utang" di kepala modul: dua kali,
/// `(0, total)` dan `(total, total)`. Tidak dipanggil lagi kalau gagal.
pub async fn create_audio_asset(
    cfg: &OpenCloudConfig,
    input: CreateAudioInput<'_>,
    mut progress: impl FnMut(u64, u64) + Send,
) -> Result<CreatedOperation, OpenCloudError> {
    validate_input(&input)?;

    let file = Part::bytes(input.bytes.to_vec())
        .file_name(input.file_name.to_owned())
        .mime_str(input.mime)
        .map_err(|e| OpenCloudError::Invalid {
            code: "MIME".to_owned(),
            message: format!("tipe MIME {:?} tidak sah: {e}", input.mime),
        })?;
    let form = Form::new()
        .text("request", request_json(&input))
        .part("fileContent", file);

    let total = input.bytes.len() as u64;
    progress(0, total);
    let url = format!("{}/assets/v1/assets", normalize_base(&cfg.base));
    let body = call(cfg, Method::POST, &url, Some(form)).await?;
    progress(total, total);

    let operation_id = read_operation_id(&body).ok_or_else(|| {
        OpenCloudError::Malformed(
            "Roblox menerima berkasnya tapi tidak menyebut id operasinya".to_owned(),
        )
    })?;
    Ok(CreatedOperation {
        operation_id,
        done: body.get("done").and_then(json::Json::as_bool) == Some(true),
        asset_id: read_asset_id(&body),
        moderation_state: read_moderation_state(&body),
    })
}

/// Tanyakan status satu operasi.
pub async fn get_operation(
    cfg: &OpenCloudConfig,
    operation_id: &str,
) -> Result<OperationState, OpenCloudError> {
    let url = format!(
        "{}/assets/v1/operations/{}",
        normalize_base(&cfg.base),
        encode_uri_component(operation_id)
    );
    let body = call(cfg, Method::GET, &url, None).await?;
    let done = body.get("done").and_then(json::Json::as_bool) == Some(true);

    // Operasi yang `done` tapi membawa `error` adalah KEGAGALAN, bukan sukses
    // tanpa assetId. Ini jalur yang dilewati audio yang ditolak moderasi, dan
    // memperlakukannya sebagai "selesai" membuat antrean menampilkan SELESAI
    // untuk berkas yang sebetulnya tidak pernah jadi asset.
    if done {
        if let Some(err) = body.get("error").filter(|e| !e.is_null()) {
            let code = err
                .get("code")
                .and_then(json::Json::as_str)
                .unwrap_or("OPERASI_GAGAL");
            let message = err
                .get("message")
                .and_then(json::Json::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or("Roblox menolak asset ini tanpa menyebut alasannya");
            return Err(OpenCloudError::OperationFailed {
                code: code.to_owned(),
                message: message.to_owned(),
            });
        }
    }

    Ok(OperationState {
        done,
        asset_id: read_asset_id(&body),
        moderation_state: read_moderation_state(&body),
    })
}

/// Terjemahkan kegagalan Roblox jadi kalimat yang bisa DIKERJAKAN user.
///
/// "HTTP 403" tidak memberi tahu siapa pun harus berbuat apa. Tiga penyebab
/// paling sering di jalur ini punya perbaikan yang sangat berbeda — kunci
/// salah, izin kurang, atau allowlist IP kunci tidak mengizinkan mesin ini —
/// dan yang terakhir itu jebakan yang hampir selalu kena saat pertama kali
/// dipasang. Kalimatnya disalin dari `describeFailure` di TS supaya UI web dan
/// desktop berkata hal yang sama.
///
/// `raw` adalah badan respons apa adanya; kalau ia JSON dengan `message` /
/// `code` (langsung atau di bawah `error`), keduanya dipakai. Kalau bukan,
/// 200 karakter pertamanya jadi detail.
pub fn describe_failure(status: u16, raw: &str) -> OpenCloudError {
    let body = json::Json::parse(raw).filter(json::Json::is_object);
    let field = |name: &str| -> Option<String> {
        let b = body.as_ref()?;
        b.get(name)
            .and_then(json::Json::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                b.get("error")
                    .and_then(|e| e.get(name))
                    .and_then(json::Json::as_str)
                    .filter(|s| !s.is_empty())
            })
            .map(str::to_owned)
    };
    let detail = field("message").unwrap_or_else(|| raw.chars().take(200).collect());
    let code = field("code").unwrap_or_else(|| format!("HTTP_{status}"));

    let sentence = match status {
        400 => "Roblox menolak metadata unggahan ini".to_owned(),
        401 => "API key tidak dikenali atau sudah dicabut".to_owned(),
        403 => "API key ditolak: pastikan ia punya izin asset (write) untuk pemilik ini, \
                dan allowlist IP-nya mengizinkan 0.0.0.0/0 — IP keluar Worker tidak tetap"
            .to_owned(),
        404 => "endpoint atau operasi tidak ditemukan di Roblox".to_owned(),
        413 => "berkas ditolak Roblox karena terlalu besar".to_owned(),
        429 => "kuota unggah Roblox habis atau permintaan terlalu cepat".to_owned(),
        500.. => "Roblox sedang bermasalah".to_owned(),
        _ => format!("Roblox menolak permintaan ini (HTTP {status})"),
    };
    let message = if detail.is_empty() {
        sentence
    } else {
        format!("{sentence} ({detail})")
    };
    OpenCloudError::Http {
        status,
        code,
        message,
    }
}

// ── Jalur bersama ───────────────────────────────────────────────────────────

/// Satu panggilan HTTP → badan JSON (objek) kalau 2xx, atau kegagalan yang
/// sudah diterjemahkan. Client dibuat per panggilan: unggahan terjadi
/// hitungan kali per sesi, dan satu `Client` yang hidup lama hanya menambah
/// state yang harus dibagi dengan command Tauri.
async fn call(
    cfg: &OpenCloudConfig,
    method: Method,
    url: &str,
    form: Option<Form>,
) -> Result<json::Json, OpenCloudError> {
    // Ditolak di sini, bukan saat `send()`: `reqwest` menunda header yang tidak
    // sah jadi error pengiriman, dan "tidak bisa menghubungi Roblox" adalah
    // diagnosis yang salah untuk key yang tertempel dengan baris baru.
    let api_key = HeaderValue::from_str(&cfg.api_key).map_err(|_| OpenCloudError::Invalid {
        code: "API_KEY".to_owned(),
        message: "API key mengandung karakter yang tidak sah".to_owned(),
    })?;

    let client = reqwest::Client::builder()
        .timeout(cfg.timeout)
        .build()
        .map_err(|e| OpenCloudError::Transport(describe_reqwest(&e)))?;
    let mut req = client
        .request(method, url)
        .header("x-api-key", api_key)
        .header(ACCEPT, "application/json");
    if let Some(form) = form {
        req = req.multipart(form);
    }

    let response = req
        .send()
        .await
        .map_err(|e| map_send_error(&e, cfg.timeout))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| map_send_error(&e, cfg.timeout))?;

    if !status.is_success() {
        return Err(describe_failure(status.as_u16(), &text));
    }
    json::Json::parse(&text)
        .filter(json::Json::is_object)
        .ok_or_else(|| {
            OpenCloudError::Malformed("Roblox menjawab dengan sesuatu yang bukan JSON".to_owned())
        })
}

fn map_send_error(e: &reqwest::Error, timeout: Duration) -> OpenCloudError {
    if e.is_timeout() {
        // Dibulatkan seperti `Math.round(timeoutMs / 1000)` di TS, tapi tidak
        // pernah 0: "tidak menjawab dalam 0 detik" bukan kalimat.
        let secs = ((timeout.as_millis() + 500) / 1000).max(1) as u64;
        OpenCloudError::Timeout { secs }
    } else {
        OpenCloudError::Transport(describe_reqwest(e))
    }
}

/// `Display` `reqwest::Error` berhenti di "error sending request"; penyebab
/// sebenarnya (connection refused, DNS) ada di rantai `source()`.
fn describe_reqwest(e: &reqwest::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        parts.push(s.to_string());
        source = s.source();
    }
    parts.join(": ")
}

/// Badan bagian `request` — urutan field mengikuti TS supaya badan yang
/// terkirim bisa dibandingkan byte per byte dengan yang dikirim Worker.
fn request_json(input: &CreateAudioInput<'_>) -> String {
    let creator_key = match input.creator_kind {
        CreatorKind::User => "userId",
        CreatorKind::Group => "groupId",
    };
    format!(
        "{{\"assetType\":\"Audio\",\"displayName\":{},\"description\":{},\
         \"creationContext\":{{\"creator\":{{\"{creator_key}\":{}}}}}}}",
        json::quote(input.name.trim()),
        json::quote(input.description),
        json::quote(input.creator_id.trim()),
    )
}

/// `operationId`, atau ekor dari `path: "operations/{id}"`.
fn read_operation_id(body: &json::Json) -> Option<String> {
    if let Some(id) = body.get("operationId").and_then(json::Json::as_str) {
        if !id.is_empty() {
            return Some(id.to_owned());
        }
    }
    let path = body.get("path").and_then(json::Json::as_str)?;
    let tail = path.rsplit('/').find(|s| !s.is_empty())?;
    (tail != "operations").then(|| tail.to_owned())
}

/// `assetId` boleh muncul di akar, di `response`, atau cuma sebagai
/// `assets/{id}`. Angka diteruskan sebagai teks aslinya.
fn read_asset_id(body: &json::Json) -> Option<String> {
    let direct = body
        .path(&["response", "assetId"])
        .filter(|v| !v.is_null())
        .or_else(|| body.get("assetId"));
    match direct {
        Some(json::Json::Str(s)) if !s.is_empty() => return Some(s.clone()),
        Some(json::Json::Num(n)) => return Some(n.clone()),
        _ => {}
    }
    let path = body
        .path(&["response", "path"])
        .and_then(json::Json::as_str)?;
    let tail = path.strip_prefix("assets/")?;
    (!tail.is_empty()).then(|| tail.to_owned())
}

fn read_moderation_state(body: &json::Json) -> Option<ModerationState> {
    let raw = body
        .path(&["response", "moderationResult", "moderationState"])
        .filter(|v| !v.is_null())
        .or_else(|| body.path(&["moderationResult", "moderationState"]))?;
    ModerationState::from_roblox(raw.as_str()?)
}

/// `encodeURIComponent`: id operasi masuk ke path URL, dan Roblox pernah
/// mengirim id yang bukan sekadar hex.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b);
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ── JSON ────────────────────────────────────────────────────────────────────

/// Pembaca/penulis JSON secukupnya — lihat kepala modul untuk alasannya.
pub(crate) mod json {
    /// Nilai JSON. Angka disimpan sebagai token aslinya.
    #[derive(Debug, Clone, PartialEq)]
    pub(crate) enum Json {
        Null,
        Bool(bool),
        Num(String),
        Str(String),
        Arr(Vec<Json>),
        Obj(Vec<(String, Json)>),
    }

    /// Kedalaman maksimum: respons Roblox dangkal, dan rekursi tanpa batas
    /// adalah cara termudah membuat parser ditumbangkan badan yang sengaja
    /// jahat.
    const MAX_DEPTH: u32 = 64;

    impl Json {
        /// `None` kalau `text` bukan tepat satu nilai JSON (spasi di tepi boleh).
        pub(crate) fn parse(text: &str) -> Option<Json> {
            let mut p = Parser {
                s: text.as_bytes(),
                i: 0,
                depth: 0,
            };
            let v = p.value()?;
            p.ws();
            (p.i == p.s.len()).then_some(v)
        }

        pub(crate) fn is_object(&self) -> bool {
            matches!(self, Json::Obj(_))
        }

        pub(crate) fn is_null(&self) -> bool {
            matches!(self, Json::Null)
        }

        /// Field objek; `None` untuk non-objek atau kunci yang tidak ada
        /// (`undefined` di TS). Nilai `null` tetap `Some(&Json::Null)`.
        pub(crate) fn get(&self, key: &str) -> Option<&Json> {
            match self {
                Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
                _ => None,
            }
        }

        /// `a?.b?.c` — berhenti di `None` begitu satu tingkat bukan objek.
        pub(crate) fn path(&self, keys: &[&str]) -> Option<&Json> {
            keys.iter().try_fold(self, |cur, k| cur.get(k))
        }

        pub(crate) fn as_str(&self) -> Option<&str> {
            match self {
                Json::Str(s) => Some(s),
                _ => None,
            }
        }

        pub(crate) fn as_bool(&self) -> Option<bool> {
            match self {
                Json::Bool(b) => Some(*b),
                _ => None,
            }
        }
    }

    /// String JSON dengan tanda kutip, escape seperti `JSON.stringify`:
    /// non-ASCII lewat apa adanya sebagai UTF-8.
    pub(crate) fn quote(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '\u{08}' => out.push_str("\\b"),
                '\u{0C}' => out.push_str("\\f"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    struct Parser<'a> {
        s: &'a [u8],
        i: usize,
        depth: u32,
    }

    impl Parser<'_> {
        fn peek(&self) -> Option<u8> {
            self.s.get(self.i).copied()
        }

        fn ws(&mut self) {
            while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                self.i += 1;
            }
        }

        fn eat(&mut self, b: u8) -> Option<()> {
            (self.peek() == Some(b)).then(|| self.i += 1)
        }

        fn value(&mut self) -> Option<Json> {
            self.ws();
            match self.peek()? {
                b'{' => self.object(),
                b'[' => self.array(),
                b'"' => self.string().map(Json::Str),
                b't' => self.literal(b"true", Json::Bool(true)),
                b'f' => self.literal(b"false", Json::Bool(false)),
                b'n' => self.literal(b"null", Json::Null),
                b'-' | b'0'..=b'9' => self.number(),
                _ => None,
            }
        }

        fn literal(&mut self, word: &[u8], v: Json) -> Option<Json> {
            let end = self.i.checked_add(word.len())?;
            (self.s.get(self.i..end)? == word).then(|| {
                self.i = end;
                v
            })
        }

        fn number(&mut self) -> Option<Json> {
            let start = self.i;
            while matches!(
                self.peek(),
                Some(b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
            ) {
                self.i += 1;
            }
            let token = std::str::from_utf8(&self.s[start..self.i]).ok()?;
            // Cukup "angka yang bisa dibaca": yang disimpan tetap tokennya.
            token.parse::<f64>().ok()?;
            Some(Json::Num(token.to_owned()))
        }

        fn string(&mut self) -> Option<String> {
            self.eat(b'"')?;
            let mut out: Vec<u8> = Vec::new();
            loop {
                let b = self.peek()?;
                self.i += 1;
                match b {
                    b'"' => break,
                    b'\\' => {
                        let e = self.peek()?;
                        self.i += 1;
                        match e {
                            b'"' | b'\\' | b'/' => out.push(e),
                            b'b' => out.push(0x08),
                            b'f' => out.push(0x0C),
                            b'n' => out.push(b'\n'),
                            b'r' => out.push(b'\r'),
                            b't' => out.push(b'\t'),
                            b'u' => {
                                let c = self.unicode_escape()?;
                                let mut buf = [0u8; 4];
                                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                            }
                            _ => return None,
                        }
                    }
                    // Byte mentah disalin apa adanya: inputnya `&str`, jadi
                    // UTF-8 tetap utuh selama pemotongan hanya di ASCII.
                    other => out.push(other),
                }
            }
            String::from_utf8(out).ok()
        }

        fn hex4(&mut self) -> Option<u32> {
            let end = self.i.checked_add(4)?;
            let hex = std::str::from_utf8(self.s.get(self.i..end)?).ok()?;
            let v = u32::from_str_radix(hex, 16).ok()?;
            self.i = end;
            Some(v)
        }

        /// Setelah `\u`. Pasangan surrogate digabung; surrogate yatim jadi
        /// U+FFFD — ini teks pesan galat, bukan data yang perlu dijaga bit-nya.
        fn unicode_escape(&mut self) -> Option<char> {
            let hi = self.hex4()?;
            if (0xD800..0xDC00).contains(&hi) {
                if self.s.get(self.i..self.i + 2) == Some(b"\\u") {
                    let save = self.i;
                    self.i += 2;
                    if let Some(lo) = self.hex4() {
                        if (0xDC00..0xE000).contains(&lo) {
                            let cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                            return Some(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                        }
                    }
                    self.i = save;
                }
                return Some('\u{FFFD}');
            }
            Some(char::from_u32(hi).unwrap_or('\u{FFFD}'))
        }

        fn nested<T>(&mut self, f: impl FnOnce(&mut Self) -> Option<T>) -> Option<T> {
            if self.depth >= MAX_DEPTH {
                return None;
            }
            self.depth += 1;
            let r = f(self);
            self.depth -= 1;
            r
        }

        fn object(&mut self) -> Option<Json> {
            self.nested(|p| {
                p.eat(b'{')?;
                let mut fields = Vec::new();
                p.ws();
                if p.eat(b'}').is_some() {
                    return Some(Json::Obj(fields));
                }
                loop {
                    p.ws();
                    let key = p.string()?;
                    p.ws();
                    p.eat(b':')?;
                    let v = p.value()?;
                    fields.push((key, v));
                    p.ws();
                    if p.eat(b',').is_some() {
                        continue;
                    }
                    p.eat(b'}')?;
                    return Some(Json::Obj(fields));
                }
            })
        }

        fn array(&mut self) -> Option<Json> {
            self.nested(|p| {
                p.eat(b'[')?;
                let mut items = Vec::new();
                p.ws();
                if p.eat(b']').is_some() {
                    return Some(Json::Arr(items));
                }
                loop {
                    items.push(p.value()?);
                    p.ws();
                    if p.eat(b',').is_some() {
                        continue;
                    }
                    p.eat(b']')?;
                    return Some(Json::Arr(items));
                }
            })
        }
    }
}

#[cfg(test)]
#[path = "open_cloud_tests.rs"]
mod tests;
