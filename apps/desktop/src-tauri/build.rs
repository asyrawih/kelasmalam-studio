//! Build script Tauri.
//!
//! `AppManifest::commands` membuat izin `allow-<command>` / `deny-<command>`
//! untuk SETIAP command aplikasi. Tanpa ini command aplikasi hanya boleh
//! dipanggil dari origin LOKAL (`tauri://`), dan build produksi memuat
//! frontend dari `http://127.0.0.1:<port>` (`src/local_server.rs`) — origin
//! REMOTE di mata ACL Tauri. Gejalanya tanpa izin ini: setiap `invoke` ditolak
//! dengan "not allowed. Plugin not found", padahal `isTauri` true dan halaman
//! terlihat normal. Daftar di bawah harus sama dengan `generate_handler!` di
//! `src/commands/mod.rs`; tes kontrak di `crates/desktop-host` menjaganya, dan
//! `capabilities/default.json` harus menyebut `allow-<slug>` tiap command.

const COMMANDS: &[&str] = &[
    "ping",
    "store_info",
    "store_relocate",
    "secret_get",
    "secret_set",
    "secret_clear",
    "library_tracks",
    "library_has",
    "library_blob",
    "library_put_bytes",
    "library_import_path",
    "library_commit",
    "library_delete_track",
    "library_put_marks",
    "library_projects",
    "library_project",
    "library_project_create",
    "library_project_update",
    "library_project_delete",
    "library_project_add_track",
    "library_project_remove_track",
    "roblox_taxonomy_list",
    "roblox_category_upsert",
    "roblox_category_delete",
    "roblox_genre_upsert",
    "roblox_genre_delete",
    "roblox_queue_list",
    "roblox_queue_put",
    "roblox_queue_remove",
    "roblox_upload_start",
    "roblox_operation_poll",
    "roblox_catalog_list",
    "roblox_target_get",
    "roblox_target_set",
    "roblox_grant_settings_get",
    "roblox_grant_cookie_set",
    "roblox_grant_cookie_clear",
    "roblox_assets_sync",
    "roblox_assets_list",
    "roblox_assets_import",
    "roblox_assets_record",
    "roblox_experiences",
    "roblox_resolve_place",
    "roblox_grant",
    "soundcloud_json",
    "soundcloud_bytes",
    "model_download",
    "model_read",
    "youtube_status",
    "youtube_setup",
    "youtube_update",
    "youtube_info",
    "youtube_bytes",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("gagal menjalankan tauri-build");
}
