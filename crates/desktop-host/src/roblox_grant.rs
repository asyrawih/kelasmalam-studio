//! Grant Access lokal (docs/21 §3f, fase R5) — port rute `/roblox/*` Worker
//! kepustakaan (`backend/src/library/worker.ts`) ke Rust, supaya tab GRANT
//! ACCESS hidup di desktop tanpa sesi, tanpa Worker, dan tanpa D1.
//!
//! Yang dipindahkan, satu-per-satu dengan URL, header, dan pemetaan galat
//! yang SAMA dengan Worker (kalimat galatnya disalin apa adanya supaya web
//! dan desktop berkata hal yang sama):
//!
//! ```text
//! POST /roblox/assets/sync    → [`sync_assets`]     users.roblox.com + itemconfiguration.roblox.com
//! GET  /roblox/experiences    → [`experiences`]     games.roblox.com
//! GET  /roblox/resolve-place  → [`resolve_place`]   apis.roblox.com/universes
//! POST /roblox/grants         → [`grant_use`]       apis.roblox.com/asset-permissions-api
//! GET/POST /roblox/assets     → `Store::catalog_assets_*` (tabel `roblox_catalog_asset`)
//! ```
//!
//! ## Rahasia tidak pernah lewat sini sebagai argumen IPC
//!
//! Cookie `.ROBLOSECURITY` dan API key diambil command Tauri dari keychain
//! (docs/21 §1f) dan diserahkan ke fungsi-fungsi di sini sebagai `&str`.
//! Fungsi-fungsi ini murni HTTP: tidak ada keychain, tidak ada Tauri; SQLite
//! hanya di blok `impl Store` di bawah. Itu yang membuat semuanya bisa diuji
//! dengan server HTTP lokal (`roblox_grant_tests.rs`) tanpa akun Roblox.
//!
//! ## Cookie adalah API tidak resmi — dan dinyatakan begitu
//!
//! `itemconfiguration` `get-assets` bukan Open Cloud; ia endpoint yang dipakai
//! Creator Hub sendiri, dan satu-satunya cara mendapatkan daftar audio LAMA
//! sebuah akun. Worker sudah memakainya (docs/16); desktop hanya memindahkan
//! pemanggilnya. Kalau Roblox mengubahnya, yang gagal hanya SYNC — katalog
//! lokal (impor CSV, unggahan yang disetujui) dan grant tetap jalan.
//!
//! ## Host bisa diganti
//!
//! [`GrantHosts`] memegang empat basis URL karena keempat API itu memang hidup
//! di empat host berbeda; produksi memakai [`GrantHosts::default`], tes
//! mengarahkan semuanya ke satu server lokal yang membedakan lewat path.

use std::time::Duration;

use reqwest::header::{HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE};
use reqwest::Method;
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::Store;
use crate::types::CreatorKind;
use crate::{HostError, LocalError};

/// Batas satu panggilan pendek (auth, experience, resolve place) — 15 s di Worker.
pub const SHORT_TIMEOUT: Duration = Duration::from_secs(15);
/// Batas satu halaman `get-assets` dan satu PATCH grant — 30 s di Worker.
pub const LONG_TIMEOUT: Duration = Duration::from_secs(30);
/// Maksimum halaman `get-assets` per sync (50 asset per halaman) — sama
/// dengan Worker: 5000 audio cukup, dan loop tanpa batas di atas cursor yang
/// mungkin berulang adalah cara mudah menggantung app.
pub const MAX_SYNC_PAGES: usize = 100;
/// Batas `roblox_assets_import` sekali panggil (413 `TERLALU_BANYAK` di Worker).
pub const MAX_IMPORT: usize = 1_000;
/// Batas asset per grant — batas Asset Permissions API, bukan batas kami.
pub const MAX_GRANT_ASSETS: usize = 100;
/// Nama asset dipotong ke ini, seperti `slice(0, 200)` di Worker.
pub const MAX_NAME_CHARS: usize = 200;

/// Empat host Roblox yang dipakai jalur ini.
#[derive(Debug, Clone)]
pub struct GrantHosts {
    /// `users.roblox.com` — siapa pemilik cookie.
    pub users: String,
    /// `itemconfiguration.roblox.com` — daftar audio milik akun/grup.
    pub item_configuration: String,
    /// `games.roblox.com` — daftar experience.
    pub games: String,
    /// `apis.roblox.com` — resolve place dan Asset Permissions API.
    pub apis: String,
    pub short_timeout: Duration,
    pub long_timeout: Duration,
}

impl Default for GrantHosts {
    fn default() -> Self {
        Self {
            users: "https://users.roblox.com".to_owned(),
            item_configuration: "https://itemconfiguration.roblox.com".to_owned(),
            games: "https://games.roblox.com".to_owned(),
            apis: "https://apis.roblox.com".to_owned(),
            short_timeout: SHORT_TIMEOUT,
            long_timeout: LONG_TIMEOUT,
        }
    }
}

// ── Tipe yang menyeberang IPC (cermin `local-commands.ts`) ─────────────────

/// Asal satu baris katalog: unggahan dari app ini, atau impor (sync/CSV).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Upload,
    Import,
}

impl CatalogSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CatalogSource::Upload => "upload",
            CatalogSource::Import => "import",
        }
    }
}

/// `RobloxCatalogAsset`: satu baris `roblox_catalog_asset`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAsset {
    pub asset_id: String,
    pub creator_kind: CreatorKind,
    pub creator_id: String,
    pub name: String,
    pub moderation_state: Option<String>,
    pub source: CatalogSource,
}

/// `RobloxCatalogAssetInput`: argumen `roblox_assets_import`/`_record`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAssetInput {
    pub asset_id: String,
    pub creator_kind: CreatorKind,
    pub creator_id: String,
    pub name: String,
    #[serde(default)]
    pub moderation_state: Option<String>,
    pub source: CatalogSource,
}

/// `RobloxExperience`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Experience {
    pub universe_id: String,
    pub place_id: String,
    pub name: String,
}

/// `RobloxGrantSettings`: creator aktif + apakah rahasianya ADA. Nilai
/// rahasianya sendiri tidak pernah ikut struct ini — itu seluruh maksudnya.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantSettings {
    pub creator_kind: CreatorKind,
    pub creator_id: String,
    pub has_cookie: bool,
    pub has_api_key: bool,
}

/// `RobloxGrantSubjectType` — ejaan PascalCase milik Asset Permissions API.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "PascalCase")]
pub enum SubjectType {
    Universe,
    Group,
    User,
}

impl SubjectType {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectType::Universe => "Universe",
            SubjectType::Group => "Group",
            SubjectType::User => "User",
        }
    }
}

// ── Galat ───────────────────────────────────────────────────────────────────

/// Kegagalan satu rute — `status`/`code`/`message` sama dengan `fail(...)`
/// Worker untuk kasus yang sama, supaya UI membaca kalimat yang identik.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    /// Ditolak SEBELUM menyentuh jaringan: argumen tidak sah, cookie/kunci
    /// belum ada, cookie milik user lain. Di UI jadi `INVALID`.
    Rejected {
        status: u16,
        code: String,
        message: String,
    },
    /// Roblox menjawab tapi bukan yang diharapkan. Di UI jadi `HTTP` + status.
    Upstream {
        status: u16,
        code: String,
        message: String,
    },
    /// Roblox tidak menjawab dalam `secs` detik (504 `WAKTU_HABIS`).
    Timeout { secs: u64 },
    /// DNS/TLS/koneksi (504 `JARINGAN`).
    Transport(String),
}

impl GrantError {
    fn rejected(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self::Rejected {
            status,
            code: code.to_owned(),
            message: message.into(),
        }
    }

    fn upstream(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self::Upstream {
            status,
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// 409 `COOKIE_HILANG` — dibuat command saat keychain tidak punya cookie.
    pub fn cookie_missing() -> Self {
        Self::rejected(
            409,
            "COOKIE_HILANG",
            "Simpan cookie .ROBLOSECURITY untuk mengambil asset lama",
        )
    }

    /// 401 `KUNCI_HILANG` — dibuat command saat keychain tidak punya API key.
    pub fn api_key_missing() -> Self {
        Self::rejected(401, "KUNCI_HILANG", "API key Roblox wajib diisi")
    }

    /// Status HTTP yang akan dikembalikan Worker untuk kegagalan ini.
    pub fn status(&self) -> u16 {
        match self {
            Self::Rejected { status, .. } | Self::Upstream { status, .. } => *status,
            Self::Timeout { .. } | Self::Transport(_) => 504,
        }
    }

    /// Kode mesin, seperti `code` di badan galat Worker.
    pub fn code(&self) -> &str {
        match self {
            Self::Rejected { code, .. } | Self::Upstream { code, .. } => code,
            Self::Timeout { .. } => "WAKTU_HABIS",
            Self::Transport(_) => "JARINGAN",
        }
    }

    /// Bentuk kontrak `LocalError`: `INVALID` untuk yang ditolak di sini,
    /// `HTTP` + `status` untuk yang datang dari Roblox. Pesannya tetap
    /// kalimat Worker — `local-api.ts` meneruskannya ke UI apa adanya.
    pub fn to_local(&self) -> LocalError {
        let (code, status) = match self {
            Self::Rejected { .. } => ("INVALID", None),
            _ => ("HTTP", Some(self.status())),
        };
        LocalError {
            code,
            message: self.to_string(),
            count: None,
            current_version: None,
            status,
        }
    }
}

impl std::fmt::Display for GrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected { message, .. } | Self::Upstream { message, .. } => f.write_str(message),
            Self::Timeout { secs } => write!(f, "Roblox tidak menjawab dalam {secs} detik"),
            Self::Transport(detail) => write!(f, "tidak bisa menghubungi Roblox: {detail}"),
        }
    }
}

impl std::error::Error for GrantError {}

// ── Rute ────────────────────────────────────────────────────────────────────

/// `users.roblox.com/v1/users/authenticated` — id user pemilik cookie.
/// Cookie yang ditolak Roblox = 401 `COOKIE_TIDAK_VALID`; kalau balasan tidak
/// menyebut `id`, hasilnya string kosong (seperti `String(profile.id ?? '')`).
pub async fn authenticated_user_id(hosts: &GrantHosts, cookie: &str) -> Result<String, GrantError> {
    let url = format!("{}/v1/users/authenticated", trim_base(&hosts.users));
    let (status, text) = send(
        Method::GET,
        &url,
        Auth::Cookie(cookie),
        None,
        hosts.short_timeout,
    )
    .await?;
    if !is_success(status) {
        return Err(GrantError::upstream(
            401,
            "COOKIE_TIDAK_VALID",
            "Cookie Roblox tidak valid atau kedaluwarsa",
        ));
    }
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(text_of(body.get("id")).unwrap_or_default())
}

/// Semua halaman `itemconfiguration` `get-assets` (Audio, tidak diarsipkan)
/// milik `creator` — `groupId` hanya ikut untuk grup, seperti Worker.
/// Baris yang id-nya bukan angka dilewati; nama kosong jadi `Asset {id}`.
pub async fn fetch_creations(
    hosts: &GrantHosts,
    cookie: &str,
    creator_kind: CreatorKind,
    creator_id: &str,
) -> Result<Vec<CatalogAssetInput>, GrantError> {
    let base = trim_base(&hosts.item_configuration);
    let mut cursor = String::new();
    let mut out = Vec::new();
    for _ in 0..MAX_SYNC_PAGES {
        // Urutan parameter mengikuti `URLSearchParams` Worker supaya URL yang
        // berangkat bisa dibandingkan apa adanya.
        let mut query = String::from("assetType=Audio&isArchived=false&limit=50");
        if !cursor.is_empty() {
            query.push_str("&cursor=");
            query.push_str(&form_encode(&cursor));
        }
        if creator_kind == CreatorKind::Group {
            query.push_str("&groupId=");
            query.push_str(&form_encode(creator_id));
        }
        let url = format!("{base}/v1/creations/get-assets?{query}");
        let (status, text) = send(
            Method::GET,
            &url,
            Auth::Cookie(cookie),
            None,
            hosts.long_timeout,
        )
        .await?;
        if !is_success(status) {
            return Err(GrantError::upstream(
                502,
                "SYNC_GAGAL",
                format!("Roblox gagal mengambil audio (HTTP {status})"),
            ));
        }
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if let Some(items) = body.get("data").and_then(Value::as_array) {
            for raw in items {
                let asset_id = text_of(raw.get("assetId"))
                    .or_else(|| text_of(raw.get("id")))
                    .or_else(|| text_of(raw.get("targetId")))
                    .unwrap_or_default();
                if !is_digits(&asset_id) {
                    continue;
                }
                out.push(CatalogAssetInput {
                    name: text_of(raw.get("name")).unwrap_or_else(|| format!("Asset {asset_id}")),
                    asset_id,
                    creator_kind,
                    creator_id: creator_id.to_owned(),
                    moderation_state: None,
                    source: CatalogSource::Import,
                });
            }
        }
        cursor = body
            .get("nextPageCursor")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if cursor.is_empty() {
            break;
        }
    }
    Ok(out)
}

/// `POST /roblox/assets/sync`: pastikan cookie milik creator yang dituju
/// (untuk `user`; grup tidak bisa dicek begitu), lalu tarik semua halaman.
/// Hasilnya daftar untuk `Store::catalog_assets_put_many` — modul ini tidak
/// menulis SQLite dari fungsi async supaya `Store` tidak perlu `Send` melewati
/// `await`.
pub async fn sync_assets(
    hosts: &GrantHosts,
    cookie: &str,
    creator_kind: CreatorKind,
    creator_id: &str,
) -> Result<Vec<CatalogAssetInput>, GrantError> {
    let owner = authenticated_user_id(hosts, cookie).await?;
    if creator_kind == CreatorKind::User && owner != creator_id {
        return Err(GrantError::rejected(
            409,
            "USER_BEDA",
            format!("Cookie Roblox bukan milik User ID {creator_id}"),
        ));
    }
    fetch_creations(hosts, cookie, creator_kind, creator_id).await
}

/// `GET /roblox/experiences`: experience publik milik user/grup dari
/// `games.roblox.com` — tanpa cookie, endpoint ini memang publik.
pub async fn experiences(
    hosts: &GrantHosts,
    owner_kind: CreatorKind,
    owner_id: &str,
) -> Result<Vec<Experience>, GrantError> {
    let owner_id = owner_id.trim();
    if !is_digits(owner_id) {
        return Err(GrantError::rejected(400, "PEMILIK", "ownerId harus angka"));
    }
    let base = trim_base(&hosts.games);
    let url = match owner_kind {
        CreatorKind::Group => {
            format!("{base}/v2/groups/{owner_id}/gamesV2?accessFilter=2&limit=50&sortOrder=Desc")
        }
        CreatorKind::User => {
            format!("{base}/v2/users/{owner_id}/games?accessFilter=2&limit=50&sortOrder=Desc")
        }
    };
    let (status, text) = send(Method::GET, &url, Auth::None, None, hosts.short_timeout).await?;
    if !is_success(status) {
        return Err(GrantError::upstream(
            502,
            "ROBLOX",
            format!("Roblox gagal mengambil experience (HTTP {status})"),
        ));
    }
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let games = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(games
        .iter()
        .map(|game| {
            let root = game.get("rootPlace").filter(|r| r.is_object());
            Experience {
                universe_id: text_of(game.get("id"))
                    .or_else(|| text_of(game.get("universeId")))
                    .unwrap_or_default(),
                place_id: root
                    .and_then(|r| text_of(r.get("id")))
                    .or_else(|| text_of(game.get("rootPlaceId")))
                    .unwrap_or_default(),
                name: text_of(game.get("name")).unwrap_or_else(|| "Tanpa nama".to_owned()),
            }
        })
        .filter(|game| is_digits(&game.universe_id))
        .collect())
}

/// `GET /roblox/resolve-place`: Place ID → Universe ID.
pub async fn resolve_place(hosts: &GrantHosts, place_id: &str) -> Result<String, GrantError> {
    let place_id = place_id.trim();
    if !is_digits(place_id) {
        return Err(GrantError::rejected(400, "PLACE", "Place ID harus angka"));
    }
    let url = format!(
        "{}/universes/v1/places/{place_id}/universe",
        trim_base(&hosts.apis)
    );
    let (status, text) = send(Method::GET, &url, Auth::None, None, hosts.short_timeout).await?;
    if !is_success(status) {
        return Err(GrantError::upstream(
            502,
            "ROBLOX",
            format!("Roblox gagal mencari Universe ID (HTTP {status})"),
        ));
    }
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let universe_id = text_of(body.get("universeId")).unwrap_or_default();
    if !is_digits(&universe_id) {
        return Err(GrantError::upstream(
            404,
            "TIDAK_ADA",
            "Universe ID tidak ditemukan",
        ));
    }
    Ok(universe_id)
}

/// `POST /roblox/grants`: PATCH Asset Permissions API, aksi `Use`, untuk
/// 1–100 asset sekaligus. Id ganda dan yang bukan angka dibuang dulu, seperti
/// Worker; hasilnya jumlah asset yang dikirim.
///
/// 403 diteruskan sebagai 403 (kunci tidak berhak — user harus mengganti
/// kunci), status lain jadi 502; keduanya membawa 500 karakter pertama badan
/// Roblox karena di sanalah alasannya ditulis.
pub async fn grant_use(
    hosts: &GrantHosts,
    api_key: &str,
    asset_ids: &[String],
    subject_type: SubjectType,
    subject_id: &str,
) -> Result<u32, GrantError> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(GrantError::api_key_missing());
    }
    let mut ids: Vec<&str> = Vec::new();
    for id in asset_ids {
        let id = id.as_str();
        if is_digits(id) && !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() || ids.len() > MAX_GRANT_ASSETS {
        return Err(GrantError::rejected(
            400,
            "ASSET",
            "pilih 1 sampai 100 asset",
        ));
    }
    let subject_id = subject_id.trim();
    if !is_digits(subject_id) {
        return Err(GrantError::rejected(
            400,
            "TARGET",
            "target grant tidak sah",
        ));
    }

    let body = json!({
        "subjectType": subject_type.as_str(),
        "subjectId": subject_id,
        "action": "Use",
        "requests": ids.iter().map(|id| json!({ "assetId": id })).collect::<Vec<_>>(),
    });
    let url = format!(
        "{}/asset-permissions-api/v1/assets/permissions",
        trim_base(&hosts.apis)
    );
    let (status, text) = send(
        Method::PATCH,
        &url,
        Auth::ApiKey(api_key),
        Some(body.to_string()),
        hosts.long_timeout,
    )
    .await?;
    if !is_success(status) {
        let detail: String = text.chars().take(500).collect();
        let message = if detail.is_empty() {
            format!("Roblox menjawab {status}")
        } else {
            detail
        };
        return Err(GrantError::upstream(
            if status == 403 { 403 } else { 502 },
            "GRANT_GAGAL",
            message,
        ));
    }
    Ok(ids.len() as u32)
}

// ── Katalog lokal (`roblox_catalog_asset`) ──────────────────────────────────

impl Store {
    /// Upsert satu baris. `false` = dilewati karena id/creator bukan angka
    /// — Worker juga diam-diam `continue`, bukan menolak seluruh permintaan,
    /// karena satu baris CSV yang rusak tidak boleh membatalkan 999 lainnya.
    /// `moderation_state` `None` TIDAK menimpa nilai yang sudah ada (COALESCE).
    pub fn catalog_asset_put(&self, input: &CatalogAssetInput) -> Result<bool, HostError> {
        let asset_id = input.asset_id.trim();
        let creator_id = input.creator_id.trim();
        if !is_digits(asset_id) || !is_digits(creator_id) {
            return Ok(false);
        }
        let name = catalog_name(&input.name, asset_id);
        self.conn().execute(
            "INSERT INTO roblox_catalog_asset
                (asset_id, creator_kind, creator_id, name, moderation_state, source, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (asset_id) DO UPDATE SET
               creator_kind = excluded.creator_kind,
               creator_id = excluded.creator_id,
               name = excluded.name,
               moderation_state = COALESCE(excluded.moderation_state, roblox_catalog_asset.moderation_state),
               source = excluded.source,
               updated_at = excluded.updated_at",
            params![
                asset_id,
                input.creator_kind.as_str(),
                creator_id,
                name,
                input.moderation_state,
                input.source.as_str(),
                self.now(),
            ],
        )?;
        Ok(true)
    }

    /// Upsert banyak baris dalam SATU transaksi (sync 5000 audio = 5000
    /// INSERT; tanpa transaksi itu 5000 fsync). Lebih dari [`MAX_IMPORT`]
    /// ditolak `INVALID`. Hasil = jumlah yang benar-benar masuk.
    pub fn catalog_assets_put_many(&self, inputs: &[CatalogAssetInput]) -> Result<u64, HostError> {
        if inputs.len() > MAX_IMPORT {
            return Err(HostError::Invalid(format!(
                "maksimum {MAX_IMPORT} asset sekali import"
            )));
        }
        // `unchecked_transaction`: hanya butuh `&Connection`, jadi
        // `catalog_asset_put` (yang meminjam `&self`) bisa dipanggil di dalamnya.
        let tx = self.conn().unchecked_transaction()?;
        let mut count = 0u64;
        for input in inputs {
            if self.catalog_asset_put(input)? {
                count += 1;
            }
        }
        tx.commit()?;
        Ok(count)
    }

    /// `roblox_assets_list`: cari di nama atau asset id, terbaru dulu,
    /// maksimum 500 — persis `listRobloxAssets` Worker.
    pub fn catalog_assets_list(&self, query: &str) -> Result<Vec<CatalogAsset>, HostError> {
        let pattern = like_pattern(query.trim());
        let mut stmt = self.conn().prepare(
            "SELECT asset_id, creator_kind, creator_id, name, moderation_state, source
               FROM roblox_catalog_asset
              WHERE name LIKE ?1 ESCAPE '\\' OR asset_id LIKE ?1 ESCAPE '\\'
              ORDER BY updated_at DESC, asset_id LIMIT 500",
        )?;
        let rows = stmt.query_map([pattern], row_to_catalog_asset)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// Nama dipangkas ke [`MAX_NAME_CHARS`] karakter; kosong → `Asset {id}`.
fn catalog_name(raw: &str, asset_id: &str) -> String {
    let name = raw.trim();
    if name.is_empty() {
        return format!("Asset {asset_id}");
    }
    name.chars().take(MAX_NAME_CHARS).collect()
}

fn row_to_catalog_asset(r: &Row<'_>) -> rusqlite::Result<CatalogAsset> {
    let conversion = |column: usize, why: String| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, why.into())
    };
    let creator_kind = r
        .get::<_, String>(1)?
        .parse::<CreatorKind>()
        .map_err(|e| conversion(1, e))?;
    let source = match r.get::<_, String>(5)?.as_str() {
        "upload" => CatalogSource::Upload,
        "import" => CatalogSource::Import,
        other => {
            return Err(conversion(
                5,
                format!("asal katalog tidak dikenal: {other:?}"),
            ))
        }
    };
    Ok(CatalogAsset {
        asset_id: r.get(0)?,
        creator_kind,
        creator_id: r.get(2)?,
        name: r.get(3)?,
        moderation_state: r.get(4)?,
        source,
    })
}

/// Pola `LIKE` dengan `%`, `_`, `\` di-escape — `q` adalah teks user, bukan
/// pola (cermin `listRobloxAssets` Worker).
fn like_pattern(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('%');
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

// ── Jalur HTTP bersama ──────────────────────────────────────────────────────

/// Kredensial satu panggilan. Cookie dan API key TIDAK pernah dua-duanya:
/// endpoint cookie (users, itemconfiguration) tidak mengenal `x-api-key`, dan
/// Open Cloud tidak mengenal cookie.
#[derive(Clone, Copy)]
enum Auth<'a> {
    None,
    Cookie(&'a str),
    ApiKey(&'a str),
}

/// Satu panggilan → `(status, badan teks)`. Non-2xx TIDAK dijadikan galat di
/// sini karena tiap rute memetakannya berbeda (401 untuk cookie, 502 untuk
/// sync, 403/502 untuk grant) — persis seperti Worker.
async fn send(
    method: Method,
    url: &str,
    auth: Auth<'_>,
    json_body: Option<String>,
    timeout: Duration,
) -> Result<(u16, String), GrantError> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| GrantError::Transport(describe_reqwest(&e)))?;
    let mut req = client
        .request(method, url)
        .header(ACCEPT, "application/json");
    // Ditolak di sini, bukan saat `send()`: `reqwest` menunda header yang
    // tidak sah jadi galat pengiriman, dan "tidak bisa menghubungi Roblox"
    // adalah diagnosis yang salah untuk cookie yang tertempel dengan baris baru.
    req = match auth {
        Auth::None => req,
        Auth::Cookie(cookie) => {
            let value = HeaderValue::from_str(&format!(".ROBLOSECURITY={}", cookie.trim()))
                .map_err(|_| {
                    GrantError::rejected(
                        400,
                        "COOKIE",
                        "cookie Roblox mengandung karakter yang tidak sah",
                    )
                })?;
            req.header(COOKIE, value)
        }
        Auth::ApiKey(key) => {
            let value = HeaderValue::from_str(key).map_err(|_| {
                GrantError::rejected(400, "API_KEY", "API key mengandung karakter yang tidak sah")
            })?;
            req.header("x-api-key", value)
        }
    };
    if let Some(body) = json_body {
        req = req.header(CONTENT_TYPE, "application/json").body(body);
    }
    let response = req.send().await.map_err(|e| map_send_error(&e, timeout))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| map_send_error(&e, timeout))?;
    Ok((status, text))
}

fn map_send_error(e: &reqwest::Error, timeout: Duration) -> GrantError {
    if e.is_timeout() {
        // Dibulatkan seperti `Math.round(ms / 1000)`, tapi tidak pernah 0:
        // "tidak menjawab dalam 0 detik" bukan kalimat.
        let secs = ((timeout.as_millis() + 500) / 1000).max(1) as u64;
        GrantError::Timeout { secs }
    } else {
        GrantError::Transport(describe_reqwest(e))
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

fn is_success(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Sama dengan `/^\d+$/` di Worker: ASCII digit saja, tidak kosong.
fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `String(v)` untuk string dan angka JSON; `None` untuk null/absen/lainnya
/// — bool dan objek pun akan gagal di pemeriksaan angka berikutnya, jadi
/// tidak ada bedanya. Angka dipertahankan sebagai tokennya: `assetId` bisa
/// lebih besar dari 2^53 dan `f64` akan membulatkannya.
fn text_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Buang slash di ujung supaya `{base}/v1/...` tidak jadi `//v1`.
fn trim_base(base: &str) -> &str {
    base.trim_end_matches('/')
}

/// Encoding nilai `URLSearchParams`: alfanumerik dan `-_.*` lolos, spasi jadi
/// `+`, sisanya `%XX`. Cursor `get-assets` bukan sekadar hex, jadi ini bukan
/// kehati-hatian berlebihan.
fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b' ' => out.push('+'),
            b if b.is_ascii_alphanumeric() || b"-_.*".contains(&b) => out.push(b as char),
            b => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
#[path = "roblox_grant_tests.rs"]
mod tests;
