//! Server HTTP loopback yang menyajikan frontend di build produksi.
//!
//! ## Kenapa bukan `tauri://localhost`
//!
//! Engine audio bergantung pada `SharedArrayBuffer` (docs/01), dan itu
//! menuntut `crossOriginIsolated === true`, yang datang dari header
//! COOP/COEP. Tauri bisa menyisipkan header itu ke protokol `tauri://`
//! (`app.security.headers`), dan headernya memang sampai — tetapi WKWebView
//! di macOS **tidak menerapkan** COOP/COEP pada skema custom. Hasil spike D0
//! (docs/20): di `tauri://localhost` isolasi selalu `false` dan engine jatuh
//! ke varian `st` (single-thread); di `http://localhost` dengan header yang
//! sama isolasi `true` dan engine `mt` hidup. Maka build produksi menyajikan
//! bundelnya sendiri lewat HTTP di loopback, dan jendela utama dibuka ke sana.
//!
//! ## Kenapa ditulis sendiri, bukan `tauri-plugin-localhost`
//!
//! Plugin itu (2.3.x) melakukan hal yang hampir sama di atas `tiny_http`,
//! dengan dua hal yang tidak ingin diwarisi: ia bind ke nama `localhost`
//! (bisa terurai ke `::1` atau `127.0.0.1`, tergantung resolver), dan
//! permintaan yang tidak menemukan asset **tidak pernah dijawab** — koneksi
//! menggantung alih-alih 404. Empat puluh baris di sini bind ke `127.0.0.1`
//! literal dan selalu menjawab; sisanya sama.
//!
//! ## Batas keamanannya, dinyatakan terang
//!
//! Server ini mendengarkan HANYA di `127.0.0.1`, pada port acak dari OS, dan
//! hanya menyajikan berkas statis dari bundel — berkas yang sama dengan yang
//! dilayani `studio.kelasmalam.app` ke siapa pun. Tidak ada IPC di sini:
//! `invoke` berjalan lewat jembatan `__TAURI_INTERNALS__` yang hanya disuntik
//! ke WebView aplikasi, jadi proses lain yang membuka port ini mendapat HTML,
//! bukan akses ke rahasia Roblox atau kepustakaan. Yang diserahkan: proses lokal
//! lain bisa tahu aplikasi ini sedang berjalan dan di port berapa.

use std::io;
use std::net::TcpListener;

use tauri::{AppHandle, Asset, Runtime};
use tiny_http::{Header, Response, Server};

/// Header yang membuat `crossOriginIsolated` true — sama persis dengan
/// `web/vite.config.ts` dan `web/public/_headers`, sengaja tidak dibagi
/// lewat konstanta lintas bahasa: kalau salah satu berubah, yang lain harus
/// ikut berubah SADAR, bukan diam-diam.
const ISOLATION_HEADERS: &[(&str, &str)] = &[
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Embedder-Policy", "require-corp"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("X-Content-Type-Options", "nosniff"),
];

/// Server yang sedang berjalan. Disimpan di `tauri::State` supaya port-nya
/// bisa dibaca (dan thread-nya hidup selama aplikasi hidup).
pub struct LocalServer {
    port: u16,
}

impl LocalServer {
    /// `http://127.0.0.1:<port><path>`. `127.0.0.1` literal, bukan
    /// `localhost`: nama itu bisa terurai ke `::1` di satu resolver dan
    /// `127.0.0.1` di resolver lain, dan server ini hanya ada di yang kedua.
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }
}

/// Mulai server di port acak loopback dan sajikan asset bundel di thread
/// sendiri. Gagal bind = galat, bukan panic: aplikasi memutuskan sendiri
/// (dan hari ini keputusannya: berhenti, karena tanpa ini tidak ada frontend).
pub fn start<R: Runtime>(app: &AppHandle<R>) -> io::Result<LocalServer> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let server = Server::from_listener(listener, None).map_err(io::Error::other)?;
    let resolver = app.asset_resolver();

    std::thread::Builder::new()
        .name("kms-local-server".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                let path = path_of(request.url());
                let response = match resolve(|p| resolver.get(p), &path) {
                    Some(asset) => asset_response(asset),
                    None => Response::from_string("tidak ada").with_status_code(404),
                };
                // Klien yang menutup koneksi di tengah bukan urusan server ini.
                let _ = request.respond(response);
            }
        })?;

    Ok(LocalServer { port })
}

/// Path tanpa query dan fragment: `/assets/x.js?v=1#a` → `/assets/x.js`.
fn path_of(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("/");
    if path.is_empty() {
        "/".to_owned()
    } else {
        path.to_owned()
    }
}

/// Navigasi (path tanpa ekstensi: `/`, `/studio`, `/dj/`) jatuh ke
/// `index.html` — app-shell yang memilih halamannya (docs/15).
///
/// Catatan jujur: resolver asset Tauri SENDIRI sudah jatuh ke `index.html`
/// untuk path apa pun yang tidak ada (perilaku yang sama dengan protokol
/// `tauri://`), jadi cabang fallback di sini praktis hanya terpakai kalau
/// bundelnya tidak punya `index.html` — dan 404 di bawah untuk keadaan itu.
/// Ia dipertahankan supaya perilaku server ini tidak bergantung pada detail
/// resolver yang tidak dijanjikan.
fn resolve<T>(get: impl Fn(String) -> Option<T>, path: &str) -> Option<T> {
    get(path.to_owned()).or_else(|| {
        if is_navigation(path) {
            get("/index.html".to_owned())
        } else {
            None
        }
    })
}

fn is_navigation(path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or("");
    !last.contains('.')
}

fn asset_response(asset: Asset) -> Response<io::Cursor<Vec<u8>>> {
    let mut response = Response::from_data(asset.bytes)
        .with_header(header("Content-Type", &asset.mime_type))
        .with_header(header("Cache-Control", "no-cache"));
    // CSP dari `app.security.csp`, disisipkan Tauri saat embed — sama dengan
    // yang protokol `tauri://` kirimkan.
    if let Some(csp) = asset.csp_header {
        response = response.with_header(header("Content-Security-Policy", &csp));
    }
    for (name, value) in ISOLATION_HEADERS {
        response = response.with_header(header(name, value));
    }
    response
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .unwrap_or_else(|()| panic!("header konstan tidak sah: {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_strips_query_and_fragment() {
        assert_eq!(path_of("/assets/x.js?v=1#a"), "/assets/x.js");
        assert_eq!(path_of("/studio"), "/studio");
        assert_eq!(path_of("?x=1"), "/");
        assert_eq!(path_of(""), "/");
    }

    #[test]
    fn navigation_falls_back_to_index_but_missing_files_do_not() {
        let assets = |p: String| (p == "/index.html" || p == "/assets/a.js").then_some(p);
        assert_eq!(
            resolve(assets, "/assets/a.js").as_deref(),
            Some("/assets/a.js")
        );
        assert_eq!(resolve(assets, "/studio").as_deref(), Some("/index.html"));
        assert_eq!(resolve(assets, "/dj/").as_deref(), Some("/index.html"));
        assert_eq!(resolve(assets, "/").as_deref(), Some("/index.html"));
        assert_eq!(resolve(assets, "/assets/hilang.js"), None);
        assert_eq!(resolve(assets, "/favicon.png"), None);
    }

    #[test]
    fn isolation_headers_match_the_web_deploy() {
        // Cermin web/public/_headers: kalau salah satu berubah, tes ini yang
        // meminta yang lain ikut.
        let headers = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/public/_headers"),
        )
        .expect("web/public/_headers ada");
        for (name, value) in ISOLATION_HEADERS {
            assert!(
                headers.contains(&format!("{name}: {value}")),
                "{name}: {value} harus ada di web/public/_headers"
            );
        }
    }

    #[test]
    fn url_uses_loopback_literal() {
        let s = LocalServer { port: 4321 };
        assert_eq!(s.url("/studio"), "http://127.0.0.1:4321/studio");
    }
}
