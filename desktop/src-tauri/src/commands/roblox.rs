//! `roblox_*` (docs/21 §3e): taksonomi, antrean, katalog, target, dan dua
//! command yang bicara dengan Open Cloud.
//!
//! `roblox_upload_start` / `roblox_operation_poll` hanya merangkai tiga fase
//! dari `daw_desktop_host::roblox_upload` (siapkan → HTTP → catat) — urutan
//! dan aturannya diuji di crate host terhadap server HTTP tiruan. Yang khas
//! Tauri di sini cuma dua: API key dibaca dari keychain lewat `AppState`,
//! dan progres dipancarkan sebagai event `daw://roblox-progress`. Kunci
//! `Store` TIDAK dipegang selama HTTP: fase 1 dan 3 lewat `with_store`
//! (`spawn_blocking`), fase 2 berjalan di runtime async tanpa kunci — jadi
//! sepuluh unggahan paralel runner dan `roblox_queue_list` tidak saling
//! menunggu.

use daw_desktop_host::open_cloud::DEFAULT_BASE;
use daw_desktop_host::roblox_upload::{
    finish_poll, finish_upload, prepare_poll, prepare_upload, send_poll, send_upload, UploadStarted,
};
use daw_desktop_host::types::{
    CatalogFilter, Category, Genre, OperationState, TargetSettings, Taxonomy, UploadInput,
    UploadRow,
};
use daw_desktop_host::SecretKey;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{with_store, AppState, CmdError, CmdResult, ROBLOX_PROGRESS_EVENT};

/// Muatan `daw://roblox-progress`: `{ id, sent, total }` byte.
#[derive(Clone, Serialize)]
struct RobloxProgress<'a> {
    id: &'a str,
    sent: u64,
    total: u64,
}

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

/// API key dari keychain. `Ok(None)` = belum ditempel (ditolak `INVALID` oleh
/// fase 1, bukan di sini); `Err` = keychain tidak bisa dibaca
/// (`SECRET_UNAVAILABLE`). Nilainya tidak pernah masuk log maupun event.
fn api_key(state: &State<'_, AppState>) -> CmdResult<Option<String>> {
    Ok(state.secrets.get(SecretKey::RobloxApiKey)?)
}

/// Baca `tracks/<hash>`, kirim multipart ke Open Cloud, simpan `operationId`.
/// Event `daw://roblox-progress` `{ id, sent, total }` selama mengirim.
#[tauri::command]
pub async fn roblox_upload_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<UploadStarted> {
    let key = api_key(&state)?;
    let job = {
        let id = id.clone();
        with_store(&state.store, move |s| {
            prepare_upload(s, &id, key.as_deref())
        })
        .await?
    };
    let outcome = send_upload(&job, DEFAULT_BASE, |sent, total| {
        // Gagal memancarkan (jendela sudah ditutup) bukan alasan membatalkan
        // unggahan yang byte-nya sedang berangkat.
        let _ = app.emit(
            ROBLOX_PROGRESS_EVENT,
            RobloxProgress {
                id: &id,
                sent,
                total,
            },
        );
    })
    .await;
    with_store(&state.store, move |s| Ok(finish_upload(s, &id, outcome)))
        .await?
        .map_err(CmdError)
}

/// `GET operations/{id}` untuk baris `id`, lalu perbarui barisnya.
#[tauri::command]
pub async fn roblox_operation_poll(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<OperationState> {
    let key = api_key(&state)?;
    let job = {
        let id = id.clone();
        with_store(&state.store, move |s| prepare_poll(s, &id, key.as_deref())).await?
    };
    let outcome = send_poll(&job, DEFAULT_BASE).await;
    with_store(&state.store, move |s| Ok(finish_poll(s, &id, outcome)))
        .await?
        .map_err(CmdError)
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
