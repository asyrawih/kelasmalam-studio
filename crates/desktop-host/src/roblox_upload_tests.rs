//! Tes `roblox_upload_start` / `roblox_operation_poll` di level fungsi:
//! `Store` sungguhan di folder sementara + server HTTP tiruan tulisan tangan
//! (pola `open_cloud_tests.rs`, disalin secukupnya — helper tes modul itu
//! privat dan modul ini tidak ingin mengubahnya). Yang dijaga: transisi
//! status baris sesudah tiap hasil, tidak ada HTTP untuk penolakan lokal, dan
//! badan multipart memuat baris `Genre:` HANYA kalau opsinya hidup.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use super::{operation_poll, prepare_poll, prepare_upload, upload_start, REJECTED_MESSAGE};
use crate::types::{
    CreatorKind, ModerationState, OperationState, TargetSettings, UploadInput, UploadStatus,
};
use crate::{HostError, Store};

const KEY: &str = "kunci-rahasia";
/// Alamat yang pasti tidak bisa dihubungi — tes yang memakainya menuntut
/// tidak ada permintaan sama sekali.
const UNREACHABLE: &str = "http://127.0.0.1:1";

// ---------------------------------------------------------------- Helper

fn open_temp() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    (tmp, store)
}

/// Lagu `.mp3` dengan byte deterministik (header tidak terbaca — tidak
/// masalah, yang diuji adalah byte yang berangkat).
fn seed_track(store: &Store, src_dir: &Path, name: &str, seed: u8) -> (String, Vec<u8>) {
    let bytes: Vec<u8> = (0..2_000u32).map(|i| (i as u8) ^ seed).collect();
    let path = src_dir.join(name);
    std::fs::write(&path, &bytes).unwrap();
    let hash = store.import_path(&path).unwrap().track.hash;
    (hash, bytes)
}

fn queued(hash: &str, name: &str) -> UploadInput {
    UploadInput {
        id: String::new(),
        hash: hash.to_owned(),
        file_name: "lagu.mp3".into(),
        bytes: 0,
        seconds: None,
        name: name.to_owned(),
        description: "catatan".into(),
        category_id: Some("kat:musik".into()),
        genre_id: Some("gen:musik/lo-fi".into()),
        creator_kind: CreatorKind::User,
        creator_id: "123".into(),
        status: UploadStatus::Queued,
        operation_id: None,
        asset_id: None,
        moderation_state: None,
        error: None,
        uploaded_at: None,
        approved_at: None,
    }
}

/// Store + satu baris antrean siap kirim. Mengembalikan `(tmp, store, id, byte lagu)`.
fn ready() -> (tempfile::TempDir, Store, String, Vec<u8>) {
    let (tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let (hash, bytes) = seed_track(&store, src.path(), "lagu.mp3", 7);
    let row = store.queue_put(&queued(&hash, "LAGU")).unwrap();
    (tmp, store, row.id, bytes)
}

fn set_genre_to_description(store: &Store, on: bool) {
    store
        .set_target(&TargetSettings {
            creator_kind: CreatorKind::User,
            creator_id: "123".into(),
            genre_to_description: on,
        })
        .unwrap();
}

async fn start(
    store: &Store,
    id: &str,
    base: &str,
) -> Result<super::UploadStarted, crate::LocalError> {
    upload_start(store, id, Some(KEY), base, |_, _| {}).await
}

// ------------------------------------------------------------ upload_start

#[tokio::test]
async fn success_marks_processing_and_stores_operation_id() {
    let (_tmp, store, id, bytes) = ready();
    let server = Server::spawn(Reply::json(
        200,
        r#"{"path":"operations/op-1","done":false}"#,
    ));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&calls);
    let got = upload_start(&store, &id, Some(KEY), &server.base, move |sent, total| {
        sink.lock().unwrap().push((sent, total));
    })
    .await
    .unwrap();

    assert_eq!(got.operation_id, "op-1");
    assert_eq!(
        got.state,
        OperationState {
            done: false,
            asset_id: None,
            moderation_state: None,
        }
    );
    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Processing);
    assert_eq!(row.operation_id.as_deref(), Some("op-1"));
    assert_eq!(row.moderation_state, Some(ModerationState::Reviewing));
    assert!(row.uploaded_at.is_some());
    assert_eq!(row.error, None);

    // Progres diteruskan (masih kasar: 0 lalu total — docs/21 §5).
    let total = bytes.len() as u64;
    assert_eq!(*calls.lock().unwrap(), vec![(0, total), (total, total)]);

    // Yang berangkat: byte lagu dari `tracks/`, nama berkas baris, kunci di header.
    let req = server.last();
    assert_eq!(
        (req.method.as_str(), req.path.as_str()),
        ("POST", "/assets/v1/assets")
    );
    assert_eq!(req.header("x-api-key"), Some(KEY));
    let body = req.body_text();
    assert!(
        body.contains("name=\"fileContent\"; filename=\"lagu.mp3\""),
        "{body}"
    );
    assert!(body.contains(r#""displayName":"LAGU""#), "{body}");
    assert!(body.contains(r#""creator":{"userId":"123"}"#), "{body}");
    assert!(
        req.body.windows(bytes.len()).any(|w| w == bytes.as_slice()),
        "byte lagu ikut utuh"
    );
}

#[tokio::test]
async fn json_shape_of_upload_started_matches_contract() {
    let (_tmp, store, id, _) = ready();
    let server = Server::spawn(Reply::json(200, r#"{"operationId":"op-2"}"#));
    let got = start(&store, &id, &server.base).await.unwrap();
    let json = serde_json::to_value(&got).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["assetId", "done", "moderationState", "operationId"]);
}

#[tokio::test]
async fn missing_genre_is_invalid_without_http_and_without_touching_status() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let (hash, _) = seed_track(&store, src.path(), "lagu.mp3", 1);
    let mut input = queued(&hash, "LAGU");
    input.genre_id = None;
    let row = store.queue_put(&input).unwrap();

    let err = start(&store, &row.id, UNREACHABLE).await.unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(
        err.message.contains("genre belum dipilih"),
        "{}",
        err.message
    );
    assert_eq!(err.status, None);
    assert_eq!(store.upload(&row.id).unwrap().status, UploadStatus::Queued);

    // Tanpa kategori pun sama, dengan kalimat `kategori-kosong`.
    input.category_id = None;
    let row = store.queue_put(&input).unwrap();
    let err = start(&store, &row.id, UNREACHABLE).await.unwrap_err();
    assert!(
        err.message.contains("kategori belum dipilih"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn missing_api_key_is_invalid_without_http() {
    let (_tmp, store, id, _) = ready();
    for key in [None, Some(""), Some("   ")] {
        let err = upload_start(&store, &id, key, UNREACHABLE, |_, _| {})
            .await
            .unwrap_err();
        assert_eq!(err.code, "INVALID", "{key:?}");
        assert!(err.message.contains("API key"), "{}", err.message);
    }
    assert_eq!(store.upload(&id).unwrap().status, UploadStatus::Queued);
}

#[tokio::test]
async fn unknown_row_is_not_found() {
    let (_tmp, store) = open_temp();
    let err = start(&store, "tidak-ada", UNREACHABLE).await.unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");
}

#[tokio::test]
async fn processing_or_done_rows_are_not_resent() {
    let (_tmp, store, id, _) = ready();
    store.mark_processing(&id, "op-x").unwrap();
    let err = start(&store, &id, UNREACHABLE).await.unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("op-x"), "{}", err.message);

    store
        .mark_done(&id, Some("asset-1"), ModerationState::Approved)
        .unwrap();
    let err = start(&store, &id, UNREACHABLE).await.unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("asset-1"), "{}", err.message);
}

#[tokio::test]
async fn failed_row_can_be_retried() {
    let (_tmp, store, id, _) = ready();
    store.mark_failed(&id, "HTTP 500 kemarin").unwrap();
    let server = Server::spawn(Reply::json(200, r#"{"operationId":"op-ulang"}"#));
    start(&store, &id, &server.base).await.unwrap();
    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Processing);
    assert_eq!(row.error, None, "galat lama dibersihkan");
}

#[tokio::test]
async fn http_429_marks_failed_with_roblox_sentence() {
    let (_tmp, store, id, _) = ready();
    let server = Server::spawn(Reply::json(429, r#"{"message":"quota exceeded"}"#));
    let err = start(&store, &id, &server.base).await.unwrap_err();
    assert_eq!(err.code, "HTTP");
    assert_eq!(err.status, Some(429));
    assert!(err.message.contains("kuota"), "{}", err.message);
    assert!(err.message.ends_with("(quota exceeded)"), "{}", err.message);

    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Failed);
    assert_eq!(row.error.as_deref(), Some(err.message.as_str()));
    assert_eq!(row.operation_id, None);
}

#[tokio::test]
async fn network_failure_marks_failed_too() {
    let (_tmp, store, id, _) = ready();
    let err = start(&store, &id, UNREACHABLE).await.unwrap_err();
    assert_eq!((err.code, err.status), ("HTTP", Some(504)));
    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Failed);
    assert!(row
        .error
        .as_deref()
        .unwrap()
        .starts_with("tidak bisa menghubungi Roblox"));
}

#[tokio::test]
async fn immediately_approved_upload_is_done_at_once() {
    let (_tmp, store, id, _) = ready();
    let server = Server::spawn(Reply::json(
        200,
        r#"{"operationId":"op-3","done":true,"response":{"assetId":"777","moderationResult":{"moderationState":"MODERATION_STATE_APPROVED"}}}"#,
    ));
    let got = start(&store, &id, &server.base).await.unwrap();
    assert!(got.state.done);
    assert_eq!(got.state.asset_id.as_deref(), Some("777"));
    assert_eq!(got.state.moderation_state, Some(ModerationState::Approved));

    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Done);
    assert_eq!(row.asset_id.as_deref(), Some("777"));
    assert!(row.approved_at.is_some());
}

#[tokio::test]
async fn immediately_rejected_upload_is_failed_but_returns_state() {
    let (_tmp, store, id, _) = ready();
    let server = Server::spawn(Reply::json(
        200,
        r#"{"operationId":"op-4","done":true,"response":{"moderationResult":{"moderationState":"Rejected"}}}"#,
    ));
    let got = start(&store, &id, &server.base).await.unwrap();
    assert_eq!(got.state.moderation_state, Some(ModerationState::Rejected));
    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Failed);
    assert_eq!(row.error.as_deref(), Some(REJECTED_MESSAGE));
}

#[tokio::test]
async fn genre_line_in_description_only_when_option_is_on() {
    let (_tmp, store, id, _) = ready();

    // Bawaan: hidup (docs/21 §1d).
    let server = Server::spawn(Reply::json(200, r#"{"operationId":"op-a"}"#));
    start(&store, &id, &server.base).await.unwrap();
    let body = server.last().body_text();
    assert!(
        body.contains(r#""description":"catatan\nGenre: Musik / Lo-fi""#),
        "{body}"
    );

    // Dimatikan: deskripsi apa adanya.
    store.mark_failed(&id, "ulang").unwrap();
    set_genre_to_description(&store, false);
    let server = Server::spawn(Reply::json(200, r#"{"operationId":"op-b"}"#));
    start(&store, &id, &server.base).await.unwrap();
    let body = server.last().body_text();
    assert!(body.contains(r#""description":"catatan""#), "{body}");
    assert!(!body.contains("Genre:"), "{body}");
}

#[tokio::test]
async fn prepare_reads_bytes_from_library_and_hides_key_in_debug() {
    let (_tmp, store, id, bytes) = ready();
    let job = prepare_upload(&store, &id, Some(KEY)).unwrap();
    assert_eq!(job.bytes, bytes);
    assert_eq!(job.mime, "audio/mpeg");
    assert_eq!(store.upload(&id).unwrap().status, UploadStatus::Uploading);
    let dbg = format!("{job:?}");
    assert!(!dbg.contains(KEY), "{dbg}");

    // Byte lagu hilang dari folder → NOT_FOUND, status tidak disentuh.
    store.mark_failed(&id, "x").unwrap();
    for f in std::fs::read_dir(store.tracks_dir()).unwrap() {
        std::fs::remove_file(f.unwrap().path()).unwrap();
    }
    match prepare_upload(&store, &id, Some(KEY)) {
        Err(HostError::NotFound(_)) => {}
        other => panic!("harus NotFound, dapat {other:?}"),
    }
    assert_eq!(store.upload(&id).unwrap().status, UploadStatus::Failed);
}

// ---------------------------------------------------------- operation_poll

fn processing() -> (tempfile::TempDir, Store, String) {
    let (tmp, store, id, _) = ready();
    store.mark_processing(&id, "op-1").unwrap();
    (tmp, store, id)
}

#[tokio::test]
async fn poll_approved_marks_done_with_asset_id() {
    let (_tmp, store, id) = processing();
    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"response":{"assetId":"556677","moderationResult":{"moderationState":"MODERATION_STATE_APPROVED"}}}"#,
    ));
    let got = operation_poll(&store, &id, Some(KEY), &server.base)
        .await
        .unwrap();
    assert_eq!(
        got,
        OperationState {
            done: true,
            asset_id: Some("556677".into()),
            moderation_state: Some(ModerationState::Approved),
        }
    );
    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Done);
    assert_eq!(row.asset_id.as_deref(), Some("556677"));
    assert_eq!(row.moderation_state, Some(ModerationState::Approved));
    assert!(row.approved_at.is_some());

    let req = server.last();
    assert_eq!(
        (req.method.as_str(), req.path.as_str()),
        ("GET", "/assets/v1/operations/op-1")
    );
    assert_eq!(req.header("x-api-key"), Some(KEY));
}

#[tokio::test]
async fn poll_rejected_marks_failed() {
    let (_tmp, store, id) = processing();
    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"response":{"moderationResult":{"moderationState":"MODERATION_STATE_REJECTED"}}}"#,
    ));
    let got = operation_poll(&store, &id, Some(KEY), &server.base)
        .await
        .unwrap();
    assert_eq!(got.moderation_state, Some(ModerationState::Rejected));
    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Failed);
    assert_eq!(row.error.as_deref(), Some(REJECTED_MESSAGE));
}

#[tokio::test]
async fn poll_reviewing_leaves_row_alone() {
    let (_tmp, store, id) = processing();
    let before = store.upload(&id).unwrap();
    let server = Server::spawn(Reply::json(200, r#"{"done":false}"#));
    let got = operation_poll(&store, &id, Some(KEY), &server.base)
        .await
        .unwrap();
    assert!(!got.done);
    assert_eq!(store.upload(&id).unwrap(), before);
}

#[tokio::test]
async fn poll_operation_error_marks_failed_but_transient_http_does_not() {
    let (_tmp, store, id) = processing();
    let server = Server::spawn(Reply::json(503, ""));
    let err = operation_poll(&store, &id, Some(KEY), &server.base)
        .await
        .unwrap_err();
    assert_eq!((err.code, err.status), ("HTTP", Some(503)));
    assert_eq!(
        store.upload(&id).unwrap().status,
        UploadStatus::Processing,
        "5xx sesaat bukan keputusan Roblox"
    );

    let server = Server::spawn(Reply::json(
        200,
        r#"{"done":true,"error":{"code":"MODERATED","message":"konten ditolak"}}"#,
    ));
    let err = operation_poll(&store, &id, Some(KEY), &server.base)
        .await
        .unwrap_err();
    assert_eq!((err.code, err.status), ("HTTP", Some(422)));
    let row = store.upload(&id).unwrap();
    assert_eq!(row.status, UploadStatus::Failed);
    assert_eq!(row.error.as_deref(), Some("konten ditolak"));
}

#[tokio::test]
async fn poll_without_operation_id_is_invalid_without_http() {
    let (_tmp, store, id, _) = ready();
    let err = operation_poll(&store, &id, Some(KEY), UNREACHABLE)
        .await
        .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("id operasi"), "{}", err.message);

    let err = operation_poll(&store, "tidak-ada", Some(KEY), UNREACHABLE)
        .await
        .unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");

    let (_tmp2, store2, id2) = processing();
    assert!(matches!(
        prepare_poll(&store2, &id2, None),
        Err(HostError::Invalid(_))
    ));
}

// ---------------------------------------------------------------- Server

#[derive(Debug, Clone)]
struct Captured {
    method: String,
    path: String,
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
struct Reply {
    status: u16,
    body: String,
}

impl Reply {
    fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_owned(),
        }
    }
}

struct Server {
    base: String,
    seen: Arc<Mutex<Vec<Captured>>>,
}

impl Server {
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
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        reply.status,
                        reply.body.len(),
                        reply.body
                    );
                    let _ = stream.flush();
                    let _ = stream.shutdown(Shutdown::Both);
                });
            }
        });
        Self {
            base: format!("http://{addr}"),
            seen,
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
