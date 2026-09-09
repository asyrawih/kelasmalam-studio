//! `store_*` dan `secret_*` (docs/21 §2a).

use daw_desktop_host::types::StoreInfo;
use daw_desktop_host::{HostError, SecretKey};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{with_store, AppState, CmdError, CmdResult, STORE_RELOCATE_EVENT};

#[derive(Clone, Serialize)]
struct RelocateProgress {
    done: u64,
    total: u64,
}

#[tauri::command]
pub async fn store_info(state: State<'_, AppState>) -> CmdResult<StoreInfo> {
    with_store(&state.store, |s| s.info()).await
}

/// Salin → verifikasi → tulis penunjuk folder → hapus lama. Penunjuk ditulis
/// di tengah (callback `commit`) supaya peluncuran berikutnya membuka folder
/// baru HANYA kalau salinannya sudah terbukti lengkap.
#[tauri::command]
pub async fn store_relocate(
    app: AppHandle,
    state: State<'_, AppState>,
    new_dir: String,
) -> CmdResult<StoreInfo> {
    let location_file = state.location_file.clone();
    let target = std::path::PathBuf::from(new_dir);
    with_store(&state.store, move |s| {
        s.relocate(
            &target,
            |done, total| {
                // Gagal memancarkan event (jendela sudah ditutup) bukan
                // alasan menghentikan pemindahan.
                let _ = app.emit(STORE_RELOCATE_EVENT, RelocateProgress { done, total });
            },
            |dir| write_location(&location_file, dir),
        )
    })
    .await
}

/// Tulis path folder kepustakaan ke berkas penunjuk (atomik lewat `.part`).
pub fn write_location(
    location_file: &std::path::Path,
    dir: &std::path::Path,
) -> Result<(), HostError> {
    if let Some(parent) = location_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = location_file.with_extension("part");
    std::fs::write(&part, dir.to_string_lossy().as_bytes())?;
    std::fs::rename(&part, location_file)?;
    Ok(())
}

fn parse_key(key: &str) -> CmdResult<SecretKey> {
    key.parse::<SecretKey>().map_err(CmdError::from)
}

#[tauri::command]
pub fn secret_get(state: State<'_, AppState>, key: String) -> CmdResult<Option<String>> {
    Ok(state.secrets.get(parse_key(&key)?)?)
}

#[tauri::command]
pub fn secret_set(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    Ok(state.secrets.set(parse_key(&key)?, &value)?)
}

#[tauri::command]
pub fn secret_clear(state: State<'_, AppState>, key: String) -> CmdResult<()> {
    Ok(state.secrets.clear(parse_key(&key)?)?)
}
