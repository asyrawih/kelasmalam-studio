//! `model_download` / `model_read` (docs/20 §1g) — mengawinkan
//! `daw_desktop_host::model` (PR #44) dengan kontrak `platform/desktop.ts`:
//! `model_download({id}) -> path` dengan event `daw://model-progress`
//! `{id, done, total}`, lalu `model_read({id}) -> byte`.
//!
//! Model tinggal di `<folder kepustakaan>/models/` supaya ikut pindah saat
//! `store_relocate`; folder itu yang dibaca dari `Store::dir()`.

use daw_desktop_host::{download_model, model_specs, read_model, ModelId, ModelSpec};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

use super::{with_store, AppState, CmdError, CmdResult, MODEL_BASE_URL, MODEL_PROGRESS_EVENT};

#[derive(Clone, Serialize)]
struct ModelProgress<'a> {
    id: &'a str,
    done: u64,
    total: u64,
}

fn spec_for(id: &str) -> CmdResult<ModelSpec> {
    let id: ModelId = id.parse().map_err(CmdError::from)?;
    let [base, large] = model_specs(MODEL_BASE_URL);
    Ok(match id {
        ModelId::Base => base,
        ModelId::Large => large,
    })
}

async fn data_dir(state: &State<'_, AppState>) -> CmdResult<std::path::PathBuf> {
    with_store(&state.store, |s| Ok(s.dir().to_path_buf())).await
}

#[tauri::command]
pub async fn model_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<String> {
    let spec = spec_for(&id)?;
    let dir = data_dir(&state).await?;
    let path = download_model(&dir, &spec, |done, total| {
        let _ = app.emit(
            MODEL_PROGRESS_EVENT,
            ModelProgress {
                id: &id,
                done,
                total,
            },
        );
    })
    .await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Byte mentah model (`Response`), bukan JSON array — 170 MB sebagai JSON
/// adalah ratusan MB teks yang harus di-parse main thread.
#[tauri::command]
pub async fn model_read(state: State<'_, AppState>, id: String) -> CmdResult<Response> {
    let spec = spec_for(&id)?;
    let dir = data_dir(&state).await?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_model(&dir, &spec))
        .await
        .map_err(|e| CmdError::new("IO", format!("thread kerja gagal: {e}")))??;
    Ok(Response::new(bytes))
}
