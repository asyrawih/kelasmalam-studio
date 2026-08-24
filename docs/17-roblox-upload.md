# 17 — Halaman ROBLOX (unggah asset audio)

Halaman `/roblox` menyiapkan berkas audio untuk diunggah jadi asset Roblox.
Iterasi ini **UI saja**: antrean, validasi, dan metadata sudah jalan; lapisan
yang benar-benar mengirim byte ke Open Cloud dikerjakan terpisah.

## Berkas

```
web/src/roblox/
  model.ts              aturan Roblox + format angka. MURNI: tanpa React, DOM, jaringan
  store.ts              antrean + target. useSyncExternalStore, pola sama dengan dj/store.ts
  RobloxPage.tsx        merangkai semuanya. UI MURNI: tidak tahu apa pun soal HTTP
  RobloxRoute.tsx       halaman + sambungan ke Worker unggah (yang dirender AppShell)
  backend/transport.ts  URL + header + XHR/fetch ke `backend/`
  backend/runner.ts     penggerak antrean: kirim, tunggu moderasi, lapor ke store
  roblox.css            media query + hover yang tidak bisa jadi inline style
  header/RobloxHeader   judul, batas Roblox, badge SIAP/UI ONLY
  destination/TargetPanel  pemilik asset (user/grup) + API key
  upload/DropZone       drop + <input type=file>
  upload/UploadQueue    daftar baris + ringkasan + aksi massal
  upload/QueueRow       satu baris (di-memo)
  upload/DetailPanel    nama & deskripsi baris terpilih
  upload/useDurations   probe durasi lewat <audio preload=metadata>
```

Foldernya `destination/`, bukan `target/`: `.gitignore` repo ini mengabaikan
setiap direktori bernama `target` (folder build Cargo), jadi berkas di sana
tidak akan pernah ikut ter-commit.

Route-nya satu baris di `app-shell/routes.ts` (`ROBLOX_PATH`), dan pintu
masuknya: tombol `ROBLOX` di topbar landing + command `shell.goto.roblox` di
palette (⌘K).

## Batas yang divalidasi

| Aturan | Nilai | Konstanta |
| --- | --- | --- |
| Format | MP3, OGG | `AUDIO_EXTS` |
| Ukuran | 20 MB | `MAX_BYTES` |
| Durasi | 7 menit | `MAX_SECONDS` |
| Nama | 50 karakter | `MAX_NAME_LEN` |
| Deskripsi | 1000 karakter | `MAX_DESC_LEN` |

Dua hal yang mudah dibalik tanpa sadar merusaknya, dan keduanya dijaga tes:

- **Durasi `null` DITAHAN.** `null` berarti durasi belum dapat diverifikasi.
  Meloloskannya berisiko mengirim lagu di atas 7 menit dan menghabiskan kuota
  sebelum Roblox menolaknya.
- **`violationsOf` mengembalikan SEMUA alasan**, bukan yang pertama. Satu berkas
  bisa sekaligus terlalu besar dan terlalu panjang.

Format yang salah tidak pernah jadi baris antrean (`isAudioFile` menjaga pintu);
yang lolos pintu dinilai `violationsOf`.

## Lapisan unggah

Sudah ada: `backend/` — Cloudflare Worker yang meneruskan berkas ke Open Cloud.
Rinciannya di `backend/README.md`; yang perlu diketahui dari sisi UI:

```
web/src/roblox/
  RobloxRoute.tsx           halaman + sambungannya. Yang dirender AppShell
  backend/transport.ts      URL, header, XHR/fetch. Tanpa aturan bisnis
  backend/runner.ts         antrean berjalan: kirim → tunggu moderasi → lapor
```

Alurnya: `RobloxRoute` membaca `VITE_ROBLOX_API`, memprobe `/health`, dan hanya
kalau Worker MENJAWAB ia memanggil `setBackendReady(true)` dan memasang
`onUpload`. Tanpa variabel itu — atau dengan Worker yang mati — halaman persis
seperti sebelum backend ada: tombol UNGGAH mati, badge `UI ONLY`.

`runner.ts` adalah "pemasang backend" yang dijanjikan seam di bawah, dan ia
memakai persis permukaan itu: `fileOf(id)` untuk byte, lalu `markUploading` /
`markProgress` / `markProcessing` / `markDone` / `markFailed`. Tidak ada satu
pun komponen yang berubah untuk membuatnya bekerja.

Adanya `assetId` saja tidak dihitung sebagai keberhasilan moderasi. Runner
meneruskan `moderationResult.moderationState` dari Roblox: baris tetap
`MODERASI` selama `Reviewing`, berubah menjadi `DISETUJUI` hanya saat
`Approved`, dan menjadi `GAGAL` saat `Rejected`.

### Bertahan setelah refresh

Antrean disimpan di IndexedDB (`web/src/roblox/persistence.ts`), termasuk byte
MP3/OGG untuk baris draft dan `operationId` untuk baris yang sudah masuk fase
moderasi. Saat `/roblox` dibuka kembali, metadata dan berkas dipulihkan; polling
baris `MODERASI` dilanjutkan setelah kredensial akun selesai dimuat. API key
tetap tidak masuk IndexedDB.

Refresh tepat saat request upload masih berjalan adalah keadaan ambigu: browser
belum tentu sempat menerima `operationId`, sementara Roblox mungkin sudah
menerima byte. Baris itu dipulihkan sebagai `GAGAL` dengan pesan agar user
memeriksa Creator Hub sebelum mengulang, bukan dikirim ulang otomatis dan
berisiko memakan kuota dua kali.

Tiga keputusan di runner yang tidak terlihat dari kodenya:

- **Satu berkas pada satu waktu.** Yang membatasi bukan bandwidth kami melainkan
  kuota Roblox; serempak hanya membuat satu `429` menjatuhkan seluruh antrean.
- **Progres nyata lewat XMLHttpRequest.** `fetch` tidak melaporkan kemajuan
  pengiriman badan permintaan, dan bar yang bergerak sendiri mengarang angka.
- **Moderasi lama ≠ gagal unggah.** Kalau Roblox belum selesai setelah 5 menit,
  pesannya menyebut bahwa berkasnya SUDAH terkirim dan menyertakan id operasinya
  — user yang mengunggah ulang membayar kuota bulanannya dua kali.

### Seam-nya sendiri (kalau lapisan lain mau menggantikan runner)

1. `robloxActions.setBackendReady(true, sisaKuota)` — badge + tombol hidup
2. `onUpload` di `<RobloxPage>` menerima hasil `readyItems(state)`
3. `fileOf(item.id)` memberi byte-nya (`File` tidak disimpan di state)
4. lapor balik lewat kelima aksi `mark*`

## Keputusan yang jangan dibalik tanpa alasan

- **API key tidak disimpan di browser.** Tidak ke localStorage maupun IndexedDB;
  saat refresh ia dimuat lagi dari penyimpanan akun yang terenkripsi di Worker.
  Antrean dan byte audio boleh persisten, tetapi kredensial Open Cloud tidak
  ikut di dalam snapshot tersebut.
- **Tombol UNGGAH mati selama backend belum ada, dengan alasan tertulis.**
  Tombol yang menyala lalu diam membuat user mengira lagunya sudah terkirim —
  kegagalan yang paling mahal untuk ditemukan di halaman ini.
- **Durasi diukur lewat `<audio>`, bukan `decodeAudioData`.** Yang dibutuhkan
  cuma satu angka dari header; mendekode seluruh lagu jadi PCM membayarnya
  dengan puluhan MB per berkas. Bonusnya: tidak butuh `AudioContext`, jadi
  halaman ini tidak menunggu gestur user seperti Studio dan DJ.
- **Satu probe per baris, seumur hidup baris itu.** Menghitung ulang daftar
  "yang perlu diukur" dari state tiap render membuat probe saling membunuh;
  catatannya ada di `useDurations.ts`.
