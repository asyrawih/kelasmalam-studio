//! Proxy HTTP untuk layanan yang halaman web panggil langsung lewat `fetch`,
//! tapi yang di desktop harus lewat Rust.
//!
//! Kenapa ada modul ini sama sekali: WebView tetap menegakkan CORS, dan origin
//! desktop (`tauri://localhost` di macOS, `http://tauri.localhost` di Windows)
//! bukan origin yang dikenal server mana pun. Server discovery SoundCloud
//! hanya mengizinkan `https://studio.kelasmalam.app` — dari desktop setiap
//! permintaan lolos sampai server lalu mati di pemeriksaan CORS WebView, tanpa
//! satu baris pun di log server. Meminta server membuka origin desktop bisa,
//! tapi itu berarti tiap layanan baru harus tahu soal desktop. Rust tidak
//! punya CORS: satu proxy kecil di sini, dan halaman memakai jalur yang sama
//! dengan Roblox (docs/21 §1e).
//!
//! Yang dijaga ketat: **allowlist host**. Command yang menerima URL bebas dari
//! WebView adalah SSRF terbuka — halaman yang disusupi bisa memakai aplikasi
//! sebagai batu loncatan ke jaringan lokal user. Maka URL diperiksa sebelum
//! satu byte pun berangkat: skema `https` dan host yang terdaftar, atau
//! loopback `http` untuk pengembangan server di mesin sendiri.

use std::time::Duration;

use reqwest::Url;
use serde::Serialize;

use crate::HostError;

/// Host server discovery SoundCloud (`soundcloud.kelasmalam.app`), satu-satunya
/// tujuan `soundcloud_*`. Loopback selalu boleh — lihat [`check_url`].
pub const SOUNDCLOUD_HOSTS: &[&str] = &["soundcloud.kelasmalam.app"];

/// Batas satu permintaan. Pencarian selesai dalam detik; stream audio satu
/// lagu bisa beberapa MB, jadi lebih longgar dari `open_cloud`.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// Balasan JSON apa adanya: status HTTP + badan yang sudah diurai. Status
/// bukan-2xx TIDAK dijadikan galat di sini — halaman yang tahu bentuk pesan
/// galat servernya (`{ message }`, `{ error }`, `{ kind }`) dan kalimat
/// fallback-nya; Rust hanya meneruskan.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JsonReply {
    pub status: u16,
    /// `null` kalau badan bukan JSON (server 502 dengan halaman HTML, misalnya).
    pub body: serde_json::Value,
}

/// Terima URL kalau (a) `https` ke salah satu `allowed_hosts`, atau (b) `http`
/// atau `https` ke loopback (`localhost`, `127.0.0.1`, `[::1]`) — jalur
/// `VITE_SOUNDCLAUDE_API=http://localhost:8080` untuk yang mengembangkan
/// server-nya sendiri. Semua yang lain ditolak dengan `INVALID` sebelum ada
/// koneksi.
pub fn check_url(url: &str, allowed_hosts: &[&str]) -> Result<Url, HostError> {
    let parsed = Url::parse(url).map_err(|e| HostError::Invalid(format!("URL tidak sah: {e}")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| HostError::Invalid("URL tanpa host".to_owned()))?
        .to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1");
    match parsed.scheme() {
        "https" if loopback || allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) => {
            Ok(parsed)
        }
        "http" if loopback => Ok(parsed),
        scheme => Err(HostError::Invalid(format!(
            "host {host} lewat {scheme} tidak diizinkan dari desktop"
        ))),
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, HostError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(HostError::Http)
}

/// `GET` yang balasannya JSON. Status diteruskan apa adanya (lihat [`JsonReply`]).
pub async fn get_json(url: &Url, timeout: Duration) -> Result<JsonReply, HostError> {
    let response = client(timeout)?
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(HostError::Http)?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(HostError::Http)?;
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Ok(JsonReply { status, body })
}

/// `GET` yang balasannya byte (stream audio). Bukan-2xx = galat `HTTP` dengan
/// statusnya — untuk byte tidak ada "badan galat yang berguna" untuk diteruskan.
pub async fn get_bytes(url: &Url, timeout: Duration) -> Result<Vec<u8>, HostError> {
    let response = client(timeout)?
        .get(url.clone())
        .send()
        .await
        .map_err(HostError::Http)?;
    let status = response.status();
    if !status.is_success() {
        return Err(HostError::HttpStatus {
            status: status.as_u16(),
            url: url.to_string(),
        });
    }
    Ok(response.bytes().await.map_err(HostError::Http)?.to_vec())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    // ---------------------------------------------------------- check_url

    #[test]
    fn https_to_allowed_host_is_accepted() {
        let u = check_url(
            "https://soundcloud.kelasmalam.app/v1/search?q=x",
            SOUNDCLOUD_HOSTS,
        )
        .unwrap();
        assert_eq!(u.path(), "/v1/search");
        // Huruf besar di host bukan alasan menolak.
        assert!(check_url("https://SoundCloud.KelasMalam.app/health", SOUNDCLOUD_HOSTS).is_ok());
    }

    #[test]
    fn loopback_http_is_accepted_for_local_dev() {
        for u in [
            "http://localhost:8080/health",
            "http://127.0.0.1:8080/v1/search?q=x",
            "https://localhost/health",
        ] {
            assert!(check_url(u, SOUNDCLOUD_HOSTS).is_ok(), "{u}");
        }
    }

    #[test]
    fn other_hosts_and_plain_http_are_rejected_before_any_request() {
        for u in [
            "http://soundcloud.kelasmalam.app/health", // https saja untuk host publik
            "https://evil.example/v1/search",
            "https://192.168.1.1/admin",
            "file:///etc/passwd",
            "bukan url",
        ] {
            let err = check_url(u, SOUNDCLOUD_HOSTS).unwrap_err();
            assert_eq!(err.code(), "INVALID", "{u}");
        }
    }

    // --------------------------------------------------- get_json / get_bytes

    /// Server sekali jawab: membaca satu permintaan, membalas `status` +
    /// `content_type` + `body`, lalu selesai. Mengembalikan alamatnya.
    fn serve_once(status: u16, content_type: &'static str, body: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn json_reply_keeps_status_and_parsed_body() {
        let base = serve_once(200, "application/json", br#"{"collection":[{"id":7}]}"#);
        let url = check_url(&format!("{base}/v1/search?q=x"), SOUNDCLOUD_HOSTS).unwrap();
        let reply = get_json(&url, DEFAULT_TIMEOUT).await.unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body["collection"][0]["id"], 7);
    }

    #[tokio::test]
    async fn json_reply_passes_error_status_through_with_body() {
        let base = serve_once(404, "application/json", br#"{"message":"tidak ada"}"#);
        let url = check_url(&format!("{base}/v1/track?url=x"), SOUNDCLOUD_HOSTS).unwrap();
        let reply = get_json(&url, DEFAULT_TIMEOUT).await.unwrap();
        assert_eq!(reply.status, 404);
        assert_eq!(reply.body["message"], "tidak ada");
    }

    #[tokio::test]
    async fn non_json_body_becomes_null_not_error() {
        let base = serve_once(502, "text/html", b"<html>bad gateway</html>");
        let url = check_url(&format!("{base}/health"), SOUNDCLOUD_HOSTS).unwrap();
        let reply = get_json(&url, DEFAULT_TIMEOUT).await.unwrap();
        assert_eq!(reply.status, 502);
        assert!(reply.body.is_null());
    }

    #[tokio::test]
    async fn bytes_ok_and_bytes_error_status() {
        let base = serve_once(200, "audio/mpeg", &[1, 2, 3, 4, 5]);
        let url = check_url(&format!("{base}/v1/stream?url=x"), SOUNDCLOUD_HOSTS).unwrap();
        assert_eq!(
            get_bytes(&url, DEFAULT_TIMEOUT).await.unwrap(),
            vec![1, 2, 3, 4, 5]
        );

        let base = serve_once(403, "application/json", br#"{"message":"tidak boleh"}"#);
        let url = check_url(&format!("{base}/v1/stream?url=x"), SOUNDCLOUD_HOSTS).unwrap();
        let err = get_bytes(&url, DEFAULT_TIMEOUT).await.unwrap_err();
        assert_eq!(err.code(), "HTTP");
        assert_eq!(err.to_local().status, Some(403));
    }

    #[test]
    fn json_reply_serializes_with_contract_keys() {
        let v = serde_json::to_value(JsonReply {
            status: 200,
            body: serde_json::json!({ "a": 1 }),
        })
        .unwrap();
        assert_eq!(v["status"], 200);
        assert_eq!(v["body"]["a"], 1);
    }
}

#[cfg(test)]
mod network_tests {
    //! Menyentuh jaringan sungguhan — `#[ignore]`, dijalankan manual:
    //! `cargo test -p daw-desktop-host network_tests -- --ignored --nocapture`.
    //! Ada karena tes di atas memakai server HTTP lokal tanpa TLS, sedangkan
    //! produksi HTTPS: fitur `rustls` reqwest yang salah konfigurasi baru
    //! terlihat di sini, bukan di tes unit.
    use super::*;

    #[tokio::test]
    #[ignore = "butuh jaringan"]
    async fn real_https_health() {
        let url = check_url("https://soundcloud.kelasmalam.app/health", SOUNDCLOUD_HOSTS).unwrap();
        let reply = get_json(&url, DEFAULT_TIMEOUT)
            .await
            .expect("HTTPS lewat reqwest/rustls");
        println!("status={} body={}", reply.status, reply.body);
        assert_eq!(reply.status, 200);
    }
}
