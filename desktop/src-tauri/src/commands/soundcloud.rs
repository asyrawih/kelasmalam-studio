//! Discovery SoundCloud dari desktop: `soundcloud_json` dan `soundcloud_bytes`,
//! dijawab DI DALAM PROSES oleh `daw_desktop_host::soundcloud` (pustaka
//! `soundclaude` yang sama dengan server web), bukan diteruskan ke server.
//!
//! Transport desktop (`web/src/soundcloud/desktop-transport.ts`) tetap mengirim
//! URL lengkap seperti yang dipakai web; yang dibaca di sini hanya path +
//! query. Bentuk jawabannya sama dengan server, jadi sisi TS tidak tahu
//! bedanya — dan tidak ada server yang bisa "offline".

use daw_desktop_host::soundcloud::{parse_request, ApiError, JsonReply};
use daw_desktop_host::LocalError;
use tauri::ipc::Response;
use tauri::State;

use super::{AppState, CmdError, CmdResult};

impl From<ApiError> for CmdError {
    fn from(e: ApiError) -> Self {
        CmdError(LocalError {
            code: "HTTP",
            message: e.message,
            count: None,
            current_version: None,
            status: Some(e.status),
        })
    }
}

#[tauri::command]
pub async fn soundcloud_json(state: State<'_, AppState>, url: String) -> CmdResult<JsonReply> {
    let (path, query) = parse_request(&url)?;
    Ok(state.discovery.json(&path, &query).await)
}

/// Badan mentah (`tauri::ipc::Response`), seperti `library_blob`: satu lagu
/// beberapa MB, dan JSON array angka untuk itu 4× lebih besar dan di-parse di
/// main thread. Galat rute → `LocalError` `HTTP` dengan `status`.
#[tauri::command]
pub async fn soundcloud_bytes(state: State<'_, AppState>, url: String) -> CmdResult<Response> {
    let (path, query) = parse_request(&url)?;
    if path != "/v1/stream" && path != "/v1/download" {
        return Err(ApiError::new(404, "no_such_route", "no such route").into());
    }
    let audio = state.discovery.audio(&query).await?;
    Ok(Response::new(audio.bytes))
}
