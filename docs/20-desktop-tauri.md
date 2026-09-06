# 20 — Desktop app (Tauri 2)

Rencana membungkus KELAS MALAM STUDIO menjadi aplikasi desktop dengan Tauri 2,
**untuk macOS dan Windows saja**. Linux sengaja tidak masuk cakupan: tidak ada
target, tidak ada job CI, tidak ada janji. Web app-nya tetap ada dan tetap
sumber utama; desktop adalah **kulit kedua di atas frontend yang sama**, bukan
cabang baru.

| Yang sudah ada | Dipakai ulang? |
|---|---|
| `web/` — React + Vite, engine WASM `mt`/`st`, AudioWorklet, worker pool | **Ya, utuh.** Satu build Vite, dua tujuan (Vercel dan bundel Tauri). |
| `crates/*` — engine, dsp, export, timeline (Rust) | Ya, lewat WASM seperti di web. Jalur native (cpal) ditunda ke v2, lihat §1b. |
| `crates/native-host` — host cpal dev-only | Bibit untuk v2. Tidak dipakai v1. |
| `backend/` — Worker kepustakaan (cookie sesi) + Worker Roblox | **Belum, untuk v1.** Desktop v1 tanpa login (§1d); kepustakaan berkata "belum tersedia di versi desktop". |
| Toolchain: nightly-2025-06-15, `cargo-tauri` 2.11.4, Xcode | Sudah terpasang di mesin ini. |

---

## Hasil D0 — spike isolasi (6 Sep 2026)

Diukur otomatis: halaman memanggil `invoke('report')` saat load, Rust mencetak
JSON ke stdout lalu keluar (skrip di §6). Tauri 2.11.5 / wry 0.55.1, mesin
macOS 26.5 arm64 (WKWebView 605.1.15, 8 core).

| OS | Asal halaman | Header COOP/COEP/CORP | `crossOriginIsolated` | `SharedArrayBuffer` | `WebAssembly.Memory {shared}` | `AudioWorklet` | `hardwareConcurrency` | Varian yang dimuat Studio |
|---|---|---|---|---|---|---|---|---|
| macOS | `tauri://localhost` | tidak | **false** | undefined | ok | function | 8 | — |
| macOS | `tauri://localhost` | ya, `app.security.headers` | **false** | undefined | ok | function | 8 | **`st`** (`engine_bg` st diambil) |
| macOS | `tauri://localhost` | ya + `useHttpsScheme: true` | **false** (opsi ini hanya berlaku Windows/Android; `href` tetap `tauri://localhost`) | undefined | ok | function | 8 | — |
| macOS | `http://localhost:5199` (server statis lokal) | tidak | false | undefined | ok | function | 8 | — |
| macOS | `http://localhost:5199` (server statis lokal) | ya | **true** | function | ok | function | 8 | **`mt`** — Studio hidup, tanpa error console |
| macOS | `http://localhost:5173` (`cargo tauri dev` → Vite) | ya (`vite.config.ts`) | true | function | ok | function | 8 | `mt` (dev meminta `wasm/mt/engine_bg.wasm`) |
| Windows | — | — | belum diuji — butuh mesin | belum diuji — butuh mesin | belum diuji — butuh mesin | belum diuji — butuh mesin | belum diuji — butuh mesin | belum diuji — butuh mesin |

Yang ditetapkan dari tabel ini:

1. **Header-nya sampai, WebKit-nya yang tidak peduli.** `fetch(location.href)`
   dari dalam halaman `tauri://` membaca `coep: require-corp` — jadi §1c benar
   soal Tauri menyisipkan header, tapi WKWebView **tidak menerapkan COOP/COEP
   pada skema kustom**. Halaman yang sama, header yang sama, lewat
   `http://localhost` → isolated. Ini bukan soal versi macOS (26.5) atau
   `isSecureContext` (true di keduanya); ini perilaku WebKit untuk
   `WKURLSchemeHandler`.
2. **Konsekuensi untuk v1 macOS:** build produksi (`frontendDist` di
   `tauri://`) berjalan **`st`** — degraded sesuai docs/01 §1d: command lewat
   `postMessage`, export single-thread, ORT single-thread (§5d). Tidak crash,
   tidak ada error. Dev (`cargo tauri dev` → Vite) justru **`mt`**, jadi
   pengembang tidak akan pernah melihat mode `st` kecuali sengaja mencoba
   binary produksi.
3. **Jalan ke `mt` di produksi macOS ada, dan itu keputusan tersendiri:**
   sajikan `web/dist` dari server HTTP lokal di dalam proses Rust
   (`tauri-plugin-localhost` dengan `on_request` menambah tiga header, atau
   server kecil sendiri) dan arahkan jendela ke `http://localhost:<port>`.
   Harganya: origin app jadi `http://localhost:<port>` (daftar origin §5c
   bertambah), aset terbaca proses lokal mana pun, dan IPC harus diizinkan
   untuk origin remote lewat `capabilities[].remote`. **Gerbang D0 memutuskan:
   v1 macOS menerima `st`** — kerangka D1 dibangun di atas `tauri://` apa
   adanya. Jalur localhost ini pantas jadi butir baru di §5 (utang terbuka)
   dan §5e harus dibaca ulang: kedua varian WASM tetap dibawa bundel macOS.
4. `app.security.headers` **tetap dipasang** di `tauri.conf.json`: tidak
   merugikan di macOS, dan di Windows (WebView2 = Chromium) ia justru yang
   diharapkan membuat `mt` jalan — yang harus dibuktikan di mesin Windows.
5. Dua hal yang ketahuan sambil lalu dan menjadi pekerjaan D2:
   `/_vercel/insights/script.js` (komponen `<Analytics/>`) di-fallback ke
   `index.html` oleh protokol Tauri → `SyntaxError: Unexpected token '<'` di
   console (sudah dicatat §2c: Analytics mati saat `kind === 'desktop'`); dan
   build produksi tanpa `VITE_LIBRARY_API` menampilkan gerbang login di
   `/studio` — untuk mengukur varian dari `web/dist` sungguhan, spike memakai
   `NODE_ENV=development vite build --mode development` (auth dilewati oleh
   `import.meta.env.DEV`).

---

## 0. Dari mana kita mulai

Tiga fakta dari repo yang menentukan bentuk rencana ini:

1. **Seluruh jalur audio hidup di dalam browser engine**: AudioWorklet
   meng-instantiate WASM di atas `SharedArrayBuffer`, worker import/export
   berbagi linear memory yang sama, dan UI membaca meter lewat SAB
   (docs/01). Prasyaratnya `crossOriginIsolated === true`, yang datang dari
   header COOP/COEP (`web/vite.config.ts`, `web/public/_headers`).
   Tauri memakai WebView OS (WKWebView di macOS, WebView2/Chromium di
   Windows) — jadi pertanyaan pertama bukan "bagaimana", tapi **"apakah
   WebView-nya bisa diisolasi"**. Itu gerbang D0, dan harus dijawab di
   **kedua** OS: WebView2 adalah Chromium, WKWebView bukan, dan yang lolos di
   satu tidak membuktikan apa pun untuk yang lain.

2. **Sesi kepustakaan adalah cookie `__Host-lib_session`, `SameSite=Lax`**
   (`backend/src/library/session.ts`, docs/16 §5b). Ia bekerja karena app dan
   API satu site (`studio.kelasmalam.app` ↔ `lib.kelasmalam.app`). Dari
   Tauri, origin app adalah `tauri://localhost` (macOS) atau
   `http://tauri.localhost` (Windows) — **bukan satu site** dengan API, dan
   cookie itu tidak akan pernah ikut terkirim. Login desktop butuh jalur lain.

3. **Frontend sudah punya lapisan yang tepat untuk dicabang**: `app-shell`
   (routing, registry command, keymap — docs/15) dan `encoders/index.ts`
   (`pickSaveLocation`, `downloadBlob`). Perbedaan web vs desktop harus
   masuk lewat satu adapter, bukan `if (isTauri)` yang tersebar.

---

## 1. Keputusan yang mengikat

### a) Satu frontend, satu build Vite

`web/dist` yang sama dipakai Vercel dan Tauri. `tauri.conf.json` menunjuk
`frontendDist: ../../web/dist` dan `devUrl: http://localhost:5173`. Tidak ada
`web-desktop/`, tidak ada fork komponen. Yang membedakan hanya **satu modul
adapter** `web/src/platform/` (§2c) yang memilih implementasi berdasarkan
`isTauri()` dari `@tauri-apps/api/core`.

### b) Audio tetap di WebView (v1); cpal native adalah v2

Engine Rust sudah berjalan sebagai WASM di AudioWorklet, dan seluruh kontrak
di sekelilingnya — layout SAB, command ring, meter SeqLock, PCM sharing ke
worker, export offline — dibangun di atas satu linear memory yang dibagi
antar-thread browser. Memindahkan audio ke thread native cpal berarti engine
hidup di proses Rust sementara UI, import worker, dan export worker hidup di
WebView: **PCM tidak lagi bisa dibagi lewat memory yang sama**, dan seluruh
docs/01 harus ditulis ulang sebagai IPC. Itu proyek sendiri.

Yang didapat dari cpal (latensi lebih rendah, pilih device output, ASIO) nyata,
tapi bukan yang dibayar user desktop hari ini: mereka membayar **berkas lokal,
drag dari Finder, ikon di Dock, dan tidak bergantung tab**. Jadi v1 memakai
jalur yang sudah teruji, dan cpal dinyatakan sebagai utang terbuka (§5a)
dengan `crates/native-host` sebagai bibitnya.

### c) COOP/COEP lewat `app.security.headers`

Tauri ≥ 2.1 bisa menyisipkan header ke respons protokol `tauri://` lewat
`tauri.conf.json`:

```jsonc
"app": {
  "security": {
    "headers": {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin"
    }
  }
}
```

Ini yang membuat `crossOriginIsolated` bisa `true` di WebView. Tapi
dukungannya per-OS berbeda (WebView2 mengikuti Chromium, WKWebView punya
sejarahnya sendiri soal SAB di skema custom), dan klaim ini **harus dibuktikan
di D0 di kedua OS**, bukan dipercaya. Kalau gagal, loader
`web/src/audio/caps.ts` sudah menangani: app jatuh ke varian `st`
(degraded: command lewat `postMessage`, export single-thread) tanpa crash.
Gerbang D0 memutuskan apakah itu bisa diterima.

### d) v1 desktop TANPA login

Keputusan (Sep 2026, menggantikan rancangan lama): **versi desktop tidak punya
login untuk sekarang.** Kepustakaan di desktop menampilkan "belum tersedia di
versi desktop" alih-alih tombol masuk; Studio, DJ, dan Roblox dibuka tanpa
gerbang sesi. Tidak ada `tauri-plugin-deep-link`, tidak ada skema
`kelasmalam://`, tidak ada command `auth_token_*`, tidak ada perubahan di
Worker kepustakaan.

Kenapa bukan "login dulu baru rilis": cookie `__Host-lib_session` tidak
mungkin dari origin `tauri://` (§0 butir 2), jadi login desktop **pasti**
berarti jalur baru di Worker (bearer token, code sekali pakai, deep link) —
dan itu perubahan pada permukaan auth yang sama yang dipakai web produksi.
Mengirimkannya bersamaan dengan kerangka desktop berarti dua hal berisiko
menumpuk di satu rilis. Yang dibayar user desktop hari ini (§1b) tidak
membutuhkan sesi sama sekali.

Alur login desktop akan **didesain ulang** sebagai proyek sendiri. Rancangan
lama — browser sistem → deep link `kelasmalam://auth?code=…` → `POST
/auth/desktop/exchange` → bearer di keychain OS — tersimpan sebagai draft di
PR #43 (backend), bukan dibuang. Kalau rancangan itu yang akhirnya dipakai,
`resolveSession()` menerima cookie ATAU bearer, redirect URI Google tidak
berubah, dan token hanya hidup di sisi Rust; kalau tidak, draft itu tinggal
ditutup.

### e) Letak proyek: `desktop/src-tauri`, anggota workspace, dikecualikan di job CI Ubuntu

```
desktop/
  src-tauri/
    Cargo.toml            package `daw-desktop`
    tauri.conf.json
    capabilities/default.json
    src/main.rs           → daw_desktop_lib::run()
    src/lib.rs            plugin, command auth_token_*, models_*
    icons/
  package.json            @dawonweb/desktop — hanya @tauri-apps/cli + api
```

Ia **anggota workspace root** (satu `Cargo.lock`, satu toolchain dari
`rust-toolchain.toml`, satu `target/`). `.cargo/config.toml` aman: seluruh
flag-nya di bawah `[target.wasm32-unknown-unknown]`, build native tidak
tersentuh. Di CI, job `native` (Ubuntu) menambah `--exclude daw-desktop`
persis seperti `daw-native-host`: crate Tauri di Linux menyeret webkit2gtk
lewat apt, dan apt sudah terbukti bisa menyandera seluruh pipeline (komentar
di `ci.yml`). Linux memang bukan target, jadi tidak ada alasan membayar itu.
Desktop diuji di job sendiri di runner macOS dan Windows (§3).

### f) macOS dulu, Windows menyusul lewat CI; keduanya target rilis

Mesin pengembang ini macOS dengan Xcode; itu jalur yang bisa diverifikasi
tangan tiap hari. Windows dibangun oleh `tauri-apps/tauri-action` di runner
`windows-latest` dan **wajib** dicoba di mesin Windows sungguhan sebelum
dinyatakan didukung — D0 dan D6 masing-masing menuntut itu.

Versi minimum: macOS **12** (WKWebView di bawah itu tidak punya `BigInt64Array`
dan top-level await yang diandalkan `build.target: esnext`); Windows **10
1803+** dengan WebView2 Evergreen. Bundler Windows memakai
`webviewInstallMode: embedBootstrapper` supaya mesin tanpa WebView2 tetap bisa
memasangnya saat instalasi, bukan gagal diam-diam saat pertama dibuka.

### g) Model ONNX tidak ikut bundel

`web/public/models/scnet/scnet-base.onnx` 44 MB (large 170 MB) sekarang ikut
`dist`. Di desktop keduanya **diunduh saat pertama dipakai** ke
`appDataDir()/models/`, lewat `reqwest` di sisi Rust (progress lewat event),
lalu dibaca sebagai byte lewat command dan diberikan ke
`InferenceSession.create(bytes)`. Ini sengaja **bukan** `fetch` dari WebView:
COEP `require-corp` akan menuntut header CORP dari server model, dan jalur
byte lewat IPC menghindari seluruh pertanyaan itu.

---

## 2. Bentuk

### a) Alur build

```
scripts/build-wasm.sh ──► web/src/wasm/{mt,st}
                               │
pnpm -C web build ─────────────┴──► web/dist  ──┬──► Vercel (seperti sekarang)
                                                 └──► cargo tauri build (bundel)
```

Skrip root yang ditambahkan:

| Skrip | Isi |
|---|---|
| `dev:desktop` | `cargo tauri dev` — `beforeDevCommand` menjalankan Vite; header COI sudah dipasang `vite.config.ts`, jadi dev desktop = dev web + jendela. |
| `build:desktop` | `build:wasm` → `pnpm -C web build` → `cargo tauri build`. |

Vite mendapat `envPrefix: ['VITE_', 'TAURI_ENV_']` supaya `TAURI_ENV_PLATFORM`
terbaca kalau suatu saat perlu, dan `clearScreen: false` supaya log Rust tidak
tertimpa. `base` tetap `/`.

### b) Routing di dalam `tauri://`

`app-shell/routes.ts` memetakan **path** (`/studio`, `/dj`). Di produksi Tauri,
halaman dibuka dari `tauri://localhost/index.html`; `pushState` ke `/studio`
berjalan, tapi **muat ulang** di path itu bergantung pada fallback protokol
Tauri yang tidak dijanjikan. Keputusan: di Tauri, shell **tidak pernah memuat
ulang** (tidak ada `location.reload`, tidak ada `href=` internal), dan
`routeOf()` tetap dipakai apa adanya. Kalau D1 menemukan reload memang
diperlukan (mis. pulih dari fault engine), jatuh ke hash-route hanya saat
`isTauri()` — satu baris di `routes.ts`, bukan perombakan.

### c) Adapter platform — `web/src/platform/`

```ts
export interface PlatformHost {
  readonly kind: 'web' | 'desktop';
  saveFile(blob: Blob, suggestedName: string, mime: string): Promise<void>;
  openAudioFiles(): Promise<readonly File[]>;
  openExternal(url: string): Promise<void>;
  login(nextPath: string): Promise<void>;        // web: navigasi; desktop: §1d
  authHeaders(): Promise<HeadersInit>;            // web: {}; desktop: Bearer
  modelBytes(id: ScnetModelId, onProgress): Promise<Uint8Array>;
  onFilesDropped(cb: (paths: readonly File[]) => void): () => void;
}
```

| Titik | Web (kode sekarang) | Desktop |
|---|---|---|
| Export selesai | `pickSaveLocation` / `downloadBlob` | `plugin-dialog.save()` + `plugin-fs.writeFile` — **streaming**, tidak menumpuk Blob 500 MB |
| Import lagu | `<input type=file>` | `plugin-dialog.open({multiple, filters})` + `readFile` |
| Drag dari Finder | DataTransfer | event `tauri://drag-drop` memberi **path**, dibaca lewat fs |
| Link keluar (SoundCloud, Roblox, kebijakan) | `window.open` | `plugin-opener` — jangan buka di WebView app |
| Login | `location.href = loginUrl` | §1d |
| Analytics Vercel | aktif | **mati** — komponen `<Analytics/>` hanya di-render saat `kind === 'web'` |
| `hardwareConcurrency` untuk pool worker | apa adanya | apa adanya (WKWebView melaporkan benar) |

Implementasi web = **kode yang sudah ada dipindah**, bukan ditulis ulang.
Tes yang sudah ada untuk `encoders` dan `library/api` tetap lewat karena
adapter web-nya identik.

### d) Sisi Rust (`desktop/src-tauri/src/lib.rs`)

Sengaja tipis. Isinya:

- Registrasi plugin: `dialog`, `fs`, `opener`, `deep-link`, `updater`,
  `window-state`.
- `auth_token_get/set/clear` → crate `keyring` (Keychain / Credential Manager
  / Secret Service).
- `model_download(id) -> path` + `model_read(id) -> Vec<u8>` dengan event
  progress; verifikasi ukuran & hash sebelum dianggap jadi (cermin
  `assertModelSize` di `scnet-model.ts`).
- Menu native yang memanggil **id command registry** (docs/15): menu adalah
  pintu ketiga ke registry, bukan salinan daftar aksi. Menu mengirim
  `emit('command', id)`, shell men-dispatch seperti dari keyboard.
- `close-requested`: tanya "simpan?" kalau project kotor.

Tidak ada logika audio, tidak ada logika project di sini.

### e) Capabilities (`capabilities/default.json`)

Hanya yang dipakai: `dialog:allow-open`, `dialog:allow-save`, `fs` dengan
scope `$APPDATA/**` dan path hasil dialog, `opener:allow-open-url` dengan
daftar host (`accounts.google.com`, `lib.kelasmalam.app`, `soundcloud.com`,
`roblox.com`), `deep-link:default`, `updater:default`. CSP mengikuti yang
sudah berlaku di web ditambah `connect-src` ke tiga API dan `ipc:`.

---

## 3. CI

Job baru `desktop` di `ci.yml`, `runs-on: macos-latest`, `needs: [wasm, web]`:

1. unduh artefak `wasm` dan `web-dist` dari run yang sama (pola yang sudah
   dipakai `deploy.yml` — yang dibundel adalah berkas yang baru saja diuji);
2. `cargo clippy -p daw-desktop --all-targets -- -D warnings`;
3. `cargo tauri build --debug --no-bundle` sebagai uji kompilasi + linking;
4. `cargo test -p daw-desktop`.

Job `desktop` dijalankan sebagai matrix `[macos-latest, windows-latest]`;
langkah 3 di Windows juga menjadi bukti bahwa crate-nya link dengan MSVC.

Rilis (§4 D6) memakai workflow terpisah `release-desktop.yml`, dipicu tag
`desktop-v*`, matrix macOS (aarch64 + x86_64) dan Windows (x86_64), lewat
`tauri-apps/tauri-action`, menghasilkan GitHub Release + `latest.json` untuk
updater. Tidak ada runner Ubuntu di sini. Job `native` Ubuntu yang sudah ada
menambah `--exclude daw-desktop`.

---

## 4. Fase kerja

Tiap fase punya "done" yang bisa diperiksa orang lain. D0 adalah **gerbang**:
fase berikutnya tidak dimulai sebelum jawabannya ada.

| Fase | Isi | Done |
|---|---|---|
| **D0 — Spike isolasi** ⚠️ | `cargo tauri init` sementara di luar repo, `frontendDist` → `web/dist` yang ada, header §1c. Buka `/studio`, tekan Play. | Tabel **macOS dan Windows** (Windows lewat mesin/VM sungguhan, bukan runner): `crossOriginIsolated`, `caps.variant` (`mt`/`st`), worklet hidup, suara keluar, export WAV 1 menit selesai. **Gerbang berhenti:** kalau salah satu OS hanya `st`, putuskan di sini — terima degraded untuk OS itu, atau majukan §5a ke v1. Jangan menulis kode adapter sebelum ini. |
| **D1 — Kerangka di repo** | `desktop/src-tauri` sebagai anggota workspace, skrip `dev:desktop`/`build:desktop`, `.gitignore` (`desktop/src-tauri/gen`, `target` sudah), ikon, ukuran/min-size jendela, `window-state`, `--exclude daw-desktop` di CI + job `desktop` macOS. | `pnpm run dev:desktop` membuka jendela ke Vite dev; `build:desktop` menghasilkan `.app` yang membuka `/studio`; CI hijau di kedua job. Belum ada fitur desktop apa pun — dan itu memang sengaja. |
| **D2 — Adapter platform** | `web/src/platform/` (§2c); pindahkan `pickSaveLocation`/`downloadBlob`/input-file/`window.open`/`<Analytics/>` ke baliknya. Drag-drop dari Finder. | Export ke lokasi pilihan user (tanpa Blob 500 MB di memori); import lewat dialog dan lewat drop; link luar terbuka di browser OS; tes `encoders` & `library` yang ada tetap hijau; tes baru untuk adapter desktop dengan mock `@tauri-apps/api`. |
| **D3 — Login desktop** — **DITUNDA** | Tidak dikerjakan di v1 (§1d). Rancangan lama (bearer di `resolveSession`, `client=desktop`, `/auth/desktop/exchange`, deep link, keyring) tersimpan sebagai draft PR #43. | Tidak ada. v1 dirilis tanpa login; kepustakaan di desktop berkata "belum tersedia di versi desktop". Fase ini dibuka lagi bersama desain ulang alur login. |
| **D4 — Model & aset besar** | `model_download`/`model_read`, `modelBytes()` di adapter, halaman proof-stem memakai adapter. Model dikeluarkan dari `dist` **hanya untuk build desktop** (web tetap seperti sekarang). | Pemisahan stem jalan di desktop dengan model yang diunduh sekali; unduhan yang putus di tengah tidak meninggalkan berkas setengah; `.app` tidak membawa `.onnx`. |
| **D5 — Rasa desktop** | Menu native → registry command; judul jendela = nama project + tanda kotor; konfirmasi tutup; pintasan `⌘,` ke editor keymap yang sudah ada; `Cmd+Q` tidak memotong export yang sedang jalan. | Setiap item menu punya id command yang juga ada di palette `⌘K` (tes: himpunan id menu ⊆ registry). Menutup saat export berjalan → dialog, bukan proses hilang. |
| **D6 — Rilis** | Signing + notarization macOS (Developer ID), code-signing Windows (Authenticode, atau Azure Trusted Signing) kalau sertifikatnya ada, `release-desktop.yml`, `tauri-plugin-updater` dengan kunci minisign di secrets, versi dari `workspace.package.version`. | Tag `desktop-v0.1.0` menghasilkan `.dmg` ter-notarize (aarch64 + x86_64), `.msi` + `.exe` NSIS, dan `latest.json`; build 0.1.1 memperbarui 0.1.0 yang terpasang lewat dialog updater **di kedua OS**. Tanpa sertifikat code-signing Windows, SmartScreen akan menahan installer — itu dicatat di README rilis, bukan disembunyikan. |

Perkiraan: D0 satu–dua hari, D1–D2 satu minggu, D3 ditunda, D4 dua hari,
D5 tiga hari, D6 bergantung antrean Apple Developer.

---

## 5. Utang yang dinyatakan terbuka

### a) Audio native lewat cpal (v2)

Latensi WebView bergantung pada `AudioContext` OS (~10–20 ms), tanpa pilihan
device output, tanpa ASIO. `crates/native-host` sudah membuktikan `Engine`
bisa berjalan di callback cpal. Yang belum ada — dan yang membuat ini proyek
sendiri — adalah **bagaimana PCM asset, command ring, dan meter menyeberang
proses**: engine di Rust, UI dan worker di WebView. Kandidat: PCM di `mmap`
berkas sementara yang dipetakan kedua sisi; command lewat channel Tauri;
meter lewat event 30 Hz (jalur `post-message` di `DegradedMatrix` sudah
menyiapkan bentuknya). Baru dikerjakan kalau ada user yang membayar latensi.

### b) Windows hanya lewat CI sampai ada mesinnya

Tidak ada mesin Windows di meja pengembang. Runner CI membuktikan crate-nya
mengompilasi dan link, bukan bahwa suara keluar dari speaker. Sebelum ada VM
atau mesin sungguhan untuk D0 dan D6, Windows tidak boleh dinyatakan
"didukung" di halaman unduhan.

### c) Dua origin desktop

macOS `tauri://localhost`, Windows `http://tauri.localhost`. Semua
daftar origin (CORS Worker, CSP `connect-src`) harus memuat keduanya, dan tes
Worker harus menutup keduanya — kalau tidak, bug-nya hanya muncul di OS yang
tidak dipakai pengembang.

### d) Thread ONNX di WKWebView

`ort.env.wasm.numThreads` bergantung pada isolasi yang sama dengan engine. Kalau
D0 memberi `mt`, ORT juga multi-thread; kalau `st`, pemisahan stem di desktop
jadi single-thread dan angkanya harus diukur ulang seperti docs/14 §S1.

### e) Ukuran bundel

`web/dist` 61 MB, 44 MB di antaranya model yang dikeluarkan di D4. Sisanya
(~17 MB: dua varian WASM, ORT, encoder) dibawa apa adanya. Varian `st` bisa
dibuang dari bundel desktop kalau D0 memastikan `mt` selalu ada di macOS —
itu keputusan setelah tabel D0, bukan sebelumnya.

---

## 6. Perintah D0 (yang benar-benar dijalankan)

Bukan `cargo tauri init` + DevTools manual seperti rencana semula — hasilnya
harus bisa diulang tanpa tangan di keyboard, jadi halaman melapor sendiri lewat
IPC dan prosesnya keluar begitu laporan tercetak. Semuanya di luar repo
(direktori sementara); tidak ada yang di-commit dari sini selain tabel di atas.

```bash
mkdir -p /tmp/kms-spike/{src,ui,capabilities} && cd /tmp/kms-spike
cat > Cargo.toml <<'TOML'
[package]
name = "kms-spike"
version = "0.0.0"
edition = "2021"
[build-dependencies]
tauri-build = "2"
[dependencies]
tauri = "2"
serde_json = "1"
TOML
printf 'fn main() { tauri_build::build() }\n' > build.rs
cat > src/main.rs <<'RS'
#[tauri::command]
fn report(app: tauri::AppHandle, report: serde_json::Value) {
    println!("D0_REPORT {report}");
    app.exit(0);
}
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report])
        .run(tauri::generate_context!())
        .expect("spike");
}
RS
cat > ui/index.html <<'HTML'
<!doctype html><meta charset="utf-8"><script>
(async () => {
  const r = { href: location.href, crossOriginIsolated, sab: typeof SharedArrayBuffer,
    audioWorklet: typeof AudioWorklet, hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent, isSecureContext };
  try { new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }); r.sharedWasmMemory = true }
  catch (e) { r.sharedWasmMemory = String(e) }
  const h = (await fetch(location.href)).headers;
  r.selfHeaders = { coop: h.get('cross-origin-opener-policy'), coep: h.get('cross-origin-embedder-policy') };
  await window.__TAURI__.core.invoke('report', { report: r });
})();
</script>
HTML
echo '{ "identifier": "default", "windows": ["main"], "permissions": ["core:default"] }' > capabilities/default.json
cat > tauri.conf.json <<'JSON'
{ "productName": "kms-spike", "version": "0.0.0", "identifier": "app.kelasmalam.spike",
  "build": { "frontendDist": "./ui" },
  "app": { "withGlobalTauri": true, "windows": [{ "label": "main", "title": "spike" }],
    "security": { "csp": null,
      "headers": { "Cross-Origin-Opener-Policy": "same-origin",
                   "Cross-Origin-Embedder-Policy": "require-corp",
                   "Cross-Origin-Resource-Policy": "same-origin" } } },
  "bundle": { "active": false } }
JSON
cargo tauri icon /path/ke/web/public/apple-touch-icon.png -o icons   # tauri-build menuntut icons/icon.png
cargo build && ./target/debug/kms-spike | grep D0_REPORT
# baris kedua tabel. Hapus `headers` → baris pertama. Tambah
# `"useHttpsScheme": true` di windows[0] → baris ketiga.
```

Langkah kedua, `web/dist` sungguhan (baris `st`/`mt` dengan "Varian yang
dimuat Studio"): salin `web/dist` ke direktori sementara, sisipkan
`<script src="/reporter.js">` setelah `<div id="root">` yang membungkus
`fetch` dan setelah 15 detik melaporkan URL `engine_bg-*.wasm` yang diminta
(`BN89mABI` = mt, `BWSYtPMo` = st — cocokkan ukurannya dengan
`web/src/wasm/{mt,st}/engine_bg.wasm`), arahkan `frontendDist` ke salinan itu
dan `windows[0].url` ke `/studio`. **Aset ditanam saat compile** — setiap
perubahan di salinan `dist` butuh `cargo build` lagi, kalau tidak yang jalan
adalah salinan lama. Untuk baris `http://localhost`, server statis Node
sepuluh baris dengan tiga header yang sama, `windows[0].url` ke
`http://localhost:5199/studio`, dan laporan dikirim lewat `fetch('/report',
{method:'POST'})` ke server itu (IPC dari origin remote butuh
`capabilities[].remote`, dan itu bukan yang sedang diuji).
