//! Bentuk data yang menyeberang IPC — cermin satu-per-satu dari
//! `web/src/platform/local-commands.ts` (docs/21 §2a).
//!
//! Semua struct `rename_all = "camelCase"` supaya JSON-nya PERSIS tipe TS,
//! tanpa lapisan pemetaan di crate Tauri. Waktu = milidetik epoch (`i64`),
//! sama dengan Worker. Tipe-tipe ini sengaja tinggal di crate ini, bukan di
//! `daw-desktop`: tes bentuk (`contract_tests.rs`) dan tes SQLite ikut
//! `cargo test --workspace` di CI Ubuntu, sedangkan crate Tauri tidak.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// `StoreInfo`: isi `store_info()` / hasil `store_relocate`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    /// Path absolut folder kepustakaan (docs/21 §1b).
    pub dir: String,
    pub bytes: u64,
    pub tracks: u64,
    pub projects: u64,
    pub schema_version: u32,
}

/// `LocalTrack`: metadata + marks satu lagu.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub hash: String,
    pub name: String,
    pub bytes: u64,
    pub mime: String,
    /// 0 = tidak diketahui, sama dengan kontrak Worker.
    pub frames: u64,
    pub sample_rate: u32,
    pub marks: Option<serde_json::Value>,
    pub created_at: i64,
}

/// `TrackMetaInput`: argumen `library_commit`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetaInput {
    pub hash: String,
    pub name: String,
    pub bytes: u64,
    pub mime: String,
    pub frames: u64,
    pub sample_rate: u32,
}

/// `ImportedTrack`: hasil `library_import_path`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTrack {
    #[serde(flatten)]
    pub track: LocalTrack,
    /// `true` = hash-nya sudah ada; tidak ada berkas baru yang ditulis.
    pub existed: bool,
}

/// `LocalProjectSummary`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_at: i64,
    pub version: i64,
}

/// `LocalProjectBody`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBody {
    #[serde(flatten)]
    pub summary: ProjectSummary,
    pub json: serde_json::Value,
    pub tracks: Vec<String>,
}

/// Hasil `library_project_create`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreated {
    pub id: String,
    pub version: i64,
}

// ── Roblox ────────────────────────────────────────────────────────────────

/// `RobloxCategory`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub sort: i64,
}

/// `RobloxGenre`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Genre {
    pub id: String,
    pub category_id: String,
    pub name: String,
    pub sort: i64,
}

/// `RobloxTaxonomy`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Taxonomy {
    pub categories: Vec<Category>,
    pub genres: Vec<Genre>,
}

/// `RobloxUploadStatus`. Antrean = bukan `Done`/`Failed`; katalog = keduanya.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum UploadStatus {
    Draft,
    Queued,
    Uploading,
    Processing,
    Done,
    Failed,
}

impl UploadStatus {
    pub const ALL: [UploadStatus; 6] = [
        UploadStatus::Draft,
        UploadStatus::Queued,
        UploadStatus::Uploading,
        UploadStatus::Processing,
        UploadStatus::Done,
        UploadStatus::Failed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            UploadStatus::Draft => "draft",
            UploadStatus::Queued => "queued",
            UploadStatus::Uploading => "uploading",
            UploadStatus::Processing => "processing",
            UploadStatus::Done => "done",
            UploadStatus::Failed => "failed",
        }
    }

    /// `true` untuk baris yang sudah keluar dari antrean (katalog).
    pub fn is_settled(self) -> bool {
        matches!(self, UploadStatus::Done | UploadStatus::Failed)
    }
}

impl fmt::Display for UploadStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for UploadStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("status unggah tidak dikenal: {s:?}"))
    }
}

/// `RobloxModerationState`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ModerationState {
    Reviewing,
    Approved,
    Rejected,
}

impl ModerationState {
    pub fn as_str(self) -> &'static str {
        match self {
            ModerationState::Reviewing => "reviewing",
            ModerationState::Approved => "approved",
            ModerationState::Rejected => "rejected",
        }
    }
}

impl FromStr for ModerationState {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "reviewing" => Ok(ModerationState::Reviewing),
            "approved" => Ok(ModerationState::Approved),
            "rejected" => Ok(ModerationState::Rejected),
            other => Err(format!("status moderasi tidak dikenal: {other:?}")),
        }
    }
}

/// `'user' | 'group'`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CreatorKind {
    User,
    Group,
}

impl CreatorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CreatorKind::User => "user",
            CreatorKind::Group => "group",
        }
    }
}

impl FromStr for CreatorKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "user" => Ok(CreatorKind::User),
            "group" => Ok(CreatorKind::Group),
            other => Err(format!("jenis creator tidak dikenal: {other:?}")),
        }
    }
}

/// `RobloxUploadRow`: satu baris `roblox_upload` + `bytes` dari `track`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadRow {
    pub id: String,
    /// Lagu kepustakaan yang byte-nya dikirim (`tracks/<hash>`).
    pub hash: String,
    pub file_name: String,
    pub bytes: u64,
    /// Durasi; `None` = belum diukur (BUKAN nol — lihat `roblox/model.ts`).
    pub seconds: Option<f64>,
    pub name: String,
    pub description: String,
    pub category_id: Option<String>,
    pub genre_id: Option<String>,
    pub creator_kind: CreatorKind,
    pub creator_id: String,
    pub status: UploadStatus,
    pub operation_id: Option<String>,
    pub asset_id: Option<String>,
    pub moderation_state: Option<ModerationState>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub uploaded_at: Option<i64>,
    pub approved_at: Option<i64>,
}

/// Argumen `roblox_queue_put`: `Omit<RobloxUploadRow, 'createdAt' | 'updatedAt'>`.
/// `id` kosong = baris baru; `bytes` diabaikan (selalu dari `track`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadInput {
    #[serde(default)]
    pub id: String,
    pub hash: String,
    pub file_name: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub seconds: Option<f64>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub genre_id: Option<String>,
    pub creator_kind: CreatorKind,
    pub creator_id: String,
    pub status: UploadStatus,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub moderation_state: Option<ModerationState>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub uploaded_at: Option<i64>,
    #[serde(default)]
    pub approved_at: Option<i64>,
}

/// Filter `roblox_catalog_list`. Semua opsional; kosong = semua.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFilter {
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub genre_id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

/// `RobloxOperationState`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    pub done: bool,
    pub asset_id: Option<String>,
    pub moderation_state: Option<ModerationState>,
}

/// `RobloxTargetSettings`: creator aktif + opsi "genre ke deskripsi" (§1d).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetSettings {
    pub creator_kind: CreatorKind,
    pub creator_id: String,
    pub genre_to_description: bool,
}

impl Default for TargetSettings {
    fn default() -> Self {
        Self {
            creator_kind: CreatorKind::User,
            creator_id: String::new(),
            // Hidup secara bawaan (docs/21 §1d): satu-satunya cara genre
            // terlihat di Creator Hub.
            genre_to_description: true,
        }
    }
}
