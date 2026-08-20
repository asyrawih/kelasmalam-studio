# Kepustakaan & Collections

Rencana untuk penyimpanan yang menggantikan IndexedDB: satu kepustakaan milik
user, di-upload atas **perintahnya**, dipakai bersama oleh `/studio` dan `/dj`.

Dokumen ini adalah keputusan + fase kerja, bukan tutorial. Yang tidak diputuskan
di sini dinyatakan terbuka di §8, bukan disembunyikan.

> **Status per 2026-08-21.** L0–L7 sudah ada, sisi server MAUPUN sisi web.
> Server: `backend/`, Worker `dawonweb-library`, seluruh permukaan §4, skema §3,
> ketiga jebakan §5. Web: `web/src/library/` — dok kepustakaan, unggah saat
> import, unduh sesuai permintaan, simpan/buka project, cue+grid tersinkron,
> dan hapus. Catatan pelaksanaan di `backend/README.md`; cara memasangnya di
> `docs/18-deploy-backend.md`.
>
> Yang MASIH terbuka ada di §8 dan tidak berkurang: pembersih objek yatim
> (§8d), multipart > 100 MB (§5c), nasib hasil bake (§8e), pengukuran biaya
> unduh-ulang (§8b), dan `buildEnvelope` yang memblokir main thread (§8a).

---

## 0. Dari mana kita mulai

Dua pembongkaran sudah terjadi, dan keduanya disengaja:

| | Apa yang dibuang | Kenapa |
|---|---|---|
| PR #16 | Autosave Studio + pemulihan saat boot | Tiap perubahan state membaca ulang byte terenkode SELURUH asset. Dengan lagu 27 menit, itu puluhan MB per gerakan tangan |
| PR ini | Seluruh lapisan IndexedDB (`persist/db.ts`, autosave sesi DJ, `saveAsset` di jalur import dan bake) | Penyimpanan yang tidak pernah diminta user dan tidak pernah bisa ia lihat, kelola, atau pindahkan |

Keadaan sekarang, dan harus disebut terang-terangan: **lagu, cue DJ, posisi
mixer, project Studio, dan hasil bake hidup selama sesi.** Refresh mengosongkan
semuanya. Itu bukan regresi yang menunggu perbaikan — itu ruang kosong yang
dokumen ini isi.

Yang **tidak** ikut dibuang, karena ia bentuk data dan bukan tempat penyimpanan:

- `serialize` / `deserialize` / `normalizeLanes` — bentuk project Studio
- `restoreProject(json, assets, decodeAsset)` — sekarang menerima byte dari
  pemanggil, jadi sumbernya bisa apa saja
- `decodeStoredAsset` — "byte → asset terdaftar + PCM ter-cache", tanpa pendapat
  soal asal byte-nya
- `assetsInUse` + `asset-roots.ts` — "lagu mana yang masih dipakai". Dulu
  pertanyaan pemangkas; sekarang pertanyaan **jalur upload**, persis sama

Jalur di §6 dibangun di atas kelima fungsi itu. Tidak ada yang perlu ditulis
ulang dari nol.

---

## 1. Empat keputusan yang mengikat

### a) Cloudflare Workers + R2 + D1

Frontend tetap di Vercel; API berdiri sendiri sebagai Worker.

Alasannya bukan preferensi platform melainkan **jumlah kredensial**: Worker
mengakses R2 lewat binding, bukan lewat kunci S3 yang harus disimpan, dirotasi,
dan tidak boleh bocor. R2 juga tidak menagih egress — dan §1d membuat aplikasi
ini mengunduh lagu yang sama berulang kali, jadi egress adalah biaya yang
paling mudah membengkak diam-diam.

**Yang diterima:** frontend dan API beda origin. Konsekuensinya nyata dan ada di
§5 — bukan detail konfigurasi.

> **Koreksi saat pelaksanaan.** "Tanpa kunci S3" ternyata tidak bisa berdiri
> bersama §5c: menandatangani presigned PUT MEMBUTUHKAN kunci S3. Yang menang
> §5c, karena batasnya keras (badan permintaan Worker 100 MB; WAV 27 menit
> ~285 MB). Kalimat di atas dilunakkan jadi: **satu pasang kunci, dipakai hanya
> untuk menandatangani upload; seluruh pembacaan tetap lewat binding.** Ini
> ketegangan yang ada di rencana sejak awal, bukan yang muncul belakangan —
> dicatat di sini supaya tidak ditemukan ulang.

### b) Google OAuth

Authorization code + PKCE, `client_secret` hanya ada di Worker.

**Yang diterima:** satu ketergantungan ke Google, dan satu layar consent sebelum
user bisa menyimpan apa pun. Sebagai gantinya tidak ada password yang harus
di-hash, tidak ada alur reset, dan tidak ada email yang harus terkirim.

### c) Lagu DAN project sekaligus di v1

Bukan lagu dulu lalu project menyusul.

Ini pilihan yang lebih lebar, dan alasannya masuk akal: project **merujuk**
lagu, jadi mengirim project tanpa kepustakaan lagu tetap memaksa upload byte-nya
juga. Memisahkannya menghasilkan dua jalur upload yang harus digabung lagi
kemudian.

**Yang diterima:** versi project, konflik antar tab, dan asset yang hilang harus
punya jawaban di v1 — bukan ditunda. §8 mencatat yang mana saja.

### d) Tanpa cache lokal — lagu diunduh ulang tiap sesi

Tidak ada IndexedDB, tidak ada localStorage untuk audio, dan **tidak ada OPFS
untuk kepustakaan**.

Satu sumber kebenaran, tidak ada salinan yang bisa basi, dan tidak ada
penyimpanan diam-diam di mesin user — persis cacat yang baru saja dibuang.

**Yang diterima, dan ini yang paling mahal:** membuka `/dj` berarti menunggu
unduhan. Lagu 27 menit ~25 MB pada koneksi 20 Mbps ≈ 10 detik, **ditambah**
decode dan `buildEnvelope` yang saat ini memblokir main thread ~1.024 ms per
lagu sepanjang itu (utang dari PR #16, lihat §8a). Angka itu harus diukur dengan
lagu sungguhan sebelum diklaim baik-baik saja.

> Catatan yang gampang tertukar: rencana OPFS di
> [docs/06 §"Asset pool: refcount, eviction, OPFS"](06-timeline-clips.md) **bukan** cache
> kepustakaan. Itu mekanisme *paging PCM* untuk muat lebih dari ~1,2 GiB audio
> di WASM memory — soal RAM, bukan soal daya tahan. Kalau ia jadi dibangun,
> isinya adalah scratch yang boleh dihapus kapan saja, bukan salinan
> kepustakaan. Perbedaan itu harus dijaga di kode, bukan hanya di dokumen.

---

## 2. Identitas asset: content hash, bukan nomor sesi

Ini masalah paling sentral, dan sebagian jawabannya sudah tertulis di repo.

Sekarang `assetId` adalah **penghitung sesi** (`studioActions.newAssetId()`).
Nomor 3 hari ini dan nomor 3 besok adalah lagu yang berbeda. Project yang
menyimpan `assetId: 3` karena itu tidak berarti apa-apa setelah refresh — dan
lebih buruk dari tidak berarti: ia menunjuk lagu yang SALAH tanpa satu pun tanda.

`schema/project.schema.json` sudah memutuskan bentuk yang benar: `AssetRef`
punya `id` **dan** `content_hash`, dengan catatan "dua import file yang sama
menghasilkan SATU asset — deduplikasi terjadi di sini".

**Rencananya mengikuti pemisahan itu, tidak menggantinya:**

| | Dipakai untuk | Umur |
|---|---|---|
| `assetId: number` | Kunci di store, deck, cue, buffer PCM, riwayat grid | Satu sesi |
| `contentHash: string` | Kunci di R2 dan D1, referensi di project tersimpan | Selamanya |

Peta `hash ↔ assetId` dibangun ulang tiap sesi saat lagu dimuat. Yang berubah di
kode karenanya kecil dan terbatas:

1. `StudioAsset` dapat field `contentHash`
2. Import menghitung hash sebelum decode, dan **melewati decode** kalau hash-nya
   sudah ada di store — dedup yang selama ini hanya rencana
3. `serialize()` menulis `contentHash`, bukan `assetId`, di referensi clip
4. Cue DJ dan `assetGrids` disimpan ke server ber-kunci hash

Yang **tidak** berubah: seluruh kode runtime tetap memakai `assetId` numerik.
Menukar kunci runtime menjadi string hash berarti menyentuh deck, cue, grid,
export payload, dan cache buffer sekaligus — pekerjaan besar tanpa satu pun
manfaat, karena yang butuh stabilitas hanyalah yang tersimpan.

**Algoritmanya: SHA-256 (`crypto.subtle.digest`), hex penuh.** Tanpa dependensi
baru, tanpa menambah permukaan build WASM. Perlu dicatat sebagai utang: Rust
memakai BLAKE3-dipotong-u64. Selama aplikasi web memakai format serialisasinya
sendiri (`persist/persistence.ts`, bukan `Project` milik `timeline-core`),
keduanya tidak pernah bertemu. Saat format Rust menjadi format sungguhan, salah
satunya harus mengalah — dan itu keputusan yang lebih murah diambil nanti
daripada menambah build BLAKE3 ke browser sekarang.

---

## 3. Model data

### R2

```
tracks/<sha256-hex>          byte file ASLI (.mp3/.ogg/.wav apa adanya)
```

Kuncinya hash, **bukan** `<user>/<nama>`. Dua user yang punya lagu sama memakai
satu objek. Konsekuensinya penghapusan tidak boleh menghapus objek begitu saja —
lihat §8d.

Yang **tidak** disimpan, dan alasannya sama seperti dulu: PCM hasil decode dan
peak pyramid. Keduanya puluhan kali lebih besar dari file aslinya dan bisa
dihasilkan ulang. Menyimpan hasil turunan berarti membayar ruang untuk sesuatu
yang bisa dihitung, dan menambah satu bentuk data lagi yang bisa basi terhadap
perbaikan algoritma.

### D1

```sql
user      (id, google_sub UNIQUE, email, name, created_at)
track     (hash, user_id, name, bytes, mime, frames, sample_rate,
           created_at, PRIMARY KEY (hash, user_id))
marks     (hash, user_id, json, updated_at)   -- cue DJ + grid/BPM override
project   (id, user_id, name, json, updated_at, version)
```

Tiga hal yang sengaja begitu:

- **`track` ber-PK gabungan `(hash, user_id)`.** Baris adalah "user ini punya
  lagu ini", bukan "lagu ini ada". Objek R2-nya satu; klaimnya sebanyak
  user-nya.
- **`marks` terpisah dari `track`.** Cue berubah puluhan kali per sesi, metadata
  lagu tidak pernah berubah. Menyatukannya berarti menulis ulang baris metadata
  tiap kali user menekan hot cue.
- **`project.json` sebagai TEXT, bukan tabel ternormalisasi.** Bentuknya sudah
  dijaga `serialize`/`deserialize` di sisi web, lengkap dengan `SCHEMA_VERSION`
  dan aturan default-nya. Menormalisasikannya ke D1 berarti bentuk yang sama
  dijaga di dua tempat, dan yang satu pasti tertinggal.

---

## 4. Permukaan API

| Metode | Rute | Isi |
|---|---|---|
| `GET` | `/auth/google` | Redirect ke consent (PKCE) |
| `GET` | `/auth/callback` | Tukar code → sesi, set cookie, redirect balik ke app |
| `POST` | `/auth/logout` | Cabut sesi |
| `GET` | `/me` | `{ id, email, name }` atau 401 |
| `GET` | `/tracks` | Daftar kepustakaan: hash, nama, frames, sampleRate, marks |
| `POST` | `/tracks/init` | `{hash,name,bytes,mime}` → `{exists:true}` **atau** `{uploadUrl}` |
| `POST` | `/tracks/commit` | Upload selesai → tulis baris `track` |
| `GET` | `/tracks/:hash/blob` | Byte-nya (lihat §5a — ini tidak boleh presigned) |
| `PUT` | `/tracks/:hash/marks` | Cue + grid |
| `DELETE` | `/tracks/:hash` | Lepas klaim user ini (§8d) |
| `GET` | `/projects` | Daftar project |
| `GET` | `/projects/:id` | `{json, version}` |
| `POST` | `/projects` | Simpan baru |
| `PUT` | `/projects/:id` | Simpan (`If-Match: version`, lihat §8c) |

`/tracks/init` yang menjawab `{exists:true}` adalah inti dedup: **file yang
sudah ada di R2 tidak pernah di-upload ulang**, oleh user mana pun. Import lagu
yang sudah pernah dikirim orang lain selesai tanpa satu byte pun naik.

---

## 5. Tiga jebakan yang harus diputuskan SEKARANG

Ketiganya lahir dari §1a (beda origin) dan dari sifat aplikasi ini. Menemukannya
belakangan berarti membongkar jalur yang sudah jadi.

### a) COEP `require-corp` memblokir audio dari origin lain

Aplikasi ini berjalan dengan `Cross-Origin-Embedder-Policy: require-corp` —
prasyarat `crossOriginIsolated`, yang prasyarat `SharedArrayBuffer`, yang
prasyarat seluruh engine. Tidak bisa ditawar.

Akibatnya: **presigned URL R2 tidak bisa dipakai untuk mengunduh.** Respons R2
tidak membawa `Cross-Origin-Resource-Policy: cross-origin`, jadi `fetch`-nya
ditolak browser — dan pesan errornya tidak menyebut CORP sama sekali.

Karena itu `GET /tracks/:hash/blob` **melewati Worker**, yang menyalin isi objek
R2 dan menambahkan `Cross-Origin-Resource-Policy: cross-origin` plus header
CORS. Worker mem-*stream*, tidak menyangga di memori.

> **Asimetri yang disengaja:** upload TETAP presigned langsung ke R2 (§5c),
> unduhan lewat Worker. Yang satu tidak butuh header di respons, yang satu
> butuh.

### b) Cookie sesi harus SAMA-SITE, bukan sekadar HTTPS

App di Vercel + API di Worker = beda origin. Kalau juga beda *registrable
domain*, cookie sesi harus `SameSite=None`, dan itu berarti bergantung pada
cookie pihak ketiga — yang sudah diblokir Safari dan sedang dimatikan Chrome.

**Karena itu: API harus di subdomain domain yang sama dengan app** (mis.
`app.contoh.com` + `api.contoh.com`). Keduanya beda origin tapi **same-site**,
jadi `SameSite=Lax` bekerja dan tidak ada yang bergantung pada cookie yang
sedang punah.

Ini keputusan **domain**, bukan keputusan kode, dan harus diambil sebelum L2 —
mengubahnya setelah alur OAuth jadi berarti mengganti redirect URI, cookie
domain, dan konfigurasi CORS sekaligus.

### c) Worker tidak boleh jadi pipa untuk upload

Request body Worker dibatasi (~100 MB; **verifikasi terhadap paket yang
dipakai**), dan lagu WAV panjang bisa melewatinya. Lebih penting: menyalurkan
puluhan MB lewat Worker berarti membayar CPU-time untuk pekerjaan yang tidak
melakukan apa-apa.

Upload karena itu **langsung ke R2** lewat presigned PUT dari browser; Worker
hanya menandatangani dan mencatat. Untuk berkas di atas ~100 MB, multipart lewat
S3 API — ditunda sampai ada berkas sungguhan yang membutuhkannya, dan sampai
saat itu `/tracks/init` **menolak** dengan alasan yang jelas, bukan gagal di
tengah upload.

---

## 6. Alur

```
IMPORT (dan ini yang berubah dari sekarang)
  file → SHA-256 → hash sudah ada di store?  ── ya ──► pakai assetId yang ada,
      │                                                 SELESAI (tanpa decode)
      └─ tidak ─► sniff → decode → envelope → registerAsset → requestAssetTempo
                    │
                    └─► POST /tracks/init
                          ├─ {exists:true} ─────────────► catat, selesai
                          └─ {uploadUrl} → PUT ke R2 → POST /tracks/commit

BOOT /dj atau /studio
  GET /me ── 401 ──► kepustakaan kosong + ajakan login. Aplikasi tetap jalan
                     penuh: import lokal, deck, mixer, export — semua hidup
                     tanpa akun. Yang tidak ada hanyalah daya tahan.
       └─ 200 ──► GET /tracks → daftar tampil SEGERA (nama, BPM, durasi)
                     │           dari metadata; belum ada audio
                     └─► unduh per lagu SESUAI PERMINTAAN, bukan semuanya

SIMPAN PROJECT (eksplisit, atas perintah user)
  assetsInUse(state) → pastikan tiap hash sudah ter-commit → PUT /projects/:id
```

Baris terakhir alur boot adalah keputusan, bukan detail: `loadLibraryIntoStore`
yang lama mengunduh **dan men-decode seluruh kepustakaan** saat mount. Dengan
§1d itu berarti puluhan MB dan belasan detik sebelum satu tombol pun bisa
ditekan. Daftar datang dari metadata; audionya menyusul saat lagunya benar-benar
dipakai — ditaruh di deck, atau ditaruh di lane.

---

## 7. Fase kerja

Tiap fase punya "done" yang bisa dilihat atau dites. Fase yang tidak bisa
dibuktikan begitu berarti belum cukup sempit.

| | Isi | Done |
|---|---|---|
| **L0** | `contentHash` di `StudioAsset`; hash dihitung saat import; dedup di store | Import file yang sama dua kali → **satu** baris di Collection, decode kedua tidak pernah jalan |
| **L1** | `serialize` menulis hash; cue + `assetGrids` ber-kunci hash | Round-trip `serialize`→`deserialize` mempertahankan referensi lewat hash; tes murni, tanpa jaringan |
| **L2** | Worker + D1 + Google OAuth + `/me`; domain diputuskan (§5b) | Buka app → login → nama user di topbar; refresh tetap login |
| **L3** | `/tracks/init` + presigned PUT + `/tracks/commit`; `exists` → tanpa upload | Import lagu → ada di R2 → import lagu SAMA di tab lain → nol byte naik |
| **L4** | `GET /tracks` + `/tracks/:hash/blob` lewat Worker (§5a); unduh sesuai permintaan + bar progres | Refresh `/dj` → Collection terisi dari server; klik lagu → mendarat di deck dengan waveform benar |
| **L5** | `/tracks/:hash/marks` | Set hot cue → refresh → cue-nya ada. Grid hasil suntingan juga |
| **L6** | Simpan/buka project; menolak simpan kalau ada asset yang belum ter-commit | Simpan → refresh → Buka → timeline identik, termasuk fade dan chain FX |
| **L7** | Hapus lagu (refcount, §8d), hapus project, kuota per user | Hapus lagu yang dipakai project → **ditolak** dengan menyebut project mana |

**Kedelapan fase sudah terpasang**, server maupun web:

| | Sisi server | Sisi web |
|---|---|---|
| L0 | — | `timeline/content-hash.ts`, dedup di `importBytesToAsset` |
| L1 | — | `persist/persistence.ts`: clip membawa hash, `relinkLanes` |
| L2 | `library/oauth.ts`, `session.ts` | dok: MASUK/KELUAR, badge status |
| L3 | `/tracks/init`+`commit`, `presign.ts` | `library/upload.ts` + `import-sink` |
| L4 | `/tracks`, `/tracks/:hash/blob` | `load-track.ts`, bar progres di dok |
| L5 | `/tracks/:hash/marks` | `library/marks.ts` |
| L6 | `/projects*` + If-Match | tab PROJECT di dok |
| L7 | `DELETE` keduanya | tombol HAPUS di kedua tab |

D1 diuji di atas SQLite sungguhan, jadi "user A tidak melihat kepustakaan user
B" dan "yang kalah versi diberi tahu" adalah hal yang dibuktikan, bukan
diasumsikan.

L0 dan L1 tidak butuh backend sama sekali. Keduanya bisa dikerjakan, di-review,
dan di-merge sebelum satu baris Worker pun ditulis — dan keduanya berdiri
sendiri sebagai perbaikan (dedup import adalah fitur yang berguna hari ini juga).

---

## 8. Utang yang dinyatakan terbuka

### a) `buildEnvelope` memblokir main thread

~1.024 ms untuk lagu 27 menit (diukur di PR #16). Selama ini biayanya dibayar
sekali saat import. Dengan §1d ia dibayar **tiap sesi, tiap lagu yang dibuka**.
Pemindahannya ke worker naik dari "enak dimiliki" menjadi prasyarat L4 yang
layak dipakai.

### b) Biaya "unduh ulang tiap sesi" belum diukur

§1d diterima berdasarkan alasan, bukan angka. Sebelum L4 ditutup: ukur waktu
dari boot sampai lagu 27 menit siap diputar, di koneksi yang wajar. Kalau
angkanya tidak bisa diterima, yang berubah bukan keputusan penyimpanannya
melainkan **kapan** unduhan dimulai (prefetch lagu yang terakhir dipakai) — dan
cache eksplisit kembali ke meja sebagai fitur yang terlihat, bukan sebagai efek
samping.

### c) Konflik: dua tab, satu project

§1c memasukkan project ke v1, jadi ini tidak bisa ditunda. Rencananya paling
sederhana yang jujur: `version` naik tiap simpan, `PUT` dengan `If-Match`, dan
kalah berarti **user diberi tahu** ("project ini sudah berubah di tempat lain"),
bukan tulisannya dibuang diam-diam. Merge otomatis tidak ada dan tidak
direncanakan.

### d) Penghapusan di bawah dedup

Objek R2 dipakai banyak user (§3). `DELETE /tracks/:hash` karena itu menghapus
**klaim**, bukan objek. Objek yatim dibersihkan terpisah, dan pembersih itu
harus menghitung dengan benar — kesalahannya berbentuk audio user lain yang
hilang, kelas bug yang persis sama dengan yang membuat `asset-roots.ts` ada.
Sampai pembersih itu ada dan teruji, objek yatim **dibiarkan**. Membayar
penyimpanan lebih murah daripada menghapus milik orang.

### e) Hasil bake dan stem

`bakeClipStem` menghasilkan asset yang tidak punya file asal. Ia harus di-encode
(WAV float32 — kodenya baru saja dibuang bersama `saveAsset` dan perlu
dikembalikan) lalu di-upload seperti lagu biasa, atau dinyatakan **fana**
seperti sekarang. Keputusannya belum diambil; yang tidak boleh terjadi adalah
project tersimpan yang merujuk asset hasil bake yang tidak ada di mana pun.

### f) Kuota

Belum ada. Satu user dengan seratus lagu WAV bisa menghabiskan tier gratis R2
sendirian. Batas per user ditegakkan di `/tracks/init` — tempat yang tahu ukuran
berkas **sebelum** byte-nya naik.
