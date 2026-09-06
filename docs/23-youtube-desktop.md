# 23 — Impor YouTube di desktop

Menempel URL YouTube dan mendapatkan audionya sebagai clip di lane. **Hanya
aplikasi desktop.** Versi web tidak berubah: link YouTube tetap ditolak dengan
kalimat "unduh dulu, lalu drag berkasnya" (`url-import.ts`), dan tombol
YOUTUBE di header tidak dirender di sana.

| Bagian | Yang berubah |
|---|---|
| `crates/desktop-host/src/youtube.rs` | perkakas (yt-dlp + qjs): unduh, verifikasi, status, `info`, `download` |
| `desktop/src-tauri/src/commands/youtube.rs` | `youtube_status/setup/update/info/bytes` + event `daw://youtube-progress` |
| `web/src/youtube/` | `api.ts` (pembungkus + pengenal URL), `import.ts` (link di-drop/paste → lane), `YouTubeDialog.tsx` |
| `web/src/studio/timeline/url-to-lane.ts` | link YouTube dibelokkan ke yt-dlp **hanya di desktop** |

---

## 1. Keputusan yang mengikat

### a) Bukan pustaka Rust — binari `yt-dlp` resmi sebagai subprocess

yt-dlp adalah program Python. Yang ada di crates.io adalah pembungkus yang
mengunduh binarinya lalu menjalankannya (`yt-dlp`, GPL-3.0) atau klien
Innertube murni Rust yang tetap butuh binari untuk PO token (`rustypipe`,
GPL-3.0). Proyek ini `MIT OR Apache-2.0`; crate GPL yang di-link ke binari
desktop memaksa binari itu ikut GPL. Program yt-dlp sendiri **Unlicense**.
Maka: binari resmi, dipanggil langsung dengan `tokio::process`, tanpa crate
pembungkus.

### b) Runtime JavaScript: QuickJS-NG, bukan Deno

Sejak 2025 yt-dlp mewajibkan runtime JavaScript eksternal untuk tantangan JS
YouTube (`--js-runtimes`). Dokumennya menyarankan Deno (± 100 MB). QuickJS-NG
(`qjs`, MIT) 1–2 MB dan sejak 0.12.0 sudah teroptimasi; ia dipin ke satu
rilis lewat URL (`QJS_RELEASE`) karena rilisnya tidak menerbitkan checksum.
yt-dlp mengenali runtime dari **nama berkasnya**, jadi binarinya disimpan
sebagai `qjs`/`qjs.exe` dan diberikan sebagai `--js-runtimes quickjs:<path>`.

### c) Diunduh sekali ke `<app_data_dir>/tools/`, bukan sidecar bundle

`bundle.externalBin` Tauri ditolak karena tiga hal: tauri-build gagal kalau
berkas sidecar tidak ada di mesin yang mem-build (CI, kontributor, `cargo
check`); bundle bertambah ± 40 MB; dan tiap pembaruan yt-dlp — YouTube sering
berubah — berarti rilis aplikasi baru. Polanya sama dengan model ONNX
(docs/20 D4): unduh saat pertama dipakai, `.part` lalu rename, verifikasi.

- yt-dlp: `releases/latest/download/<aset>` + `SHA2-256SUMS` — hash diverifikasi.
- qjs: rilis yang dipin; tidak ada checksum resmi.
- Berkas yang diunduh proses sendiri tidak membawa atribut karantina
  Gatekeeper, jadi dieksekusi tanpa dialog. Windows Defender kadang menandai
  `yt-dlp.exe` (false positive yang dikenal); pesannya diteruskan apa adanya.
- `youtube_update` mengunduh ulang yt-dlp hanya kalau hash rilis terbaru
  berbeda dari yang terpasang. Bukan `yt-dlp -U`: kita yang memegang
  berkasnya, verifikasinya lewat jalur yang sama.

Foldernya `app_data_dir()/tools`, folder data bawaan — **bukan** folder
kepustakaan yang bisa dipindah user (`store_relocate` tidak menyentuhnya,
docs/21 §1f). Ia cache, bukan data.

### d) Perkakas tidak pernah diunduh diam-diam

Hanya tombol SIAPKAN di dialog yang mengunduh. Link YouTube yang di-drop ke
lane saat perkakas belum ada gagal dengan petunjuk ke dialog itu: 40 MB yang
turun karena satu link di-drop adalah kejutan, dan di dialog barnya kelihatan.

### e) Hanya audio, tanpa ffmpeg

Format `bestaudio[ext=m4a]/bestaudio`. m4a (AAC) bisa di-decode
`decodeAudioData` WebKit — jalur `importBytesToLane` yang sama dengan drop
berkas — jadi ffmpeg tidak diperlukan. Kalau YouTube hanya punya Opus/WebM
untuk sebuah video, decode-nya tetap dicoba dan gagalnya terbaca sebagai galat
decode biasa.

### f) Argumen yt-dlp yang selalu ada

`--no-config` (config user di mesin itu tidak ikut campur), `--no-warnings`,
`--no-playlist`, `--js-runtimes quickjs:<qjs>`, URL sesudah `--`. Hanya URL
`http(s)` yang diteruskan. Galat yt-dlp sampai ke user sebagai baris
`ERROR:` terakhirnya tanpa label extractor ("Video unavailable", "Sign in to
confirm you're not a bot"), kode `YOUTUBE` di `LocalError`.

---

## 2. Kontrak

| Command | Isi |
|---|---|
| `youtube_status()` | `{ ready, ytDlpVersion }` — `ready` hanya kalau kedua binari ada DAN `yt-dlp --version` menjawab |
| `youtube_setup()` | unduh yang belum ada; idempoten; progres `phase: 'tools'` |
| `youtube_update()` | ganti yt-dlp kalau hash rilis terbaru berbeda; `true` = diganti |
| `youtube_info({url})` | `--dump-single-json`: id, judul, kanal, durasi, thumbnail, ekstensi dan perkiraan ukuran format audio |
| `youtube_bytes({url})` | badan mentah audio (`tauri::ipc::Response`); progres `phase: 'audio'`, `name` = id video |

Event `daw://youtube-progress`: `{ phase: 'tools' | 'audio', name, done, total }`,
`total` 0 = tidak diketahui.

---

## 3. Alur di UI

- Header Studio: tombol **YOUTUBE** hanya kalau `getPlatformHost().kind === 'desktop'`.
- Dialog: keadaan perkakas (SIAPKAN / PERBARUI + bar), URL + lane tujuan,
  **LIHAT** (judul, kanal, durasi, ukuran — sebelum apa pun diunduh), **+ LANE**
  (unduh → clip `judul.ekstensi` di playhead → tutup).
- Drop/paste link YouTube ke lane di desktop → jalur yang sama tanpa dialog,
  bar progres di lane (`ImportJob`, tahap `reading` berasio).

---

## 4. Tes

- `youtube_tests.rs` (Unix): yt-dlp **palsu** berupa skrip shell yang mencatat
  argumennya — yang diuji kontrak kita dengan yt-dlp (argumen, baris progres,
  galat), unduhan perkakas ke server HTTP lokal, verifikasi hash, `update`.
- `youtube_tests::real_*` (`#[ignore]`): jaringan sungguhan — unduh rilis
  asli, baca info dan unduh audio satu video pendek. Dijalankan manual:
  `cargo test -p daw-desktop-host real_ -- --ignored --nocapture`.
- Web: `api.test.ts`, `import.test.ts` (pembelokan hanya di desktop),
  `dialog.test.tsx`.

---

## 5. Utang yang dinyatakan terbuka

- Progres `youtube_bytes` tidak bisa dibatalkan dari UI: command Tauri tidak
  punya pembatalan; menutup dialog membuang hasilnya, prosesnya tetap selesai.
- Playlist sengaja tidak didukung (`--no-playlist`): satu link = satu clip.
- Windows ARM64 belum ada aset qjs yang dipakai; mengikuti docs/20 §1f
  (target rilis x86_64).
