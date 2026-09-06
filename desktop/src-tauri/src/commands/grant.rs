//! Grant Access lokal (docs/21 §3f, fase R5): `roblox_grant_*`,
//! `roblox_assets_*`, `roblox_experiences`, `roblox_resolve_place`,
//! `roblox_grant` — pembungkus `daw_desktop_host::roblox_grant`.
//!
//! Dua rahasia yang dibutuhkan jalur ini tidak pernah datang dari WebView:
//! cookie `.ROBLOSECURITY` dan API key dibaca DI SINI dari keychain
//! (`roblox.cookie`, `roblox.api_key`) dan diserahkan ke crate host sebagai
//! `&str`. `roblox_grant_settings_get` hanya menjawab "ada/tidak" — nilai
//! cookie tidak pernah kembali ke halaman, berbeda dengan Worker yang
//! mengembalikannya untuk mengisi ulang kolom (di sini kolomnya memang kosong:
//! yang tersimpan, tersimpan di OS).
//!
//! HTTP berjalan di runtime async Tauri; SQLite lewat `with_store`
//! (`spawn_blocking`) seperti command lain. Sync memisahkan keduanya: tarik
//! semua halaman dulu (async), baru satu transaksi tulis.

use daw_desktop_host::roblox_grant::{
    self, CatalogAsset, CatalogAssetInput, Experience, GrantError, GrantHosts, GrantSettings,
    SubjectType,
};
use daw_desktop_host::types::CreatorKind;
use daw_desktop_host::SecretKey;
use tauri::State;

use super::{with_store, AppState, CmdError, CmdResult};

impl From<GrantError> for CmdError {
    fn from(e: GrantError) -> Self {
        CmdError(e.to_local())
    }
}

/// Produksi: empat host Roblox sungguhan. Satu tempat, supaya tes crate host
/// yang mengarahkan ke server lokal tidak punya padanan tersembunyi di sini.
fn hosts() -> GrantHosts {
    GrantHosts::default()
}

#[tauri::command]
pub async fn roblox_grant_settings_get(state: State<'_, AppState>) -> CmdResult<GrantSettings> {
    let target = with_store(&state.store, |s| s.target()).await?;
    // `is_some()` saja yang keluar; nilainya dibuang di sini.
    let has_cookie = state.secrets.get(SecretKey::RobloxCookie)?.is_some();
    let has_api_key = state.secrets.get(SecretKey::RobloxApiKey)?.is_some();
    Ok(GrantSettings {
        creator_kind: target.creator_kind,
        creator_id: target.creator_id,
        has_cookie,
        has_api_key,
    })
}

#[tauri::command]
pub fn roblox_grant_cookie_set(state: State<'_, AppState>, cookie: String) -> CmdResult<()> {
    // `SecretStore::set` menolak nilai kosong dengan kalimat yang benar.
    Ok(state.secrets.set(SecretKey::RobloxCookie, cookie.trim())?)
}

#[tauri::command]
pub fn roblox_grant_cookie_clear(state: State<'_, AppState>) -> CmdResult<()> {
    Ok(state.secrets.clear(SecretKey::RobloxCookie)?)
}

/// `POST /roblox/assets/sync`: cookie dari keychain → semua halaman audio
/// milik creator aktif → upsert `roblox_catalog_asset`. Hasil = jumlah baris.
#[tauri::command]
pub async fn roblox_assets_sync(state: State<'_, AppState>) -> CmdResult<u64> {
    let cookie = state
        .secrets
        .get(SecretKey::RobloxCookie)?
        .ok_or_else(GrantError::cookie_missing)?;
    let target = with_store(&state.store, |s| s.target()).await?;
    let assets =
        roblox_grant::sync_assets(&hosts(), &cookie, target.creator_kind, &target.creator_id)
            .await?;
    with_store(&state.store, move |s| s.catalog_assets_put_many(&assets)).await
}

#[tauri::command]
pub async fn roblox_assets_list(
    state: State<'_, AppState>,
    query: Option<String>,
) -> CmdResult<Vec<CatalogAsset>> {
    with_store(&state.store, move |s| {
        s.catalog_assets_list(query.as_deref().unwrap_or(""))
    })
    .await
}

#[tauri::command]
pub async fn roblox_assets_import(
    state: State<'_, AppState>,
    assets: Vec<CatalogAssetInput>,
) -> CmdResult<u64> {
    with_store(&state.store, move |s| s.catalog_assets_put_many(&assets)).await
}

#[tauri::command]
pub async fn roblox_assets_record(
    state: State<'_, AppState>,
    asset: CatalogAssetInput,
) -> CmdResult<()> {
    // Baris yang id-nya bukan angka dilewati diam-diam (seperti Worker) —
    // dipanggil untuk tiap unggahan selesai, dan satu baris aneh tidak boleh
    // memunculkan galat di tab yang tidak berhubungan.
    with_store(&state.store, move |s| {
        s.catalog_asset_put(&asset).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn roblox_experiences(
    owner_type: CreatorKind,
    owner_id: String,
) -> CmdResult<Vec<Experience>> {
    Ok(roblox_grant::experiences(&hosts(), owner_type, &owner_id).await?)
}

#[tauri::command]
pub async fn roblox_resolve_place(place_id: String) -> CmdResult<String> {
    Ok(roblox_grant::resolve_place(&hosts(), &place_id).await?)
}

/// `POST /roblox/grants` — API key dari keychain, BUKAN dari argumen.
#[tauri::command]
pub async fn roblox_grant(
    state: State<'_, AppState>,
    asset_ids: Vec<String>,
    subject_type: SubjectType,
    subject_id: String,
) -> CmdResult<u32> {
    let api_key = state
        .secrets
        .get(SecretKey::RobloxApiKey)?
        .ok_or_else(GrantError::api_key_missing)?;
    Ok(roblox_grant::grant_use(&hosts(), &api_key, &asset_ids, subject_type, &subject_id).await?)
}
