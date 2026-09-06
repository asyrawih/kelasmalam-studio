//! Discovery SoundCloud dari desktop: `soundcloud_json` dan `soundcloud_bytes`.
//!
//! Halaman web memanggil server discovery langsung lewat `fetch`. Dari
//! WebView desktop itu mati di CORS (origin `tauri://localhost` tidak dikenal
//! server), jadi di desktop `SoundCloudApi` memakai transport yang memanggil
//! dua command ini — Rust yang menghubungi server, tanpa CORS. Allowlist host
//! ada di `daw_desktop_host::proxy`; command ini tidak menerima host lain.

use daw_desktop_host::proxy::{self, JsonReply};
use tauri::ipc::Response;

use super::CmdResult;

#[tauri::command]
pub async fn soundcloud_json(url: String) -> CmdResult<JsonReply> {
    let url = proxy::check_url(&url, proxy::SOUNDCLOUD_HOSTS)?;
    Ok(proxy::get_json(&url, proxy::DEFAULT_TIMEOUT).await?)
}

/// Badan mentah (`tauri::ipc::Response`), seperti `library_blob`: stream audio
/// satu lagu beberapa MB, dan JSON array angka untuk itu adalah 4× lebih besar
/// dan di-parse di main thread.
#[tauri::command]
pub async fn soundcloud_bytes(url: String) -> CmdResult<Response> {
    let url = proxy::check_url(&url, proxy::SOUNDCLOUD_HOSTS)?;
    let bytes = proxy::get_bytes(&url, proxy::DEFAULT_TIMEOUT).await?;
    Ok(Response::new(bytes))
}
