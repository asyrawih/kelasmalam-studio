# 21 — Desktop lokal: kepustakaan & halaman Roblox tanpa server

Dua revamp untuk **versi desktop** (docs/20), yang berbagi satu fondasi:
semua data tinggal di mesin user, tanpa login, tanpa Worker.

| Bagian | Yang berubah | Fase |
|---|---|---|
| **Fondasi lokal** | SQLite + folder berkas + keychain di `crates/desktop-host`, dipanggil lewat command Tauri | K0 |
| **Kepustakaan (LibraryDock)** | `LibraryApi` yang sama, implementasi lokal menggantikan Worker; dock tidak tahu bedanya | K1–K3 |
| **Halaman Roblox** | kategori & genre WAJIB sebelum unggah; katalog lokal yang menjawab "lagu genre apa yang sudah kuunggah"; unggah dan moderasi langsung ke Open Cloud dari Rust | R1–R5 |

Versi **web tidak berubah**: ia tetap memakai Worker kepustakaan dan Worker
Roblox seperti docs/16 dan docs/17. Yang dibuat di sini adalah implementasi
kedua di balik antarmuka yang sudah ada — bukan cabang UI.

---

## 0. Dari mana kita mulai

1. **Kepustakaan web sudah punya antarmuka yang tepat.** `LibraryApi`
   (`web/src/library/api.ts`) adalah satu interface: `tracks`, `blob`,
   `initTrack`/`putUpload`/`commitTrack`, `projects`, `putMarks`, dst. Dock,
   `load-track.ts`, `upload.ts`, `projects.ts`, `marks.ts` semuanya hanya
   berbicara lewat interface itu. Skema D1-nya (docs/16 §3: `track`, `marks`,
   `project`) adalah skema yang bisa dipindah ke SQLite lokal hampir apa adanya.
   Identitas lagu tetap **content hash** (docs/16 §2) — itu yang membuat
   project yang disimpan lokal tetap merujuk lagu yang benar setelah berkas
   dipindah.

2. **Halaman Roblox sudah memisahkan UI dari transport.** `RobloxPage` UI
   murni; `RobloxRoute` memasang `Runner` + `Transport` (docs/17 §Seam).
   Antreannya bertahan lewat IndexedDB (`persistence.ts`), termasuk byte
   MP3/OGG draft. Worker Roblox ada karena dua hal (backend/README): Open Cloud
   tidak mengirim CORS, dan API key tidak aman di halaman. **Di desktop
   keduanya hilang**: Rust memanggil `apis.roblox.com` tanpa CORS, dan API key
   duduk di keychain OS. Worker tidak diperlukan.

3. **Open Cloud tidak punya kolom genre.** `POST /assets/v1/assets` hanya
   menerima `displayName`, `description`, `assetType`, dan `creator`. Kategori
   dan genre adalah **metadata milik user di mesin user**. Satu-satunya tempat
   ia bisa ikut ke Roblox adalah teks deskripsi — dan itu dibuat sebagai
   pilihan, bukan asumsi (§3d).

4. **Desktop v1 tanpa login** (docs/20 §1d). Grant Access di `/roblox` hari
   ini memakai Worker kepustakaan (`/roblox/settings`, `/roblox/assets`,
   `/roblox/grants`), yang butuh sesi. Di desktop ia harus pindah ke jalur lokal
   juga, atau dinyatakan belum tersedia (§3f).

5. **Yang sudah ada dari wave 1** (docs/20): `crates/desktop-host` (unduh
   model, PR #44), `web/src/platform/` (adapter save/open/drop, PR #46),
   `desktop/src-tauri` (PR #47). Rencana ini dibangun di atas ketiganya dan
   tidak dimulai sebelum ketiganya di-merge. `TokenStore` keychain yang dicabut
   di PR #44 (commit `7f9d34e`) dipulihkan di K0 sebagai `SecretStore` — kali ini
   untuk API key Roblox, bukan sesi.

---

## 1. Keputusan yang mengikat

### a) Rust memiliki data; UI hanya memanggil command

Bukan `tauri-plugin-sql` (SQL ditulis dari TypeScript) melainkan `rusqlite`
(fitur `bundled`) di `crates/desktop-host`, dengan skema, migrasi, dan tes di
Rust di atas SQLite sungguhan. Alasannya sama dengan yang membuat Worker
kepustakaan memiliki D1-nya: UI yang tidak tahu SQL tidak bisa merusaknya, dan
aturan (dedup hash, refcount hapus, versi project) diuji di satu tempat. Tes D1
di `backend/src/library/worker.test.ts` adalah cetak biru tes K0.

### b) Satu folder kepustakaan, satu basis data

```
<dataDir>/                        default: appDataDir Tauri; bisa dipindah user (§2a)
  library.sqlite                  semua tabel §2b — WAL mode
  tracks/<sha256>.<ext>           byte ASLI lagu, dedup lewat hash (sama dengan R2 docs/16 §3)
  roblox/                         tidak ada byte sendiri — draft merujuk tracks/ lewat hash
  models/                         sudah ada (PR #44)
```

Berkas yang diimpor **disalin** ke `tracks/`, bukan dirujuk lewat path asal:
berkas asal dipindah, di-rename, dan dihapus user tanpa memberi tahu siapa pun,
dan kepustakaan yang isinya "ada di suatu tempat" bukan kepustakaan. Harganya
ruang disk dua kali untuk lagu yang tetap disimpan user di tempat lain, dan itu
harga yang jujur — ditampilkan sebagai ukuran total di strip dock.

Backup = salin satu folder. Itu fitur, dan ditulis di dokumen bantuan.

### c) `LibraryApi` tidak diubah; implementasinya yang bertambah

`createLocalLibraryApi()` mengimplementasikan interface yang sama di atas
command Tauri. `LibraryDock`, `load-track`, `upload`, `projects`, `marks`
**tidak diedit** kecuali di dua titik yang memang membicarakan server: status
(`'masuk'` dengan user `LOKAL`, tanpa tombol MASUK/KELUAR) dan kalimat notice.
Kalau ada perilaku yang hanya masuk akal untuk server (mis. `loginUrl`),
implementasi lokal melempar dengan pesan yang jelas, dan pemanggilnya tidak
pernah menjalankannya karena `login` di `PlatformHost` tidak ada (PR #46).

Byte lagu menyeberang IPC sebagai **biner mentah** (`tauri::ipc::Response`,
`invoke` mengembalikan `ArrayBuffer`), bukan JSON array angka — lagu 25 MB
sebagai JSON adalah 100 MB teks yang di-parse main thread. Untuk berkas yang
dijatuhkan dari Finder, import memakai **path** (`onDragDropEvent` memberi
path, PR #46): Rust menyalin dan meng-hash berkasnya sendiri, nol byte lewat
IPC.

### d) Kategori → genre: taksonomi milik user, dua tingkat, wajib saat unggah

Dua tabel (`roblox_category`, `roblox_genre`) yang **bisa disunting user**:
tambah, ganti nama, pindah genre ke kategori lain, hapus (ditolak kalau masih
dipakai, dengan menyebut jumlah lagunya — pola yang sama dengan hapus lagu
docs/16 §8d). Diisi awal dengan taksonomi bawaan supaya halaman tidak kosong,
tapi bawaan itu hanya baris biasa — bukan enum di kode:

| Kategori | Genre bawaan |
|---|---|
| Musik | Lo-fi, Hip-hop, EDM, Pop, Rock, Ambient, Orkestra, Jazz, Chiptune |
| Efek suara | UI, Ambience, Foley, Stinger, Senjata |
| Suara | Jingle, Narasi, Vokal |

Sebuah baris antrean **tidak bisa diunggah** tanpa kategori dan genre:
`violationsOf` mendapat dua kode baru (`kategori-kosong`, `genre-kosong`),
dengan pola yang sama dengan `nama-kosong`. Alasannya bukan disiplin: seluruh
manfaat revamp ini (§3a) adalah katalog yang bisa menjawab "genre apa", dan
katalog yang separuh isinya "belum dikategorikan" tidak menjawab apa-apa.
Pilihan massal ("terapkan ke 12 baris terpilih") ada supaya kewajiban ini tidak
jadi 12 klik.

Genre juga bisa ikut ke Roblox sebagai baris terakhir deskripsi
(`Genre: Musik / Lo-fi`), **hidup secara bawaan** dan bisa dimatikan di
pengaturan. Itu satu-satunya cara metadata ini terlihat di Creator Hub, dan
memakan ≤ 40 dari 1000 karakter deskripsi.

### e) Unggah dan moderasi langsung dari Rust

`crates/desktop-host/src/roblox.rs` memindahkan `backend/src/roblox/open-cloud.ts`
ke Rust: multipart `request` + `fileContent`, `x-api-key`, `POST assets`,
`GET operations/{id}`, pemetaan `moderationState`. Bentuk hasilnya identik
dengan yang dikembalikan Worker, jadi `runner.ts` tetap dipakai — yang diganti
hanya `Transport` (`createHttpTransport` → `createDesktopTransport`), persis
seam yang docs/17 janjikan. Kebijakan runner (satu berkas pada satu waktu,
moderasi lama ≠ gagal, resume setelah restart) tidak ditulis ulang.

Progres unggah: `reqwest` tidak melaporkan progres badan permintaan secara
bawaan; body dibungkus stream yang mengirim event `daw://roblox-progress`
`{ uploadId, sent, total }` per chunk 256 KB. Kalau itu ternyata rumit, fase R3
boleh mengirim progres kasar (0 → 100) dan mencatatnya sebagai utang — bar
yang jujur "sedang mengirim" lebih baik daripada bar yang mengarang angka.

### f) API key dan cookie Roblox di keychain, bukan di SQLite

`SecretStore` (pemulihan `TokenStore` PR #44 `7f9d34e`, dengan nama yang lebih
jujur): `roblox.api_key` dan, untuk Grant Access, `roblox.cookie`. Tidak pernah
masuk `library.sqlite`, tidak pernah masuk log, tidak pernah lewat event.
Kebijakan docs/17 "API key tidak disimpan di browser" berlaku persis sama:
ia tidak disimpan di WebView; yang menyimpannya OS.

---

## 2. Fondasi lokal (K0)

### a) Command Tauri

| Command | Isi |
|---|---|
| `store_info()` | path folder, ukuran total, jumlah lagu/project, versi skema |
| `store_relocate(newDir)` | pindahkan folder (salin → verifikasi → tukar → hapus lama), progres lewat event |
| `secret_get/set/clear(key)` | keychain, hanya untuk kunci yang terdaftar (`roblox.api_key`, `roblox.cookie`) |
| `library_*` | §2c |
| `roblox_*` | §3e |

Semua command menerima/mengembalikan struct `serde` yang tipenya di-generate
ke TypeScript (`specta` atau ditulis tangan + tes bentuk) supaya kontrak Rust↔TS
tidak bisa diam-diam melenceng.

### b) Skema `library.sqlite`

```sql
-- cermin docs/16 §3, tanpa user_id: satu mesin, satu pemilik
track          (hash PK, name, bytes, mime, frames, sample_rate, created_at)
marks          (hash PK REFERENCES track, json, updated_at)
project        (id PK, name, json, updated_at, version)
project_track  (project_id, hash, PRIMARY KEY (project_id, hash))

-- Roblox (§3b)
roblox_category (id PK, name UNIQUE, sort)
roblox_genre    (id PK, category_id REFERENCES roblox_category, name, sort, UNIQUE (category_id, name))
roblox_upload   (id PK, hash REFERENCES track, file_name, name, description,
                 category_id, genre_id, creator_kind, creator_id,
                 status, operation_id, asset_id, moderation_state, error,
                 created_at, updated_at, uploaded_at, approved_at)
setting         (key PK, value)     -- creator aktif, folder, opsi "genre ke deskripsi"
schema_version  (version)
```

Migrasi numerik seperti `backend/migrations/`, dijalankan saat buka.
`roblox_upload.hash → track`: byte draft Roblox adalah lagu kepustakaan
(dedup gratis, dan lagu yang diunggah ke Roblox otomatis ada di kepustakaan).
Hapus lagu ditolak kalau masih dirujuk `roblox_upload` yang belum `done`, dengan
pesan yang menyebutkannya — pola docs/16 §8d.

### c) Command kepustakaan ↔ `LibraryApi`

| `LibraryApi` | Command | Catatan |
|---|---|---|
| `tracks()` | `library_tracks` | metadata + marks, satu query |
| `blob(hash)` | `library_blob` | biner mentah; progres tidak perlu (disk lokal) — `onProgress(100)` sekali |
| `initTrack(meta)` | `library_has(hash)` | `exists` = ada di `track` |
| `putUpload(url, bytes)` | `library_put_bytes(hash, ext, bytes)` | `url` diabaikan; menulis `tracks/<hash>.<ext>.part` → rename |
| — | `library_import_path(path)` | jalur cepat drop Finder: hash + salin di Rust; `frames`/`sampleRate` dibaca dari header (`symphonia`, belum ada di workspace — lihat §5) atau diisi belakangan oleh probe `<audio>` yang sudah ada |
| `commitTrack(meta)` | `library_commit` | tulis baris `track` |
| `projects/project/createProject/updateProject/deleteProject` | `library_project_*` | `version` + tolak kalau beda, sama dengan `If-Match` |
| `addProjectTrack/removeProjectTrack/deleteTrack` | `library_*` | refcount di SQL, bukan di TS |
| `putMarks` | `library_put_marks` | |
| `me()` | — | lokal: `{ id: 'lokal', name: 'KEPUSTAKAAN LOKAL' }` |
| `logout/loginUrl` | — | tidak dipanggil di desktop (PR #46) |

### d) Tes K0

Rust: tiap command di atas SQLite sementara (`tempfile`), termasuk: import
berkas yang sama dua kali → satu baris dan satu berkas; hapus lagu yang dipakai
project → ditolak menyebut project; simpan project dengan versi basi → ditolak;
relocate yang gagal di tengah → folder lama utuh. TS: `createLocalLibraryApi`
dengan `invoke` di-mock memenuhi kontrak yang sama dengan tes `library.test.ts`
yang sudah ada (jalankan suite kontrak itu untuk KEDUA implementasi).

---

## 3. Halaman Roblox

### a) Manfaat yang harus terlihat oleh user

Tiga hal yang tidak bisa dijawab halaman hari ini, dan bisa dijawab sesudahnya:

1. **"Lagu genre apa saja yang sudah kuunggah, dan berapa?"** — tab KATALOG
   yang dikelompokkan kategori → genre dengan hitungan, status moderasi, dan
   `assetId` yang bisa disalin. Filter per genre, cari nama.
2. **"Yang mana yang masih ditinjau / ditolak?"** — status moderasi bertahan
   di SQLite dan dipoll ulang saat app dibuka, bukan hilang bersama IndexedDB.
3. **"Genre apa yang belum kupunya untuk game ini?"** — ringkasan per kategori
   (misal: 14 Musik, 0 Efek suara) di kepala tab KATALOG. Sederhana, tapi ini
   yang membuat taksonomi terasa berguna, bukan formulir tambahan.

Manfaat yang **tidak** dijanjikan: Roblox tidak akan menampilkan genre di
katalognya sendiri (§0.3). Kalimatnya di UI: "Genre tersimpan di mesin ini
(dan di deskripsi asset kalau opsinya hidup)".

### b) Model (`web/src/roblox/model.ts`)

`QueueItem` bertambah `categoryId: string | null`, `genreId: string | null`;
`RobloxState` bertambah `taxonomy: { categories, genres }` dan `catalog`
(baris `roblox_upload` yang sudah `done`/`failed`, dipisah dari antrean aktif
supaya antrean tetap ringan). `violationsOf` bertambah dua kode (§1d).
`persistence.ts` (IndexedDB) **dihapus di desktop** — antrean adalah tabel;
di web ia tetap dipakai, di balik adapter `QueuePersistence` yang sudah ada
bentuknya di `store.ts` (`PersistenceAdapter`).

### c) UI

```
ROBLOX ─┬─ UNGGAH   (yang ada) + kolom KATEGORI/GENRE di DetailPanel dan QueueRow,
        │            pilihan massal untuk baris terpilih, tombol "+ genre baru" inline
        ├─ KATALOG  (baru) kelompok kategori → genre, hitungan, filter, salin assetId,
        │            status moderasi hidup (poll), "coba lagi" untuk yang ditolak
        ├─ TAKSONOMI (baru) sunting kategori/genre; hapus ditolak kalau dipakai
        └─ GRANT    (yang ada) — §3f
```

Header: badge `SIAP` hanya kalau API key ada di keychain DAN creator id terisi;
`UI ONLY` diganti `BELUM ADA API KEY` yang menunjuk ke panel target — badge yang
menyebut penyebabnya, bukan keadaannya.

### d) Yang dikirim ke Roblox

`name`, `description` (+ baris `Genre: <kategori> / <genre>` kalau opsi hidup),
`creator`. Tidak lebih. Sesudah `Approved`: baris `roblox_upload` diperbarui
(`asset_id`, `approved_at`) — itu yang menggantikan `grantApi.recordAsset`.

### e) Command Tauri Roblox

| Command | Isi |
|---|---|
| `roblox_taxonomy_list/upsert_category/upsert_genre/delete_*` | §1d |
| `roblox_queue_list/put/remove` | antrean (draft/queued/uploading/processing) |
| `roblox_upload_start(uploadId)` | baca `tracks/<hash>`, kirim multipart, simpan `operation_id`; event progres §1e |
| `roblox_operation_poll(uploadId)` | `GET operations/{id}` → perbarui status |
| `roblox_catalog_list(filter)` | `done`/`failed`, dikelompokkan di TS |
| `roblox_target_get/set` | creator kind/id di `setting`; API key lewat `secret_*` |

`runner.ts` memakai `createDesktopTransport()` yang memetakan
`send()`/`operation()` ke dua command di atas; `resume()` yang ada memuat
`operation_id` dari tabel, bukan IndexedDB.

### f) Grant Access

Hari ini ia memakai Worker kepustakaan (butuh sesi) untuk katalog asset, daftar
experience (`games.roblox.com`), resolve place, dan grant (`apis.roblox.com`).
Semua panggilan itu bisa dilakukan Rust langsung, dengan cookie Roblox di
keychain. Tapi ia fitur terpisah dengan API tidak resmi (`itemconfiguration`,
cookie `.ROBLOSECURITY`), jadi dinyatakan **fase terakhir (R5)** dan sampai
saat itu tab GRANT di desktop berkata "belum tersedia di versi desktop" —
kalimat yang sama dengan kepustakaan di PR #46. Katalog lokal (§3a) sudah
memberi sebagian nilainya (daftar asset + assetId) tanpa cookie sama sekali.

---

## 4. Fase kerja

Prasyarat: PR #44, #46, #47 sudah di-merge (docs/20 wave 1).

| Fase | Isi | Done |
|---|---|---|
| **K0 — Fondasi** | `rusqlite` + skema §2b + migrasi; `tracks/` store; `SecretStore`; `store_info/relocate`; command `library_*`; generate tipe TS; tes §2d | `cargo test -p daw-desktop-host` mencakup semua butir §2d; `store_relocate` ke folder lain lalu buka app → kepustakaan utuh |
| **K1 — Dock lokal** | `createLocalLibraryApi`; `getPlatformHost().libraryApi()` memilih lokal di desktop; dock berstatus `masuk`/LOKAL tanpa MASUK/KELUAR; `library_import_path` dari drop Finder | Drop 3 lagu dari Finder → muncul di dock tanpa byte lewat IPC (diukur); tutup-buka app → masih ada; klik lagu → mendarat di lane |
| **K2 — Project & marks lokal** | simpan/buka/hapus project, `markSaved` (PR #45 butir 1), cue+grid | Simpan → tutup app → buka → timeline identik termasuk FX; hot cue di `/dj` bertahan; hapus lagu yang dipakai project ditolak menyebut namanya |
| **K3 — Pengaturan & ukuran** | panel "Folder kepustakaan": path, ukuran, pindahkan; peringatan disk penuh saat import | Pindahkan folder → tidak ada lagu yang hilang; import saat disk sisa < ukuran berkas → ditolak sebelum menyalin |
| **R1 — Taksonomi** | tabel + command + tab TAKSONOMI + seed bawaan | Tambah/ganti nama/pindah genre; hapus genre yang dipakai → ditolak menyebut jumlah |
| **R2 — Antrean berkategori** | `QueueItem.categoryId/genreId`, `violationsOf`, kolom di QueueRow/DetailPanel, pilihan massal, antrean di SQLite (desktop) di balik `PersistenceAdapter` | Baris tanpa genre tidak bisa diunggah dan alasannya tertulis; pilih 12 baris → satu klik memberi genre semuanya; tutup app saat draft → draft kembali |
| **R3 — Unggah dari Rust** | `roblox.rs` (port `open-cloud.ts` + tesnya di atas server HTTP lokal), `roblox_upload_start/operation_poll`, `createDesktopTransport`, progres, badge `BELUM ADA API KEY` | Unggah satu MP3 sungguhan → `MODERASI` → `DISETUJUI` dengan `assetId`; tutup app di tengah moderasi → buka → poll lanjut; API key tidak ada di SQLite maupun log (tes grep) |
| **R4 — Katalog** | tab KATALOG: kelompok, hitungan, filter, salin assetId, "coba lagi"; opsi "genre ke deskripsi" | Sesudah 3 unggahan beda genre, tab KATALOG menampilkan 3 kelompok dengan hitungan benar; deskripsi asset di Creator Hub memuat baris Genre bila opsi hidup |
| **R5 — Grant Access lokal** | port `/roblox/*` Worker kepustakaan ke Rust, cookie di keychain | Grant satu asset ke satu universe dari desktop tanpa Worker |

Urutan: K0 → (K1, R1 paralel) → (K2, R2 paralel) → R3 → (K3, R4 paralel) → R5.
K0 adalah gerbang; tidak ada yang mulai sebelum tes §2d hijau.

---

## 5. Utang yang dinyatakan terbuka

- **Dua kepustakaan, satu user.** Web (R2/D1) dan desktop (lokal) tidak saling
  tahu. Sinkronisasi antara keduanya bukan bagian rencana ini, dan menyebutnya
  di UI ("kepustakaan ini hanya di mesin ini") lebih jujur daripada
  menyiratkan bahwa lagu di web akan muncul di desktop.
- **Progres unggah Roblox** (§1e) mungkin kasar di R3.
- **Kuota Roblox** (`quotaLeft`) tidak diketahui tanpa Worker; Open Cloud
  tidak mengumumkannya. Ditampilkan sebagai "—" sampai ada sumber yang benar.
- **Durasi di Rust** (`library_import_path`): K0 memakai `symphonia` (hanya
  probe format: mp3/ogg-vorbis/wav/flac, tanpa decode). Header yang tidak
  terbaca — MP3 tanpa Xing/Info, berkas rusak — menghasilkan `frames`/
  `sampleRate` 0, dan `library_commit` (UPSERT; nol tidak pernah menimpa nilai
  yang sudah diketahui) mengisinya dari probe `<audio>` yang sudah ada.
- **Katalog Roblox ikut hilang bersama lagunya.** `roblox_upload.hash`
  `REFERENCES track ON DELETE CASCADE`: hapus lagu ditolak selama ada unggahan
  yang belum `done`/`failed` (§2b), tapi baris yang SUDAH selesai ikut terhapus
  — assetId-nya tetap ada di Creator Hub, hanya catatannya di mesin ini yang
  hilang. Kalau R4 memutuskan katalog harus bertahan tanpa lagunya, kolom
  `bytes`/`file_name` harus disalin ke `roblox_upload` dan FK-nya dilonggarkan.
- **`roblox_upload.seconds`** ditambahkan di luar daftar kolom §2b: durasi yang
  diukur `<audio>` di TS butuh tempat saat `frames` = 0.
- **Hasil bake/stem** (docs/16 §8e) tetap tanpa berkas asal, tetap tidak masuk
  kepustakaan lokal. Tidak berubah oleh rencana ini.
