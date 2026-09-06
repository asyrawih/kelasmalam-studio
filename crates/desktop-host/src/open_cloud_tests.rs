//! Tes klien Open Cloud — port `backend/src/roblox/open-cloud.test.ts`.
//!
//! Server HTTP-nya tulisan tangan di atas `std::net::TcpListener`, dengan
//! satu tambahan dibanding `tests.rs`: permintaan yang MASUK direkam. Yang
//! dijaga di sini terutama bentuk permintaan yang berangkat — Roblox menolak
//! dengan pesan yang tidak menyebut sebabnya kalau salah — dan bentuk balasan
//! yang diterima, termasuk dua variasi yang keduanya nyata: `operationId`
//! telanjang, dan `path: "operations/{id}"`.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::json::{quote, Json};
use super::{
    create_audio_asset, describe_failure, describe_with_genre, ext_of, get_operation, mime_of,
    normalize_base, validate_input, CreateAudioInput, CreatorKind, ModerationState,
    OpenCloudConfig, OpenCloudError, MAX_BYTES, MAX_DESC_LEN,
};

const KEY: &str = "kunci-rahasia";
const BYTES: [u8; 4] = [1, 2, 3, 4];

fn input() -> CreateAudioInput<'static> {
    CreateAudioInput {
        bytes: &BYTES,
        file_name: "lagu.mp3",
        mime: "audio/mpeg",
        name: "LAGU",
        description: "catatan",
        creator_kind: CreatorKind::User,
        creator_id: "123",
    }
}

/// Konfigurasi yang menunjuk ke alamat yang PASTI tidak bisa dihubungi: port
/// 1 di loopback. Tes yang memakainya menuntut tidak ada permintaan sama sekali.
fn unreachable() -> OpenCloudConfig {
    OpenCloudConfig {
        base: "http://127.0.0.1:1".to_owned(),
        api_key: KEY.to_owned(),
        timeout: Duration::from_secs(5),
    }
}

// ------------------------------------------------------- create_audio_asset

#[tokio::test]
async fn create_posts_to_assets_endpoint_with_key_in_header() {
    let server = Server::spawn(Reply::json(
        200,
        r#"{"path":"operations/op-1","done":false}"#,
    ));
    let got = create_audio_asset(&server.cfg(), input(), |_, _| {})
        .await
        .unwrap();
    assert_eq!(got.operation_id, "op-1");
    assert!(!got.done);

    let req = server.last();
    assert_eq!(req.method, "POST");
    assert_eq!(req.path, "/assets/v1/assets");
    assert_eq!(req.header("x-api-key"), Some(KEY));
    assert_eq!(req.header("accept"), Some("application/json"));
}

#[tokio::test]
async fn create_sends_request_as_text_field_and_file_content_as_file() {
    let server = Server::spawn(Reply::json(200, r#"{"path":"operations/op-1"}"#));
    create_audio_asset(&server.cfg(), input(), |_, _| {})
        .await
        .unwrap();

    let req = server.last();
    let content_type = req.header("content-type").unwrap_or_default();
    assert!(
        content_type.starts_with("multipart/form-data; boundary="),
        "content-type: {content_type}"
    );
    // Content-Length harus ada: semua bagian ukurannya diketahui, dan badan
    // chunked adalah hal yang tidak ingin kita uji terhadap Roblox.
    assert!(req.header("content-length").is_some());

    let body = req.body_text();
    assert!(body.contains("name=\"request\""));
    assert!(
        !body.contains("name=\"request\"; filename="),
        "metadata tidak boleh punya filename"
    );
    assert!(body.contains("name=\"fileContent\"; filename=\"lagu.mp3\""));
    assert!(body.contains("Content-Type: audio/mpeg"));
    assert!(body.contains(
        r#"{"assetType":"Audio","displayName":"LAGU","description":"catatan","creationContext":{"creator":{"userId":"123"}}}"#
    ));
    assert!(req.body.windows(4).any(|w| w == BYTES), "byte berkas ikut");
    assert!(req.body.len() > BYTES.len());
}

#[tokio::test]
async fn create_escapes_user_text_in_metadata() {
    let server = Server::spawn(Reply::json(200, r#"{"path":"operations/op-1"}"#));
    let mut i = input();
    i.name = "  Lagu \"Baru\"  ";
    i.description = "baris 1\nGenre: Musik / Lo-fi";
    create_audio_asset(&server.cfg(), i, |_, _| {})
        .await
        .unwrap();
    let body = server.last().body_text();
    assert!(body.contains(r#""displayName":"Lagu \"Baru\"""#), "{body}");
    assert!(body.contains(r#""description":"baris 1\nGenre: Musik / Lo-fi""#));
}

#[tokio::test]
async fn create_group_uses_group_id() {
    let server = Server::spawn(Reply::json(200, r#"{"path":"operations/op-1"}"#));
    let mut i = input();
    i.creator_kind = CreatorKind::Group;
    i.creator_id = "777";
    create_audio_asset(&server.cfg(), i, |_, _| {})
        .await
        .unwrap();
    let body = server.last().body_text();
    assert!(body.contains(r#""creator":{"groupId":"777"}"#));
    assert!(!body.contains("userId"));
}

#[tokio::test]
async fn create_reads_operation_id_from_path_or_bare_field() {
    let from_path = Server::spawn(Reply::json(200, r#"{"path":"operations/op-9"}"#));
    let got = create_audio_asset(&from_path.cfg(), input(), |_, _| {})
        .await
        .unwrap();
    assert_eq!((got.operation_id.as_str(), got.done), ("op-9", false));

    let from_field = Server::spawn(Reply::json(200, r#"{"operationId":"op-8","done":true}"#));
    let got = create_audio_asset(&from_field.cfg(), input(), |_, _| {})
        .await
        .unwrap();
    assert_eq!((got.operation_id.as_str(), got.done), ("op-8", true));
}

#[tokio::test]
async fn create_done_immediately_carries_asset_and_moderation() {
    let server = Server::spawn(Reply::json(
        200,
        r#"{"operationId":"op-3","done":true,"response":{"assetId":98765432109876543210,"moderationResult":{"moderationState":"MODERATION_STATE_APPROVED"}}}"#,
    ));
    let got = create_audio_asset(&server.cfg(), input(), |_, _| {})
        .await
        .unwrap();
    assert!(got.done);
    // Angka diteruskan sebagai teks aslinya — tidak ada presisi yang hilang.
    assert_eq!(got.asset_id.as_deref(), Some("98765432109876543210"));
    assert_eq!(got.moderation_state, Some(ModerationState::Approved));
}

#[tokio::test]
async fn create_without_operation_id_is_malformed_not_empty_success() {
    let server = Server::spawn(Reply::json(200, r#"{"done":false}"#));
    let err = create_audio_asset(&server.cfg(), input(), |_, _| {})
        .await
        .unwrap_err();
    assert!(matches!(err, OpenCloudError::Malformed(_)), "{err:?}");
    assert_eq!(err.code(), "BALASAN_TIDAK_DIKENALI");
    assert_eq!(err.status(), 502);
    assert!(err.to_string().contains("tidak menyebut id operasinya"));
}

#[tokio::test]
async fn create_non_json_success_body_is_malformed() {
    let server = Server::spawn(Reply::text(200, "<html>ok</html>"));
    let err = create_audio_asset(&server.cfg(), input(), |_, _| {})
        .await
        .unwrap_err();
    assert_eq!(
        err,
        OpenCloudError::Malformed("Roblox menjawab dengan sesuatu yang bukan JSON".to_owned())
    );
}

#[tokio::test]
async fn create_trailing_slashes_in_base_do_not_double_slash() {
    let server = Server::spawn(Reply::json(200, r#"{"path":"operations/x"}"#));
    let mut cfg = server.cfg();
    cfg.base.push_str("//");
    create_audio_asset(&cfg, input(), |_, _| {}).await.unwrap();
    assert_eq!(server.last().path, "/assets/v1/assets");
    assert_eq!(normalize_base("https://x.test///"), "https://x.test");
}

#[tokio::test]
async fn create_reports_coarse_progress_zero_then_total() {
    let server = Server::spawn(Reply::json(200, r#"{"path":"operations/op-1"}"#));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&calls);
    create_audio_asset(&server.cfg(), input(), move |sent, total| {
        sink.lock().unwrap().push((sent, total));
    })
    .await
    .unwrap();
    let total = BYTES.len() as u64;
    assert_eq!(*calls.lock().unwrap(), vec![(0, total), (total, total)]);
}

#[tokio::test]
async fn create_failure_never_reports_completion() {
    let server = Server::spawn(Reply::json(401, r#"{"message":"Unauthorized"}"#));
    let mut last = None;
    create_audio_asset(&server.cfg(), input(), |sent, total| {
        last = Some((sent, total))
    })
    .await
    .unwrap_err();
    assert_eq!(last, Some((0, BYTES.len() as u64)));
}

#[tokio::test]
async fn create_network_error_is_transport_504_jaringan() {
    let err = create_audio_asset(&unreachable(), input(), |_, _| {})
        .await
        .unwrap_err();
    assert!(matches!(err, OpenCloudError::Transport(_)), "{err:?}");
    assert_eq!((err.status(), err.code()), (504, "JARINGAN"));
    assert!(err
        .to_string()
        .starts_with("tidak bisa menghubungi Roblox: "));
}

#[tokio::test]
async fn create_timeout_when_roblox_hangs() {
    let server = Server::spawn(Reply::Hang);
    let mut cfg = server.cfg();
    cfg.timeout = Duration::from_millis(300);
    let err = create_audio_asset(&cfg, input(), |_, _| {})
        .await
        .unwrap_err();
    // 300 ms dibulatkan jadi 0, tapi kalimatnya tidak boleh bilang "0 detik".
    assert_eq!(err, OpenCloudError::Timeout { secs: 1 });
    assert_eq!((err.status(), err.code()), (504, "WAKTU_HABIS"));
    assert_eq!(err.to_string(), "Roblox tidak menjawab dalam 1 detik");
}

#[tokio::test]
async fn create_http_errors_become_user_sentences() {
    let server = Server::spawn(Reply::json(403, r#"{"message":"Forbidden"}"#));
    let err = create_audio_asset(&server.cfg(), input(), |_, _| {})
        .await
        .unwrap_err();
    match &err {
        OpenCloudError::Http {
            status,
            code,
            message,
        } => {
            assert_eq!(*status, 403);
            assert_eq!(code, "HTTP_403");
            assert!(message.contains("allowlist IP"), "{message}");
            assert!(message.ends_with("(Forbidden)"), "{message}");
            assert_eq!(err.to_string(), *message);
        }
        other => panic!("harus Http, dapat {other:?}"),
    }
}

#[tokio::test]
async fn create_invalid_input_is_rejected_without_touching_network() {
    let cases: Vec<(CreateAudioInput<'static>, &str)> = vec![
        (
            CreateAudioInput {
                file_name: "lagu.wav",
                ..input()
            },
            "FORMAT",
        ),
        (
            CreateAudioInput {
                file_name: "",
                ..input()
            },
            "NAMA_BERKAS_HILANG",
        ),
        (
            CreateAudioInput {
                bytes: &[],
                ..input()
            },
            "KOSONG",
        ),
        (
            CreateAudioInput {
                name: "   ",
                ..input()
            },
            "NAMA_KOSONG",
        ),
        (
            CreateAudioInput {
                creator_id: "12a",
                ..input()
            },
            "PEMILIK",
        ),
        (
            CreateAudioInput {
                creator_id: "",
                ..input()
            },
            "PEMILIK",
        ),
    ];
    for (i, code) in cases {
        let err = create_audio_asset(&unreachable(), i, |_, _| {})
            .await
            .unwrap_err();
        assert!(matches!(err, OpenCloudError::Invalid { .. }), "{err:?}");
        assert_eq!(err.code(), code);
        assert_eq!(err.status(), 400);
    }
}

#[test]
fn validate_input_checks_lengths_like_the_worker() {
    let long_name = "n".repeat(51);
    let err = validate_input(&CreateAudioInput {
        name: &long_name,
        ..input()
    })
    .unwrap_err();
    assert_eq!(err.code(), "NAMA_PANJANG");
    assert_eq!(err.to_string(), "nama 51 karakter, maksimum 50");

    let long_desc = "é".repeat(MAX_DESC_LEN + 1); // dihitung per karakter, bukan byte
    let err = validate_input(&CreateAudioInput {
        description: &long_desc,
        ..input()
    })
    .unwrap_err();
    assert_eq!(err.code(), "DESKRIPSI_PANJANG");

    let big = vec![0u8; MAX_BYTES as usize + 1];
    let err = validate_input(&CreateAudioInput {
        bytes: &big,
        ..input()
    })
    .unwrap_err();
    assert_eq!(err.code(), "UKURAN");

    assert_eq!(
        validate_input(&CreateAudioInput {
            file_name: "LAGU.OGG",
            ..input()
        }),
        Ok(())
    );
}

// ------------------------------------------------------------ get_operation

#[tokio::test]
async fn operation_finds_asset_id_in_response() {
    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"response":{"assetId":"556677"}}"#,
    ));
    let got = get_operation(&server.cfg(), "op-1").await.unwrap();
    assert!(got.done);
    assert_eq!(got.asset_id.as_deref(), Some("556677"));
    assert_eq!(got.moderation_state, None);

    let req = server.last();
    assert_eq!(req.method, "GET");
    assert_eq!(req.path, "/assets/v1/operations/op-1");
    assert_eq!(req.header("x-api-key"), Some(KEY));
}

#[tokio::test]
async fn operation_forwards_moderation_states() {
    for (raw, expected) in [
        ("MODERATION_STATE_APPROVED", ModerationState::Approved),
        ("MODERATION_STATE_REVIEWING", ModerationState::Reviewing),
        ("MODERATION_STATE_REJECTED", ModerationState::Rejected),
        ("Rejected", ModerationState::Rejected),
    ] {
        let done = expected != ModerationState::Reviewing;
        let server = Server::spawn(Reply::json(
            200,
            &format!(
                r#"{{"done":{done},"response":{{"assetId":"123","moderationResult":{{"moderationState":"{raw}"}}}}}}"#
            ),
        ));
        let got = get_operation(&server.cfg(), "op-moderasi").await.unwrap();
        assert_eq!(got.moderation_state, Some(expected), "{raw}");
        assert_eq!(got.done, done);
    }
}

#[tokio::test]
async fn operation_finds_asset_id_in_assets_path_and_at_root() {
    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"response":{"path":"assets/889"}}"#,
    ));
    let got = get_operation(&server.cfg(), "op-1").await.unwrap();
    assert_eq!(got.asset_id.as_deref(), Some("889"));

    // `response.assetId` null → jatuh ke `assetId` akar, seperti `??` di TS.
    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"assetId":42,"response":{"assetId":null}}"#,
    ));
    let got = get_operation(&server.cfg(), "op-1").await.unwrap();
    assert_eq!(got.asset_id.as_deref(), Some("42"));
}

#[tokio::test]
async fn operation_not_done_is_not_a_failure() {
    let server = Server::spawn(Reply::json(200, r#"{"done":false}"#));
    let got = get_operation(&server.cfg(), "op-1").await.unwrap();
    assert!(!got.done);
    assert_eq!(got.asset_id, None);
    assert_eq!(got.moderation_state, None);
}

#[tokio::test]
async fn operation_done_with_error_is_failure_not_success() {
    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"error":{"code":"MODERATED","message":"ditolak moderasi"}}"#,
    ));
    let err = get_operation(&server.cfg(), "op-1").await.unwrap_err();
    assert_eq!(
        err,
        OpenCloudError::OperationFailed {
            code: "MODERATED".to_owned(),
            message: "ditolak moderasi".to_owned(),
        }
    );
    assert_eq!(err.status(), 422);
    assert_eq!(err.to_string(), "ditolak moderasi");

    // Tanpa kode/pesan pun tetap gagal, dengan kalimat pengganti.
    let server = Server::spawn(Reply::json(200, r#"{"done":true,"error":{}}"#));
    let err = get_operation(&server.cfg(), "op-1").await.unwrap_err();
    assert_eq!(err.code(), "OPERASI_GAGAL");
    assert_eq!(
        err.to_string(),
        "Roblox menolak asset ini tanpa menyebut alasannya"
    );

    // `error: null` BUKAN error — Roblox menulisnya begitu pada operasi sukses.
    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"error":null,"response":{"assetId":"1"}}"#,
    ));
    assert!(get_operation(&server.cfg(), "op-1").await.is_ok());
}

#[tokio::test]
async fn operation_id_is_url_encoded() {
    let server = Server::spawn(Reply::json(200, r#"{"done":false}"#));
    get_operation(&server.cfg(), "op/1 aneh").await.unwrap();
    assert_eq!(server.last().path, "/assets/v1/operations/op%2F1%20aneh");
}

#[tokio::test]
async fn operation_http_error_uses_body_code() {
    let server = Server::spawn(Reply::json(
        404,
        r#"{"error":{"code":"NOT_FOUND","message":"operation not found"}}"#,
    ));
    let err = get_operation(&server.cfg(), "op-hilang").await.unwrap_err();
    assert_eq!(err.status(), 404);
    assert_eq!(err.code(), "NOT_FOUND");
    assert_eq!(
        err.to_string(),
        "endpoint atau operasi tidak ditemukan di Roblox (operation not found)"
    );
}

// --------------------------------------------------------- describe_failure

#[test]
fn describe_failure_403_mentions_ip_allowlist() {
    let d = describe_failure(403, r#"{"message":"Forbidden"}"#);
    let msg = d.to_string();
    assert!(msg.contains("allowlist IP"), "{msg}");
    assert!(msg.contains("Forbidden"), "{msg}");
}

#[test]
fn describe_failure_distinguishes_401_429_5xx() {
    let says = |status: u16, needle: &str| {
        let msg = describe_failure(status, "").to_string();
        assert!(msg.contains(needle), "{status}: {msg}");
    };
    says(401, "tidak dikenali");
    says(429, "kuota");
    says(503, "Roblox sedang bermasalah");
    says(413, "terlalu besar");
    says(418, "HTTP 418");
}

#[test]
fn describe_failure_uses_code_from_body_when_present() {
    assert_eq!(
        describe_failure(400, r#"{"code":"INVALID_ARGUMENT"}"#).code(),
        "INVALID_ARGUMENT"
    );
    assert_eq!(describe_failure(400, "").code(), "HTTP_400");
    // Bukan JSON → 200 karakter pertama badan jadi detail.
    let long = "x".repeat(300);
    let msg = describe_failure(500, &long).to_string();
    assert_eq!(
        msg,
        format!("Roblox sedang bermasalah ({})", "x".repeat(200))
    );
}

// ----------------------------------------------------- describe_with_genre

#[test]
fn describe_with_genre_appends_last_line() {
    assert_eq!(
        describe_with_genre("catatan", "Musik", "Lo-fi"),
        "catatan\nGenre: Musik / Lo-fi"
    );
    assert_eq!(
        describe_with_genre("catatan\n\n", " Musik ", "Lo-fi"),
        "catatan\nGenre: Musik / Lo-fi"
    );
    assert_eq!(
        describe_with_genre("", "Musik", "Lo-fi"),
        "Genre: Musik / Lo-fi"
    );
    assert_eq!(describe_with_genre("catatan", "", "Lo-fi"), "catatan");
}

#[test]
fn describe_with_genre_cuts_description_not_genre_line() {
    let line = "Genre: Efek suara / Ambience";
    let desc = "é".repeat(MAX_DESC_LEN); // per karakter: 1000 karakter, 2000 byte
    let out = describe_with_genre(&desc, "Efek suara", "Ambience");
    assert_eq!(out.chars().count(), MAX_DESC_LEN);
    assert!(out.ends_with(&format!("\n{line}")));
    assert!(out.starts_with("ééé"));

    // Pas tepat 1000: tidak ada yang dipotong.
    let fit = "a".repeat(MAX_DESC_LEN - line.len() - 1);
    let out = describe_with_genre(&fit, "Efek suara", "Ambience");
    assert_eq!(out, format!("{fit}\n{line}"));
    assert_eq!(out.chars().count(), MAX_DESC_LEN);

    // Baris genre yang kelewat panjang pun tidak menembus batas.
    let out = describe_with_genre("catatan", &"k".repeat(1200), "g");
    assert_eq!(out.chars().count(), MAX_DESC_LEN);
    assert!(out.starts_with("Genre: kkk"));

    // Potongan tidak menyisakan spasi menggantung sebelum '\n'.
    let spaced = format!("{}   ", "b".repeat(MAX_DESC_LEN - line.len() - 3));
    let out = describe_with_genre(&spaced, "Efek suara", "Ambience");
    assert!(!out.contains(" \n"), "{out:?}");
}

// --------------------------------------------------- enum, ekstensi, JSON

#[test]
fn moderation_state_strings_match_typescript_union() {
    for (s, v) in [
        ("reviewing", ModerationState::Reviewing),
        ("approved", ModerationState::Approved),
        ("rejected", ModerationState::Rejected),
    ] {
        assert_eq!(v.as_str(), s);
        assert_eq!(v.to_string(), s);
        assert_eq!(s.parse::<ModerationState>(), Ok(v));
    }
    assert!("Approved".parse::<ModerationState>().is_err());
    assert_eq!(
        ModerationState::from_roblox("MODERATION_STATE_PENDING"),
        None
    );

    assert_eq!("group".parse::<CreatorKind>(), Ok(CreatorKind::Group));
    assert_eq!(CreatorKind::User.to_string(), "user");
    assert!("admin".parse::<CreatorKind>().is_err());
}

#[test]
fn ext_and_mime_mirror_limits_ts() {
    assert_eq!(ext_of("Lagu.MP3"), ".mp3");
    assert_eq!(ext_of("arsip.tar.ogg"), ".ogg");
    assert_eq!(ext_of("tanpa-ekstensi"), "");
    assert_eq!(ext_of(".bashrc"), "");
    assert_eq!(mime_of("a.mp3"), Some("audio/mpeg"));
    assert_eq!(mime_of("a.OGG"), Some("audio/ogg"));
    assert_eq!(mime_of("a.wav"), None);
}

#[test]
fn json_reader_handles_the_shapes_roblox_sends() {
    let v = Json::parse(
        r#" {"done": true, "n": -1.5e3, "s": "a\"b\\c\né🎵", "arr": [1, {"x": null}], "o": {}} "#,
    )
    .unwrap();
    assert_eq!(v.get("done").and_then(Json::as_bool), Some(true));
    assert_eq!(v.get("n"), Some(&Json::Num("-1.5e3".to_owned())));
    assert_eq!(
        v.get("s").and_then(Json::as_str),
        Some("a\"b\\c\n\u{e9}\u{1F3B5}")
    );
    assert_eq!(v.path(&["arr", "x"]), None);
    assert_eq!(v.path(&["o", "x"]), None);
    assert!(v.get("o").unwrap().is_object());
    assert!(v.path(&["arr"]).is_some());
    assert_eq!(v.get("hilang"), None);

    // Surrogate yatim tidak bikin parser gagal — cuma jadi U+FFFD.
    assert_eq!(
        Json::parse(r#""\ud83c x""#).unwrap().as_str(),
        Some("\u{FFFD} x")
    );

    for bad in [
        "",
        "   ",
        "{",
        "{\"a\":}",
        "[1,]",
        "tru",
        "{} x",
        "\"open",
        "-",
        "{\"a\":1}}",
    ] {
        assert_eq!(Json::parse(bad), None, "{bad:?}");
    }
    // Sangat dalam → ditolak, bukan stack overflow.
    let deep = "[".repeat(100) + &"]".repeat(100);
    assert_eq!(Json::parse(&deep), None);

    assert_eq!(
        quote("a\"b\\c\n\t\u{01}\u{e9}"),
        "\"a\\\"b\\\\c\\n\\t\\u0001\u{e9}\""
    );
}

// ---------------------------------------------------------------- Helper

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

    fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Clone)]
enum Reply {
    /// Status + badan dengan Content-Type yang diberikan.
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
            content_type: "text/html",
            body: body.to_owned(),
        }
    }
}

struct Server {
    base: String,
    seen: Arc<Mutex<Vec<Captured>>>,
}

impl Server {
    /// Server yang menjawab SETIAP koneksi dengan `reply` dan merekam
    /// permintaannya. Thread-nya dibiarkan hidup sampai proses tes selesai —
    /// listener di port acak, tidak ada yang perlu dibersihkan.
    fn spawn(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let reply = reply.clone();
                let sink = Arc::clone(&sink);
                thread::spawn(move || {
                    let Some(req) = read_request(&mut stream) else {
                        return;
                    };
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

    fn cfg(&self) -> OpenCloudConfig {
        OpenCloudConfig {
            base: self.base.clone(),
            api_key: KEY.to_owned(),
            timeout: Duration::from_secs(5),
        }
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
/// sepanjang `Content-Length`. Badan chunked tidak didukung — dan itu
/// disengaja: kalau klien mengirim chunked, tes bentuk multipart harus gagal.
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
