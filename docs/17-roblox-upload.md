# 17 — Halaman ROBLOX (unggah asset audio)

Halaman `/roblox` menyiapkan berkas audio untuk diunggah jadi asset Roblox.
Iterasi ini **UI saja**: antrean, validasi, dan metadata sudah jalan; lapisan
yang benar-benar mengirim byte ke Open Cloud dikerjakan terpisah.

## Berkas

```
web/src/roblox/
  model.ts              aturan Roblox + format angka. MURNI: tanpa React, DOM, jaringan
  store.ts              antrean + target. useSyncExternalStore, pola sama dengan dj/store.ts
  RobloxPage.tsx        merangkai semuanya; satu-satunya yang tahu soal routing
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

- **Durasi `null` LOLOS.** `null` berarti "belum/tidak bisa diukur", bukan nol.
  Menebak nol membuat lagu 9 menit lolos lalu ditolak Roblox; menganggapnya
  melanggar membuat berkas sah tertahan gara-gara browser tidak bisa membaca
  headernya.
- **`violationsOf` mengembalikan SEMUA alasan**, bukan yang pertama. Satu berkas
  bisa sekaligus terlalu besar dan terlalu panjang.

Format yang salah tidak pernah jadi baris antrean (`isAudioFile` menjaga pintu);
yang lolos pintu dinilai `violationsOf`.

## Menyambungkan lapisan unggah

Tidak ada yang perlu diubah di komponen. Empat langkah:

1. `robloxActions.setBackendReady(true, sisaKuota)` saat lapisannya hidup —
   badge header berubah dari `UI ONLY` ke `SIAP`, dan tombol UNGGAH ikut hidup
   begitu target dan antreannya juga siap.
2. Pasang `onUpload` di `<RobloxPage onUpload={…} />` (dari `AppShell`). Ia
   menerima `readonly QueueItem[]` — hasil `readyItems(state)`, yaitu baris
   berstatus `draft`/`failed` yang lolos seluruh validasi.
3. Ambil byte-nya dengan `fileOf(item.id)`. `File` sengaja TIDAK disimpan di
   state; alasannya di kepala `store.ts`.
4. Lapor balik: `markQueued` → `markUploading` → `markProgress(id, 0..100)` →
   `markProcessing` (byte sampai, Roblox masih memoderasi) → `markDone(id,
   assetId)` atau `markFailed(id, pesan)`. Laporan untuk baris yang sudah
   dihapus user diabaikan diam-diam, jadi respons yang datang terlambat tidak
   perlu dijaga pemanggil.

`targetProblems(target)` memberi alasan target belum lengkap; halaman sudah
memajangnya dan mematikan tombol, jadi pengunggah tidak perlu memvalidasi ulang
— tapi kalau ia mau, sumbernya sama.

## Keputusan yang jangan dibalik tanpa alasan

- **API key tidak disimpan.** Tidak ke localStorage, tidak ke IndexedDB. Ia
  hidup di memori tab dan hilang saat refresh. Repo ini memang sudah membuang
  penyimpanan lokal seluruhnya (`docs/16-kepustakaan.md`), dan kredensial Open
  Cloud adalah kandidat terburuk untuk jadi pengecualian.
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
