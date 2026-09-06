//! Discovery SoundCloud DI DALAM PROSES — pustaka `soundclaude` yang sama
//! dengan yang menjalankan `soundcloud.kelasmalam.app`, dipanggil langsung
//! dari mesin user.
//!
//! ## Kenapa tidak memanggil server sama sekali
//!
//! Server discovery hanyalah lapisan HTTP tipis di atas crate `soundclaude`
//! (`crates/soundclaude-server/src/routes.rs`, ~200 baris): ia menerima
//! `/v1/search?q=…`, memanggil `Client::search`, dan mengembalikan JSON-nya.
//! Web butuh server itu karena browser tidak bisa menghubungi `api-v2.soundcloud.com`
//! sendiri (CORS + `client_id` yang harus di-scrape). Desktop tidak punya
//! kedua batasan itu — jadi lapisan HTTP-nya dilewati, bukan dipindah:
//! tidak ada CORS, tidak ada server yang bisa "offline", tidak ada satu
//! byte pun yang mampir ke server milik kita. Yang tersisa hanyalah
//! SoundCloud sendiri.
//!
//! ## Bentuk jawaban = bentuk jawaban server, sengaja
//!
//! Halaman (`web/src/soundcloud/api.ts`) menafsirkan jawaban server:
//! `collection`, `next_href`, `kind`, `{ error: { kind, message } }`. Modul
//! ini menghasilkan bentuk yang sama persis untuk path yang sama, sehingga
//! sisi TS tidak tahu bedanya — transport desktop tetap mengirim URL
//! `…/v1/search?q=x`, dan yang dibaca di sini hanya path + query-nya. Kalau
//! server berubah bentuk, tempat mengubahnya di sini adalah satu fungsi per
//! rute, di bawah.
//!
//! `client_id` SoundCloud di-scrape sekali dari soundcloud.com dan di-cache
//! di folder data aplikasi (TTL milik pustaka), persis seperti server.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};
use soundclaude::{Client, DownloadOptions, Error as ScError, Format, PaginatedQuery, Protocol};

use crate::HostError;

/// Nama berkas cache `client_id` di folder data aplikasi.
pub const CLIENT_ID_CACHE_FILE: &str = "soundcloud-client-id.json";

/// Balasan JSON: status HTTP "seolah-olah" + badan. Status dipertahankan
/// karena `SoundCloudApi` di TS membaca `status` untuk memutuskan galat, dan
/// pesan galatnya dari `body.error.message` — sama dengan jalur web.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JsonReply {
    pub status: u16,
    pub body: Value,
}

/// Galat rute, cermin `soundclaude-server/src/error.rs`: status + `kind`
/// yang stabil (dibaca TS sebagai fallback pesan) + kalimat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
    pub status: u16,
    pub kind: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            kind,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "bad_request", message)
    }

    fn reply(&self) -> JsonReply {
        JsonReply {
            status: self.status,
            body: json!({ "error": { "kind": self.kind, "message": self.message } }),
        }
    }
}

/// Pemetaan galat pustaka → status, disalin dari server supaya kalimat dan
/// kode yang dilihat user di desktop sama dengan di web.
impl From<ScError> for ApiError {
    fn from(err: ScError) -> Self {
        use ScError as E;
        let (status, kind) = match &err {
            E::NotSoundcloudUrl(_) | E::UrlParse(_) => (400, "invalid_url"),
            E::FirebaseUnresolved(_) => (400, "unresolvable_link"),
            E::NotATrack(_) => (400, "not_a_track"),
            E::NotASet(_) => (400, "not_a_set"),
            E::NoMatchingTranscoding(_) | E::NoTranscodings(_) => (422, "no_media"),
            E::NotFound { .. } => (404, "not_found"),
            E::Forbidden { .. } => (403, "upstream_forbidden"),
            E::TrackUnavailable { .. } => (422, "track_unavailable"),
            E::Unauthorized { .. } => (502, "upstream_unauthorized"),
            E::ClientIdNotFound => (502, "client_id_unavailable"),
            E::ClientIdRejected => (500, "client_id_rejected"),
            E::Status { status, .. } if (500..600).contains(status) => (502, "upstream_error"),
            E::KindMismatch { .. } => (502, "upstream_kind_mismatch"),
            E::Status { .. } | E::MissingMediaUrl(_) | E::Hls(_) => (502, "upstream_error"),
            E::Http(e) if e.is_timeout() => (504, "upstream_timeout"),
            E::Http(_) => (502, "upstream_error"),
            E::Json(_) => (502, "upstream_malformed_json"),
            E::Io(_) | E::Other(_) => (500, "internal"),
        };
        Self::new(status, kind, err.to_string())
    }
}

/// Query string yang sudah diurai. Kunci yang berulang: yang terakhir menang.
pub type Query = HashMap<String, String>;

/// `path` + query dari URL yang dikirim transport desktop. Host dan skema
/// diabaikan dengan sengaja — TS masih menyusun URL dengan basis server web,
/// dan di sini yang berarti hanya rutenya.
pub fn parse_request(url: &str) -> Result<(String, Query), ApiError> {
    // URL relatif (`/v1/search?q=x`) diterima juga, lewat basis palsu.
    let parsed = reqwest::Url::parse(url)
        .or_else(|_| reqwest::Url::parse(&format!("http://local{url}")))
        .map_err(|e| ApiError::bad_request(format!("URL tidak sah: {e}")))?;
    let query: Query = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    Ok((parsed.path().to_owned(), query))
}

/// Audio satu track, sudah utuh di memori (batas praktis: satu lagu).
#[derive(Debug)]
pub struct Audio {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub filename: String,
}

pub struct Discovery {
    client: Client,
}

impl Discovery {
    /// Klien dengan cache `client_id` di `data_dir`. Tidak menyentuh jaringan
    /// di sini — `client_id` di-scrape saat permintaan pertama, dan kalau
    /// gagal, permintaan itulah yang melaporkannya.
    pub fn new(data_dir: &Path) -> Result<Self, HostError> {
        let client = Client::builder()
            .cache_client_id(data_dir.join(CLIENT_ID_CACHE_FILE))
            .build()
            .map_err(|e| HostError::Invalid(format!("klien SoundCloud: {e}")))?;
        Ok(Self { client })
    }

    pub fn with_client(client: Client) -> Self {
        Self { client }
    }

    /// Rute JSON. Tidak pernah gagal sebagai `Err`: galat pun adalah balasan
    /// berstatus, seperti dari server.
    pub async fn json(&self, path: &str, query: &Query) -> JsonReply {
        match self.dispatch(path, query).await {
            Ok(body) => JsonReply { status: 200, body },
            Err(e) => e.reply(),
        }
    }

    async fn dispatch(&self, path: &str, q: &Query) -> Result<Value, ApiError> {
        let c = &self.client;
        let value = match path.trim_end_matches('/') {
            "/health" => {
                json!({ "status": "ok", "mode": "in-process", "version": env!("CARGO_PKG_VERSION") })
            }
            "/v1/resolve" => to_value(c.resolve(url_of(q)?).await?)?,
            "/v1/track" => to_value(c.track(url_of(q)?).await?)?,
            "/v1/set" => to_value(c.set(url_of(q)?).await?)?,
            "/v1/user" => to_value(c.user(url_of(q)?).await?)?,
            "/v1/likes" => {
                let user_id = match (q.get("id"), q.get("url")) {
                    (Some(id), _) => id
                        .parse::<u64>()
                        .map_err(|_| ApiError::bad_request("`id` harus angka"))?,
                    (None, Some(url)) => c.user(url).await?.id,
                    (None, None) => {
                        return Err(ApiError::bad_request("one of `id` or `url` is required"))
                    }
                };
                // Batas yang sama dengan server: satu klik tidak boleh jadi
                // ratusan permintaan ke SoundCloud.
                let limit = Some(limit_of(q, 500));
                let offset = offset_of(q);
                if flag_of(q, "playlists") {
                    to_value(c.likes_raw(user_id, limit, offset).await?)?
                } else {
                    to_value(c.likes(user_id, limit, offset).await?)?
                }
            }
            "/v1/search" => {
                let text = q.get("q").map(|s| s.trim()).unwrap_or("");
                if text.is_empty() {
                    return Err(ApiError::bad_request("`q` must not be empty"));
                }
                let kind = q.get("kind").map(String::as_str).unwrap_or("tracks");
                const VALID_KINDS: [&str; 5] = ["tracks", "users", "albums", "playlists", "all"];
                if !VALID_KINDS.contains(&kind) {
                    return Err(ApiError::bad_request(format!(
                        "`kind` must be one of {}",
                        VALID_KINDS.join(", ")
                    )));
                }
                let page: PaginatedQuery<Value> =
                    c.search(text, kind, limit_of(q, 200), offset_of(q)).await?;
                to_value(page)?
            }
            "/v1/related" => {
                let id = q
                    .get("id")
                    .and_then(|s| s.parse::<u64>().ok())
                    .ok_or_else(|| ApiError::bad_request("`id` is required"))?;
                to_value(c.related(id, limit_of(q, 200), offset_of(q)).await?)?
            }
            _ => return Err(ApiError::new(404, "no_such_route", "no such route")),
        };
        Ok(value)
    }

    /// `/v1/stream` dan `/v1/download`: audio track utuh. Opsi `format`,
    /// `protocol`, `no_direct` sama dengan server.
    pub async fn audio(&self, q: &Query) -> Result<Audio, ApiError> {
        let url = url_of(q)?;
        let mut opts = DownloadOptions::new().use_download_link(!flag_of(q, "no_direct"));
        if let Some(f) = q.get("format") {
            let format: Format = f.parse().map_err(ApiError::bad_request)?;
            opts = opts.format(format);
        }
        if let Some(p) = q.get("protocol") {
            let protocol: Protocol = p.parse().expect("infallible");
            if let Protocol::Other(other) = &protocol {
                return Err(ApiError::bad_request(format!(
                    "unknown protocol `{other}` (expected `progressive` or `hls`)"
                )));
            }
            opts = opts.protocol(protocol);
        }
        let track = self.client.track(url).await?;
        let stream = self.client.download_track(&track, &opts).await?;
        let mime_type = stream.mime_type.clone();
        let filename = stream.filename.clone();
        let bytes = stream.bytes().await?.to_vec();
        Ok(Audio {
            bytes,
            mime_type,
            filename,
        })
    }
}

fn to_value<T: Serialize>(v: T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError::new(500, "internal", e.to_string()))
}

fn url_of(q: &Query) -> Result<&str, ApiError> {
    q.get("url")
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request("`url` is required"))
}

fn limit_of(q: &Query, max: u32) -> u32 {
    q.get("limit")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(20)
        .clamp(1, max)
}

fn offset_of(q: &Query) -> u32 {
    q.get("offset")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
}

fn flag_of(q: &Query, key: &str) -> bool {
    matches!(
        q.get(key).map(String::as_str),
        Some("true" | "1" | "yes" | "on")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovery() -> Discovery {
        let tmp = tempfile::tempdir().unwrap();
        // Klien dibangun tanpa jaringan; cache-nya di folder sementara.
        Discovery::new(tmp.path()).unwrap()
    }

    fn q(pairs: &[(&str, &str)]) -> Query {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn parse_request_reads_path_and_query_and_ignores_host() {
        let (path, query) =
            parse_request("https://soundcloud.kelasmalam.app/v1/search?q=lo%20fi&limit=5").unwrap();
        assert_eq!(path, "/v1/search");
        assert_eq!(query["q"], "lo fi");
        assert_eq!(query["limit"], "5");
        let (path, query) = parse_request("/health").unwrap();
        assert_eq!((path.as_str(), query.len()), ("/health", 0));
    }

    #[tokio::test]
    async fn health_and_unknown_route_need_no_network() {
        let d = discovery();
        let ok = d.json("/health", &q(&[])).await;
        assert_eq!(ok.status, 200);
        assert_eq!(ok.body["mode"], "in-process");

        let missing = d.json("/v1/tidak-ada", &q(&[])).await;
        assert_eq!(missing.status, 404);
        assert_eq!(missing.body["error"]["kind"], "no_such_route");
    }

    #[tokio::test]
    async fn validation_rejects_before_touching_soundcloud() {
        let d = discovery();
        let cases: &[(&str, Query, &str)] = &[
            ("/v1/search", q(&[("q", "   ")]), "`q` must not be empty"),
            (
                "/v1/search",
                q(&[("q", "x"), ("kind", "video")]),
                "`kind` must be one of",
            ),
            ("/v1/likes", q(&[]), "one of `id` or `url` is required"),
            ("/v1/related", q(&[("limit", "5")]), "`id` is required"),
            ("/v1/track", q(&[]), "`url` is required"),
        ];
        for (path, query, expected) in cases {
            let reply = d.json(path, query).await;
            assert_eq!(reply.status, 400, "{path}");
            assert!(
                reply.body["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(expected),
                "{path}: {}",
                reply.body
            );
        }

        let err = d
            .audio(&q(&[
                ("url", "https://soundcloud.com/a/b"),
                ("format", "flac"),
            ]))
            .await
            .unwrap_err();
        assert_eq!(err.status, 400);
        let err = d
            .audio(&q(&[
                ("url", "https://soundcloud.com/a/b"),
                ("protocol", "dash"),
            ]))
            .await
            .unwrap_err();
        assert!(err.message.contains("unknown protocol"));
    }

    #[test]
    fn library_errors_map_like_the_server() {
        let e: ApiError = ScError::NotSoundcloudUrl("x".into()).into();
        assert_eq!((e.status, e.kind), (400, "invalid_url"));
        let e: ApiError = ScError::NotFound { url: "u".into() }.into();
        assert_eq!((e.status, e.kind), (404, "not_found"));
        let e: ApiError = ScError::ClientIdNotFound.into();
        assert_eq!((e.status, e.kind), (502, "client_id_unavailable"));
        assert_eq!(e.reply().body["error"]["kind"], "client_id_unavailable");
    }

    #[test]
    fn limits_are_clamped_and_flags_parsed() {
        assert_eq!(limit_of(&q(&[("limit", "9999")]), 200), 200);
        assert_eq!(limit_of(&q(&[("limit", "0")]), 200), 1);
        assert_eq!(limit_of(&q(&[]), 200), 20);
        assert_eq!(offset_of(&q(&[("offset", "x")])), 0);
        assert!(flag_of(&q(&[("playlists", "true")]), "playlists"));
        assert!(!flag_of(&q(&[("playlists", "false")]), "playlists"));
    }
}

#[cfg(test)]
mod network_tests {
    //! Menyentuh SoundCloud sungguhan (scrape `client_id` + satu pencarian).
    //! `cargo test -p daw-desktop-host soundcloud::network_tests -- --ignored --nocapture`
    use super::*;

    #[tokio::test]
    #[ignore = "butuh jaringan"]
    async fn real_search_returns_tracks() {
        let tmp = tempfile::tempdir().unwrap();
        let d = Discovery::new(tmp.path()).unwrap();
        let reply = d
            .json(
                "/v1/search",
                &[("q".to_owned(), "lofi".to_owned())].into_iter().collect(),
            )
            .await;
        println!(
            "status={} n={}",
            reply.status,
            reply.body["collection"].as_array().map_or(0, Vec::len)
        );
        assert_eq!(reply.status, 200, "{}", reply.body);
        assert!(!reply.body["collection"].as_array().unwrap().is_empty());
        assert!(
            tmp.path().join(CLIENT_ID_CACHE_FILE).is_file(),
            "client_id di-cache"
        );
    }
}
