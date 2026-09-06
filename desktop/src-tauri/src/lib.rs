//! Sisi Rust aplikasi desktop — sengaja tipis (docs/20 §2d).
//!
//! Yang hidup di sini hanya: registrasi plugin, menu native, urusan siklus
//! hidup proses, dan pembungkus command untuk penyimpanan lokal (docs/21;
//! `commands/`). Tidak ada logika audio, tidak ada logika project —
//! semuanya tetap di `web/` dan berjalan di dalam WebView, persis seperti di
//! browser. Aturan kepustakaan lokal pun tidak di sini melainkan di
//! `crates/desktop-host`, yang diuji tanpa Tauri. Kalau ada dorongan menaruh
//! sesuatu di sini, pertanyaannya: "apakah ini hanya mungkin dilakukan proses
//! native?" Kalau tidak, tempatnya di `web/src/platform/`.

mod commands;
mod menu;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use daw_desktop_host::{SecretStore, Store};
use tauri::{App, Manager, RunEvent};

use commands::AppState;

/// Berkas penunjuk folder kepustakaan di `app_config_dir()`. Ada hanya kalau
/// user pernah memindahkan foldernya (`store_relocate`); tanpa itu folder
/// bawaan `app_data_dir()` yang dipakai.
const LOCATION_FILE: &str = "library-dir.txt";

/// Command sanity: bukti IPC hidup dari WebView ke Rust. Dipakai adapter
/// platform (D2) untuk mendeteksi bahwa ia benar-benar berjalan di dalam
/// aplikasi ini, bukan sekadar `isTauri()` yang bisa true di WebView lain.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Buka folder kepustakaan dan keychain saat aplikasi mulai.
///
/// Folder: yang tertulis di berkas penunjuk kalau ada DAN masih berisi
/// `library.sqlite` (folder yang dipindah/dihapus user di luar app jatuh ke
/// bawaan — kepustakaan kosong lebih baik daripada app yang tidak bisa
/// dibuka; penunjuk yang basi ditimpa saat relokasi berikutnya). Gagal
/// membuka basis data adalah kegagalan `setup` — app tanpa kepustakaan
/// tidak berguna, dan pesannya lebih jelas di sini daripada di tiap command.
fn open_state(app: &App) -> Result<AppState, Box<dyn std::error::Error>> {
    let default_dir = app.path().app_data_dir()?;
    let location_file = app.path().app_config_dir()?.join(LOCATION_FILE);
    let dir = std::fs::read_to_string(&location_file)
        .ok()
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.join(daw_desktop_host::DB_FILE).is_file())
        .unwrap_or(default_dir);
    let store = Store::open(&dir)?;
    Ok(AppState {
        store: Arc::new(Mutex::new(store)),
        secrets: SecretStore::new(&app.config().identifier),
        location_file,
    })
}

/// Titik masuk. `src/main.rs` hanya memanggil ini; dipisah ke lib supaya tes
/// unit (`menu::tests`) bisa mengimpor modul tanpa menyeret `main`.
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // window-state: ukuran/posisi jendela dipulihkan saat dibuka lagi.
        // Tanpa ini tiap peluncuran kembali ke 1280×800 di tengah layar —
        // hal kecil yang paling cepat membuat aplikasi terasa "bukan native".
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(commands::invoke_handler())
        .setup(|app| {
            menu::install(app.handle())?;
            app.manage(open_state(app)?);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal membangun aplikasi Tauri");

    app.run(|app, event| {
        // Penjaga "project kotor / export sedang berjalan" hidup di JS lewat
        // `onCloseRequested` (D5, sisi web). Ia hanya terpanggil kalau jendela
        // ditutup lewat `close()`. Cmd+Q (item Quit bawaan) memanggil
        // `app.exit()` yang MELEWATI jalur itu — jadi di sini keluar dicegah
        // dan diubah jadi permintaan tutup jendela. Kalau JS mengizinkan,
        // jendela hancur, `ExitRequested` datang lagi tanpa jendela, dan kali
        // ini dibiarkan lewat. Kalau JS menolak, aplikasi tetap hidup — itu
        // memang maksudnya.
        if let RunEvent::ExitRequested { api, .. } = event {
            if let Some(main) = app.get_webview_window(menu::MAIN_WINDOW) {
                api.prevent_exit();
                // Gagal menutup (jendela sedang dihancurkan) berarti kita
                // sedang dalam perjalanan keluar; tidak ada yang perlu dilakukan.
                let _ = main.close();
            }
        }
    });
}
