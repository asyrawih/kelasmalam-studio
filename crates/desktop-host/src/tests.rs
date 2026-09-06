//! Tes crate. Server HTTP-nya tulisan tangan di atas `std::net::TcpListener`:
//! yang perlu ditiru hanya empat bentuk respons (utuh, 404, terpotong,
//! chunked kebanyakan), dan itu lebih kecil daripada dependensi mock HTTP
//! mana pun.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use sha2::{Digest, Sha256};

use crate::model::{part_path_for_test, to_hex};
use crate::{
    download_model, model_is_ready, model_path, model_specs, read_model, HostError, ModelId,
    ModelSpec, MODELS_SUBDIR,
};

// ------------------------------------------------------------------- Model

#[test]
fn model_id_parses_and_displays() {
    assert_eq!("base".parse::<ModelId>().unwrap(), ModelId::Base);
    assert_eq!("large".parse::<ModelId>().unwrap(), ModelId::Large);
    assert_eq!(ModelId::Base.to_string(), "base");
    assert_eq!(ModelId::Large.to_string(), "large");
    match "medium".parse::<ModelId>() {
        Err(HostError::UnknownModel(id)) => assert_eq!(id, "medium"),
        other => panic!("harus UnknownModel, dapat {other:?}"),
    }
}

#[test]
fn model_specs_mirror_typescript_definitions() {
    // Angka-angka ini adalah `SCNET_MODELS` di web/src/proof-stem/scnet-model.ts.
    let [base, large] = model_specs("https://studio.kelasmalam.app/");
    assert_eq!(base.id, ModelId::Base);
    assert_eq!(
        base.url,
        "https://studio.kelasmalam.app/models/scnet/scnet-base.onnx"
    );
    assert_eq!(base.bytes, 44_516_685);
    assert_eq!(
        to_hex(&base.sha256.unwrap()),
        "29137273515c3f10dc69e22a84a63bfc09b71abdf27cf801da463e0644870ade"
    );
    assert_eq!(large.id, ModelId::Large);
    assert_eq!(
        large.url,
        "https://studio.kelasmalam.app/models/scnet/scnet-large.onnx"
    );
    assert_eq!(large.bytes, 170_914_085);
    assert_eq!(
        to_hex(&large.sha256.unwrap()),
        "b604b88207a8b3830b7969c7aef708c56710a39bd1c8b196f105ee7b68c0f939"
    );

    // Tanpa `/` di akhir hasilnya sama — pemanggil tidak perlu tahu aturannya.
    assert_eq!(model_specs("https://studio.kelasmalam.app"), [base, large]);
}

#[test]
fn model_path_lives_under_models_subdir() {
    let dir = Path::new("/data");
    assert_eq!(
        model_path(dir, ModelId::Base),
        Path::new("/data")
            .join(MODELS_SUBDIR)
            .join("scnet-base.onnx")
    );
    assert_eq!(
        model_path(dir, ModelId::Large),
        Path::new("/data")
            .join(MODELS_SUBDIR)
            .join("scnet-large.onnx")
    );
}

#[test]
fn read_model_rejects_wrong_size() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = spec_for(&body(1000), "http://unused");
    let path = model_path(tmp.path(), spec.id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, body(999)).unwrap();

    assert!(!model_is_ready(tmp.path(), &spec));
    match read_model(tmp.path(), &spec) {
        Err(HostError::SizeMismatch { expected, actual }) => {
            assert_eq!((expected, actual), (1000, 999));
        }
        other => panic!("harus SizeMismatch, dapat {other:?}"),
    }
}

#[test]
fn read_model_missing_is_io_error() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = spec_for(&body(10), "http://unused");
    match read_model(tmp.path(), &spec) {
        Err(HostError::Io(e)) => assert_eq!(e.kind(), std::io::ErrorKind::NotFound),
        other => panic!("harus Io(NotFound), dapat {other:?}"),
    }
}

// ---------------------------------------------------------------- Unduhan

#[tokio::test]
async fn download_success_verifies_and_reports_progress() {
    let data = body(20_000);
    let server = Server::spawn(Reply::Full(data.clone()));
    let spec = spec_for(&data, &server.url("/models/scnet/scnet-base.onnx"));
    let tmp = tempfile::tempdir().unwrap();
    assert!(!model_is_ready(tmp.path(), &spec));

    let calls = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&calls);
    let path = download_model(tmp.path(), &spec, move |got, total| {
        sink.lock().unwrap().push((got, total));
    })
    .await
    .unwrap();

    assert_eq!(path, model_path(tmp.path(), ModelId::Base));
    assert!(model_is_ready(tmp.path(), &spec));
    assert!(
        !part_path_for_test(&path).exists(),
        ".part harus sudah di-rename"
    );
    assert_eq!(read_model(tmp.path(), &spec).unwrap(), data);

    let calls = calls.lock().unwrap();
    assert!(!calls.is_empty());
    assert!(
        calls.iter().all(|&(_, total)| total == spec.bytes),
        "total selalu spec.bytes"
    );
    assert!(
        calls.windows(2).all(|w| w[0].0 <= w[1].0),
        "progress monoton"
    );
    assert_eq!(*calls.last().unwrap(), (spec.bytes, spec.bytes));
}

#[tokio::test]
async fn download_skips_network_when_already_ready() {
    let data = body(4_096);
    let tmp = tempfile::tempdir().unwrap();
    // URL yang tidak bisa dihubungi: kalau download_model mencoba jaringan,
    // tes ini gagal dengan Http, bukan Ok.
    let spec = spec_for(&data, "http://127.0.0.1:1/scnet-base.onnx");
    let path = model_path(tmp.path(), spec.id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &data).unwrap();

    let mut calls = Vec::new();
    let got = download_model(tmp.path(), &spec, |a, b| calls.push((a, b)))
        .await
        .unwrap();
    assert_eq!(got, path);
    assert_eq!(calls, vec![(spec.bytes, spec.bytes)]);
}

#[tokio::test]
async fn download_wrong_content_length_is_size_mismatch_without_files() {
    let data = body(3_000);
    let server = Server::spawn(Reply::Full(data.clone()));
    let mut spec = spec_for(&data, &server.url("/scnet-base.onnx"));
    spec.bytes += 1;
    let tmp = tempfile::tempdir().unwrap();

    match download_model(tmp.path(), &spec, |_, _| {}).await {
        Err(HostError::SizeMismatch { expected, actual }) => {
            assert_eq!((expected, actual), (3_001, 3_000));
        }
        other => panic!("harus SizeMismatch, dapat {other:?}"),
    }
    assert_no_files(tmp.path(), spec.id);
}

#[tokio::test]
async fn download_chunked_overrun_is_size_mismatch_without_files() {
    // Tanpa Content-Length, kelebihan byte baru ketahuan saat mengalir.
    let data = body(5_000);
    let server = Server::spawn(Reply::Chunked(data.clone()));
    let mut spec = spec_for(&data, &server.url("/scnet-base.onnx"));
    spec.bytes = 4_000;
    let tmp = tempfile::tempdir().unwrap();

    match download_model(tmp.path(), &spec, |_, _| {}).await {
        Err(HostError::SizeMismatch { expected, actual }) => {
            assert_eq!(expected, 4_000);
            assert!(actual > 4_000 && actual <= 5_000, "actual = {actual}");
        }
        other => panic!("harus SizeMismatch, dapat {other:?}"),
    }
    assert_no_files(tmp.path(), spec.id);
}

#[tokio::test]
async fn download_chunked_without_length_succeeds() {
    let data = body(5_000);
    let server = Server::spawn(Reply::Chunked(data.clone()));
    let spec = spec_for(&data, &server.url("/scnet-large.onnx"));
    let tmp = tempfile::tempdir().unwrap();
    download_model(tmp.path(), &spec, |_, _| {}).await.unwrap();
    assert_eq!(read_model(tmp.path(), &spec).unwrap(), data);
}

#[tokio::test]
async fn download_truncated_connection_leaves_no_files() {
    let data = body(50_000);
    let server = Server::spawn(Reply::Truncated {
        body: data.clone(),
        send: 20_000,
    });
    let spec = spec_for(&data, &server.url("/scnet-base.onnx"));
    let tmp = tempfile::tempdir().unwrap();

    let mut last = (0, 0);
    let err = download_model(tmp.path(), &spec, |a, b| last = (a, b))
        .await
        .expect_err("koneksi putus harus error");
    // hyper bisa melapor sebagai error transport ATAU menutup body lebih awal;
    // keduanya sah asal berkas tidak tertinggal.
    assert!(
        matches!(err, HostError::Http(_) | HostError::SizeMismatch { .. }),
        "dapat {err:?}"
    );
    assert!(
        last.0 < spec.bytes,
        "progress tidak boleh pernah melapor selesai"
    );
    assert_no_files(tmp.path(), spec.id);
    assert!(!model_is_ready(tmp.path(), &spec));
}

#[tokio::test]
async fn download_hash_mismatch_leaves_no_files() {
    let data = body(2_000);
    let server = Server::spawn(Reply::Full(data.clone()));
    let mut spec = spec_for(&data, &server.url("/scnet-base.onnx"));
    spec.sha256 = Some([0xAB; 32]);
    let tmp = tempfile::tempdir().unwrap();

    match download_model(tmp.path(), &spec, |_, _| {}).await {
        Err(HostError::HashMismatch) => {}
        other => panic!("harus HashMismatch, dapat {other:?}"),
    }
    assert_no_files(tmp.path(), spec.id);
}

#[tokio::test]
async fn download_http_error_status() {
    let server = Server::spawn(Reply::NotFound);
    let spec = spec_for(&body(10), &server.url("/scnet-base.onnx"));
    let tmp = tempfile::tempdir().unwrap();
    match download_model(tmp.path(), &spec, |_, _| {}).await {
        Err(HostError::HttpStatus { status, url }) => {
            assert_eq!(status, 404);
            assert_eq!(url, spec.url);
        }
        other => panic!("harus HttpStatus, dapat {other:?}"),
    }
    assert_no_files(tmp.path(), spec.id);
}

#[tokio::test]
async fn download_replaces_stale_part_file() {
    let data = body(1_500);
    let server = Server::spawn(Reply::Full(data.clone()));
    let spec = spec_for(&data, &server.url("/scnet-base.onnx"));
    let tmp = tempfile::tempdir().unwrap();
    let final_path = model_path(tmp.path(), spec.id);
    std::fs::create_dir_all(final_path.parent().unwrap()).unwrap();
    let part = part_path_for_test(&final_path);
    std::fs::write(&part, b"sisa unduhan lama yang putus").unwrap();

    download_model(tmp.path(), &spec, |_, _| {}).await.unwrap();
    assert!(!part.exists());
    assert_eq!(read_model(tmp.path(), &spec).unwrap(), data);
}

// ---------------------------------------------------------------- Helper

/// Byte deterministik yang tidak monoton, supaya kesalahan offset ketahuan.
fn body(len: usize) -> Vec<u8> {
    let mut x: u32 = 0x9E37_79B9;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x & 0xFF) as u8
        })
        .collect()
}

fn spec_for(data: &[u8], url: &str) -> ModelSpec {
    ModelSpec {
        id: if url.contains("large") {
            ModelId::Large
        } else {
            ModelId::Base
        },
        url: url.to_owned(),
        bytes: data.len() as u64,
        sha256: Some(Sha256::digest(data).into()),
    }
}

fn assert_no_files(data_dir: &Path, id: ModelId) {
    let final_path = model_path(data_dir, id);
    assert!(!final_path.exists(), "berkas akhir tidak boleh ada");
    assert!(
        !part_path_for_test(&final_path).exists(),
        ".part harus dibersihkan"
    );
}

#[derive(Clone)]
pub(crate) enum Reply {
    /// 200 dengan Content-Length lengkap.
    Full(Vec<u8>),
    /// 200 Transfer-Encoding: chunked (tanpa Content-Length).
    Chunked(Vec<u8>),
    /// 200 dengan Content-Length `body.len()` tapi hanya `send` byte
    /// dikirim, lalu socket ditutup: koneksi putus di tengah.
    Truncated {
        body: Vec<u8>,
        send: usize,
    },
    NotFound,
}

pub(crate) struct Server {
    base: String,
}

impl Server {
    /// Server yang menjawab SETIAP koneksi dengan `reply`. Thread-nya
    /// dibiarkan hidup sampai proses tes selesai — listener di port acak,
    /// tidak ada yang perlu dibersihkan.
    pub(crate) fn spawn(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let reply = reply.clone();
                thread::spawn(move || {
                    // Baca sampai akhir header; isi request tidak penting.
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let _ = write_reply(&mut stream, &reply);
                    let _ = stream.shutdown(Shutdown::Both);
                });
            }
        });
        Self {
            base: format!("http://{addr}"),
        }
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

fn write_reply(stream: &mut std::net::TcpStream, reply: &Reply) -> std::io::Result<()> {
    match reply {
        Reply::Full(body) => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            stream.write_all(body)?;
        }
        Reply::Chunked(body) => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            )?;
            for piece in body.chunks(256) {
                write!(stream, "{:x}\r\n", piece.len())?;
                stream.write_all(piece)?;
                stream.write_all(b"\r\n")?;
            }
            stream.write_all(b"0\r\n\r\n")?;
        }
        Reply::Truncated { body, send } => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            stream.write_all(&body[..*send])?;
        }
        Reply::NotFound => {
            write!(
                stream,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )?;
        }
    }
    stream.flush()
}
