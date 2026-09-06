//! `roblox_*` (docs/21 §3e): taksonomi, antrean, katalog, target.
//!
//! Dua command yang bicara dengan Open Cloud — `roblox_upload_start` dan
//! `roblox_operation_poll` — SENGAJA masih menolak: klien HTTP-nya
//! (`open_cloud.rs`) digarap terpisah dan dikawinkan di fase R3. Keduanya
//! tetap terdaftar supaya kontrak tidak berlubang: TS memanggil nama yang
//! sudah ada dan mendapat `LocalError` yang jelas, bukan "command not found".

use daw_desktop_host::types::{
    CatalogFilter, Category, Genre, OperationState, TargetSettings, Taxonomy, UploadInput,
    UploadRow,
};
use serde::Serialize;
use tauri::State;

use super::{with_store, AppState, CmdError, CmdResult};

/// Kalimat yang sama untuk kedua command yang belum dikawinkan.
const NOT_WIRED: &str = "unggah Roblox belum dikawinkan (docs/21 R3)";

#[tauri::command]
pub async fn roblox_taxonomy_list(state: State<'_, AppState>) -> CmdResult<Taxonomy> {
    with_store(&state.store, |s| s.taxonomy()).await
}

#[tauri::command]
pub async fn roblox_category_upsert(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    sort: Option<i64>,
) -> CmdResult<Category> {
    with_store(&state.store, move |s| {
        s.upsert_category(id.as_deref(), &name, sort)
    })
    .await
}

#[tauri::command]
pub async fn roblox_category_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_store(&state.store, move |s| s.delete_category(&id)).await
}

#[tauri::command]
pub async fn roblox_genre_upsert(
    state: State<'_, AppState>,
    id: Option<String>,
    category_id: String,
    name: String,
    sort: Option<i64>,
) -> CmdResult<Genre> {
    with_store(&state.store, move |s| {
        s.upsert_genre(id.as_deref(), &category_id, &name, sort)
    })
    .await
}

#[tauri::command]
pub async fn roblox_genre_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_store(&state.store, move |s| s.delete_genre(&id)).await
}

#[tauri::command]
pub async fn roblox_queue_list(state: State<'_, AppState>) -> CmdResult<Vec<UploadRow>> {
    with_store(&state.store, |s| s.queue_list()).await
}

#[tauri::command]
pub async fn roblox_queue_put(
    state: State<'_, AppState>,
    row: UploadInput,
) -> CmdResult<UploadRow> {
    with_store(&state.store, move |s| s.queue_put(&row)).await
}

#[tauri::command]
pub async fn roblox_queue_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_store(&state.store, move |s| s.queue_remove(&id)).await
}

/// Hasil `roblox_upload_start`: `RobloxOperationState & { operationId }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStarted {
    #[serde(flatten)]
    pub state: OperationState,
    pub operation_id: String,
}

/// Belum dikawinkan (R3). `id` tetap diterima supaya tanda tangannya sudah
/// benar saat klien Open Cloud masuk. Saat dikawinkan: baris
/// `Genre: <kategori> / <genre>` di akhir deskripsi ditambahkan DI SINI
/// (`Store::upload_genre_names` + `Store::target().genre_to_description`,
/// `open_cloud::describe_with_genre`) — TS di desktop tidak menambahkannya.
#[tauri::command]
pub async fn roblox_upload_start(
    _state: State<'_, AppState>,
    id: String,
) -> CmdResult<UploadStarted> {
    let _ = id;
    Err(CmdError::new("HTTP", NOT_WIRED))
}

/// Belum dikawinkan (R3).
#[tauri::command]
pub async fn roblox_operation_poll(
    _state: State<'_, AppState>,
    id: String,
) -> CmdResult<OperationState> {
    let _ = id;
    Err(CmdError::new("HTTP", NOT_WIRED))
}

#[tauri::command]
pub async fn roblox_catalog_list(
    state: State<'_, AppState>,
    category_id: Option<String>,
    genre_id: Option<String>,
    query: Option<String>,
) -> CmdResult<Vec<UploadRow>> {
    let filter = CatalogFilter {
        category_id,
        genre_id,
        query,
    };
    with_store(&state.store, move |s| s.catalog_list(&filter)).await
}

#[tauri::command]
pub async fn roblox_target_get(state: State<'_, AppState>) -> CmdResult<TargetSettings> {
    with_store(&state.store, |s| s.target()).await
}

#[tauri::command]
pub async fn roblox_target_set(
    state: State<'_, AppState>,
    creator_kind: daw_desktop_host::types::CreatorKind,
    creator_id: String,
    genre_to_description: bool,
) -> CmdResult<()> {
    let target = TargetSettings {
        creator_kind,
        creator_id,
        genre_to_description,
    };
    with_store(&state.store, move |s| s.set_target(&target)).await
}
