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
app.contoh.com   ← frontend (Vercel)
api.contoh.com   ← Worker kepustakaan
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
> `*.workers.dev` sudah cukup untuknya.

---

## 1. Prasyarat

- Akun Cloudflare (tier gratis cukup untuk memulai)
- Node ≥ 22.5 (`node --version`)
- Domain yang zone DNS-nya ada di Cloudflare — untuk `api.contoh.com`
- Project Google Cloud — untuk OAuth

```bash
cd backend
npm ci
npm test          # 86 tes; kalau merah, jangan deploy
npx wrangler login
```

`wrangler` sengaja tidak ada di `devDependencies` (ia menarik `workerd` dan
`sharp`, puluhan MB, yang tidak dipakai saat tes). Semua script memanggilnya
lewat `npx` dengan versi terpin.

---

## 2. Worker Roblox

Tiga langkah, tanpa rahasia dan tanpa penyimpanan.

**2.1** Isi origin aplikasi di `wrangler.roblox.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://app.contoh.com"
```

Beberapa origin dipisah koma, tanpa spasi. Untuk dev lokal tambahkan
`http://localhost:5173`.

**2.2** Deploy:

```bash
npm run deploy:roblox
```

**2.3** Periksa:

```bash
curl https://dawonweb-roblox.<akun>.workers.dev/health
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

Salin `database_id` dari keluarannya ke `wrangler.library.toml`. **Jangan ubah
`binding`** — ia harus `DB`, karena itu yang dibaca kode (`env.DB`). Dashboard
menyarankan nama yang mengikuti nama database; saran itu membuat `env.DB`
undefined tanpa menggagalkan deploy:

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
    "AllowedOrigins": ["https://app.contoh.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Contoh bawaan di dashboard berisi `localhost:3000` + `GET` — ganti seluruhnya.
`GET` tidak dibutuhkan dan `PUT` yang dibutuhkan; `AllowedHeaders` wajib ada,
kalau tidak preflight PUT-nya ditolak karena klien mengirim tipe berkasnya.

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
- Authorized redirect URI: **`https://api.contoh.com/auth/callback`**

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
APP_ORIGIN = "https://app.contoh.com"
API_ORIGIN = "https://api.contoh.com"
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
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.library.toml
npx wrangler secret put R2_ACCESS_KEY_ID     --config wrangler.library.toml
npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.library.toml
```

### 3.6 Deploy + domain

```bash
npm run deploy:library
```

Lalu pasang domainnya. Cara paling tahan lama adalah menuliskannya di config,
supaya tidak hilang saat orang lain men-deploy dari mesin lain:

```toml
routes = [{ pattern = "api.contoh.com", custom_domain = true }]
```

Deploy sekali lagi sesudah menambahkannya. (Alternatifnya: **Workers & Pages →
dawonweb-library → Settings → Domains & Routes → Add custom domain**.)

Periksa:

```bash
curl https://api.contoh.com/health
# {"ok":true,"service":"dawonweb-library"}

curl -i https://api.contoh.com/me
# HTTP/2 401  → benar: belum ada sesi
```

---

## 4. Sisi frontend

Kedua alamat ditanam Vite **saat build**, dan build produksi terjadi di
**GitHub Actions** — bukan di Vercel. Job `web` menghasilkan `web/dist`, dan
job `deploy` hanya merakit `.vercel/output` lalu mengirimnya dengan
`vercel deploy --prebuilt`.

> **Mengisi variabel di dashboard Vercel karena itu TIDAK berpengaruh apa pun.**
> Yang sampai ke sana adalah berkas yang sudah selesai ditulis; variabel yang
> datang belakangan tidak bisa masuk ke dalamnya. Gejalanya persis seperti
> tidak diisi sama sekali — dok berkata "belum dipasang" pada build yang
> variabelnya sudah diisi dengan benar di tempat yang salah.

Tempatnya: **Settings → Secrets and variables → Actions → Variables**
(*variables*, bukan *secrets* — keduanya URL publik yang muncul di setiap
permintaan browser):

```
VITE_ROBLOX_API   = https://robloz.kelasmalam.app
VITE_LIBRARY_API  = https://lib.kelasmalam.app
```

Lalu jalankan ulang CI di `main` — variabel build hanya berlaku untuk build
yang dijalankan sesudahnya.

### Lokal

```bash
cat > web/.env.local <<'EOF'
VITE_ROBLOX_API=https://robloz.kelasmalam.app
VITE_LIBRARY_API=https://lib.kelasmalam.app
EOF
pnpm -C web dev
```

`.env.local` diabaikan git. Ia menunjuk backend PRODUKSI, jadi lagu yang
diunggah dari dev mendarat di kepustakaan sungguhan — itu biasanya yang
diinginkan, tapi layak diketahui sebelum menjatuhkan berkas uji coba.

Untuk menjalankan Worker di lokal, ganti alamatnya dan beri port berbeda:

```bash
npm --prefix backend run dev:roblox   -- --port 8787
npm --prefix backend run dev:library  -- --port 8788
```

Keduanya **opsional**. Tanpa `VITE_ROBLOX_API`, halaman `/roblox` tetap jalan
sebagai UI dengan badge `UI ONLY`. Tanpa `VITE_LIBRARY_API`, dok kepustakaan
tetap tampil dan berkata `BELUM DIPASANG` — import berkas lokal berjalan penuh,
yang tidak ada hanyalah daya tahan. Tidak ada nilai bawaan dengan sengaja:
bawaan yang menunjuk ke mana pun akan membuat build lokal siapa pun mengirim
kredensial user ke host yang tidak mereka pilih.

---

## 5. Memastikan ia benar-benar hidup

Urutannya menaik: yang gagal lebih dulu menyempitkan masalahnya.

1. `curl https://api.contoh.com/health` → `{"ok":true,…}`
2. `curl -i https://api.contoh.com/me` → `401` (bukan 500, bukan CORS)
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
| Dok berkata "belum dipasang" padahal variabel sudah diisi | diisi di dashboard **Vercel**, bukan di variables **GitHub Actions** | §4 — build-nya di CI, bukan di Vercel |
| `Cannot read properties of undefined (reading 'prepare')` | nama binding di `wrangler.toml` bukan `DB` | kode membaca `env.DB`; dashboard menyarankan nama yang mengikuti nama database, dan saran itu salah. Sejak versi ini pesannya langsung menyebut `BINDING_HILANG` |
| `error code: 1101` dari Worker | Worker melempar exception — HAMPIR SELALU binding basi (deploy lebih tua dari config) atau tabel belum ada | redeploy, lalu ulangi tes di §5; sejak versi ini galatnya dibalas ber-JSON dengan pesannya, bukan halaman 1101 |
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
