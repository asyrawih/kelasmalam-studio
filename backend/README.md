# backend — Worker unggah asset audio Roblox

Cloudflare Worker yang meneruskan satu berkas audio ke [Roblox Open
Cloud](https://create.roblox.com/docs/cloud/guides/usage-assets) dan melaporkan
status moderasinya. Dipakai oleh halaman `/roblox` (`web/src/roblox`).

Ia **tidak menyimpan apa pun**: bukan berkasnya, bukan API key-nya, bukan
riwayatnya. Kepustakaan (R2 + D1, `docs/16-kepustakaan.md`) adalah layanan lain
dengan umur data yang berbeda — sengaja tidak digabung, supaya satu deploy yang
salah tidak menjatuhkan dua-duanya.

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
npm test              # 37 tes, tanpa jaringan (Roblox dipalsukan)
npm run typecheck
npm run dev           # wrangler dev di localhost:8787
npm run deploy
```

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

Jangan lupa memasukkan origin app ke `ALLOWED_ORIGINS` di `wrangler.toml`.

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
