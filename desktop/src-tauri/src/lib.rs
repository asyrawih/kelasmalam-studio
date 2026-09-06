//! Sisi Rust aplikasi desktop — sengaja tipis (docs/20 §2d).
//!
//! Yang hidup di sini hanya: registrasi plugin, menu native, dan urusan
//! siklus hidup proses. Tidak ada logika audio, tidak ada logika project —
//! semuanya tetap di `web/` dan berjalan di dalam WebView, persis seperti di
//! browser. Kalau ada dorongan menaruh sesuatu di sini, pertanyaannya:
//! "apakah ini hanya mungkin dilakukan proses native?" Kalau tidak, tempatnya
//! di `web/src/platform/`.

mod menu;

use tauri::{Manager, RunEvent};

/// Command sanity: bukti IPC hidup dari WebView ke Rust. Dipakai adapter
/// platform (D2) untuk mendeteksi bahwa ia benar-benar berjalan di dalam
/// aplikasi ini, bukan sekadar `isTauri()` yang bisa true di WebView lain.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Titik masuk. `src/main.rs` hanya memanggil ini; dipisah ke lib supaya tes
/// unit (`menu::tests`) bisa mengimpor modul tanpa menyeret `main`.
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // window-state: ukuran/posisi jendela dipulihkan saat dibuka lagi.
        // Tanpa ini tiap peluncuran kembali ke 1280×800 di tengah layar —
        // hal kecil yang paling cepat membuat aplikasi terasa "bukan native".
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ping])
        .setup(|app| {
            menu::install(app.handle())?;
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
