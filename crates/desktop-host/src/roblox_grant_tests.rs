//! Tes Grant Access lokal — cetak birunya kasus `Roblox catalog dan grants`
//! di `backend/src/library/worker.test.ts`, di atas server HTTP tulisan
//! tangan (pola `open_cloud_tests.rs`) yang MEMILIH balasan per path: sync
//! memanggil dua host dalam satu alur (auth lalu get-assets), dan satu server
//! yang menjawab semuanya dengan hal yang sama tidak bisa mengujinya.
//!
//! Yang dijaga: URL, header, dan badan yang BERANGKAT (Roblox menolak tanpa
//! menyebut sebab kalau salah), pemetaan galat per rute (401/403/429/502/504)
//! dengan kalimat yang sama dengan Worker, dan tabel `roblox_catalog_asset`.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::json;

use super::{
    authenticated_user_id, experiences, fetch_creations, form_encode, grant_use, resolve_place,
    sync_assets, CatalogAsset, CatalogAssetInput, CatalogSource, Experience, GrantError,
    GrantHosts, GrantSettings, SubjectType, MAX_IMPORT, MAX_NAME_CHARS,
};
use crate::types::CreatorKind;
use crate::{Store, SCHEMA_VERSION};

const COOKIE: &str = "cookie-rahasia-roblox";
const KEY: &str = "secret-key";

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn asset(id: &str, name: &str) -> CatalogAssetInput {
    CatalogAssetInput {
        asset_id: id.to_owned(),
        creator_kind: CreatorKind::User,
        creator_id: "2468".to_owned(),
        name: name.to_owned(),
        moderation_state: None,
        source: CatalogSource::Import,
    }
}

// ---------------------------------------------------------- authenticated

#[tokio::test]
async fn auth_sends_roblosecurity_cookie_and_reads_id() {
    let server = Server::spawn(|_| Reply::json(200, r#"{"id":2468,"name":"ana"}"#));
    let id = authenticated_user_id(&server.hosts(), COOKIE)
        .await
        .unwrap();
    assert_eq!(id, "2468");
    let req = server.last();
    assert_eq!(
        (req.method.as_str(), req.path.as_str()),
        ("GET", "/v1/users/authenticated")
    );
    assert_eq!(
        req.header("cookie"),
        Some(".ROBLOSECURITY=cookie-rahasia-roblox")
    );
    assert_eq!(
        req.header("x-api-key"),
        None,
        "cookie dan API key tidak pernah bersama"
    );
}

#[tokio::test]
async fn auth_rejected_cookie_is_401_cookie_tidak_valid() {
    let server = Server::spawn(|_| Reply::json(401, r#"{"errors":[{"message":"Unauthorized"}]}"#));
    let err = authenticated_user_id(&server.hosts(), COOKIE)
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (401, "COOKIE_TIDAK_VALID"));
    assert_eq!(
        err.to_string(),
        "Cookie Roblox tidak valid atau kedaluwarsa"
    );
    assert_eq!(err.to_local().code, "HTTP");
    assert_eq!(err.to_local().status, Some(401));
}

#[tokio::test]
async fn auth_cookie_with_newline_is_rejected_before_network() {
    let hosts = unreachable();
    let err = authenticated_user_id(&hosts, "abc\ndef").await.unwrap_err();
    assert!(matches!(err, GrantError::Rejected { .. }), "{err:?}");
    assert_eq!(err.code(), "COOKIE");
}

// ------------------------------------------------------------------- sync

#[tokio::test]
async fn sync_walks_every_page_with_cursor_and_group_id() {
    let server = Server::spawn(|req| {
        if req.path.starts_with("/v1/users/authenticated") {
            return Reply::json(200, r#"{"id":1}"#);
        }
        if req.path.contains("cursor=") {
            Reply::json(
                200,
                r#"{"data":[{"assetId":"22","name":"Dua"},{"id":"bukan-angka","name":"x"},{"targetId":33}],"nextPageCursor":null}"#,
            )
        } else {
            Reply::json(
                200,
                r#"{"data":[{"assetId":9876,"name":"Audio Lama","created":"2020-01-01T00:00:00Z"}],"nextPageCursor":"halaman 2/a+b"}"#,
            )
        }
    });
    let got = sync_assets(&server.hosts(), COOKIE, CreatorKind::Group, "42")
        .await
        .unwrap();
    assert_eq!(
        got.iter()
            .map(|a| (a.asset_id.as_str(), a.name.as_str()))
            .collect::<Vec<_>>(),
        [("9876", "Audio Lama"), ("22", "Dua"), ("33", "Asset 33")]
    );
    assert!(got.iter().all(|a| a.creator_kind == CreatorKind::Group
        && a.creator_id == "42"
        && a.source == CatalogSource::Import));

    let seen = server.seen();
    assert_eq!(seen.len(), 3, "auth + dua halaman");
    assert_eq!(
        seen[1].path,
        "/v1/creations/get-assets?assetType=Audio&isArchived=false&limit=50&groupId=42"
    );
    assert_eq!(
        seen[2].path,
        "/v1/creations/get-assets?assetType=Audio&isArchived=false&limit=50&cursor=halaman+2%2Fa%2Bb&groupId=42"
    );
    for req in &seen[1..] {
        assert_eq!(
            req.header("cookie"),
            Some(".ROBLOSECURITY=cookie-rahasia-roblox")
        );
    }
}

#[tokio::test]
async fn sync_user_kind_omits_group_id_and_checks_cookie_owner() {
    let server = Server::spawn(|req| {
        if req.path.starts_with("/v1/users/authenticated") {
            Reply::json(200, r#"{"id":2468}"#)
        } else {
            Reply::json(200, r#"{"data":[{"assetId":1,"name":"Satu"}]}"#)
        }
    });
    let got = sync_assets(&server.hosts(), COOKIE, CreatorKind::User, "2468")
        .await
        .unwrap();
    assert_eq!(got.len(), 1);
    assert!(!server.last().path.contains("groupId"));

    // Cookie milik orang lain: ditolak SEBELUM get-assets dipanggil.
    let err = sync_assets(&server.hosts(), COOKIE, CreatorKind::User, "1")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (409, "USER_BEDA"));
    assert_eq!(err.to_string(), "Cookie Roblox bukan milik User ID 1");
    assert_eq!(err.to_local().code, "INVALID");
    assert_eq!(server.seen().len(), 3, "tidak ada get-assets setelah 409");
}

#[tokio::test]
async fn sync_upstream_failure_is_502_sync_gagal_with_status() {
    let server = Server::spawn(|req| {
        if req.path.starts_with("/v1/users/authenticated") {
            Reply::json(200, r#"{"id":1}"#)
        } else {
            Reply::json(429, r#"{"errors":[{"message":"TooManyRequests"}]}"#)
        }
    });
    let err = fetch_creations(&server.hosts(), COOKIE, CreatorKind::User, "1")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (502, "SYNC_GAGAL"));
    assert_eq!(err.to_string(), "Roblox gagal mengambil audio (HTTP 429)");
}

#[tokio::test]
async fn sync_stops_at_page_cap_even_if_cursor_never_ends() {
    let server = Server::spawn(|_| {
        Reply::json(200, r#"{"data":[{"assetId":"5"}],"nextPageCursor":"lagi"}"#)
    });
    let got = fetch_creations(&server.hosts(), COOKIE, CreatorKind::User, "1")
        .await
        .unwrap();
    assert_eq!(got.len(), super::MAX_SYNC_PAGES);
    assert_eq!(server.seen().len(), super::MAX_SYNC_PAGES);
}

// ------------------------------------------------------------ experiences

#[tokio::test]
async fn experiences_maps_games_endpoint_for_user_and_group() {
    let server = Server::spawn(|_| {
        Reply::json(
            200,
            r#"{"data":[
                {"id":77,"name":"Klub","rootPlace":{"id":88}},
                {"universeId":"78","rootPlaceId":"89"},
                {"id":"bukan","name":"dibuang"}
            ]}"#,
        )
    });
    let got = experiences(&server.hosts(), CreatorKind::Group, "42")
        .await
        .unwrap();
    assert_eq!(
        got,
        [
            Experience {
                universe_id: "77".into(),
                place_id: "88".into(),
                name: "Klub".into()
            },
            Experience {
                universe_id: "78".into(),
                place_id: "89".into(),
                name: "Tanpa nama".into()
            },
        ]
    );
    assert_eq!(
        server.last().path,
        "/v2/groups/42/gamesV2?accessFilter=2&limit=50&sortOrder=Desc"
    );
    assert_eq!(
        server.last().header("cookie"),
        None,
        "endpoint publik: tanpa cookie"
    );

    experiences(&server.hosts(), CreatorKind::User, " 7 ")
        .await
        .unwrap();
    assert_eq!(
        server.last().path,
        "/v2/users/7/games?accessFilter=2&limit=50&sortOrder=Desc"
    );
}

#[tokio::test]
async fn experiences_rejects_non_numeric_owner_and_maps_upstream_failure() {
    let err = experiences(&unreachable(), CreatorKind::User, "abc")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (400, "PEMILIK"));
    assert_eq!(err.to_string(), "ownerId harus angka");
    assert_eq!(err.to_local().code, "INVALID");

    let server = Server::spawn(|_| Reply::text(503, "down"));
    let err = experiences(&server.hosts(), CreatorKind::User, "1")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (502, "ROBLOX"));
    assert_eq!(
        err.to_string(),
        "Roblox gagal mengambil experience (HTTP 503)"
    );
}

// ---------------------------------------------------------- resolve_place

#[tokio::test]
async fn resolve_place_returns_universe_id_from_apis_host() {
    let server = Server::spawn(|_| Reply::json(200, r#"{"universeId":77}"#));
    assert_eq!(resolve_place(&server.hosts(), "88").await.unwrap(), "77");
    assert_eq!(server.last().path, "/universes/v1/places/88/universe");
}

#[tokio::test]
async fn resolve_place_errors_match_worker() {
    let err = resolve_place(&unreachable(), "8x").await.unwrap_err();
    assert_eq!((err.status(), err.code()), (400, "PLACE"));

    let server = Server::spawn(|_| Reply::json(200, r#"{"universeId":null}"#));
    let err = resolve_place(&server.hosts(), "88").await.unwrap_err();
    assert_eq!((err.status(), err.code()), (404, "TIDAK_ADA"));
    assert_eq!(err.to_string(), "Universe ID tidak ditemukan");

    let server = Server::spawn(|_| Reply::text(500, ""));
    let err = resolve_place(&server.hosts(), "88").await.unwrap_err();
    assert_eq!((err.status(), err.code()), (502, "ROBLOX"));
    assert_eq!(
        err.to_string(),
        "Roblox gagal mencari Universe ID (HTTP 500)"
    );
}

// ------------------------------------------------------------------ grant

#[tokio::test]
async fn grant_patches_asset_permissions_with_key_and_batch_body() {
    let server = Server::spawn(|_| Reply::json(200, "{}"));
    let n = grant_use(
        &server.hosts(),
        KEY,
        &ids(&["123", "456", "123", "abc"]),
        SubjectType::Universe,
        "77",
    )
    .await
    .unwrap();
    assert_eq!(n, 2, "id ganda dan bukan angka dibuang");

    let req = server.last();
    assert_eq!(req.method, "PATCH");
    assert_eq!(req.path, "/asset-permissions-api/v1/assets/permissions");
    assert_eq!(req.header("x-api-key"), Some(KEY));
    assert_eq!(req.header("content-type"), Some("application/json"));
    assert_eq!(req.header("cookie"), None);
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(
        body,
        json!({
            "subjectType": "Universe",
            "subjectId": "77",
            "action": "Use",
            "requests": [{ "assetId": "123" }, { "assetId": "456" }],
        })
    );
}

#[tokio::test]
async fn grant_forwards_403_and_turns_other_failures_into_502_with_body() {
    let server = Server::spawn(|_| Reply::json(403, r#"{"message":"Insufficient scope"}"#));
    let err = grant_use(&server.hosts(), KEY, &ids(&["1"]), SubjectType::Group, "9")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (403, "GRANT_GAGAL"));
    assert_eq!(err.to_string(), r#"{"message":"Insufficient scope"}"#);
    assert_eq!(err.to_local().status, Some(403));

    let server = Server::spawn(|_| Reply::text(429, ""));
    let err = grant_use(&server.hosts(), KEY, &ids(&["1"]), SubjectType::User, "9")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (502, "GRANT_GAGAL"));
    assert_eq!(err.to_string(), "Roblox menjawab 429");

    let long = "x".repeat(900);
    let server = Server::spawn(move |_| Reply::text(500, &long));
    let err = grant_use(&server.hosts(), KEY, &ids(&["1"]), SubjectType::User, "9")
        .await
        .unwrap_err();
    assert_eq!(err.to_string().len(), 500, "badan dipotong 500 karakter");
}

#[tokio::test]
async fn grant_validates_before_touching_network() {
    let hosts = unreachable();
    let err = grant_use(&hosts, "  ", &ids(&["1"]), SubjectType::Universe, "7")
        .await
        .unwrap_err();
    assert_eq!(err, GrantError::api_key_missing());
    assert_eq!((err.status(), err.code()), (401, "KUNCI_HILANG"));
    assert_eq!(err.to_string(), "API key Roblox wajib diisi");
    assert_eq!(err.to_local().code, "INVALID");

    let err = grant_use(&hosts, KEY, &ids(&["x", "y"]), SubjectType::Universe, "7")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (400, "ASSET"));
    assert_eq!(err.to_string(), "pilih 1 sampai 100 asset");

    let too_many: Vec<String> = (0..101).map(|i| i.to_string()).collect();
    let err = grant_use(&hosts, KEY, &too_many, SubjectType::Universe, "7")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "ASSET");

    let err = grant_use(&hosts, KEY, &ids(&["1"]), SubjectType::Universe, "tujuh")
        .await
        .unwrap_err();
    assert_eq!((err.status(), err.code()), (400, "TARGET"));
    assert_eq!(err.to_string(), "target grant tidak sah");

    let err = grant_use(
        &hosts,
        // Newline di TENGAH: di ujung memang di-trim, tapi ini tak bisa jadi header.
        "kun\nci",
        &ids(&["1"]),
        SubjectType::Universe,
        "7",
    )
    .await
    .unwrap_err();
    assert_eq!(err.code(), "API_KEY");
}

#[tokio::test]
async fn grant_timeout_and_network_errors_are_504() {
    let server = Server::spawn(|_| Reply::Hang);
    let mut hosts = server.hosts();
    hosts.long_timeout = Duration::from_millis(300);
    let err = grant_use(&hosts, KEY, &ids(&["1"]), SubjectType::Universe, "7")
        .await
        .unwrap_err();
    assert_eq!(err, GrantError::Timeout { secs: 1 });
    assert_eq!((err.status(), err.code()), (504, "WAKTU_HABIS"));
    assert_eq!(err.to_string(), "Roblox tidak menjawab dalam 1 detik");
    assert_eq!(err.to_local().code, "HTTP");

    let err = grant_use(
        &unreachable(),
        KEY,
        &ids(&["1"]),
        SubjectType::Universe,
        "7",
    )
    .await
    .unwrap_err();
    assert!(matches!(err, GrantError::Transport(_)), "{err:?}");
    assert_eq!((err.status(), err.code()), (504, "JARINGAN"));
    assert!(err
        .to_string()
        .starts_with("tidak bisa menghubungi Roblox: "));
}

#[test]
fn cookie_missing_is_409_like_the_worker() {
    let err = GrantError::cookie_missing();
    assert_eq!((err.status(), err.code()), (409, "COOKIE_HILANG"));
    assert_eq!(
        err.to_string(),
        "Simpan cookie .ROBLOSECURITY untuk mengambil asset lama"
    );
    let local = err.to_local();
    assert_eq!((local.code, local.status), ("INVALID", None));
    assert_eq!(local.message, err.to_string());
}

// ----------------------------------------------------- roblox_catalog_asset

/// Jam maju 1 ms tiap dibaca: `updated_at` monoton, jadi urutan "terbaru
/// dulu" bisa diuji tanpa bergantung pada jam mesin.
fn open_temp() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().unwrap();
    let tick = Arc::new(std::sync::atomic::AtomicI64::new(1_700_000_000_000));
    let store = Store::open_with_clock(
        tmp.path(),
        Box::new(move || tick.fetch_add(1, std::sync::atomic::Ordering::SeqCst)),
    )
    .unwrap();
    (tmp, store)
}

#[test]
fn migration_creates_catalog_table_and_bumps_schema_version() {
    let (_tmp, store) = open_temp();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(
        store.catalog_assets_list("").unwrap(),
        Vec::<CatalogAsset>::new()
    );
}

#[test]
fn put_then_list_and_upsert_keeps_moderation_when_none() {
    let (_tmp, store) = open_temp();
    assert!(store
        .catalog_asset_put(&CatalogAssetInput {
            moderation_state: Some("approved".into()),
            source: CatalogSource::Upload,
            ..asset("12345", "Lagu Malam")
        })
        .unwrap());
    // Sync ulang tanpa moderation_state: nilai lama BERTAHAN, sumber ikut baru.
    assert!(store
        .catalog_asset_put(&asset("12345", "Lagu Malam (v2)"))
        .unwrap());

    let rows = store.catalog_assets_list("").unwrap();
    assert_eq!(
        rows,
        [CatalogAsset {
            asset_id: "12345".into(),
            creator_kind: CreatorKind::User,
            creator_id: "2468".into(),
            name: "Lagu Malam (v2)".into(),
            moderation_state: Some("approved".into()),
            source: CatalogSource::Import,
        }]
    );
}

#[test]
fn put_skips_non_numeric_ids_and_defaults_the_name() {
    let (_tmp, store) = open_temp();
    assert!(!store.catalog_asset_put(&asset("12a", "x")).unwrap());
    assert!(!store
        .catalog_asset_put(&CatalogAssetInput {
            creator_id: "".into(),
            ..asset("1", "x")
        })
        .unwrap());
    assert!(store.catalog_asset_put(&asset(" 9876 ", "   ")).unwrap());
    let long = "n".repeat(MAX_NAME_CHARS + 50);
    assert!(store.catalog_asset_put(&asset("2", &long)).unwrap());

    let rows = store.catalog_assets_list("").unwrap();
    let by_id = |id: &str| rows.iter().find(|r| r.asset_id == id).unwrap();
    assert_eq!(by_id("9876").name, "Asset 9876");
    assert_eq!(by_id("2").name.chars().count(), MAX_NAME_CHARS);
    assert_eq!(rows.len(), 2);
}

#[test]
fn list_searches_name_or_id_with_escaped_like() {
    let (_tmp, store) = open_temp();
    store
        .catalog_asset_put(&asset("12345", "Lagu Malam"))
        .unwrap();
    store.catalog_asset_put(&asset("678", "100% Pagi")).unwrap();
    store.catalog_asset_put(&asset("999", "a_b")).unwrap();

    let names = |q: &str| -> Vec<String> {
        store
            .catalog_assets_list(q)
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect()
    };
    assert_eq!(names("Malam"), ["Lagu Malam"]);
    assert_eq!(names("678"), ["100% Pagi"]);
    // `%` dan `_` adalah teks user, bukan wildcard.
    assert_eq!(names("%"), ["100% Pagi"]);
    assert_eq!(names("_"), ["a_b"]);
    assert_eq!(names("tidak ada"), Vec::<String>::new());
    // Terbaru dulu.
    assert_eq!(names(""), ["a_b", "100% Pagi", "Lagu Malam"]);
}

#[test]
fn put_many_is_one_transaction_and_caps_at_max_import() {
    let (_tmp, store) = open_temp();
    let inputs: Vec<CatalogAssetInput> = (0..5)
        .map(|i| asset(&i.to_string(), &format!("Audio {i}")))
        .chain(std::iter::once(asset("bukan", "dilewati")))
        .collect();
    assert_eq!(store.catalog_assets_put_many(&inputs).unwrap(), 5);
    assert_eq!(store.catalog_assets_list("").unwrap().len(), 5);

    let too_many: Vec<CatalogAssetInput> = (0..=MAX_IMPORT)
        .map(|i| asset(&i.to_string(), "x"))
        .collect();
    let err = store.catalog_assets_put_many(&too_many).unwrap_err();
    assert!(matches!(err, crate::HostError::Invalid(_)), "{err:?}");
    assert_eq!(err.to_string(), "maksimum 1000 asset sekali import");
    assert_eq!(
        store.catalog_assets_list("").unwrap().len(),
        5,
        "tidak ada yang masuk"
    );
}

// -------------------------------------------------------- bentuk kontrak

#[test]
fn ipc_shapes_are_camel_case_like_the_contract() {
    let asset = CatalogAsset {
        asset_id: "1".into(),
        creator_kind: CreatorKind::Group,
        creator_id: "2".into(),
        name: "n".into(),
        moderation_state: None,
        source: CatalogSource::Upload,
    };
    assert_eq!(
        serde_json::to_value(&asset).unwrap(),
        json!({ "assetId": "1", "creatorKind": "group", "creatorId": "2", "name": "n", "moderationState": null, "source": "upload" })
    );
    // Argumen dari TS: `moderationState` boleh absen.
    let input: CatalogAssetInput = serde_json::from_value(
        json!({ "assetId": "1", "creatorKind": "user", "creatorId": "2", "name": "n", "source": "import" }),
    )
    .unwrap();
    assert_eq!(input.moderation_state, None);
    assert_eq!(input.source, CatalogSource::Import);

    assert_eq!(
        serde_json::to_value(GrantSettings {
            creator_kind: CreatorKind::User,
            creator_id: "1".into(),
            has_cookie: true,
            has_api_key: false,
        })
        .unwrap(),
        json!({ "creatorKind": "user", "creatorId": "1", "hasCookie": true, "hasApiKey": false })
    );
    assert_eq!(
        serde_json::to_value(Experience {
            universe_id: "1".into(),
            place_id: "2".into(),
            name: "n".into()
        })
        .unwrap(),
        json!({ "universeId": "1", "placeId": "2", "name": "n" })
    );
    for (raw, v) in [
        ("Universe", SubjectType::Universe),
        ("Group", SubjectType::Group),
        ("User", SubjectType::User),
    ] {
        assert_eq!(
            serde_json::from_value::<SubjectType>(json!(raw)).unwrap(),
            v
        );
        assert_eq!(v.as_str(), raw);
    }
    assert!(serde_json::from_value::<SubjectType>(json!("universe")).is_err());
}

#[test]
fn form_encode_matches_url_search_params() {
    assert_eq!(form_encode("abc-_.*"), "abc-_.*");
    assert_eq!(form_encode("a b/c+d=e&f"), "a+b%2Fc%2Bd%3De%26f");
    assert_eq!(form_encode("é"), "%C3%A9");
}

// ---------------------------------------------------------------- Helper

/// Host yang PASTI tidak bisa dihubungi: port 1 di loopback.
fn unreachable() -> GrantHosts {
    let dead = "http://127.0.0.1:1".to_owned();
    GrantHosts {
        users: dead.clone(),
        item_configuration: dead.clone(),
        games: dead.clone(),
        apis: dead,
        short_timeout: Duration::from_secs(5),
        long_timeout: Duration::from_secs(5),
    }
}

/// Satu permintaan yang sampai di server tes.
#[derive(Debug, Clone)]
struct Captured {
    method: String,
    path: String,
    /// Nama header sudah huruf kecil.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Captured {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Clone)]
enum Reply {
    Body {
        status: u16,
        content_type: &'static str,
        body: String,
    },
    /// Baca permintaan, lalu diam 3 detik tanpa menjawab: Roblox "hang".
    Hang,
}

impl Reply {
    fn json(status: u16, body: &str) -> Self {
        Self::Body {
            status,
            content_type: "application/json",
            body: body.to_owned(),
        }
    }

    fn text(status: u16, body: &str) -> Self {
        Self::Body {
            status,
            content_type: "text/plain",
            body: body.to_owned(),
        }
    }
}

type Router = Arc<dyn Fn(&Captured) -> Reply + Send + Sync>;

struct Server {
    base: String,
    seen: Arc<Mutex<Vec<Captured>>>,
}

impl Server {
    /// Server yang memilih balasan per permintaan lewat `route` dan merekam
    /// semuanya. Thread-nya dibiarkan hidup sampai proses tes selesai —
    /// listener di port acak, tidak ada yang perlu dibersihkan.
    fn spawn(route: impl Fn(&Captured) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let route: Router = Arc::new(route);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let route = Arc::clone(&route);
                let sink = Arc::clone(&sink);
                thread::spawn(move || {
                    let Some(req) = read_request(&mut stream) else {
                        return;
                    };
                    let reply = route(&req);
                    sink.lock().unwrap().push(req);
                    let _ = write_reply(&mut stream, &reply);
                    let _ = stream.shutdown(Shutdown::Both);
                });
            }
        });
        Self {
            base: format!("http://{addr}"),
            seen,
        }
    }

    /// Keempat host menunjuk ke server ini; path yang membedakan.
    fn hosts(&self) -> GrantHosts {
        GrantHosts {
            users: self.base.clone(),
            item_configuration: self.base.clone(),
            games: self.base.clone(),
            apis: self.base.clone(),
            short_timeout: Duration::from_secs(5),
            long_timeout: Duration::from_secs(5),
        }
    }

    fn seen(&self) -> Vec<Captured> {
        self.seen.lock().unwrap().clone()
    }

    fn last(&self) -> Captured {
        self.seen
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("tidak ada permintaan yang sampai")
    }
}

/// Baca satu permintaan HTTP/1.1 utuh: kepala sampai `\r\n\r\n`, lalu badan
/// sepanjang `Content-Length`.
fn read_request(stream: &mut TcpStream) -> Option<Captured> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        })
        .collect();

    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    body.truncate(len);

    Some(Captured {
        method,
        path,
        headers,
        body,
    })
}

fn write_reply(stream: &mut TcpStream, reply: &Reply) -> std::io::Result<()> {
    match reply {
        Reply::Body {
            status,
            content_type,
            body,
        } => {
            write!(
                stream,
                "HTTP/1.1 {status} Status\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            stream.write_all(body.as_bytes())?;
            stream.flush()
        }
        Reply::Hang => {
            thread::sleep(Duration::from_secs(3));
            Ok(())
        }
    }
}
