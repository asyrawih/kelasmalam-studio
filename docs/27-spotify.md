# Bagian 27 — Spotify: kurasi, metadata, dan satu pemutar referensi

Status: **rencana** (25 September 2026). Client id + client secret sudah
didaftarkan user; belum ada satu baris kode.

Dokumen ini adalah keputusan dan fase, mengikuti bentuk
[docs/23](23-youtube-desktop.md) dan [docs/26](26-vocal-split-mdx.md).

---

## 0. Tiga pertanyaan, tiga jawaban singkat

**"Bisa impor lagu dari Spotify ke lane seperti YouTube dan SoundCloud?"**
Tidak, dan itu bukan soal usaha. Web API Spotify tidak punya endpoint berkas:
yang keluar dari sana hanya metadata. Tidak ada URL stream yang boleh dipakai,
dan `preview_url` 30 detik pun sudah dicabut untuk aplikasi yang didaftarkan
belakangan (§1). Pola "cari → IMPOR → masuk lane" berhenti di sini.

**"Kalau Web Playback SDK? Kita sudah punya kredensialnya."**
Bisa, dan sah — tapi audionya tersegel. SDK memutar lewat elemen audio
ber-DRM miliknya sendiri; tidak ada jalan ke `AudioContext`, jadi tidak ada
EQ, tidak ada FX, tidak ada mix, tidak ada export, tidak ada pisah vokal,
tidak ada unggah ke Roblox. Ia berguna sebagai **pemutar referensi** — satu
tombol dengar sambil menyusun daftar — dan hanya itu. Butuh akun Premium, dan
kemungkinan besar tidak jalan di WebView desktop (§1).

**"Jadi apa isinya?"**
Tiga hal yang semuanya menutup lubang yang sudah ada di repo: **kurasi**
(playlist dan lagu yang disukai user), **metadata** (kolom Artist/Album/Tahun
yang hari ini kosong di browser DJ karena `StudioAsset` tidak punya tag sama
sekali — lihat matriks di `recordbox/00-plan.md`), dan **wantlist** (playlist
Spotify dicocokkan dengan berkas yang SUDAH dimiliki user di kepustakaan).

---

## 1. Fakta yang mengikat

Tabel ini adalah dasar semua keputusan di §2. Baris bertanda **VERIFIKASI**
harus dijawab ulang oleh app id kita sendiri di S0 sebelum fase mana pun
dimulai — status endpoint Spotify berubah per tanggal pendaftaran aplikasi,
dan membangun di atas endpoint mati adalah cara termahal mengetahuinya.

| Fakta | Akibatnya di sini |
|---|---|
| Web API tidak menyediakan berkas audio | Spotify tidak pernah menjadi sumber materi. Tidak ada `importBytesToLane` dari jalur ini |
| `preview_url` dicabut untuk aplikasi baru (sejak 27 Nov 2024) — **VERIFIKASI** | Audisi 30 detik tidak boleh jadi tiang rencana. Kalau ternyata masih ada, ia bonus, bukan fondasi |
| Audio Features (BPM, **KEY**), Audio Analysis, Recommendations, Related Artists ikut dibatasi — **VERIFIKASI** | Kalau hidup: kolom Key di browser DJ (Utang 1 `recordbox/`) lunas hampir gratis. Kalau mati: BPM tetap dari `crates/analysis` (yang lebih benar, karena mengukur berkas user, bukan master Spotify) dan Key tetap terbuka |
| Web Playback SDK: Premium, DRM (EME), output tidak bisa disadap | Pemutar referensi, bukan deck. Dan **web saja**: WKWebView tertanam tidak membawa Widevine, jadi desktop tidak mendapat pemutar ini |
| Kebijakan pengembang melarang download, transcode, sinkronisasi dengan visual, dan pencampuran dengan audio lain | Bukan cuma teknis — pintu ini ditutup dua kali. Tes penjaga di §7 yang menjaganya tetap tertutup |
| Dev Mode dibatasi 25 pengguna sampai Extended Quota disetujui | Gerbang rilis publik, untuk web MAUPUN desktop. Diputuskan sebelum S2 dipromosikan ke user |
| Redirect URI harus cocok persis; `local_server.rs` bind ke **port acak** OS | Desktop tidak bisa memakai `http://127.0.0.1:<port>`. Jalurnya deep link (§2e) |
| COEP `require-corp` di semua origin kita; `credentialless` ditolak karena Safari (`packages/engine/vite/base.ts`) | Cover art `i.scdn.co` diblokir browser kecuali di-proxy sendiri (§2g) |
| Kewajiban atribusi Spotify (logo, nama artis, tautan balik) | Bagian dari UI sejak baris pertama, bukan polish |

---

## 2. Keputusan yang mengikat

### a) Spotify tidak pernah menjadi sumber audio untuk engine

Satu kalimat yang mengikat seluruh dokumen. Tidak ada byte dari Spotify yang
masuk `AudioContext` milik kita, `studio-core/timeline/audio-import`, worker
decode, export, maupun `vocal-split`. Paket `@kelasmalam/spotify` karena itu
**tidak boleh** mengimpor `@kelasmalam/engine` atau jalur impor Studio — dan
itu ditegakkan tes, bukan disiplin (§7).

### b) Yang diambil: metadata dan kurasi

Track (id, judul, artis, album, tahun rilis, durasi, ISRC, cover, URL
Spotify), playlist milik user, lagu yang disukai, dan hasil pencarian. Itu
saja. Kalau S0 membuktikan Audio Features hidup, BPM/key ikut — ditandai
sumbernya, karena angkanya milik master Spotify dan bisa berbeda dari berkas
yang dipegang user.

### c) Jembatan ke kepustakaan adalah WANTLIST, bukan otomatisasi unduhan

Playlist Spotify diimpor sebagai **daftar keinginan**: satu baris per lagu,
masing-masing dicocokkan dengan kepustakaan yang sudah ada (§5). Baris yang
ketemu menunjuk `hash` berkas milik user. Baris yang tidak ketemu berkata
"belum ada di kepustakaan" dan berhenti di situ.

Yang SENGAJA TIDAK dibangun: tombol yang menyuapkan baris kosong ke dialog
YouTube/SoundCloud, apalagi secara massal. Itu mengubah fitur kurasi menjadi
mesin penggandaan playlist, dan itu bukan produk yang sedang kita bangun.
User tetap bisa membuka dialog impor yang sudah ada sendiri, satu per satu,
seperti hari ini.

### d) Metadata mengalir ke ASET, dan ditandai sumbernya

Hasil cocok mengisi kolom Artist/Album/Tahun/cover di browser DJ dan
kepustakaan. Disimpan pada aset (sifat materi sumber, seperti `AssetTempo` di
`studio-core/assets/model.ts`), bukan pada clip maupun deck. Tiap nilai
membawa `source: 'spotify'` supaya bisa dicabut utuh kalau user memutus akun —
metadata yang tidak bisa dicabut adalah metadata yang menyandera.

### e) OAuth: dua platform, dua redirect, satu kontrak

| | Web | Desktop |
|---|---|---|
| Flow | Authorization Code + secret **di Worker** | Authorization Code **+ PKCE**, tanpa secret |
| Redirect | HTTPS ke origin situs, ditukar di Worker | deep link `kelasmalam://spotify/callback` (plugin sudah terpasang, docs/20 §2) |
| Refresh token | sesi Worker, seperti Google (`backend/src/library/oauth.ts`); tidak pernah di browser | `crates/desktop-host/src/secret.rs`, kunci baru `spotify.refresh_token` — pola yang sama dengan rahasia Roblox (docs/21 §1f) |
| Panggilan API | lewat Worker (kuota, token tidak bocor, sekalian proxy gambar) | langsung dari Rust — tanpa CORS, pola `soundcloud.rs` |

`SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` menjadi secret Wrangler di
Worker, bersebelahan dengan `GOOGLE_CLIENT_*` yang sudah ada. Desktop hanya
menerima client id (bukan rahasia; PKCE memang dirancang untuk itu).

### f) Bentuk jawaban Rust = bentuk jawaban Worker

Persis alasan `soundcloud.rs`: sisi TS tidak boleh tahu transportnya berbeda.
Satu tipe `SpotifyApi`, dua implementasi di baliknya, satu suite kontrak yang
dijalankan untuk keduanya — pola `api-contract.ts` kepustakaan (docs/21 §2d).

### g) Semua gambar Spotify lewat proxy kita

COEP `require-corp` memblokir `<img src="https://i.scdn.co/...">` kecuali CDN
Spotify mengirim `Cross-Origin-Resource-Policy`, yang tidak dijamin. Web:
rute proxy di Worker yang menambahkan CORP. Desktop: Rust mengambilnya dan
menyajikannya dari server loopback yang sudah ada. Ini ditemukan di meja,
bukan di mesin user — docs/16 §5a sudah menabrak hal yang sama untuk audio.

### h) Pemutar referensi (Web Playback SDK) adalah fase paling akhir, dan web saja

Ia butuh Premium, butuh SDK pihak ketiga di halaman, dan memberi nol manfaat
pada engine. Ditaruh di S5 supaya S1–S4 (yang berguna untuk semua user,
Premium atau bukan) tidak menunggunya. Di UI ia harus terbaca sebagai pemutar
Spotify yang terpisah — bukan deck ketiga, bukan lane.

### i) Atribusi bukan polish

Logo Spotify, nama artis, dan tautan "Buka di Spotify" pada tiap baris, sejak
S2. Ini syarat pemakaian API-nya, dan menambahkannya belakangan berarti
merombak tiap komponen daftar.

---

## 3. Alur produk

```
  Login Spotify ──► PLAYLIST / DISUKAI / CARI
                          │
                          ├──► "Impor sebagai wantlist"
                          │         │
                          │         ├── cocok  → baris menunjuk hash di kepustakaan
                          │         │            + metadata mengalir ke aset
                          │         └── tidak  → "belum ada di kepustakaan"
                          │
                          └──► "Buka di Spotify" / ▶ pemutar referensi (S5, web, Premium)
```

Pencocokan dikerjakan sekali saat impor dan bisa dijalankan ulang: kepustakaan
bertambah, dan baris yang dulu kosong bisa terisi tanpa impor ulang playlist.

---

## 4. Struktur kode

```
packages/spotify/src/spotify/
  api.ts             kontrak + tipe (cermin bentuk jawaban Worker)
  api-contract.ts    suite kontrak, dijalankan untuk dua transport
  auth.ts            PKCE (desktop) + penukaran kode (web)
  SpotifyDialog.tsx  CARI / PLAYLIST / DISUKAI  — atribusi di tiap baris
  wantlist.ts        model + pencocokan ke kepustakaan
  match.ts           aturan cocok (§5) — murni, tanpa jaringan, mudah diuji
  ReferencePlayer.tsx  (S5, web saja)

backend/src/spotify/
  worker.ts          /v1/auth/*, /v1/search, /v1/playlists, /v1/img
  oauth.ts           tukar code, refresh, simpan di sesi

crates/desktop-host/src/
  spotify.rs         klien API + PKCE, cermin bentuk jawaban Worker
  secret.rs          + SecretKey::SpotifyRefreshToken
```

Paket baru, bukan tambahan di `library`: kepustakaan adalah penyimpanan milik
user, Spotify adalah sumber luar. Menggabungkannya membuat kepustakaan tidak
bisa dipahami tanpa akun Spotify.

---

## 5. Model data

**Satu baris wantlist** (disimpan di D1 untuk web, `library.sqlite` untuk
desktop — dua adapter, satu bentuk, seperti `QueuePersistence` Roblox):

| Field | Isi |
|---|---|
| `spotifyId` | identitas baris; sekaligus kunci dedup |
| `title`, `artists`, `album`, `year`, `durationMs`, `isrc` | apa adanya dari API |
| `artworkId` | id gambar yang sudah di-proxy (§2g), bukan URL `i.scdn.co` |
| `matchedHash` | `hash` berkas di kepustakaan, atau `null` |
| `matchConfidence` | `exact` \| `kuat` \| `lemah` \| `tidak` |

**Aturan cocok** (`match.ts`, murni dan berurutan — berhenti di yang pertama
kena):

1. **ISRC** sama → `exact`. Ini satu-satunya identitas rekaman yang benar.
2. Judul + artis ternormalisasi sama **dan** durasi beda < 2 detik → `kuat`.
3. Judul ternormalisasi sama, durasi beda < 5 detik → `lemah`, ditandai di UI
   dan bisa dibatalkan user.
4. Sisanya `tidak`.

Normalisasi: huruf kecil, buang tanda baca, buang kurung penanda versi
(`(Remastered 2011)`, `- Radio Edit`), rapikan spasi. Remix dan edit yang
berbeda durasinya JATUH ke `lemah` dengan sengaja — dua versi lagu yang sama
adalah dua berkas berbeda untuk DJ, dan menebak di sini merusak crate.

---

## 6. Fase

### S0 — Gerbang: apa yang benar-benar hidup untuk app id kita (setengah hari)

Jalankan sendiri dengan kredensial yang sudah didaftarkan:

- token Client Credentials → berhasil?
- `GET /v1/audio-features/{id}` → `200` atau `403`?
- `GET /v1/tracks/{id}` → apakah `preview_url` berisi?
- status kuota aplikasi: Dev Mode (25 user) atau Extended?

**Keluaran:** tabel §1 diperbarui dengan jawaban nyata + tanggal. Fase lain
tidak dimulai sebelum ini terisi; §1 mencatat kenapa.

### S1 — Metadata tanpa login (1 hari)

Client Credentials di Worker + `spotify.rs`; `search` dan `track`. Belum ada
UI selain satu halaman uji. Yang dibuktikan: dua transport menjawab bentuk
yang sama (suite kontrak hijau untuk keduanya).

### S2 — Login user + dialog kurasi (2 hari)

OAuth dua platform (§2e), penyimpanan token, `me()`, playlist, lagu disukai,
proxy gambar (§2g), atribusi (§2i). Dialog `SpotifyDialog` masuk sebagai
`extras` Studio — persis pintu yang dipakai SoundCloud dan YouTube, jadi
tidak ada cabang baru di shell mana pun.

### S3 — Wantlist + pencocokan (2 hari)

Model §5, dua adapter persistensi, `match.ts`, tombol "impor sebagai
wantlist", dan "cocokkan ulang". Tanpa metadata mengalir ke aset — itu S4.

### S4 — Metadata ke aset + kolom browser DJ (1–2 hari)

Artist/Album/Tahun/cover pada aset yang sudah cocok, kolom baru di
`CollectionBrowser`, dan pencabutan penuh saat akun diputus (§2d). Kalau S0
menjawab Audio Features hidup: kolom **Key** ikut di sini, dan Utang 1
`recordbox/` ditutup dengan catatan sumbernya.

### S5 — Pemutar referensi (1 hari, web saja, opsional)

Web Playback SDK di belakang gerbang Premium, terpisah jelas dari deck.
Tidak dikerjakan sebelum S1–S4 berdiri.

---

## 7. Tes

Selain suite kontrak dan tes unit `match.ts` (yang murni, jadi murah dan
banyak), ada **satu tes penjaga yang lebih penting daripada sisanya**, bergaya
`no-web-leak.test.ts`:

> `packages/spotify/src` tidak boleh mengandung impor ke `@kelasmalam/engine`,
> ke jalur impor/decode `studio-core`, maupun ke `vocal-split` — dan tidak
> boleh menyebut `preview_url` di luar tipe. Kalau suatu hari ada yang
> mencoba menyambungkan audio Spotify ke engine, tes ini yang merah lebih
> dulu, dengan kalimat yang menyebut alasannya (§2a).

Ditambah: token tidak pernah muncul di `Debug`/log (cermin tes `secret.rs`),
dan `?state=` OAuth diverifikasi (CSRF) di kedua platform.

---

## 8. Utang yang dinyatakan terbuka

1. **Extended Quota.** 25 user cukup untuk mencoba, tidak cukup untuk rilis.
   Pengajuannya perlu menjelaskan bahwa aplikasi ini TIDAK mengunduh — dan
   §2a plus tes §7 adalah bukti yang bisa ditunjukkan.
2. **Wantlist milik siapa.** Berdiri sendiri (seperti sekarang di §5) atau
   ikut project? Diputuskan sebelum S3 menulis migrasi.
3. **Key dari Spotify vs dari analisis sendiri.** Kalau S0 menjawab "hidup",
   kita punya angka gratis yang kadang salah untuk berkas user. Deteksi key
   sendiri tetap utang terbuka `recordbox/`; Spotify hanya menundanya.
4. **Playback SDK di desktop.** Diasumsikan tidak jalan (§1). Kalau suatu
   hari WebView-nya membawa EME, keputusan §2h ditinjau ulang — bukan
   sebaliknya.
