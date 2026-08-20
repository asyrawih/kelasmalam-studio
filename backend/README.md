# backend — dua Cloudflare Worker

| Worker | Isi | Config | Dokumen |
| --- | --- | --- | --- |
| `dawonweb-roblox` | unggah asset audio ke Roblox Open Cloud | `wrangler.roblox.toml` | `docs/17-roblox-upload.md` |
| `dawonweb-library` | kepustakaan user: lagu, cue, project (R2 + D1) | `wrangler.library.toml` | `docs/16-kepustakaan.md` |

**Deploy-nya terpisah, dengan sengaja.** Umur datanya berbeda — yang satu tidak
menyimpan apa pun, yang satu memegang seluruh kepustakaan user — dan satu deploy
yang salah tidak boleh menjatuhkan dua-duanya. Yang dibagi hanyalah tooling
(tsconfig, vitest, lockfile) dan `src/http/cors.ts`.

```
src/
  http/cors.ts        dipakai berdua
  roblox/             worker.ts + open-cloud.ts + upload-request.ts + limits.ts
  library/            worker.ts + store.ts + oauth.ts + session.ts + presign.ts
  test-support/       D1 di atas node:sqlite, R2 palsu
migrations/           skema D1 kepustakaan
```

---

# Worker Roblox

Meneruskan satu berkas audio ke [Roblox Open
Cloud](https://create.roblox.com/docs/cloud/guides/usage-assets) dan melaporkan
status moderasinya. Dipakai oleh halaman `/roblox` (`web/src/roblox`).

Ia **tidak menyimpan apa pun**: bukan berkasnya, bukan API key-nya, bukan
riwayatnya.

## Kenapa ada Worker sama sekali

Dua alasan, dan keduanya mengikat:

1. **`apis.roblox.com` tidak mengirim header CORS.** Panggilan dari halaman
   diblokir browser sebelum berangkat, seberapa benar pun multipart-nya disusun.
2. **API key Open Cloud tidak punya bentuk yang aman di halaman.** Ia bisa
   membuat asset atas nama pemiliknya tanpa batas.

## API

| Endpoint | Kegunaan |
| --- | --- |
| `GET /health` | probe kesiapan; UI memakainya untuk badge `SIAP` / `UI ONLY` |
| `POST /roblox/uploads` | kirim satu berkas — `202` + `operationId` |
| `GET /roblox/operations/{id}` | `{ done, assetId }` |

`POST /roblox/uploads` adalah `multipart/form-data`:

| Bagian | Isi |
| --- | --- |
| `file` | berkas audio (MP3/OGG, ≤ 20 MB) |
| `name` | nama asset (≤ 50 karakter) |
| `description` | deskripsi (≤ 1000 karakter) |
| `creatorKind` | `user` atau `group` |
| `creatorId` | angka |

Semua endpoint kecuali `/health` butuh header **`x-roblox-api-key`**.

Kegagalan selalu berbentuk `{ code, message }`, dan `message` ditulis untuk
dibaca user — bukan `"Bad Request"`.

## Kunci

Kunci datang dari **user**, per permintaan, lalu hilang bersama permintaannya.
Tidak ada `wrangler secret` untuk ini, dan itu keputusan sadar: satu kunci milik
server akan membuat Worker ini mengunggah atas nama SATU akun untuk siapa pun
yang bisa memanggilnya — sekaligus menjadikannya lumbung kredensial yang layak
dicuri. Dengan kunci milik pemanggil, yang bisa disalahgunakan hanyalah
bandwidth kami.

Konsekuensinya jujur: `ALLOWED_ORIGINS` **bukan** batas keamanan (`Origin` bisa
dipalsukan di luar browser). Ia hanya mencegah halaman orang lain memakai Worker
ini dari browser korban. Kalau suatu saat butuh batas sungguhan, jawabannya
autentikasi — bukan mengetatkan daftar origin.

## Menjalankan

```bash
cd backend
npm ci
npm test              # 86 tes; tanpa jaringan, tanpa Cloudflare
npm run typecheck     # dua tsconfig — lihat catatan di bawah
npm run dev:roblox
npm run deploy:roblox
```

Butuh **Node ≥ 22.5**: tes kepustakaan menjalankan SQL-nya di atas `node:sqlite`.

`npm run typecheck` menjalankan tsc DUA KALI. Kode Worker dinilai tanpa tipe
Node, supaya `Buffer`, `process.env`, dan `require` tidak diam-diam lolos ke
produksi; harness tes dinilai dengan tipe Node, karena ia memang berjalan di
sana.

`wrangler` sengaja tidak ada di `devDependencies`: ia menarik `workerd` dan
`sharp` (puluhan MB) untuk sesuatu yang tidak dipakai saat tes. Script
`dev`/`deploy` memanggilnya lewat `npx` dengan versi terpin.

### Menyambungkan ke UI

Isi `VITE_ROBLOX_API` saat mem-build web:

```bash
VITE_ROBLOX_API=https://dawonweb-roblox.<akun>.workers.dev pnpm -C web dev
```

Tanpa variabel itu halaman `/roblox` tetap berjalan sebagai UI saja — tombol
UNGGAH mati dan badge berkata `UI ONLY`. Tidak ada URL bawaan dengan sengaja:
bawaan yang menunjuk ke mana pun akan membuat build lokal siapa pun mengirim
API key user ke host yang tidak mereka pilih.

Jangan lupa memasukkan origin app ke `ALLOWED_ORIGINS` di `wrangler.roblox.toml`.

## Tiga jebakan pemasangan

1. **Allowlist IP pada API key.** Kunci Open Cloud bisa dibatasi per-IP, dan IP
   keluar Worker tidak tetap. Kunci yang dibatasi akan menjawab `403` yang
   terlihat seperti "izin kurang". Pakai `0.0.0.0/0`, atau jangan pakai Worker.
2. **Izin kunci.** Butuh `asset:write` **untuk pemilik yang bersangkutan** —
   kunci milik akun pribadi tidak bisa mengunggah ke grup kecuali diberi izin
   grup itu.
3. **Kuota Roblox.** 10 unggahan audio per bulan tanpa verifikasi ID, 100 dengan
   verifikasi. Habisnya terlihat sebagai `429`. Tidak ada endpoint yang
   melaporkan sisa kuota, jadi UI menampilkan `—` alih-alih menebak.

## Yang sengaja belum ada

- **Rate limit / autentikasi.** Lihat §Kunci untuk alasannya, dan kenapa itu
  belum jadi lubang. Kalau Worker ini nanti dipakai di luar lingkaran kecil,
  ini yang pertama harus ditambahkan.
- **Retry otomatis.** `429` dan `5xx` dilaporkan apa adanya; yang memutuskan
  mengulang adalah user, lewat tombol ULANGI di antrean. Retry otomatis atas
  kuota bulanan yang habis hanya membakar sisa percobaan.
- **Validasi durasi.** Butuh mendekode audio di Worker. UI sudah mengukurnya
  dengan `<audio>` (gratis), dan Roblox menegakkannya sungguhan.
- **Dukungan WAV/FLAC.** Open Cloud menerimanya untuk asset audio; UI dan Worker
  ini sama-sama membatasi ke MP3/OGG. Kalau mau dibuka, ubah `AUDIO_EXTS` di
  **kedua** sisi — `src/roblox/limits.test.ts` akan merah kalau hanya satu yang
  diubah.


---

# Worker Kepustakaan

Implementasi sisi server `docs/16-kepustakaan.md` — pengganti IndexedDB yang
dibuang di PR #23. Lagu, cue DJ, dan project milik user, di R2 + D1, di-upload
atas **perintahnya**.

## API

| Metode | Rute | Isi |
| --- | --- | --- |
| `GET` | `/health` | probe |
| `GET` | `/auth/google?next=/dj` | redirect ke consent (PKCE) |
| `GET` | `/auth/callback` | tukar code → sesi → kembali ke app |
| `POST` | `/auth/logout` | cabut sesi |
| `GET` | `/me` | `{id,email,name}` atau 401 |
| `GET` | `/tracks` | kepustakaan + marks, sudah terurai |
| `POST` | `/tracks/init` | `{exists:true}` **atau** `{uploadUrl}` |
| `POST` | `/tracks/commit` | catat klaim sesudah upload |
| `GET` | `/tracks/:hash/blob` | byte-nya, lewat Worker |
| `PUT` | `/tracks/:hash/marks` | cue + grid |
| `DELETE` | `/tracks/:hash` | lepas klaim |
| `GET`/`POST` | `/projects` | daftar / simpan baru |
| `GET`/`PUT`/`DELETE` | `/projects/:id` | `PUT` wajib `If-Match: "<versi>"` |

## Empat hal yang paling mudah dikira bug

**1. Upload langsung ke R2, unduhan lewat Worker.** Bukan ketidakkonsistenan.
App berjalan dengan COEP `require-corp` (syarat `SharedArrayBuffer`, syarat
seluruh engine), dan respons R2 tidak membawa
`Cross-Origin-Resource-Policy` — audio yang diunduh langsung darinya DITOLAK
browser, dengan galat yang tidak menyebut CORP sama sekali. Upload tidak punya
masalah itu, dan punya masalah lain: badan permintaan Worker dibatasi 100 MB,
sementara WAV 27 menit ~285 MB.

**2. Kunci S3 R2 tetap ada meski binding R2 juga ada.** `docs/16 §1a` memilih
Workers+R2 justru supaya kunci S3 tidak perlu; `§5c` melarang Worker jadi pipa
upload. Keduanya tidak bisa benar sekaligus — menandatangani presigned URL
BUTUH kunci. Yang menang `§5c`, karena batasnya keras. `§1a` dilunakkan: satu
pasang kunci, dipakai HANYA untuk menandatangani PUT, seluruh pembacaan tetap
lewat binding.

**3. `DELETE /tracks/:hash` tidak menghapus objek R2.** Objeknya ber-kunci hash
dan dipakai bersama antar user (§3); yang dihapus adalah klaim. Objek yatim
dibiarkan sampai ada pembersih yang menghitung dengan benar (§8d) — membayar
penyimpanan lebih murah daripada menghapus milik orang.

**4. `PUT /projects/:id` menolak tanpa `If-Match`** dengan `428`. Simpan tanpa
versi berarti "timpa apa pun yang ada", dan itu persis kejadian yang §8c ingin
cegah: dua tab, yang belakangan menang diam-diam.

## Domain — keputusan yang harus diambil sebelum dipasang

`APP_ORIGIN` dan `API_ORIGIN` **harus subdomain dari domain yang sama**
(`app.contoh.com` + `api.contoh.com`). Kalau beda registrable domain, cookie
sesi terpaksa `SameSite=None` — cookie pihak ketiga, sudah diblokir Safari dan
sedang dimatikan Chrome. Rusaknya senyap: jalan di Chrome hari ini, mati di
Safari. Ini `docs/16 §5b`, dan mengubahnya sesudah alur OAuth jadi berarti
mengganti redirect URI, domain cookie, dan CORS sekaligus.

## Memasang

```bash
cd backend
npx wrangler d1 create dawonweb-library          # salin id-nya ke wrangler.library.toml
npx wrangler r2 bucket create dawonweb-tracks
npm run migrate:library

npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.library.toml
npx wrangler secret put R2_ACCESS_KEY_ID     --config wrangler.library.toml
npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.library.toml

npm run deploy:library
```

Di Google Cloud Console, redirect URI-nya `https://<API_ORIGIN>/auth/callback`.

## Tentang tesnya

D1 diuji dengan **SQLite sungguhan** (`node:sqlite`), bukan palsuan. Ini yang
membuat 34 tes kepustakaan berarti: palsuan yang "mengerti" query kami akan
mengerti persis apa yang kami KIRA kami tulis — `WHERE user_id` yang lupa,
`ON CONFLICT` yang tidak cocok dengan PK, `UPDATE … WHERE version` yang tidak
benar-benar menghitung perubahan. R2 sebaliknya dipalsukan, karena "objeknya
ada?" dan "byte-nya apa?" tidak punya perilaku yang bisa mengejutkan.

Tanda tangan presigned URL hanya bisa divalidasi R2. Yang diuji di sini adalah
BAHAN-nya — canonical request dan string-to-sign, disalin dari dokumentasi AWS
baris per baris — bukan konstanta tanda tangan dari ingatan, yang terlihat
berwibawa dan tidak membuktikan apa pun.

## Yang sengaja belum ada

- **Sisi web.** Fase L0 dan L1 (`contentHash` di `StudioAsset`, dedup saat
  import, `serialize` menulis hash) belum dikerjakan, dan tanpa keduanya belum
  ada yang memanggil API ini. Keduanya tidak butuh backend dan bisa jalan
  sendiri.
- **Pembersih objek yatim** (§8d).
- **Multipart upload** untuk berkas > 100 MB (§5c). `/tracks/init` menolaknya
  dengan alasan yang jelas, bukan gagal di tengah upload.
- **Keputusan soal hasil bake** (§8e): asset tanpa file asal belum punya jalur
  upload, jadi project yang merujuknya akan ditolak `/projects` — yang benar,
  tapi bukan jawaban akhirnya.
