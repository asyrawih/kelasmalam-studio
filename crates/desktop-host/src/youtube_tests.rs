//! Tes `youtube.rs` TANPA jaringan, Python, maupun YouTube: yt-dlp-nya skrip
//! shell palsu yang menjawab tiga bentuk pemanggilan (`--version`,
//! `--dump-single-json`, unduh dengan `-o`) dan mencatat argumennya, supaya
//! yang diuji adalah kontrak kita dengan yt-dlp — argumen yang dikirim,
//! baris progres yang dibaca, galat yang diteruskan — bukan yt-dlp sendiri.
//! Unduhan perkakas diarahkan ke server HTTP lokal `tests.rs`.
//!
//! Hanya Unix: skripnya `#!/bin/sh`. Windows tidak menjalankan tes crate
//! ini di CI (job desktop menguji crate Tauri, bukan yang ini).

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::tests::{Reply, Server};
use crate::youtube::{Phase, Sources, Tools};
use crate::HostError;

/// yt-dlp palsu. Menulis semua argumennya ke `<skrip>.args` lalu:
/// `--version` → versi; `--dump-single-json` → JSON satu video; `-o` →
/// menulis berkas sesuai template + baris progres; URL berisi `fail` → galat
/// yt-dlp di stderr, exit 1.
const FAKE_YT_DLP: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "$0.args"
mode=""
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) echo "2026.08.19"; exit 0 ;;
    --dump-single-json) mode=json ;;
    -o) out="$2"; shift ;;
    --) shift; url="$1" ;;
  esac
  shift
done
case "$url" in
  *fail*) echo "WARNING: abaikan" >&2; echo "ERROR: [youtube] zzz: Video unavailable" >&2; exit 1 ;;
esac
if [ "$mode" = json ]; then
  printf '{"id":"abc","title":"Lagu Malam","uploader":"Kanal","duration":191.4,"thumbnail":"https://i/x.jpg","webpage_url":"%s","ext":"m4a","filesize_approx":3000000}\n' "$url"
  exit 0
fi
if [ -n "$out" ]; then
  dest=$(printf '%s' "$out" | sed 's/%(id)s/abc/; s/%(ext)s/m4a/')
  echo "download:abc|0|3000000|NA"
  echo "download:abc|1500000|3000000|NA"
  printf 'AUDIOBYTES' > "$dest"
  echo "download:abc|3000000|3000000|NA"
  exit 0
fi
exit 2
"#;

fn write_exe(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Folder perkakas berisi yt-dlp palsu + qjs kosong (hanya keberadaannya
/// yang diperiksa; yt-dlp palsu tidak pernah menjalankannya).
fn fake_tools() -> (tempfile::TempDir, Tools) {
    let tmp = tempfile::tempdir().unwrap();
    let tools = Tools::new(tmp.path());
    write_exe(&tools.yt_dlp_path(), FAKE_YT_DLP);
    write_exe(&tools.qjs_path(), "#!/bin/sh\nexit 0\n");
    (tmp, tools)
}

fn recorded_args(tools: &Tools) -> Vec<String> {
    let path = format!("{}.args", tools.yt_dlp_path().display());
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Runtime::new().unwrap()
}

fn no_progress() -> impl FnMut(Phase, &str, u64, u64) {
    |_, _, _, _| {}
}

#[test]
fn status_is_not_ready_until_both_tools_exist() {
    let tmp = tempfile::tempdir().unwrap();
    let tools = Tools::new(tmp.path());
    let status = rt().block_on(tools.status());
    assert!(!status.ready);
    assert_eq!(status.yt_dlp_version, None);

    // yt-dlp ada tapi qjs belum: tetap belum siap — yt-dlp akan gagal tanpa
    // runtime JS dengan pesan yang jauh dari sebabnya.
    write_exe(&tools.yt_dlp_path(), FAKE_YT_DLP);
    assert!(!rt().block_on(tools.status()).ready);

    write_exe(&tools.qjs_path(), "#!/bin/sh\nexit 0\n");
    let status = rt().block_on(tools.status());
    assert!(status.ready);
    assert_eq!(status.yt_dlp_version.as_deref(), Some("2026.08.19"));
}

#[test]
fn info_passes_our_runtime_and_reads_the_json() {
    let (_tmp, tools) = fake_tools();
    let info = rt().block_on(tools.info("https://youtu.be/abc")).unwrap();
    assert_eq!(info.id, "abc");
    assert_eq!(info.title, "Lagu Malam");
    assert_eq!(info.uploader, "Kanal");
    assert_eq!(info.duration_sec, 191);
    assert_eq!(info.ext, "m4a");
    assert_eq!(info.bytes, 3_000_000);
    assert_eq!(info.webpage_url, "https://youtu.be/abc");

    let args = recorded_args(&tools);
    // Argumen yang SELALU ada: config user diabaikan, runtime JS = qjs kita
    // (nama berkasnya `qjs` — yt-dlp mengenali runtime dari nama itu).
    assert!(args.contains(&"--no-config".to_owned()), "{args:?}");
    let runtime = format!("quickjs:{}", tools.qjs_path().display());
    let i = args.iter().position(|a| a == "--js-runtimes").unwrap();
    assert_eq!(args[i + 1], runtime);
    // Hanya audio, tanpa playlist, dan URL sesudah `--`.
    assert!(args.contains(&"bestaudio[ext=m4a]/bestaudio".to_owned()));
    assert!(args.contains(&"--no-playlist".to_owned()));
    let dd = args.iter().position(|a| a == "--").unwrap();
    assert_eq!(args[dd + 1], "https://youtu.be/abc");
}

#[test]
fn download_reports_progress_and_returns_the_file_bytes() {
    let (_tmp, tools) = fake_tools();
    let mut seen = Vec::new();
    let audio = rt()
        .block_on(
            tools.download("https://youtu.be/abc", &mut |phase, id, done, total| {
                seen.push((phase, id.to_owned(), done, total));
            }),
        )
        .unwrap();
    assert_eq!(audio.bytes, b"AUDIOBYTES");
    assert_eq!(audio.file_name, "abc.m4a");
    assert_eq!(
        seen,
        vec![
            (Phase::Audio, "abc".to_owned(), 0, 3_000_000),
            (Phase::Audio, "abc".to_owned(), 1_500_000, 3_000_000),
            (Phase::Audio, "abc".to_owned(), 3_000_000, 3_000_000),
        ]
    );
    // Folder kerja sementara dibersihkan: tidak ada `kelasmalam-yt-*` tersisa.
    let leftovers: Vec<_> = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("kelasmalam-yt-")
        })
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn yt_dlp_errors_reach_the_caller_as_their_own_sentence() {
    let (_tmp, tools) = fake_tools();
    match rt().block_on(tools.info("https://youtu.be/fail")) {
        Err(e @ HostError::Youtube(_)) => {
            assert_eq!(e.code(), "YOUTUBE");
            assert_eq!(e.to_string(), "YouTube: Video unavailable");
        }
        other => panic!("harus Youtube, dapat {other:?}"),
    }
    match rt().block_on(tools.download("https://youtu.be/fail", &mut no_progress())) {
        Err(HostError::Youtube(msg)) => assert_eq!(msg, "Video unavailable"),
        other => panic!("harus Youtube, dapat {other:?}"),
    }
}

#[test]
fn non_http_input_never_reaches_yt_dlp() {
    let (_tmp, tools) = fake_tools();
    assert!(matches!(
        rt().block_on(tools.info("abc")),
        Err(HostError::Invalid(_))
    ));
    assert!(
        !Path::new(&format!("{}.args", tools.yt_dlp_path().display())).exists(),
        "yt-dlp tidak dijalankan"
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Tiga server lokal: qjs, yt-dlp (skrip palsu supaya `status()` sesudahnya
/// bisa menjalankannya), dan SHA2-256SUMS yang menyebut asetnya.
fn sources(yt_dlp_body: &[u8], sums: &str) -> Sources {
    let qjs = Server::spawn(Reply::Full(b"#!/bin/sh\nexit 0\n".to_vec()));
    let yt = Server::spawn(Reply::Full(yt_dlp_body.to_vec()));
    let sums = Server::spawn(Reply::Full(sums.as_bytes().to_vec()));
    Sources {
        yt_dlp_url: yt.url("/yt-dlp_macos"),
        yt_dlp_sums_url: sums.url("/SHA2-256SUMS"),
        qjs_url: qjs.url("/qjs-darwin-arm64"),
    }
}

#[test]
fn ensure_downloads_both_tools_verified_and_executable() {
    let tmp = tempfile::tempdir().unwrap();
    let digest = hex(&Sha256::digest(FAKE_YT_DLP.as_bytes()));
    let sums = format!("{}  yt-dlp\n{digest}  yt-dlp_macos\n", "0".repeat(64));
    // Folder `tools/` belum ada — `ensure` yang membuatnya.
    let tools = Tools::with_sources(
        tmp.path().join("tools"),
        sources(FAKE_YT_DLP.as_bytes(), &sums),
    );

    let mut seen = Vec::new();
    let status = rt()
        .block_on(tools.ensure(&mut |phase, name, done, total| {
            seen.push((phase, name.to_owned(), done, total));
        }))
        .unwrap();
    assert!(status.ready, "{status:?}");
    assert_eq!(status.yt_dlp_version.as_deref(), Some("2026.08.19"));

    for path in [tools.yt_dlp_path(), tools.qjs_path()] {
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "{}: mode {mode:o}", path.display());
        assert!(!path.with_extension("part").exists());
    }
    assert!(seen
        .iter()
        .any(|(p, n, ..)| *p == Phase::Tools && n == "qjs"));
    assert!(seen
        .iter()
        .any(|(p, n, d, t)| *p == Phase::Tools && n == "yt-dlp" && d == t && *t > 0));

    // Kedua kalinya: tidak ada yang diunduh lagi.
    seen.clear();
    rt().block_on(tools.ensure(&mut |p, n, d, t| seen.push((p, n.to_owned(), d, t))))
        .unwrap();
    assert!(seen.is_empty(), "{seen:?}");
}

#[test]
fn ensure_rejects_a_yt_dlp_whose_hash_disagrees_with_the_release() {
    let tmp = tempfile::tempdir().unwrap();
    let sums = format!("{}  yt-dlp_macos\n", "f".repeat(64));
    let tools = Tools::with_sources(tmp.path(), sources(FAKE_YT_DLP.as_bytes(), &sums));
    match rt().block_on(tools.ensure(&mut no_progress())) {
        Err(HostError::HashMismatch) => {}
        other => panic!("harus HashMismatch, dapat {other:?}"),
    }
    assert!(
        !tools.yt_dlp_path().exists(),
        "binari yang salah tidak dipasang"
    );
    assert!(!tools.yt_dlp_path().with_extension("part").exists());
    // qjs sudah terunduh sebelum yt-dlp — itu tidak apa-apa, dan tidak diulang.
    assert!(tools.qjs_path().is_file());
}

#[test]
fn update_replaces_yt_dlp_only_when_the_release_hash_differs() {
    let tmp = tempfile::tempdir().unwrap();
    let digest = hex(&Sha256::digest(FAKE_YT_DLP.as_bytes()));
    let sums = format!("{digest}  yt-dlp_macos\n");
    let tools = Tools::with_sources(tmp.path(), sources(FAKE_YT_DLP.as_bytes(), &sums));

    // Belum ada apa-apa: update memasang.
    assert!(rt().block_on(tools.update(&mut no_progress())).unwrap());
    assert!(tools.yt_dlp_path().is_file());
    // Sudah sama dengan rilis: tidak ada yang diganti.
    assert!(!rt().block_on(tools.update(&mut no_progress())).unwrap());

    // Terpasang versi lama (hash berbeda): diganti dengan yang di rilis.
    write_exe(&tools.yt_dlp_path(), "#!/bin/sh\necho 2024.01.01\n");
    assert!(rt().block_on(tools.update(&mut no_progress())).unwrap());
    assert_eq!(
        std::fs::read(tools.yt_dlp_path()).unwrap(),
        FAKE_YT_DLP.as_bytes()
    );
}

/// Jaringan SUNGGUHAN: unduh rilis yt-dlp + qjs asli, baca info dan unduh
/// audio video pendek. Membuktikan nama aset rilis, `SHA2-256SUMS`, dan
/// `--js-runtimes quickjs:` benar di dunia nyata — hal yang skrip palsu di
/// atas tidak bisa buktikan. Manual:
/// `cargo test -p daw-desktop-host real_ -- --ignored --nocapture`.
#[test]
#[ignore = "butuh jaringan; mengunduh ± 40 MB dan menghubungi YouTube"]
fn real_tools_download_then_info_and_audio() {
    let tmp = tempfile::tempdir().unwrap();
    let tools = Tools::new(tmp.path().join("tools"));
    let status = rt()
        .block_on(tools.ensure(&mut |phase, name, done, total| {
            if done == total || done == 0 {
                eprintln!("{phase:?} {name}: {done}/{total}");
            }
        }))
        .unwrap();
    eprintln!("status: {status:?}");
    assert!(status.ready, "{status:?}");

    // "Me at the zoo" — video pertama YouTube, 19 detik.
    let url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    let info = rt().block_on(tools.info(url)).unwrap();
    eprintln!("info: {info:?}");
    assert_eq!(info.id, "jNQXAC9IVRw");
    assert!(info.duration_sec > 10 && info.duration_sec < 60);

    let audio = rt()
        .block_on(tools.download(url, &mut |_, id, done, total| {
            if done == total {
                eprintln!("audio {id}: {done}/{total}");
            }
        }))
        .unwrap();
    eprintln!("audio: {} byte, {}", audio.bytes.len(), audio.file_name);
    assert!(audio.bytes.len() > 50_000, "{} byte", audio.bytes.len());
}
