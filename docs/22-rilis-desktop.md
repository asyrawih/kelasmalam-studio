# 22 — Rilis desktop (D6): dari mesin lokal ke GitHub Releases

Menutup fase **D6** di [docs/20 §4](20-desktop-tauri.md): `.dmg` macOS (aarch64 +
x86_64), `.msi` + `-setup.exe` Windows, dan `latest.json` untuk
`tauri-plugin-updater`, semuanya di satu GitHub Release bertag `desktop-v<versi>`.

Dokumen ini ditulis **jujur soal status**: baca §0 dulu.

---

## 0. Status: apa yang sudah terbukti, apa yang belum

| Terbukti di mesin ini (macOS arm64, 6 Sep 2026) | Belum pernah dijalankan |
|---|---|
| `scripts/release-desktop.sh --dry-run` untuk satu dan dua target, dengan dan tanpa `--publish` | Build **ber-signing** dan **notarization** sungguhan (kredensial ada di mesin, tapi rilis pertama belum dibuat) |
| `scripts/release-desktop.sh --unsigned` penuh: `cargo tauri build --target aarch64-apple-darwin --bundles app dmg` 6 m 40 s dari cache dingin → `dist-desktop/0.1.0/KelasMalamStudio_0.1.0_aarch64.dmg` **51 MB** (`.app` 54 MB, `Signature=adhoc`, `CFBundleShortVersionString` = `0.1.0` dari `[workspace.package]`, `LSMinimumSystemVersion` 12.0). 44 MB di antaranya model ONNX (§5d) | Artefak updater (`.app.tar.gz` + `.sig`) — butuh kunci privat (§2) |
| Overlay `--config '{"bundle":{"createUpdaterArtifacts":false}}'` diterima tauri-cli 2.11.4 | `latest.json` yang dibaca aplikasi sungguhan — **belum ada pemanggil `check()` di `web/src`** (§7) |
| `scripts/desktop-version.sh` (cetak / `--check` / `--set`) | Skrip di **Windows** (Git Bash) — belum ada mesin Windows (docs/20 §5b) |
| `cargo tauri build --debug --no-bundle` dengan `tauri.conf.json` yang baru (CI job `desktop`) | `--publish`: `gh release create/upload` — dry-run saja |
| `bash -n` kedua skrip | Penggabungan `latest.json` lintas mesin (§5c) — logikanya ada, datanya belum |

Kolom kanan berarti: **rilis `desktop-v0.1.0` yang pertama adalah run sungguhan
pertama**. Perkirakan ada satu-dua putaran perbaikan di skrip; itu normal.

---

## 1. Kenapa lokal, bukan GitHub Actions

Rencana awal (docs/20 §3) memakai `tauri-apps/tauri-action` di runner
macOS/Windows. Diganti menjadi skrip lokal karena:

- sertifikat Developer ID, sesi notarization, dan kunci privat updater semuanya
  sudah ada di mesin pengembang; CI harus mengimpor semuanya ke keychain
  sementara di setiap run;
- runner macOS/Windows GitHub lambat, berbayar lebih mahal, dan pernah
  menggantung (lihat komentar job `desktop` di `ci.yml`);
- yang merilis satu orang, dari satu Mac. Pipeline CI untuk itu adalah lapisan
  yang tidak membeli apa pun kecuali tempat baru untuk gagal.

Konsekuensinya jujur: **Windows dibangun di mesin Windows** dengan skrip yang
sama (§5), bukan oleh runner. Sampai mesin itu ada, rilis hanya berisi macOS.

Yang tetap di CI: job `desktop` di `ci.yml` (`cargo tauri build --debug
--no-bundle` di macOS + Windows) — bukti compile + link, bukan bundel.

---

## 2. Kunci updater (sekali seumur hidup aplikasi)

`tauri-plugin-updater` memverifikasi setiap unduhan dengan tanda tangan
minisign. Kunci publiknya **ditanam di aplikasi** (`plugins.updater.pubkey` di
`desktop/src-tauri/tauri.conf.json`), kunci privatnya dipakai saat build.

```bash
cargo tauri signer generate -w ~/.tauri/kelasmalam-studio.key
# diminta password — boleh kosong (Enter dua kali), tapi kalau diisi,
# simpan password itu bersama kuncinya.
```

Hasil: `~/.tauri/kelasmalam-studio.key` (privat) dan
`~/.tauri/kelasmalam-studio.key.pub` (publik).

1. Isi `kelasmalam-studio.key.pub` (satu baris base64 panjang, **bukan** baris
   `untrusted comment:`) → ganti nilai `pubkey` di `tauri.conf.json`, dan hapus
   field `_pubkey_catatan` di sebelahnya. **Commit** — kunci publik memang
   untuk umum.
2. Kunci privat → `.env.release` (§4), sebagai path:
   `TAURI_SIGNING_PRIVATE_KEY=/Users/<kamu>/.tauri/kelasmalam-studio.key`.
   tauri-cli menerima path ATAU isi berkas; path lebih aman dari salah kutip.
3. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=` — **tulis meski kosong**. Kalau
   variabelnya tidak ada sama sekali, tauri-cli di luar CI **meminta password
   di terminal**, dan skrip yang jalan tanpa pengawasan tampak menggantung.

**Kalau kunci privat hilang, tidak ada aplikasi yang sudah terpasang yang
bisa di-update lagi** — mereka hanya percaya kunci publik yang lama. Simpan
salinannya di password manager / tempat cadangan yang terenkripsi. Jangan
pernah commit.

Selama `pubkey` masih placeholder `TODO-D6…`, aplikasi tetap jalan (kunci baru
di-decode saat `check()` mengunduh), tapi setiap pemeriksaan update gagal.
Skrip rilis memperingatkan itu di langkah 2/7.

---

## 3. macOS: Developer ID + notarization

### a) Sertifikat

Butuh **Developer ID Application** (bukan "Apple Development", bukan "Mac App
Distribution"). Dari Xcode → Settings → Accounts → Manage Certificates → `+` →
Developer ID Application; atau dari <https://developer.apple.com/account/resources/certificates>.
Sertifikatnya harus ada di keychain login mesin yang mem-build:

```bash
security find-identity -v -p codesigning
#   1) ABCDEF... "Developer ID Application: Nama Kamu (TEAMID1234)"
```

String di dalam tanda kutip itulah `APPLE_SIGNING_IDENTITY`. tauri-bundler
membaca env ini sendiri (`interface/rust.rs`), menandatangani `.app` dengan
hardened runtime, lalu `.dmg`.

### b) Notarization — pilih satu

**App Store Connect API key** (disarankan: tidak menyentuh password Apple ID,
tidak kena 2FA):

1. <https://appstoreconnect.apple.com/access/integrations/api> → Team Keys →
   `+`, role **Developer** (cukup untuk notarytool).
2. Unduh `AuthKey_<KEYID>.p8` — **hanya bisa diunduh sekali**. Simpan di
   `~/.private_keys/AuthKey_<KEYID>.p8` (salah satu lokasi yang dicari bundler
   otomatis; yang lain: `./private_keys`, `~/private_keys`,
   `~/.appstoreconnect/private_keys`), atau sebutkan `APPLE_API_KEY_PATH`.
3. `.env.release`: `APPLE_API_KEY=<KEYID>`, `APPLE_API_ISSUER=<Issuer ID, UUID
   di halaman yang sama>`.

**Apple ID + app-specific password** (alternatif):
<https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.
`.env.release`: `APPLE_ID`, `APPLE_PASSWORD` (yang app-specific, bukan
password akun), `APPLE_TEAM_ID` (10 karakter, di developer.apple.com →
Membership). Ketiganya wajib — bundler menolak kalau `APPLE_TEAM_ID` kosong.

Urutan yang dilakukan bundler: codesign `.app` → `notarytool submit --wait` →
staple → bundel `.dmg` → codesign `.dmg` → notarize `.dmg`. Antrean Apple
biasanya 1–5 menit, kadang 30. Butuh Xcode / Command Line Tools ≥ 13
(`xcrun --find notarytool`).

Tanpa `APPLE_SIGNING_IDENTITY`, `.dmg` tetap jadi, **tidak** ditandatangani,
dan Gatekeeper di mesin lain berkata "damaged" / "can't be opened". Cukup untuk
uji di mesin sendiri (`xattr -d com.apple.quarantine` kalau perlu), bukan untuk
dibagikan.

---

## 4. `.env.release`

Di root repo, sudah di-gitignore lewat pola `.env*`. Disumber skrip dengan
`set -a`, jadi cukup `KEY=nilai` per baris, tanpa `export`.

```bash
# alamat backend — ditanam Vite SAAT build (sama dengan job web di ci.yml).
# Kosong = halaman /roblox UI ONLY, kepustakaan daring "belum dipasang".
VITE_ROBLOX_API=https://...
VITE_LIBRARY_API=https://lib.kelasmalam.app

# macOS
APPLE_SIGNING_IDENTITY=Developer ID Application: Nama Kamu (TEAMID1234)
APPLE_API_KEY=ABC123DEF4
APPLE_API_ISSUER=12345678-1234-1234-1234-123456789012
# atau: APPLE_ID=..., APPLE_PASSWORD=..., APPLE_TEAM_ID=...

# updater (kedua OS — kunci yang SAMA)
TAURI_SIGNING_PRIVATE_KEY=/Users/kamu/.tauri/kelasmalam-studio.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
```

Variabel yang sudah ada di shell (mis. dari `~/.zshrc`) juga terbaca —
`.env.release` menimpanya. **Perhatian:** karena itu pula, build "uji" di
mesin yang profil shell-nya memuat kredensial Apple akan **mengirim `.app` ke
notarization**. Pakai `--unsigned` untuk build uji; skrip melepas semua env
`APPLE_*` dan `TAURI_SIGNING_*` dan menolak digabung dengan `--publish`.

### b) Windows: Authenticode (opsional, tapi SmartScreen menahan tanpa itu)

Bukan env, melainkan config bundler. Dua jalur:

- **Sertifikat OV/EV di mesin** — pasang `.pfx` ke Personal store, lalu di
  `desktop/src-tauri/tauri.windows.conf.json` (auto-merge Tauri, boleh
  di-commit — thumbprint bukan rahasia):
  ```json
  { "bundle": { "windows": {
      "certificateThumbprint": "<SHA1 thumbprint>",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com" } } }
  ```
  Butuh `signtool.exe` dari Windows SDK (bundler mencarinya lewat registry
  `Installed Roots`, atau `TAURI_WINDOWS_SIGNTOOL_PATH`).
- **Azure Trusted Signing** — `bundle.windows.signCommand` memanggil
  `trusted-signing-cli` (lihat dokumen Tauri "Windows Code Signing"); tidak
  perlu sertifikat di mesin.

Tanpa keduanya installer tetap jadi. SmartScreen menampilkan "Windows
protected your PC" sampai reputasi terbentuk — bahkan dengan sertifikat OV
baru, beberapa minggu pertama masih ditahan. Itu **dicatat di catatan rilis**,
bukan disembunyikan (docs/20 §4 D6).

---

## 5. Menjalankan rilis

### a) macOS — urutan lengkap untuk `desktop-v0.1.0`

```bash
# 0. versi. Satu sumber: [workspace.package] version di Cargo.toml root.
scripts/desktop-version.sh              # 0.1.0
scripts/desktop-version.sh --set 0.1.0  # hanya kalau perlu diubah
cargo update -w                         # Cargo.lock mencatat versi crate workspace
git commit -am "desktop: versi 0.1.0"
git tag desktop-v0.1.0                  # opsional sekarang; wajib sebelum publish

# 1. target kedua (sekali saja)
rustup target add x86_64-apple-darwin

# 2. build + draft release
scripts/release-desktop.sh --targets aarch64,x86_64 --publish --notes CATATAN.md
```

Yang terjadi, dan yang diperiksa skrip di tiap langkah:

| Langkah | Isi | Gagal kalau |
|---|---|---|
| 1/7 prasyarat | `cargo tauri`, `wasm-bindgen`, `wasm-opt`, `node`, target rustup, `gh` (hanya `--publish`); identitas codesign terlihat di keychain; kredensial notarization lengkap; kunci updater ada | perkakas/target tidak ada. Kredensial yang kurang hanya **peringatan** — dengan penjelasan hasil seperti apa yang keluar |
| 2/7 versi | `desktop-version.sh --check`; repo GitHub diturunkan dari `plugins.updater.endpoints` | `tauri.conf.json` punya `version` yang beda; endpoint bukan GitHub |
| 3/7 wasm | `scripts/build-wasm.sh` (`--skip-wasm` kalau artefak `mt`/`st` sudah ada) | seperti skrip itu |
| 4/7 web | `web/node_modules/.bin/vite build` dengan `VITE_*` dari env | `web/node_modules` belum `npm ci` |
| 5/7 tauri | `cargo tauri build --target <triple> --bundles app dmg` per target; tanpa kunci updater ditambah overlay `--config '{"bundle":{"createUpdaterArtifacts":false}}'` | codesign/notarize ditolak (§8) |
| 6/7 kumpul | salin ke `dist-desktop/0.1.0/` dengan nama **tanpa spasi** | bundel tidak ditemukan |
| 7/7 latest.json | tulis/gabung `latest.json`; `--publish`: `gh release create --draft` (atau pakai yang ada), `gh release upload --clobber` | versi `latest.json` yang digabung berbeda |

Nama berkas yang keluar (**bukan** `KELAS MALAM STUDIO_0.1.0_aarch64.dmg`
buatan Tauri): GitHub mengganti spasi di nama aset dengan titik, sehingga URL
yang ditulis ke `latest.json` dari nama lokal tidak akan cocok dengan URL aset
sungguhan. Dan `.app.tar.gz` buatan Tauri tidak memuat versi/arsitektur sama
sekali — dua target macOS saling menimpa.

```
dist-desktop/0.1.0/
  KelasMalamStudio_0.1.0_aarch64.dmg
  KelasMalamStudio_0.1.0_aarch64.app.tar.gz        ← target updater
  KelasMalamStudio_0.1.0_aarch64.app.tar.gz.sig
  KelasMalamStudio_0.1.0_x86_64.dmg
  KelasMalamStudio_0.1.0_x86_64.app.tar.gz
  KelasMalamStudio_0.1.0_x86_64.app.tar.gz.sig
  latest.json
```

### b) Windows — mesin Windows, Git Bash

Skrip ini bash; jalankan dari **Git Bash** (Git for Windows), bukan
PowerShell/cmd. Prasyarat yang berbeda dari macOS:

- Visual Studio Build Tools (C++ workload) — MSVC untuk `x86_64-pc-windows-msvc`;
  `rustup` memasang toolchain nightly dari `rust-toolchain.toml` sendiri;
- WebView2 Runtime (sudah ada di Windows 10/11 modern);
- Windows SDK kalau mau Authenticode (`signtool.exe`);
- `cargo install tauri-cli --version ^2` (atau binari dari rilis tauri-cli),
  `cargo install wasm-bindgen-cli --version <persis versi di Cargo.lock>`,
  binaryen (`wasm-opt`) dari rilis GitHub-nya ke PATH, Node 20+, `gh`;
- `.env.release` dengan `TAURI_SIGNING_PRIVATE_KEY` menunjuk **kunci yang
  sama** (salin berkas `.key` lewat jalur aman) — tanpa `APPLE_*`.

```bash
bash scripts/release-desktop.sh --publish      # --targets hanya menerima x86_64
```

Bundel: `--bundles msi nsis`. Yang masuk `latest.json` sebagai
`windows-x86_64` adalah **NSIS** (`KelasMalamStudio_0.1.0_x64-setup.exe`),
bukan `.msi`: installer NSIS yang membawa bootstrapper WebView2
(`webviewInstallMode: embedBootstrapper`, docs/20 §1f) dan mendukung mode
`passive` yang dipakai updater. `.msi` tetap diunggah untuk yang butuh
deployment lewat Group Policy.

Yang **belum diketahui** karena belum ada mesinnya: apakah `find`/`mktemp`
Git Bash berperilaku sama (seharusnya), apakah `cargo tauri build` di Git Bash
menemukan `signtool` (ia membaca registry, bukan PATH — seharusnya ya), dan
berapa lama compile-nya. docs/20 §5b berlaku: Windows tidak dinyatakan
didukung sampai `.exe`-nya dicoba di mesin sungguhan.

### c) Menggabungkan `latest.json` dari dua mesin

`latest.json` hanya satu per release, tapi dibangun di dua mesin. Dua cara:

1. **Lewat draft release (disarankan).** Mesin kedua jalan dengan `--publish`
   ke tag yang sama: skrip melihat release sudah ada, **mengunduh
   `latest.json` yang sudah terunggah**, menggabungkan platform-nya dengan
   yang baru dibangun, dan mengunggah ulang (`--clobber`). Urutan macOS →
   Windows atau sebaliknya sama saja.
2. **Offline.** Salin `dist-desktop/0.1.0/latest.json` dari mesin pertama,
   jalankan di mesin kedua dengan `--merge <berkas itu>` (tanpa `--publish`),
   lalu unggah hasil gabungannya sendiri:
   `gh release upload desktop-v0.1.0 --clobber dist-desktop/0.1.0/*`.

Kedua jalur menolak menggabungkan `latest.json` yang `version`-nya berbeda —
`latest.json` 0.1.0 dari Windows tidak boleh nyasar ke rilis 0.1.1.

### d) Memeriksa draft, lalu publish

Di <https://github.com/asyrawih/kelasmalam-studio/releases> (draft hanya
terlihat oleh yang punya akses tulis):

1. Semua aset ada, nama tanpa spasi, ukuran masuk akal (`.dmg` ~20–70 MB;
   kalau ~60 MB+ berarti model ONNX 44 MB masih ikut `dist` — docs/20 §1g/§5e
   dan D4 menyebut ia dikeluarkan hanya untuk build desktop; periksa
   `web/dist/models` sebelum build).
2. `latest.json`: `version` = versi tag tanpa `desktop-v`; setiap `platforms.*.url`
   menunjuk ke `releases/download/desktop-v0.1.0/<nama aset yang benar-benar ada>`;
   `signature` berisi teks `.sig` (dimulai `untrusted comment:`).
3. Unduh `.dmg` di Mac lain (atau `xattr -c` di Mac sendiri) → buka → tidak ada
   dialog Gatekeeper. `spctl -a -vv -t install "KELAS MALAM STUDIO.app"` →
   `accepted, source=Notarized Developer ID`.
4. **Publish** (bukan pre-release). Endpoint updater adalah
   `releases/latest/download/latest.json`: `latest` = release non-draft,
   non-prerelease **terbaru di repo ini, apa pun tag-nya**. Kalau suatu saat
   repo ini punya release lain (mis. backend), updater desktop akan membaca
   `latest.json` release itu — atau 404. Solusinya nanti: endpoint dengan tag
   eksplisit atau repo terpisah; sekarang cukup: jangan buat release lain.

---

## 6. Versi berikutnya (0.1.1)

```bash
scripts/desktop-version.sh --set 0.1.1 && cargo update -w
git commit -am "desktop: 0.1.1" && git tag desktop-v0.1.1
scripts/release-desktop.sh --targets aarch64,x86_64 --publish --notes CATATAN.md
# (+ mesin Windows, §5b) → periksa draft (§5d) → publish
```

Updater hanya memasang versi yang **lebih besar** (semver) dari yang terpasang.
Rilis ulang 0.1.0 dengan isi berbeda tidak akan pernah sampai ke user — naikkan
patch.

---

## 7. Menguji updater 0.1.0 → 0.1.1

**Prasyarat yang belum ada:** tidak ada satu baris pun di `web/src` yang
memanggil `@tauri-apps/plugin-updater` (`check()`), meski plugin-nya terdaftar
di `lib.rs` dan capability `updater:default` sudah diberikan. Tanpa pemanggil,
aplikasi tidak pernah bertanya ke endpoint. Tindak lanjut D6 (PR terpisah,
`web/src/platform/` adapter desktop): saat start + menu "Periksa
pembaruan…" → `check()` → dialog "Versi X tersedia" → `downloadAndInstall()`
dengan progres → `relaunch()`. Setelah itu, urutan ujinya:

1. Publish `desktop-v0.1.0` (§5d). Pasang dari `.dmg` di Mac uji, buka sekali,
   pastikan ia berjalan sebagai aplikasi ter-notarize (§5d langkah 3).
2. Rilis 0.1.1 (§6) sampai **draft** — jangan publish dulu.
3. Buka 0.1.0 → periksa pembaruan → harus berkata "sudah terbaru" (draft tidak
   terlihat di `releases/latest`). Ini menguji bahwa endpoint terbaca sama
   sekali. Permintaannya dibuat di sisi Rust (`reqwest`), bukan dari WebView,
   jadi CSP `connect-src` **tidak** ikut campur — kalau gagal di sini, itu
   jaringan, `pubkey`, atau `latest.json`-nya (§8).
4. Publish 0.1.1 → periksa lagi → dialog 0.1.1 → pasang → relaunch → About
   menunjukkan 0.1.1. Ulangi di Windows: installer NSIS berjalan `passive`,
   aplikasi tertutup dan terbuka lagi.
5. Uji negatif yang murah: ubah satu byte `signature` di `latest.json` lokal
   (server statis sementara + `endpoints` sementara di build debug) → harus
   ditolak dengan "signature invalid", bukan dipasang.

---

## 8. Gejala kalau gagal

| Gejala | Penyebab yang lazim | Periksa |
|---|---|---|
| `A public key has been found, but no private key` saat build | `createUpdaterArtifacts: true` tapi `TAURI_SIGNING_PRIVATE_KEY` kosong dan overlay tidak terpasang | skrip memasang overlay otomatis; kalau memanggil `cargo tauri build` manual, tambahkan `--config '{"bundle":{"createUpdaterArtifacts":false}}'` atau isi kuncinya |
| Build "menggantung" tanpa output | tauri-cli menunggu password kunci privat di terminal | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=` (kosong pun harus ada) |
| `notarytool` "Invalid" / status `Invalid` | biasanya binari di dalam `.app` tanpa hardened runtime / tanpa timestamp, atau entitlement yang tidak diizinkan | `xcrun notarytool log <submission-id> --key … --key-id … --issuer …` — JSON-nya menyebut berkas dan alasannya per baris |
| "The software asset has already been uploaded" | submit ulang bundel yang identik | bukan error: staple saja (`xcrun stapler staple`), atau naikkan versi |
| Gatekeeper: "is damaged and can't be opened" | tidak ter-notarize (atau notarize `.app` tapi bukan `.dmg`), atau quarantine + tanda tangan rusak | `spctl -a -vv -t install`, `codesign -dv --verbose=4 <app>` |
| Updater: `signature invalid` / "The signature could not be verified" | `pubkey` di aplikasi ≠ pasangan kunci privat yang menandatangani (kunci diganti setelah 0.1.0 dirilis), atau `signature` di `latest.json` milik berkas lain | cocokkan `.key.pub` dengan `pubkey`; `signature` harus dari `.sig` berkas yang URL-nya ditulis di baris yang sama. Mengganti nama berkas setelah ditandatangani **aman** — tanda tangan atas isinya |
| Updater: "Could not fetch a valid release JSON" / 404 | release masih draft; `latest` menunjuk release lain; nama aset di URL beda dengan yang ada (spasi → titik) | buka URL `latest.json` di browser (tanpa login) |
| Updater diam saja, tidak ada request | belum ada pemanggil `check()` (§7); atau capability `updater:default` hilang dari `capabilities/default.json` (perintah ditolak diam-diam di sisi IPC) | build debug: error `updater.check not allowed` di console. Bukan CSP — unduhan dilakukan Rust (`reqwest`), bukan WebView |
| Updater: versi baru tidak ditawarkan | `version` di `latest.json` ≤ versi terpasang | semver, bukan tanggal; `0.1.10 > 0.1.9` |
| SmartScreen "Windows protected your PC" | tanpa Authenticode, atau sertifikat baru tanpa reputasi | "More info → Run anyway" untuk penguji; untuk publik butuh sertifikat (§4b) |
| `.dmg` 60 MB+ | model ONNX ikut `web/dist` | §5d langkah 1 |
| macOS x86_64 gagal link di Mac arm64 | target belum dipasang, atau dependensi C (rusqlite bundled) butuh SDK yang sama — biasanya tidak | `rustup target add x86_64-apple-darwin`; kalau tetap gagal, bangun x86_64 di Mac Intel |
