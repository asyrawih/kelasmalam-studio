//! Mengawinkan antrean (`roblox_db.rs`) dengan Open Cloud (`open_cloud.rs`)
//! untuk `roblox_upload_start` dan `roblox_operation_poll` (docs/21 §1e, §3d,
//! §3e). Ini satu-satunya tempat yang tahu URUTAN-nya: baris → pemeriksaan →
//! byte dari `tracks/` → `mark_uploading` → HTTP → `mark_processing`.
//!
//! ## Tiga fase, bukan satu fungsi
//!
//! Di aplikasi, `Store` hidup di balik `Mutex` dan satu unggahan bisa makan
//! puluhan detik. Memegang kuncinya selama HTTP berarti `roblox_queue_list`
//! dan sepuluh unggahan paralel runner saling menunggu. Maka pekerjaannya
//! dipotong di batas HTTP:
//!
//! 1. [`prepare_upload`] — SQLite + disk, di bawah kunci (`spawn_blocking`).
//! 2. [`send_upload`] — murni HTTP, tanpa kunci.
//! 3. [`finish_upload`] — SQLite lagi, di bawah kunci.
//!
//! (Sama untuk poll: [`prepare_poll`] → [`send_poll`] → [`finish_poll`].)
//! Command Tauri di `desktop/src-tauri/src/commands/roblox.rs` merangkai
//! ketiganya lewat `with_store`; [`upload_start`] dan [`operation_poll`] di
//! sini merangkainya di atas `&Store` polos — itu rujukan urutannya dan yang
//! diuji terhadap server HTTP tiruan (`roblox_upload_tests.rs`).
//!
//! ## Galat
//!
//! Kegagalan SEBELUM HTTP (`HostError`: baris tidak ada, genre kosong, API key
//! kosong, byte hilang) tidak menyentuh status baris — tidak ada yang terjadi,
//! jadi tidak ada yang perlu dicatat. Kegagalan Open Cloud (`OpenCloudError`)
//! mencatat `failed` + kalimatnya di baris, lalu menyeberang IPC sebagai
//! `LocalError { code: "HTTP", status, message }` — bentuk yang
//! `createDesktopTransport` teruskan ke runner apa adanya.
//!
//! ## API key tidak pernah lewat sini sebagai argumen IPC
//!
//! Command membacanya dari keychain dan menyuapkannya sebagai `Option<&str>`;
//! `None`/kosong ditolak `INVALID` sebelum ada yang dikirim. `Debug` untuk
//! [`UploadJob`] tidak menampilkannya.

use std::fmt;
use std::time::Duration;

use serde::Serialize;

use crate::open_cloud::{
    self, create_audio_asset, describe_with_genre, get_operation, mime_of, CreateAudioInput,
    CreatedOperation, OpenCloudConfig, OpenCloudError, DEFAULT_TIMEOUT,
};
use crate::store::Store;
use crate::tracks;
use crate::types::{CreatorKind, ModerationState, OperationState, UploadRow, UploadStatus};
use crate::{HostError, LocalError};

/// Batas waktu `POST assets`. [`DEFAULT_TIMEOUT`] (30 s) berlaku untuk
/// SELURUH permintaan termasuk mengirim badan, dan 20 MB di koneksi 1 Mbit/s
/// butuh hampir tiga menit — timeout 30 s akan menggagalkan unggahan yang
/// sebetulnya berjalan. Lima menit: cukup untuk koneksi lambat, tetap
/// berhingga kalau Roblox benar-benar diam.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Kalimat `error` baris yang ditolak moderasi — sama untuk jalur unggah
/// (Roblox langsung `done` + `rejected`) dan jalur poll.
pub const REJECTED_MESSAGE: &str = "ditolak moderasi Roblox";

/// Hasil `roblox_upload_start`: `RobloxOperationState & { operationId }`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadStarted {
    #[serde(flatten)]
    pub state: OperationState,
    pub operation_id: String,
}

/// Semua yang dibutuhkan [`send_upload`], sudah lepas dari `Store`: byte lagu
/// di memori (Roblox membatasi 20 MB, jadi ini paling banyak 20 MB — dan
/// `create_audio_asset` toh menyalinnya ke badan multipart), metadata yang
/// sudah final (deskripsi dengan/tanpa baris genre), dan API key.
pub struct UploadJob {
    pub id: String,
    pub file_name: String,
    pub mime: &'static str,
    pub name: String,
    pub description: String,
    pub creator_kind: CreatorKind,
    pub creator_id: String,
    pub bytes: Vec<u8>,
    api_key: String,
}

impl fmt::Debug for UploadJob {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UploadJob")
            .field("id", &self.id)
            .field("file_name", &self.file_name)
            .field("name", &self.name)
            .field("bytes", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

/// Yang dibutuhkan [`send_poll`]: id operasi + API key.
pub struct PollJob {
    pub id: String,
    pub operation_id: String,
    api_key: String,
}

impl fmt::Debug for PollJob {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PollJob")
            .field("id", &self.id)
            .field("operation_id", &self.operation_id)
            .finish_non_exhaustive()
    }
}

// ── unggah ──────────────────────────────────────────────────────────────────

/// Fase 1 `roblox_upload_start`: ambil baris, tolak yang tidak boleh
/// dikirim, susun metadata, baca byte, lalu `mark_uploading`.
///
/// Urutan pemeriksaannya disengaja: kategori/genre dulu (cermin
/// `violationsOf` di TS — katalog tanpa genre tidak berguna, §1d), baru API
/// key. Baris `processing`/`done` ditolak: mengirim ulang byte yang sudah
/// diterima Roblox membuat asset kembar dan memakan kuota bulanan; `failed`
/// boleh dikirim lagi — itulah "coba lagi".
pub fn prepare_upload(
    store: &Store,
    id: &str,
    api_key: Option<&str>,
) -> Result<UploadJob, HostError> {
    let row = store.upload(id)?;
    ensure_sendable(&row)?;
    let (category, genre) = ensure_categorized(store, &row)?;
    let api_key = ensure_api_key(api_key)?;

    let target = store.target()?;
    let description = if target.genre_to_description {
        describe_with_genre(&row.description, &category, &genre)
    } else {
        row.description.clone()
    };
    // Creator dari BARIS (yang dipilih saat baris dibuat); target hanya
    // cadangan untuk baris lama yang belum punya creator.
    let (creator_kind, creator_id) = if row.creator_id.trim().is_empty() {
        (target.creator_kind, target.creator_id)
    } else {
        (row.creator_kind, row.creator_id.clone())
    };
    // MIME dari nama berkas; nama yang formatnya asing tetap diteruskan
    // supaya `validate_input` yang menolaknya dengan kode `FORMAT` yang sama
    // dengan Worker — bukan kalimat baru dari sini.
    let mime = mime_of(&row.file_name).unwrap_or("application/octet-stream");
    let bytes = tracks::read_track(&store.tracks_dir(), &row.hash)?;

    store.mark_uploading(id)?;
    Ok(UploadJob {
        id: row.id,
        file_name: row.file_name,
        mime,
        name: row.name,
        description,
        creator_kind,
        creator_id,
        bytes,
        api_key,
    })
}

/// Fase 2: `POST assets`. `base` adalah [`open_cloud::DEFAULT_BASE`] di
/// produksi dan server tiruan di tes. `progress(sent, total)` diteruskan apa
/// adanya dari `create_audio_asset` (masih kasar — docs/21 §5).
pub async fn send_upload(
    job: &UploadJob,
    base: &str,
    progress: impl FnMut(u64, u64) + Send,
) -> Result<CreatedOperation, OpenCloudError> {
    let cfg = OpenCloudConfig {
        base: base.to_owned(),
        api_key: job.api_key.clone(),
        timeout: UPLOAD_TIMEOUT,
    };
    let input = CreateAudioInput {
        bytes: &job.bytes,
        file_name: &job.file_name,
        mime: job.mime,
        name: &job.name,
        description: &job.description,
        creator_kind: cloud_kind(job.creator_kind),
        creator_id: &job.creator_id,
    };
    create_audio_asset(&cfg, input, progress).await
}

/// Fase 3: catat hasil HTTP ke baris.
///
/// - Roblox langsung `done` + `approved` + assetId → `done` (jarang, tapi
///   nyata untuk berkas kecil).
/// - Langsung `rejected` → `failed`; hasilnya tetap `Ok` dengan
///   `moderationState: rejected` supaya runner yang mengucapkan
///   `MODERASI_DITOLAK`, sama seperti di web.
/// - Selain itu → `processing` + `operation_id`; poll yang menyelesaikannya.
/// - Galat → `failed` + kalimat Roblox, lalu `LocalError` `HTTP`.
pub fn finish_upload(
    store: &Store,
    id: &str,
    outcome: Result<CreatedOperation, OpenCloudError>,
) -> Result<UploadStarted, LocalError> {
    let created = match outcome {
        Ok(created) => created,
        Err(e) => {
            record_failure(store, id, &e.to_string())?;
            return Err(http_error(&e));
        }
    };
    let moderation = created.moderation_state.map(local_moderation);
    let state = OperationState {
        done: created.done,
        asset_id: created.asset_id.clone(),
        moderation_state: moderation,
    };
    match (created.done, moderation, created.asset_id.as_deref()) {
        (_, Some(ModerationState::Rejected), _) => {
            store
                .mark_failed(id, REJECTED_MESSAGE)
                .map_err(|e| e.to_local())?;
        }
        (true, Some(ModerationState::Approved), Some(asset_id)) => {
            store
                .mark_done(id, Some(asset_id), ModerationState::Approved)
                .map_err(|e| e.to_local())?;
        }
        _ => {
            store
                .mark_processing(id, &created.operation_id)
                .map_err(|e| e.to_local())?;
        }
    }
    Ok(UploadStarted {
        state,
        operation_id: created.operation_id,
    })
}

/// `roblox_upload_start` di atas `&Store` polos — rujukan urutan yang
/// dirangkai command Tauri lewat `with_store` (lihat kepala modul).
pub async fn upload_start(
    store: &Store,
    id: &str,
    api_key: Option<&str>,
    base: &str,
    progress: impl FnMut(u64, u64) + Send,
) -> Result<UploadStarted, LocalError> {
    let job = prepare_upload(store, id, api_key).map_err(|e| e.to_local())?;
    let outcome = send_upload(&job, base, progress).await;
    finish_upload(store, id, outcome)
}

// ── poll ────────────────────────────────────────────────────────────────────

/// Fase 1 `roblox_operation_poll`: baris harus punya `operation_id` — tanpa
/// itu tidak ada yang bisa ditanyakan ke Roblox, dan itu `INVALID`, bukan
/// `NOT_FOUND` (barisnya ada; yang salah adalah memanggil poll untuknya).
pub fn prepare_poll(store: &Store, id: &str, api_key: Option<&str>) -> Result<PollJob, HostError> {
    let row = store.upload(id)?;
    let operation_id = row.operation_id.filter(|s| !s.is_empty()).ok_or_else(|| {
        HostError::Invalid(
            "baris ini belum punya id operasi Roblox — kirim dulu sebelum poll".into(),
        )
    })?;
    let api_key = ensure_api_key(api_key)?;
    Ok(PollJob {
        id: row.id,
        operation_id,
        api_key,
    })
}

/// Fase 2: `GET operations/{id}`.
pub async fn send_poll(
    job: &PollJob,
    base: &str,
) -> Result<open_cloud::OperationState, OpenCloudError> {
    let cfg = OpenCloudConfig {
        base: base.to_owned(),
        api_key: job.api_key.clone(),
        timeout: DEFAULT_TIMEOUT,
    };
    get_operation(&cfg, &job.operation_id).await
}

/// Fase 3: `approved` + assetId → `done`; `approved` tanpa assetId →
/// `failed` (runner mengucapkan `TANPA_ASSET_ID`; baris `done` tanpa asset
/// tidak berguna di katalog); `rejected` → `failed`; `reviewing`/belum ada →
/// baris tidak disentuh.
///
/// Galat: operasi `done` yang membawa `error` (`OperationFailed`) adalah
/// keputusan final Roblox → `failed`. Galat jaringan/HTTP saat poll TIDAK
/// mengubah baris: byte-nya sudah di Roblox, dan 5xx sesaat bukan alasan
/// menyatakan unggahan gagal — runner yang memutuskan kapan menyerah.
pub fn finish_poll(
    store: &Store,
    id: &str,
    outcome: Result<open_cloud::OperationState, OpenCloudError>,
) -> Result<OperationState, LocalError> {
    let got = match outcome {
        Ok(got) => got,
        Err(e) => {
            if matches!(e, OpenCloudError::OperationFailed { .. }) {
                record_failure(store, id, &e.to_string())?;
            }
            return Err(http_error(&e));
        }
    };
    let moderation = got.moderation_state.map(local_moderation);
    match (moderation, got.asset_id.as_deref()) {
        (Some(ModerationState::Approved), Some(asset_id)) => {
            store
                .mark_done(id, Some(asset_id), ModerationState::Approved)
                .map_err(|e| e.to_local())?;
        }
        (Some(ModerationState::Approved), None) => {
            store
                .mark_failed(
                    id,
                    "Roblox menyatakan selesai tapi tidak menyebut asset id-nya",
                )
                .map_err(|e| e.to_local())?;
        }
        (Some(ModerationState::Rejected), _) => {
            store
                .mark_failed(id, REJECTED_MESSAGE)
                .map_err(|e| e.to_local())?;
        }
        _ => {}
    }
    Ok(OperationState {
        done: got.done,
        asset_id: got.asset_id,
        moderation_state: moderation,
    })
}

/// `roblox_operation_poll` di atas `&Store` polos — lihat [`upload_start`].
pub async fn operation_poll(
    store: &Store,
    id: &str,
    api_key: Option<&str>,
    base: &str,
) -> Result<OperationState, LocalError> {
    let job = prepare_poll(store, id, api_key).map_err(|e| e.to_local())?;
    let outcome = send_poll(&job, base).await;
    finish_poll(store, id, outcome)
}

// ── pembantu ────────────────────────────────────────────────────────────────

fn ensure_sendable(row: &UploadRow) -> Result<(), HostError> {
    match row.status {
        UploadStatus::Processing => Err(HostError::Invalid(format!(
            "baris ini sudah terkirim ke Roblox (operasi {}) dan sedang dimoderasi — jangan kirim ulang",
            row.operation_id.as_deref().unwrap_or("?")
        ))),
        UploadStatus::Done => Err(HostError::Invalid(format!(
            "unggahan ini sudah selesai (asset {})",
            row.asset_id.as_deref().unwrap_or("?")
        ))),
        _ => Ok(()),
    }
}

/// Nama kategori + genre baris, atau `INVALID` dengan kalimat yang sama
/// dengan `violationsOf` (`kategori-kosong` / `genre-kosong`) supaya user
/// membaca satu kalimat dari sisi mana pun penolakannya.
fn ensure_categorized(store: &Store, row: &UploadRow) -> Result<(String, String), HostError> {
    if row.category_id.as_deref().unwrap_or("").is_empty() {
        return Err(HostError::Invalid(
            "kategori belum dipilih — pilih di kolom KATEGORI baris ini, atau centang beberapa baris lalu terapkan sekaligus".into(),
        ));
    }
    if row.genre_id.as_deref().unwrap_or("").is_empty() {
        return Err(HostError::Invalid(
            "genre belum dipilih — pilih di kolom GENRE, atau buat lewat \"+ genre baru\"".into(),
        ));
    }
    // Id terisi tapi genrenya sudah tidak ada di taksonomi: `queue_put`
    // menjaga pasangannya, dan `delete_genre` menolak selama dipakai, jadi
    // ini hanya mungkin lewat basis data yang diedit tangan.
    store.upload_genre_names(&row.id)?.ok_or_else(|| {
        HostError::Invalid("genre baris ini sudah tidak ada di taksonomi — pilih ulang".into())
    })
}

fn ensure_api_key(api_key: Option<&str>) -> Result<String, HostError> {
    match api_key.map(str::trim).filter(|s| !s.is_empty()) {
        Some(key) => Ok(key.to_owned()),
        None => Err(HostError::Invalid(
            "belum ada API key Roblox di keychain — tempel dulu di panel tujuan".into(),
        )),
    }
}

/// `failed` + kalimat. Baris yang sudah dihapus user di tengah unggahan
/// bukan alasan menyembunyikan galat Roblox-nya — `NOT_FOUND` diabaikan,
/// galat basis data lain tetap naik.
fn record_failure(store: &Store, id: &str, message: &str) -> Result<(), LocalError> {
    match store.mark_failed(id, message) {
        Ok(_) | Err(HostError::NotFound(_)) => Ok(()),
        Err(e) => Err(e.to_local()),
    }
}

/// `OpenCloudError` → `LocalError` kontrak: kode `HTTP`, `status` terisi,
/// `message` = kalimat `Display` (sudah kalimat user, disalin dari
/// `describeFailure`).
fn http_error(e: &OpenCloudError) -> LocalError {
    LocalError {
        code: "HTTP",
        message: e.to_string(),
        count: None,
        current_version: None,
        status: Some(e.status()),
    }
}

/// `open_cloud` punya enum sendiri supaya modul itu bebas dari `types.rs`;
/// nilainya identik.
fn cloud_kind(kind: CreatorKind) -> open_cloud::CreatorKind {
    match kind {
        CreatorKind::User => open_cloud::CreatorKind::User,
        CreatorKind::Group => open_cloud::CreatorKind::Group,
    }
}

fn local_moderation(state: open_cloud::ModerationState) -> ModerationState {
    match state {
        open_cloud::ModerationState::Reviewing => ModerationState::Reviewing,
        open_cloud::ModerationState::Approved => ModerationState::Approved,
        open_cloud::ModerationState::Rejected => ModerationState::Rejected,
    }
}

#[cfg(test)]
#[path = "roblox_upload_tests.rs"]
mod tests;
