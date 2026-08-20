# 18 — Memasang backend

Panduan langkah demi langkah untuk menaikkan kedua Worker di `backend/`.

| Worker | Butuh | Config |
|---|---|---|
| `dawonweb-roblox` | tidak ada penyimpanan, tidak ada rahasia | `wrangler.roblox.toml` |
| `dawonweb-library` | D1 + R2 + Google OAuth + 3 secret | `wrangler.library.toml` |

Keduanya **deploy terpisah**. Yang satu bisa naik tanpa yang lain, dan memang
sebaiknya begitu: Worker Roblox selesai dalam lima menit, kepustakaan butuh
keputusan domain lebih dulu.

---

## 0. Satu keputusan sebelum mengetik apa pun

**API kepustakaan harus berada di subdomain domain yang sama dengan aplikasi.**

```
studio.kelasmalam.app   ← frontend (Vercel)
lib.kelasmalam.app      ← Worker kepustakaan
robloz.kelasmalam.app   ← Worker Roblox
```

Bukan `dawonweb-library.<akun>.workers.dev`, dan bukan domain lain.

Alasannya di `docs/16 §5b`: sesi hidup di cookie. Kalau app dan API beda
*registrable domain*, cookie itu terpaksa `SameSite=None` — yaitu cookie pihak
ketiga, yang sudah diblokir Safari dan sedang dimatikan Chrome. Yang membuatnya
mahal bukan larangannya melainkan **cara ia gagal**: login jalan mulus di
Chrome hari ini, lalu diam-diam tidak pernah berhasil di Safari.

Mengubahnya sesudah terpasang berarti mengganti redirect URI Google, domain
cookie, dan konfigurasi CORS sekaligus. Putuskan sekarang.

> Worker Roblox tidak punya syarat ini — ia tidak memakai cookie sama sekali.
> Ia dipasang di `robloz.kelasmalam.app` demi alamat yang enak dibaca, bukan
> karena terpaksa; `*.workers.dev` pun jalan.

---

## 1. Prasyarat

- Akun Cloudflare (tier gratis cukup untuk memulai)
- Node ≥ 22.5 (`node --version`)
- Domain yang zone DNS-nya ada di Cloudflare — untuk `lib.kelasmalam.app`
- Project Google Cloud — untuk OAuth

```bash
cd backend
npm ci
npm test          # 88 tes; kalau merah, jangan deploy
npx wrangler login
```

`wrangler` sengaja tidak ada di `devDependencies` (ia menarik `workerd` dan
`sharp`, puluhan MB, yang tidak dipakai saat tes). Semua script memanggilnya
lewat `npx` dengan versi terpin.

---

## 2. Worker Roblox

Tiga langkah, tanpa rahasia dan tanpa penyimpanan.

**2.1** `wrangler.roblox.toml` sudah terisi:

```toml
routes = [{ pattern = "robloz.kelasmalam.app", custom_domain = true }]

[vars]
ALLOWED_ORIGINS = "https://studio.kelasmalam.app,http://localhost:5173"
```

Origin dipisah koma, tanpa spasi, tanpa slash di ujung. Worker ini tidak punya
syarat same-site seperti kepustakaan — ia tidak memakai cookie — jadi domainnya
bebas; `*.workers.dev` pun cukup kalau tidak mau memakai subdomain.

**2.2** Deploy:

```bash
npm run deploy:roblox
```

**2.3** Periksa:

```bash
curl https://robloz.kelasmalam.app/health
# {"ok":true,"service":"dawonweb-roblox"}
```

Selesai. API key Open Cloud **tidak** dipasang di sini — ia datang dari user
per permintaan dan tidak pernah menetap di Worker (alasannya di
`backend/README.md §Kunci`).

---

## 3. Worker Kepustakaan

### 3.1 D1

```bash
npx wrangler d1 create dawonweb-library
```

Salin `database_id` dari keluarannya ke `wrangler.library.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "dawonweb-library"
database_id = "<yang-tadi>"
migrations_dir = "migrations"
```

Lalu jalankan migrasinya:

```bash
npm run migrate:library
```

Periksa tabelnya benar-benar ada:

```bash
npx wrangler d1 execute dawonweb-library --config wrangler.library.toml --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
# user, session, track, marks, project
```

### 3.2 Bucket R2

```bash
npx wrangler r2 bucket create dawonweb-tracks
```

**Lalu pasang CORS-nya.** Ini langkah yang paling mudah terlewat, dan
kegagalannya baru muncul jauh kemudian: upload berjalan **langsung dari browser
ke R2** dengan presigned PUT (`docs/16 §5c`), jadi bucket-nya harus mengizinkan
origin aplikasi. Tanpa ini, unggahan pertama gagal dengan galat CORS yang tidak
menyebut R2.

Di dashboard: **R2 → dawonweb-tracks → Settings → CORS Policy**:

```json
[
  {
    "AllowedOrigins": ["https://studio.kelasmalam.app"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

> Jalur **unduh** tidak butuh ini: ia lewat Worker, bukan langsung ke R2 —
> justru supaya Worker bisa menambahkan `Cross-Origin-Resource-Policy` yang
> dituntut COEP aplikasi (`§5a`). Asimetrinya disengaja.
>
> Sampai L0/L1 selesai belum ada yang mengunggah, jadi CORS ini belum terpakai.
> Pasang sekarang saja — supaya ia bukan kejutan di hari fiturnya menyala.

### 3.3 Kredensial S3 untuk R2

Presigned PUT butuh kunci S3; binding R2 tidak bisa menandatangani. Ketegangan
ini dicatat di `docs/16 §1a` — kuncinya dipakai **hanya** untuk menandatangani
upload, seluruh pembacaan tetap lewat binding.

Dashboard: **R2 → Manage R2 API Tokens → Create API token**

- Permission: **Object Read & Write**
- Batasi ke bucket `dawonweb-tracks` saja
- Simpan **Access Key ID** dan **Secret Access Key** — yang kedua hanya
  ditampilkan sekali

Account ID ada di sidebar dashboard R2 (atau `npx wrangler whoami`).

### 3.4 Client OAuth Google

Google Cloud Console → **APIs & Services → Credentials → Create credentials →
OAuth client ID**:

- Application type: **Web application**
- Authorized redirect URI: **`https://lib.kelasmalam.app/auth/callback`**

Persis itu, termasuk `https` dan tanpa slash di ujung. Kalau tidak cocok
karakter per karakter, Google menolak dengan `redirect_uri_mismatch`.

Dua jebakan di layar consent:

- Selama status **Testing**, hanya akun yang terdaftar sebagai *test user* yang
  bisa masuk. Yang lain melihat "app tidak diverifikasi" dan berhenti di situ.
- Scope yang dipakai hanya `openid email profile` — cukup untuk `sub`, email,
  dan nama. Tidak perlu menambah apa pun.

### 3.5 Vars dan secret

Yang tidak rahasia masuk `wrangler.library.toml`:

```toml
[vars]
APP_ORIGIN = "https://studio.kelasmalam.app"
API_ORIGIN = "https://lib.kelasmalam.app"
ALLOWED_ORIGINS = ""                     # kosong = pakai APP_ORIGIN saja
GOOGLE_CLIENT_ID = "....apps.googleusercontent.com"
R2_ACCOUNT_ID = "<account id>"
R2_BUCKET = "dawonweb-tracks"
MAX_TRACK_BYTES = "104857600"            # 100 MB; di atas ini butuh multipart (§5c)
MAX_USER_BYTES = ""                      # kosong = tanpa kuota (§8f)
SESSION_TTL_DAYS = "30"
```

Yang rahasia **tidak pernah** ditulis di berkas:

```bash
cd backend
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.library.toml
npx wrangler secret put R2_ACCESS_KEY_ID     --config wrangler.library.toml
npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.library.toml
```

Tiap perintah meminta nilainya lewat prompt — tempel, Enter. Nilainya tidak
muncul di layar, tidak masuk riwayat shell, dan tidak bisa dibaca kembali dari
mana pun; yang bisa dilakukan nanti hanyalah menimpanya.

Menempel dari pipe juga bisa, tapi ingat ia MASUK riwayat shell:

```bash
printf %s "$RAHASIA" | npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.library.toml
```

Periksa ketiganya terdaftar (namanya saja yang terlihat, bukan nilainya):

```bash
npx wrangler secret list --config wrangler.library.toml
```

> Kalau Worker-nya belum pernah di-deploy, wrangler akan menawarkan membuatnya
> lebih dulu. Lebih rapi: `npm run deploy:library` sekali, baru pasang secret.

**Untuk `wrangler dev` lokal, `secret put` tidak berlaku** — yang dibaca adalah
berkas `backend/.dev.vars`:

```bash
cd backend
cp .dev.vars.example .dev.vars     # lalu isi ketiga nilainya
```

`.dev.vars` diabaikan git. Untuk login lokal, daftarkan redirect URI KEDUA di
Google Console (`http://localhost:8788/auth/callback`) — Google mencocokkannya
persis, dan alamat produksi tidak berlaku untuk localhost.

### 3.6 Deploy + domain

```bash
npm run deploy:library
```

Domainnya sudah tertulis di config, jadi ia terpasang saat deploy:

```toml
routes = [{ pattern = "lib.kelasmalam.app", custom_domain = true }]
```

Syaratnya zone `kelasmalam.app` ada di Cloudflare. Kalau deploy mengeluh soal
zone, itu yang harus dibereskan lebih dulu — bukan konfigurasi Worker-nya.

Periksa:

```bash
curl https://lib.kelasmalam.app/health
# {"ok":true,"service":"dawonweb-library"}

curl -i https://lib.kelasmalam.app/me
# HTTP/2 401  → benar: belum ada sesi
```

---

## 4. Sisi frontend

Kedua alamat masuk sebagai variabel build. Di Vercel: **Settings → Environment
Variables**, lalu **redeploy** — Vite menanamkannya saat build, jadi mengubah
variabel tanpa build ulang tidak mengubah apa pun.

```
VITE_ROBLOX_API   = https://robloz.kelasmalam.app
VITE_LIBRARY_API  = https://lib.kelasmalam.app
```

Lokal:

```bash
VITE_ROBLOX_API=http://localhost:8787 \
VITE_LIBRARY_API=http://localhost:8788 \
pnpm -C web dev
```

Keduanya **opsional**. Tanpa `VITE_ROBLOX_API`, halaman `/roblox` tetap jalan
sebagai UI dengan badge `UI ONLY`. Tanpa `VITE_LIBRARY_API`, dok kepustakaan
tetap tampil dan berkata `BELUM DIPASANG`. Tidak ada nilai bawaan dengan
sengaja: bawaan yang menunjuk ke mana pun akan membuat build lokal siapa pun
mengirim kredensial user ke host yang tidak mereka pilih.

Untuk menjalankan kedua Worker sekaligus di lokal, beri port berbeda:

```bash
npm run dev:roblox   -- --port 8787
npm run dev:library  -- --port 8788
```

---

## 5. Memastikan ia benar-benar hidup

Urutannya menaik: yang gagal lebih dulu menyempitkan masalahnya.

1. `curl https://lib.kelasmalam.app/health` → `{"ok":true,…}`
2. `curl -i https://lib.kelasmalam.app/me` → `401` (bukan 500, bukan CORS)
3. Buka `/studio`, buka dok kepustakaan → **BELUM MASUK** + tombol masuk
4. Klik **MASUK DENGAN GOOGLE** → consent → kembali ke `/studio`, nama muncul
5. Refresh → masih masuk (kalau tidak: cookie tidak bertahan, lihat §6)
6. `/roblox`: badge berubah dari `UI ONLY` jadi `SIAP`

---

## 6. Kalau ada yang salah

| Gejala | Sebab yang paling mungkin | Perbaikan |
|---|---|---|
| Login berhasil, refresh logout lagi | app dan API beda registrable domain → cookie `SameSite=Lax` tidak terkirim | §0. Pindahkan API ke subdomain yang sama |
| Semua panggilan 401 walau baru login | `credentials` tidak sampai, atau `ALLOWED_ORIGINS` tidak memuat origin app | cocokkan `APP_ORIGIN` persis, termasuk skema dan tanpa slash |
| `redirect_uri_mismatch` di layar Google | redirect URI beda satu karakter | samakan dengan `${API_ORIGIN}/auth/callback` |
| "App tidak diverifikasi", login mentok | consent screen masih **Testing** | tambahkan akun sebagai test user, atau publish |
| Unggah Roblox `403` | allowlist IP pada API key Open Cloud; IP keluar Worker tidak tetap | set `0.0.0.0/0` di key-nya |
| Unggah lagu gagal CORS ke `*.r2.cloudflarestorage.com` | CORS bucket belum dipasang | §3.2 |
| Audio kepustakaan gagal dimuat di halaman | jalur unduh tidak lewat Worker | jangan pakai presigned untuk unduh — `GET /tracks/:hash/blob` yang menambahkan CORP (§5a) |
| `no such table: user` | migrasi belum dijalankan di **remote** | `npm run migrate:library` |
| `/tracks/init` menjawab 413 | berkas > `MAX_TRACK_BYTES` | naikkan, atau tunggu multipart (§5c) |

Log langsung:

```bash
npx wrangler tail --config wrangler.library.toml
npx wrangler tail --config wrangler.roblox.toml
```

Yang **tidak** akan muncul di log: API key Roblox, secret R2, dan token sesi.
Ketiganya sengaja tidak pernah ditulis ke mana pun.

---

## 7. Rollback

```bash
npx wrangler deployments list --config wrangler.library.toml
npx wrangler rollback <deployment-id> --config wrangler.library.toml
```

Rollback mengembalikan **kode**, bukan data: migrasi D1 yang sudah jalan tetap
jalan. Skema di `migrations/` karena itu ditulis hanya-menambah — kolom yang
dibuang akan membuat versi lama gagal membaca tabelnya sendiri.

---

## 8. Yang belum otomatis

Deploy backend masih manual. CI (`.github/workflows/ci.yml`) menjalankan tes
dan typecheck kedua Worker pada tiap PR, tapi tidak menaikkannya.

Itu pilihan sadar untuk sekarang: deploy pertama butuh keputusan yang tidak
bisa diambil pipeline (domain, kuota, siapa yang memegang secret). Begitu
semuanya duduk, menambahkan satu job dengan `cloudflare/wrangler-action` dan
`CLOUDFLARE_API_TOKEN` adalah pekerjaan setengah jam — dan syaratnya sama
dengan job `deploy` yang sudah ada: **hanya berjalan setelah CI hijau**, bukan
sebagai pipeline kedua yang berlomba dengannya.
