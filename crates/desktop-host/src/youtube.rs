//! Impor audio dari YouTube — HANYA desktop (docs/23).
//!
//! ## Bentuknya: dua binari yang diunduh sekali, dipanggil sebagai subprocess
//!
//! Tidak ada pustaka Rust yang mengekstrak YouTube dengan andal: yang ada
//! adalah pembungkus di sekitar program Python `yt-dlp` (dan crate-nya GPL,
//! sedangkan proyek ini MIT/Apache). Maka yang dipakai adalah binari
//! `yt-dlp` resmi (Unlicense) apa adanya, ditambah `qjs` (QuickJS-NG, MIT)
//! sebagai runtime JavaScript yang diwajibkan yt-dlp untuk tantangan JS
//! YouTube — Deno yang disarankan dokumennya 100 MB, QuickJS-NG 1–2 MB dan
//! sejak 0.12.0 sudah cukup cepat.
//!
//! Keduanya TIDAK dibundel sebagai sidecar Tauri: tauri-build menolak build
//! kalau berkasnya tidak ada di mesin yang mem-build, bundle bertambah
//! 40 MB, dan setiap pembaruan yt-dlp (YouTube sering berubah) berarti rilis
//! aplikasi baru. Mereka diunduh SEKALI ke `<app_data_dir>/tools/` saat
//! pertama dipakai — pola yang sama dengan model ONNX (`model.rs`) — dan
//! `update` mengunduh ulang yt-dlp kalau rilis terbarunya berbeda hash.
//! Berkas yang diunduh proses sendiri tidak membawa atribut karantina
//! Gatekeeper, jadi bisa dijalankan tanpa dialog.
//!
//! ## Yang dijaga
//!
//! - yt-dlp diverifikasi terhadap `SHA2-256SUMS` rilisnya; qjs dipin ke satu
//!   versi lewat URL (rilisnya tidak menerbitkan checksum).
//! - Unduhan ke `.part` lalu rename — tidak ada binari setengah jadi yang
//!   bisa dieksekusi.
//! - `--no-config`: konfigurasi yt-dlp milik user di mesin itu tidak ikut
//!   campur; perilaku impor sama di semua mesin.
//! - Hanya audio: `bestaudio[ext=m4a]/bestaudio`. m4a (AAC) bisa di-decode
//!   `decodeAudioData` WebKit, jadi ffmpeg tidak diperlukan.
//! - Galat yt-dlp sampai ke user sebagai kalimatnya sendiri (`ERROR: …`
//!   terakhir di stderr), bukan "exit code 1".

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::HostError;

/// Subfolder `app_data_dir()` tempat kedua binari tinggal.
pub const TOOLS_SUBDIR: &str = "tools";

/// Rilis QuickJS-NG yang dipakai — dipin, bukan `latest`: tidak ada checksum
/// yang bisa diverifikasi, jadi yang dijamin adalah "versi yang sudah dicoba".
pub const QJS_RELEASE: &str = "v0.16.2";

const YT_DLP_LATEST: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const QJS_RELEASES: &str = "https://github.com/quickjs-ng/quickjs/releases/download";

/// Format audio yang diminta. Lihat kepala berkas soal kenapa m4a.
const AUDIO_FORMAT: &str = "bestaudio[ext=m4a]/bestaudio";

/// `YoutubeStatus` (kontrak `local-commands.ts`): apakah perkakasnya ada.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeStatus {
    /// Kedua binari ada dan yt-dlp menjawab `--version`.
    pub ready: bool,
    /// Versi yt-dlp (`2026.08.19`), `None` kalau belum ada / tidak menjawab.
    pub yt_dlp_version: Option<String>,
}

/// `YoutubeInfo`: metadata satu video sebelum diunduh.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeInfo {
    pub id: String,
    pub title: String,
    pub uploader: String,
    /// Detik; 0 kalau tidak diketahui (siaran langsung).
    pub duration_sec: u64,
    pub thumbnail: Option<String>,
    pub webpage_url: String,
    /// Ekstensi format audio yang akan diunduh (`m4a`, `webm`, …).
    pub ext: String,
    /// Perkiraan ukuran unduhan dalam byte; 0 kalau tidak diketahui.
    pub bytes: u64,
}

/// Hasil unduhan: byte audio + nama berkas yang dipilih yt-dlp (`<id>.<ext>`).
#[derive(Debug)]
pub struct YoutubeAudio {
    pub bytes: Vec<u8>,
    pub file_name: String,
}

/// Fase progres: mengunduh perkakas atau mengunduh audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Tools,
    Audio,
}

/// `progress(phase, nama, done, total)`; `total` 0 = tidak diketahui.
pub type Progress<'a> = &'a mut (dyn FnMut(Phase, &str, u64, u64) + Send);

/// Dari mana binari diunduh. Dipisah supaya tes mengarahkannya ke server lokal.
#[derive(Clone, Debug)]
pub struct Sources {
    pub yt_dlp_url: String,
    pub yt_dlp_sums_url: String,
    pub qjs_url: String,
}

impl Sources {
    /// Rilis resmi untuk OS + arsitektur binari INI.
    pub fn official() -> Self {
        let yt_dlp_asset = if cfg!(target_os = "windows") {
            "yt-dlp.exe"
        } else if cfg!(target_os = "macos") {
            // Universal2 — satu berkas untuk arm64 dan x86_64.
            "yt-dlp_macos"
        } else {
            "yt-dlp_linux"
        };
        let qjs_asset = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", _) => "qjs-windows-x86_64.exe",
            ("macos", "aarch64") => "qjs-darwin-arm64",
            ("macos", _) => "qjs-darwin-x86_64",
            (_, "aarch64") => "qjs-linux-aarch64",
            _ => "qjs-linux-x86_64",
        };
        Self {
            yt_dlp_url: format!("{YT_DLP_LATEST}/{yt_dlp_asset}"),
            yt_dlp_sums_url: format!("{YT_DLP_LATEST}/SHA2-256SUMS"),
            qjs_url: format!("{QJS_RELEASES}/{QJS_RELEASE}/{qjs_asset}"),
        }
    }
}

/// Perkakas YouTube di satu folder.
#[derive(Clone, Debug)]
pub struct Tools {
    dir: PathBuf,
    sources: Sources,
}

fn exe(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

impl Tools {
    /// `dir` = `<app_data_dir>/tools`; sumber unduhan resmi.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self::with_sources(dir, Sources::official())
    }

    pub fn with_sources(dir: impl Into<PathBuf>, sources: Sources) -> Self {
        Self {
            dir: dir.into(),
            sources,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn yt_dlp_path(&self) -> PathBuf {
        self.dir.join(exe("yt-dlp"))
    }

    /// Namanya HARUS `qjs`: yt-dlp mengenali runtime dari nama berkasnya.
    pub fn qjs_path(&self) -> PathBuf {
        self.dir.join(exe("qjs"))
    }

    /// Keadaan sekarang. Menjalankan `yt-dlp --version` kalau berkasnya ada
    /// — satu-satunya bukti binari itu utuh dan bisa dieksekusi di mesin ini.
    pub async fn status(&self) -> YoutubeStatus {
        if !self.yt_dlp_path().is_file() || !self.qjs_path().is_file() {
            return YoutubeStatus {
                ready: false,
                yt_dlp_version: None,
            };
        }
        let version = self.yt_dlp_version().await.ok();
        YoutubeStatus {
            ready: version.is_some(),
            yt_dlp_version: version,
        }
    }

    async fn yt_dlp_version(&self) -> Result<String, HostError> {
        let out = self.command().arg("--version").output().await?;
        if !out.status.success() {
            return Err(HostError::Youtube(last_error_line(&out.stderr)));
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if text.is_empty() {
            return Err(HostError::Youtube("yt-dlp tidak melaporkan versi".into()));
        }
        Ok(text)
    }

    /// Unduh yang belum ada. Idempoten: yang sudah ada tidak disentuh.
    pub async fn ensure(&self, progress: Progress<'_>) -> Result<YoutubeStatus, HostError> {
        tokio::fs::create_dir_all(&self.dir).await?;
        if !self.qjs_path().is_file() {
            download_to(
                &self.sources.qjs_url,
                &self.qjs_path(),
                None,
                "qjs",
                progress,
            )
            .await?;
        }
        if !self.yt_dlp_path().is_file() {
            let expected = self.expected_yt_dlp_hash().await?;
            download_to(
                &self.sources.yt_dlp_url,
                &self.yt_dlp_path(),
                expected,
                "yt-dlp",
                progress,
            )
            .await?;
        }
        Ok(self.status().await)
    }

    /// Unduh ulang yt-dlp kalau rilis terbarunya berbeda dari yang terpasang.
    /// qjs dipin (lihat `QJS_RELEASE`), jadi tidak ikut. Mengembalikan `true`
    /// kalau ada yang diganti.
    pub async fn update(&self, progress: Progress<'_>) -> Result<bool, HostError> {
        tokio::fs::create_dir_all(&self.dir).await?;
        let path = self.yt_dlp_path();
        let expected = self.expected_yt_dlp_hash().await?;
        let current = match tokio::fs::read(&path).await {
            Ok(bytes) => Some(<[u8; 32]>::from(Sha256::digest(&bytes))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if expected.is_some() && current == expected {
            return Ok(false);
        }
        download_to(
            &self.sources.yt_dlp_url,
            &path,
            expected,
            "yt-dlp",
            progress,
        )
        .await?;
        Ok(true)
    }

    /// Hash yt-dlp menurut `SHA2-256SUMS` rilis terbaru; `None` kalau nama
    /// asetnya tidak ada di daftar (aset baru yang belum dicatat — unduhan
    /// tetap jalan, hanya tidak diverifikasi).
    async fn expected_yt_dlp_hash(&self) -> Result<Option<[u8; 32]>, HostError> {
        let asset = self
            .sources
            .yt_dlp_url
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_owned();
        let text = fetch_text(&self.sources.yt_dlp_sums_url).await?;
        Ok(parse_sums(&text, &asset))
    }

    /// Metadata satu video — `yt-dlp -J`, tanpa mengunduh.
    pub async fn info(&self, url: &str) -> Result<YoutubeInfo, HostError> {
        let url = checked_url(url)?;
        let out = self
            .command()
            .args([
                "--dump-single-json",
                "--no-playlist",
                "-f",
                AUDIO_FORMAT,
                "--",
            ])
            .arg(&url)
            .output()
            .await?;
        if !out.status.success() {
            return Err(HostError::Youtube(last_error_line(&out.stderr)));
        }
        let json: serde_json::Value = serde_json::from_slice(&out.stdout)
            .map_err(|e| HostError::Youtube(format!("jawaban yt-dlp bukan JSON: {e}")))?;
        Ok(info_from_json(&json))
    }

    /// Unduh audionya. `progress(Audio, id, done, total)` dari baris progres
    /// yt-dlp; byte dibaca dari berkas sementara yang dihapus sesudahnya.
    pub async fn download(
        &self,
        url: &str,
        progress: Progress<'_>,
    ) -> Result<YoutubeAudio, HostError> {
        let url = checked_url(url)?;
        let work = std::env::temp_dir().join(format!("kelasmalam-yt-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&work).await?;
        let result = self.download_into(&url, &work, progress).await;
        let _ = tokio::fs::remove_dir_all(&work).await;
        result
    }

    async fn download_into(
        &self,
        url: &str,
        work: &Path,
        progress: Progress<'_>,
    ) -> Result<YoutubeAudio, HostError> {
        let template = work.join("%(id)s.%(ext)s");
        let mut child = self
            .command()
            .args([
                "--no-playlist",
                "-f",
                AUDIO_FORMAT,
                "--newline",
                "--progress",
                "--progress-template",
                "download:%(info.id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s",
                "-o",
            ])
            .arg(&template)
            .arg("--")
            .arg(url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdout = child.stdout.take().expect("stdout piped");
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            if let Some((id, done, total)) = parse_progress(&line) {
                progress(Phase::Audio, id, done, total);
            }
        }
        let out = child.wait_with_output().await?;
        if !out.status.success() {
            return Err(HostError::Youtube(last_error_line(&out.stderr)));
        }

        // Satu video → satu berkas di folder kerja; namanya `<id>.<ext>`.
        let mut entries = tokio::fs::read_dir(work).await?;
        let mut found: Option<PathBuf> = None;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            if path.is_file() && !name.as_deref().unwrap_or("").ends_with(".part") {
                found = Some(path);
            }
        }
        let path = found.ok_or_else(|| {
            HostError::Youtube("yt-dlp selesai tanpa menghasilkan berkas audio".into())
        })?;
        let bytes = tokio::fs::read(&path).await?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "audio.m4a".into());
        Ok(YoutubeAudio { bytes, file_name })
    }

    /// `yt-dlp` dengan argumen yang SELALU ada: tanpa config user, tanpa
    /// peringatan di stdout, runtime JS = qjs kita. Windows: tanpa jendela
    /// konsol yang berkedip.
    fn command(&self) -> Command {
        let mut cmd = Command::new(self.yt_dlp_path());
        cmd.arg("--no-config")
            .arg("--no-warnings")
            .arg("--js-runtimes")
            .arg(format!("quickjs:{}", self.qjs_path().display()))
            .stdin(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }
}

/// Hanya URL http(s); `--` sudah mencegah URL dibaca sebagai opsi, ini
/// mencegah skema lain yang tidak ada urusannya di sini.
fn checked_url(url: &str) -> Result<String, HostError> {
    let url = url.trim();
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(url.to_owned())
    } else {
        Err(HostError::Invalid(format!("bukan URL http(s): {url:?}")))
    }
}

/// `download:<id>|<done>|<total>|<estimate>` → `(id, done, total)`. Nilai
/// yang tidak diketahui ditulis yt-dlp sebagai `NA`; `total` jatuh ke
/// estimasi, lalu ke 0.
fn parse_progress(line: &str) -> Option<(&str, u64, u64)> {
    let rest = line.trim().strip_prefix("download:")?;
    let mut parts = rest.split('|');
    let id = parts.next()?;
    let done = parts.next().and_then(num)?;
    let total = parts.next().and_then(num).unwrap_or(0);
    let estimate = parts.next().and_then(num).unwrap_or(0);
    Some((id, done, if total > 0 { total } else { estimate }))
}

fn num(s: &str) -> Option<u64> {
    s.trim().parse::<f64>().ok().map(|f| f.max(0.0) as u64)
}

/// Baris `ERROR:` terakhir di stderr, tanpa awalannya; kalau tidak ada,
/// baris terakhir yang tidak kosong; kalau stderr kosong, kalimat umum.
fn last_error_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let picked = lines
        .iter()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .or_else(|| lines.last())
        .map(|l| l.trim_start_matches("ERROR:").trim())
        .unwrap_or("yt-dlp gagal tanpa pesan");
    // `[youtube] abc123: Video unavailable` → buang label extractor + id.
    let picked = picked
        .strip_prefix('[')
        .and_then(|rest| rest.split_once("] "))
        .map(|(_, msg)| msg)
        .unwrap_or(picked);
    let picked = picked
        .split_once(": ")
        .filter(|(head, _)| !head.contains(' '))
        .map(|(_, msg)| msg)
        .unwrap_or(picked);
    picked.to_owned()
}

fn info_from_json(json: &serde_json::Value) -> YoutubeInfo {
    let text = |k: &str| {
        json.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned()
    };
    let uploader = ["uploader", "channel", "creator"]
        .iter()
        .map(|k| text(k))
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let bytes = ["filesize", "filesize_approx"]
        .iter()
        .filter_map(|k| json.get(k).and_then(|v| v.as_f64()))
        .find(|b| *b > 0.0)
        .unwrap_or(0.0) as u64;
    YoutubeInfo {
        id: text("id"),
        title: text("title"),
        uploader,
        duration_sec: json
            .get("duration")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .max(0.0) as u64,
        thumbnail: json
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        webpage_url: text("webpage_url"),
        ext: text("ext"),
        bytes,
    }
}

/// Format `SHA2-256SUMS`: `<hex>  <nama>` per baris.
fn parse_sums(text: &str, asset: &str) -> Option<[u8; 32]> {
    text.lines().find_map(|line| {
        let mut it = line.split_whitespace();
        let hex = it.next()?;
        let name = it.next()?;
        if name != asset || hex.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(out)
    })
}

async fn fetch_text(url: &str) -> Result<String, HostError> {
    let response = reqwest::Client::new().get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(HostError::HttpStatus {
            status: status.as_u16(),
            url: url.to_owned(),
        });
    }
    Ok(response.text().await?)
}

/// Unduh `url` ke `dest` lewat `.part`, verifikasi hash kalau ada, lalu
/// jadikan executable. Gagal di mana pun: `.part` dihapus, `dest` tidak
/// disentuh.
async fn download_to(
    url: &str,
    dest: &Path,
    expected: Option<[u8; 32]>,
    name: &str,
    progress: Progress<'_>,
) -> Result<(), HostError> {
    let part = dest.with_extension("part");
    let result = download_part(url, &part, expected, name, progress).await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).await?;
    }
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

async fn download_part(
    url: &str,
    part: &Path,
    expected: Option<[u8; 32]>,
    name: &str,
    progress: Progress<'_>,
) -> Result<(), HostError> {
    let mut response = reqwest::Client::new().get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(HostError::HttpStatus {
            status: status.as_u16(),
            url: url.to_owned(),
        });
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(part).await?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    progress(Phase::Tools, name, 0, total);
    while let Some(chunk) = response.chunk().await? {
        received += chunk.len() as u64;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        progress(Phase::Tools, name, received, total);
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    if received == 0 {
        return Err(HostError::Youtube(format!(
            "{name}: unduhan kosong dari {url}"
        )));
    }
    if let Some(expected) = expected {
        let actual: [u8; 32] = hasher.finalize().into();
        if actual != expected {
            return Err(HostError::HashMismatch);
        }
    }
    Ok(())
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn progress_line_parses_and_falls_back_to_estimate() {
        assert_eq!(
            parse_progress("download:abc|1024|4096|NA"),
            Some(("abc", 1024, 4096))
        );
        assert_eq!(
            parse_progress("download:abc|1024.0|NA|8000.5"),
            Some(("abc", 1024, 8000))
        );
        assert_eq!(parse_progress("download:abc|NA|NA|NA"), None);
        assert_eq!(parse_progress("[download] 12%"), None);
    }

    #[test]
    fn error_line_is_the_last_error_without_extractor_noise() {
        assert_eq!(
            last_error_line(b"WARNING: x\nERROR: [youtube] abc: Video unavailable\n"),
            "Video unavailable"
        );
        assert_eq!(
            last_error_line(b"ERROR: Unsupported URL: https://x\n"),
            "Unsupported URL: https://x"
        );
        assert_eq!(last_error_line(b"sesuatu\n"), "sesuatu");
        assert_eq!(last_error_line(b""), "yt-dlp gagal tanpa pesan");
    }

    #[test]
    fn sums_file_yields_the_named_asset_only() {
        let text = format!(
            "{}  yt-dlp\n{}  yt-dlp_macos\n",
            "a".repeat(64),
            "b".repeat(64)
        );
        assert_eq!(parse_sums(&text, "yt-dlp_macos"), Some([0xbb; 32]));
        assert_eq!(parse_sums(&text, "yt-dlp"), Some([0xaa; 32]));
        assert_eq!(parse_sums(&text, "yt-dlp.exe"), None);
    }

    #[test]
    fn info_reads_the_fields_the_dialog_shows() {
        let json = serde_json::json!({
            "id": "abc", "title": "Lagu", "channel": "Kanal", "duration": 191.4,
            "thumbnail": "https://i/x.jpg", "webpage_url": "https://youtu.be/abc",
            "ext": "m4a", "filesize_approx": 3_000_000.0
        });
        let info = info_from_json(&json);
        assert_eq!(info.uploader, "Kanal");
        assert_eq!(info.duration_sec, 191);
        assert_eq!(info.bytes, 3_000_000);
        assert_eq!(info.ext, "m4a");
    }

    #[test]
    fn only_http_urls_reach_yt_dlp() {
        assert!(checked_url("  https://youtu.be/x ").is_ok());
        assert!(matches!(
            checked_url("ftp://example.invalid/x"),
            Err(HostError::Invalid(_))
        ));
        assert!(matches!(
            checked_url("-o /tmp/x"),
            Err(HostError::Invalid(_))
        ));
    }
}
