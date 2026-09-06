//! Impor YouTube dari desktop (docs/23): `youtube_status/setup/update/info/bytes`,
//! pembungkus tipis `daw_desktop_host::youtube`.
//!
//! Perkakas (yt-dlp + qjs) tinggal di `<app_data_dir>/tools/` — folder data
//! bawaan, BUKAN folder kepustakaan yang bisa dipindah user: ia cache yang
//! bisa diunduh ulang, bukan data. Progres unduhan (perkakas maupun audio)
//! dipancarkan lewat satu event `daw://youtube-progress` dengan `phase`
//! yang membedakannya; dialog di web menggambar bar dari situ.

use daw_desktop_host::youtube::{Phase, Tools, YoutubeInfo, YoutubeStatus};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

use super::{AppState, CmdResult, YOUTUBE_PROGRESS_EVENT};

#[derive(Clone, Serialize)]
struct YoutubeProgress<'a> {
    /// `tools` = mengunduh yt-dlp/qjs (`name` = binarinya), `audio` =
    /// mengunduh lagu (`name` = id video).
    phase: &'static str,
    name: &'a str,
    done: u64,
    /// 0 = tidak diketahui.
    total: u64,
}

fn tools(state: &State<'_, AppState>) -> Tools {
    Tools::new(&state.tools_dir)
}

fn emitter(app: &AppHandle) -> impl FnMut(Phase, &str, u64, u64) + '_ {
    move |phase, name, done, total| {
        let phase = match phase {
            Phase::Tools => "tools",
            Phase::Audio => "audio",
        };
        // Gagal memancarkan (jendela sudah ditutup) bukan alasan menghentikan
        // unduhan yang sedang berjalan.
        let _ = app.emit(
            YOUTUBE_PROGRESS_EVENT,
            YoutubeProgress {
                phase,
                name,
                done,
                total,
            },
        );
    }
}

#[tauri::command]
pub async fn youtube_status(state: State<'_, AppState>) -> CmdResult<YoutubeStatus> {
    Ok(tools(&state).status().await)
}

/// Unduh perkakas yang belum ada. Idempoten; mengembalikan status sesudahnya.
#[tauri::command]
pub async fn youtube_setup(app: AppHandle, state: State<'_, AppState>) -> CmdResult<YoutubeStatus> {
    let tools = tools(&state);
    let mut progress = emitter(&app);
    Ok(tools.ensure(&mut progress).await?)
}

/// Ganti yt-dlp dengan rilis terbaru kalau hash-nya berbeda. `true` = diganti.
#[tauri::command]
pub async fn youtube_update(app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    let tools = tools(&state);
    let mut progress = emitter(&app);
    Ok(tools.update(&mut progress).await?)
}

#[tauri::command]
pub async fn youtube_info(state: State<'_, AppState>, url: String) -> CmdResult<YoutubeInfo> {
    Ok(tools(&state).info(&url).await?)
}

/// Badan mentah audio (`Response`), seperti `soundcloud_bytes`: beberapa MB
/// sebagai JSON array angka 4× lebih besar dan di-parse di main thread.
#[tauri::command]
pub async fn youtube_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> CmdResult<Response> {
    let tools = tools(&state);
    let mut progress = emitter(&app);
    let audio = tools.download(&url, &mut progress).await?;
    Ok(Response::new(audio.bytes))
}
