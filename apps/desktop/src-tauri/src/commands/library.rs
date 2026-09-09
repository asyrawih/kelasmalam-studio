//! `library_*` (docs/21 §2c) — cermin `LibraryApi`.

use daw_desktop_host::types::{
    ImportedTrack, LocalTrack, ProjectBody, ProjectCreated, ProjectSummary, TrackMetaInput,
};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::{with_store, AppState, CmdError, CmdResult};

#[tauri::command]
pub async fn library_tracks(state: State<'_, AppState>) -> CmdResult<Vec<LocalTrack>> {
    with_store(&state.store, |s| s.tracks()).await
}

#[tauri::command]
pub async fn library_has(state: State<'_, AppState>, hash: String) -> CmdResult<bool> {
    with_store(&state.store, move |s| s.has_track(&hash)).await
}

/// Byte mentah — `invoke` di TS menerima `ArrayBuffer`, bukan JSON array.
#[tauri::command]
pub async fn library_blob(state: State<'_, AppState>, hash: String) -> CmdResult<Response> {
    let bytes = with_store(&state.store, move |s| s.blob(&hash)).await?;
    Ok(Response::new(bytes))
}

/// Badan mentah = byte lagu; metadata lewat header `x-hash` dan `x-ext`.
/// TIDAK menulis baris `track` — itu `library_commit`.
#[tauri::command]
pub async fn library_put_bytes(state: State<'_, AppState>, request: Request<'_>) -> CmdResult<()> {
    let header = |name: &str| -> CmdResult<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| CmdError::new("INVALID", format!("header {name} wajib ada")))
    };
    let hash = header("x-hash")?;
    let ext = header("x-ext")?;
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(CmdError::new(
                "INVALID",
                "library_put_bytes butuh badan mentah (ArrayBuffer), bukan JSON",
            ))
        }
    };
    with_store(&state.store, move |s| s.put_bytes(&hash, &ext, &bytes)).await
}

/// Jalur cepat drop Finder: path dibaca Rust langsung, nol byte lewat IPC.
#[tauri::command]
pub async fn library_import_path(
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<ImportedTrack> {
    with_store(&state.store, move |s| {
        s.import_path(std::path::Path::new(&path))
    })
    .await
}

#[tauri::command]
pub async fn library_commit(
    state: State<'_, AppState>,
    hash: String,
    name: String,
    bytes: u64,
    mime: String,
    frames: u64,
    sample_rate: u32,
) -> CmdResult<()> {
    let meta = TrackMetaInput {
        hash,
        name,
        bytes,
        mime,
        frames,
        sample_rate,
    };
    with_store(&state.store, move |s| s.commit_track(&meta)).await
}

#[tauri::command]
pub async fn library_delete_track(state: State<'_, AppState>, hash: String) -> CmdResult<()> {
    with_store(&state.store, move |s| s.delete_track(&hash)).await
}

#[tauri::command]
pub async fn library_put_marks(
    state: State<'_, AppState>,
    hash: String,
    marks: serde_json::Value,
) -> CmdResult<()> {
    with_store(&state.store, move |s| s.put_marks(&hash, &marks)).await
}

#[tauri::command]
pub async fn library_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectSummary>> {
    with_store(&state.store, |s| s.projects()).await
}

#[tauri::command]
pub async fn library_project(state: State<'_, AppState>, id: String) -> CmdResult<ProjectBody> {
    with_store(&state.store, move |s| s.project(&id)).await
}

#[tauri::command]
pub async fn library_project_create(
    state: State<'_, AppState>,
    name: String,
    json: serde_json::Value,
    tracks: Vec<String>,
) -> CmdResult<ProjectCreated> {
    with_store(&state.store, move |s| {
        s.create_project(&name, &json, &tracks)
    })
    .await
}

#[tauri::command]
pub async fn library_project_update(
    state: State<'_, AppState>,
    id: String,
    name: String,
    json: serde_json::Value,
    expected_version: i64,
) -> CmdResult<i64> {
    with_store(&state.store, move |s| {
        s.update_project(&id, &name, &json, expected_version)
    })
    .await
}

#[tauri::command]
pub async fn library_project_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_store(&state.store, move |s| s.delete_project(&id)).await
}

#[tauri::command]
pub async fn library_project_add_track(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
) -> CmdResult<()> {
    with_store(&state.store, move |s| {
        s.add_project_track(&project_id, &hash)
    })
    .await
}

#[tauri::command]
pub async fn library_project_remove_track(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
) -> CmdResult<bool> {
    with_store(&state.store, move |s| {
        s.remove_project_track(&project_id, &hash)
    })
    .await
}
