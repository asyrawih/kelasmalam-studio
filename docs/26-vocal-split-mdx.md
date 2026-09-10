# 26 — Vocal split desktop (Kim_Vocal_2 / MDX-Net)

Status: **rencana**, belum ada kode. Menjawab satu permintaan produk:
tombol di sebelah SNAP yang memisahkan clip menjadi dua lane — vokal dan
instrumen — memakai model **Kim_Vocal_2** dari UVR, **hanya di desktop**.

Dokumen ini menumpang pada docs/14 (SCNet) dan docs/20 §1g (unduhan model di
desktop). Yang baru di sini bukan infrastrukturnya, melainkan model, transform
STFT-nya, dan alur UI-nya.

## Jawaban singkat untuk pertanyaan awal

**"Apa gua butuh model ONNX?"** — Kim_Vocal_2 di UVR **sudah** berbentuk ONNX.
Tidak ada konversi. Yang dibutuhkan adalah *runtime* ONNX, dan repo ini sudah
punya satu (ONNX Runtime Web di `packages/proof-stem`). Yang perlu ditulis
adalah transform di sekeliling model (STFT/iSTFT dengan parameter MDX-Net),
bukan modelnya.

Hati-hati dengan dua benda bernama mirip:

| Nama | Arsitektur | Format | Ukuran | Cocok? |
|---|---|---|---|---|
| `Kim_Vocal_2.onnx` (UVR, kategori MDX-Net) | ConvTDF-Net | ONNX, opset 13 | 66,8 MB | **Ya, ini yang dipakai** |
| "Kim Vocal 2" Mel-Band-RoFormer | RoFormer, ~228 M param | PyTorch `.ckpt` | ~900 MB | Tidak — perlu export sendiri, dan terlalu berat untuk WASM |

## 1. Fakta model (diukur langsung, September 2026)

Semua angka di bawah diambil dari berkas yang diunduh, bukan dari ingatan.

| Hal | Nilai |
|---|---|
| Berkas | `Kim_Vocal_2.onnx`, **66 759 214 byte** |
| sha256 | `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b` |
| Hash gaya UVR (md5 10 MB terakhir) | `970b3f9492014d18fefeedfe4773cb42` |
| Sumber | HuggingFace `seanghay/uvr_models` dan `Politrees/UVR_resources` (mirror dari rilis UVR) |
| ONNX opset | 13 (ORT-web 1.21 yang sudah ada di repo mendukungnya) |
| Input | `input` `[batch, 4, 3072, 256]` float32 |
| Output | `output` `[batch, 4, 3072, 256]` float32 |
| Stem primer | **Vocals** (satu stem; instrumen = mix − vokal) |

Parameter dari `model_data.json` UVR untuk hash di atas:

| Parameter | Nilai | Artinya |
|---|---|---|
| `mdx_n_fft_scale_set` | **7680** | n_fft STFT, window Hann, `hop = 1024` (tetap di seluruh MDX-Net) |
| `mdx_dim_f_set` | **3072** | hanya 3072 bin frekuensi terbawah dari 3841 yang masuk model; sisanya dibuang lalu diisi nol saat iSTFT |
| `mdx_dim_t_set` | **8** | `2^8 = 256` frame per segmen |
| `compensate` | **1.009** | pengali output vokal sebelum dikurangkan dari mix |

Turunannya, semua pada 44,1 kHz stereo:

- Sumbu channel `4` = `[L.re, L.im, R.re, R.im]` — hasil `reshape` UVR dari
  `[B, ch, 2, F, T]` ke `[B, ch×2, F, T]`, jadi real/imajiner per channel
  berdampingan. STFT `center=true`, window Hann **periodik** (`torch.hann_window`
  default), padding refleksi.
- Panjang segmen = `hop × (256 − 1)` = **261 120 sampel ≈ 5,92 detik**.
- `trim = n_fft / 2 = 3840` sampel dipotong di kedua tepi tiap segmen.
- Overlap antar segmen (UVR default 0,25) dijahit dengan window Hann dan
  dinormalisasi oleh jumlah window; ini yang membuat sambungan tidak berdetak.
- Tiga bin frekuensi terbawah di-nol-kan sebelum masuk model
  (`spek[:, :, :3, :] = 0`), sama seperti UVR.
- Lagu 4 menit ≈ **41 segmen** tanpa overlap, ≈ 55 dengan overlap 0,25.
- Instrumen: `inst = mix − vocals × 1.009`, dihitung di domain waktu.
- **Temuan P0:** pada overlap 0, `demix` UVR menumpuk keluaran segmen utuh dan
  `zeroLowBins` pada frame yang melintasi tepi segmen meninggalkan galat
  sub-17 Hz sepanjang ±nFft di batas interior (terukur SNR ≈ 62 dB di sana,
  > 148 dB di tempat lain). Ini sifat algoritma rujukan, alasan UVR default
  0,25 — overlap 0 tidak ditawarkan sebagai pilihan di dialog.
- Opsi *denoise* UVR = jalankan model dua kali (`x` dan `−x`), rata-ratakan
  `(y⁺ − y⁻) / 2`. Biaya 2×, artefak berkurang. Default **mati**.

Semua transform di atas hanya aritmetika di TS worker; **crate Rust tidak
tersentuh** (prinsip docs/14: FFT tetap di worker, bukan di engine).

## 2. Keputusan yang mengikat

1. **Desktop dulu, web menyusul; keduanya disuntik lewat `StudioExtras`**
   (docs/25 §1c), bukan `if (isTauri)`. `apps/desktop` (lalu `apps/web`) yang
   memasang tombolnya; `packages/studio` hanya menyediakan slot. Tes
   `app-web-imports.test.ts` tetap hijau.
2. **Runtime ONNX = jalur yang sudah ada dulu**: ORT-web WASM SIMD
   multi-thread di Web Worker, byte model diambil main thread lewat
   `PlatformHost.modelBytes` (pola `prefetchModelBytes` di proof-stem).
   Runtime native (`ort` crate di Rust) **tidak** masuk sebelum P1 memberi
   angka — lihat §4.
3. **Model diunduh dan disimpan di sisi client, tidak pernah di-rehost.**
   Katalog menyimpan URL *resolve* HuggingFace (bukan URL CDN yang berubah),
   ukuran, dan sha256; isi dijaga hash, bukan URL.
   - Desktop: lewat Rust (`crates/desktop-host/src/model.rs`), ke
     `appDataDir()/models/Kim_Vocal_2.onnx`, pola `.part` → rename. Tidak ada
     `fetch` dari WebView (docs/20 §1g).
   - Web: `fetch` langsung dari HuggingFace di worker, cache OPFS (pola
     `scnet-model.ts`). Ini lolos COEP `require-corp` karena HuggingFace
     mengirim `access-control-allow-origin` di kedua hop (resolve dan CDN) —
     **diverifikasi dengan `curl` September 2026**. Bobot tidak pernah
     menyentuh Vercel atau R2.
4. **Hasil = dua asset baru + dua lane baru**, bukan mask live. Clip sumber
   tidak diubah, tidak dihapus. Undo satu langkah mengembalikan proyek ke
   keadaan sebelum split (kedua lane hilang, asset boleh tinggal di cache).
5. **Job berjalan sambil transport hidup**, tapi **ditolak saat export
   sedang berjalan** — keduanya berebut thread WASM.
6. Jalur realtime (engine, worklet, SAB, ring) **tidak berubah sama sekali**.

## 3. Alur produk

### 3a. Yang dilihat user

1. User drop file audio ke sebuah lane (jalur impor yang sudah ada:
   `useNativeFileDrop` → `importBytesToLane`). Tidak ada perubahan di sini.
2. Di kanan toolbar, di sebelah `SnapToggle`, ada tombol **SPLIT** (glyph
   `⋔` atau serupa, label "SPLIT"). Tombol ini hanya ada di desktop.
3. Klik → popup konfigurasi (`VocalSplitDialog`), pola `MenuBar` popup
   (satu popup terbuka pada satu waktu) atau dialog portal seperti
   `ClipDetailDialog` kalau isinya terlalu tinggi.
4. Tekan **PISAHKAN** → popup menutup, progres muncul **di lane sumber**
   (pola `LaneImportOverlay`, tahap baru: `MODEL` unduh, `STFT`,
   `INFERENSI 12/41`, `SUSUN`). Ada tombol batal.
5. Selesai → dua lane baru muncul tepat di bawah lane sumber:
   - lane pertama: `<nama clip> · VOCALS`
   - lane kedua: `<nama clip> · INST`
   Masing-masing berisi satu clip dengan `start` dan `len` **sama persis**
   dengan clip sumber, warna lane dari palet berikutnya. Lane sumber
   otomatis di-*mute* (bisa di-unmute; ini yang paling sering diinginkan dan
   paling murah dibatalkan).

> Asumsi: "lane 1 / lane 2" dibaca sebagai *urutan lane hasil* (vokal di atas,
> instrumen di bawah), disisipkan di bawah lane sumber. Kalau maksudnya
> harfiah lane #1 dan #2 proyek, hanya `insertIndex` di P3 yang berubah.

### 3b. Isi popup konfigurasi

| Bidang | Default | Catatan |
|---|---|---|
| Sumber | clip terpilih (`selectedClipId`) | kalau tidak ada clip terpilih, tombol PISAHKAN nonaktif dengan alasan tertulis |
| Model | `Kim_Vocal_2` | katalog `VOCAL_MODELS`; status: `belum diunduh (66,8 MB)` / `siap` / `mengunduh 40%` dengan tombol unduh terpisah — mengunduh **bukan** bagian dari tombol PISAHKAN |
| Overlap | 0,25 | pilihan 0,25 / 0,5; makin besar makin halus dan makin lama (0 dibuang, lihat §1 temuan P0) |
| Denoise | mati | 2× waktu |
| Thread | `min(4, cores − 2)` | sama dengan `loadScnetModel` |
| Mute lane sumber | ya | |

Yang **sengaja tidak ada** di v1: batch banyak clip, pilih stem lain,
ensemble model, output 4 stem (itu wilayah SCNet, docs/14).

### 3c. Kondisi tepi yang harus ditangani

- Clip yang **di-trim / di-loop**: yang diproses adalah `sourceStart..sourceLen`
  dari asset, bukan seluruh asset. Hasilnya dipotong sama.
- Asset **mono** → digandakan ke stereo sebelum STFT (model menuntut 2 ch).
- Sample rate ≠ 44,1 kHz → resample dulu (`OfflineAudioContext` cukup untuk
  job offline), hasil dikembalikan ke rate proyek.
- Clip sumber dihapus / proyek diganti saat job jalan → job dibatalkan,
  bukan lane baru muncul di proyek yang salah. Kunci: simpan `projectId` +
  `clipId` di job, verifikasi saat commit.
- Export sedang berjalan → tombol nonaktif, tooltip "menunggu export".
- Dua job sekaligus → antre, bukan paralel (thread WASM satu pool).

## 4. Runtime: WASM dulu, native kalau angkanya memaksa

Kim_Vocal_2 lebih berat per detik audio daripada SCNet base (input 3072 × 256
vs 2049 × 476, dan jaringan TDF yang lebar). Perkiraan kasar di WASM 8 thread
adalah 0,5–1× realtime — lagu 4 menit **4–8 menit**. Itu tebakan, dan tebakan
tidak masuk roadmap; P1 yang mengukur.

Tiga jalur yang ada, dari yang termurah:

| Jalur | Biaya tambah | Perkiraan | Catatan |
|---|---|---|---|
| **ORT-web WASM** (ada) | nol dependensi | 0,5–1× RT | jalur P0/P1 |
| ORT-web **WebGPU** | nol dependensi, tapi WKWebView butuh macOS 26 / WebView2 baru | 3–8× RT | MDX-Net tidak punya LSTM, jadi masalah docs/14 §WebGPU **tidak berlaku**; layak diukur di P1 |
| `ort` crate di Rust (CoreML / DirectML / CPU) | binari ORT ~30–50 MB per platform, signing, kontrak command baru, PCM lewat IPC | 3–10× RT | hanya kalau dua di atas gagal gerbang |

**Gerbang P1:** lagu 4 menit selesai ≤ 3 menit di MacBook 8-core, puncak memori
worker ≤ 1,5 GB. Lulus → lanjut dengan WASM/WebGPU. Gagal → §7 memutuskan,
bukan menambah runtime diam-diam.

### Hasil P1 (10 Sep 2026, Apple M4 10-core, satu segmen = 5,92 s audio)

| Runtime | Per segmen | RTF | Lagu 4 mnt (overlap 0,25) | RSS |
|---|---|---|---|---|
| ORT-web WASM 1 thread (Node) | 15 399 ms | 0,38× | 14,1 mnt | 1,2 GB |
| ORT-web WASM 4 thread (Node) | 5 235 ms | 1,13× | 4,8 mnt | 1,5 GB |
| ORT-web WASM 8 thread (Node) | 4 333 ms | 1,37× | 4,0 mnt | 1,5 GB |
| onnxruntime native CPU 1 thread | 2 411 ms | 2,46× | 2,2 mnt | — |
| onnxruntime native CPU 4 thread | 1 051 ms | 5,64× | 1,0 mnt | — |
| onnxruntime native CoreML | 388 ms | 15,3× | 0,4 mnt | — |
| ORT-web WebGPU (Safari/WKWebView) | **belum diukur** — halaman benchmark disiapkan, user menguji manual | | | |

WASM **gagal gerbang tipis** (4,0 > 3 mnt, dan ini di M4; mesin user lebih
lambat). Native CPU lolos 3× lebih cepat, CoreML 8× lagi.

**Keputusan sementara:** P3 dibangun di atas jalur WASM yang sudah ada, karena
UI, job, dan komit ke proyek tidak bergantung pada runtime — `split-client.ts`
adalah satu-satunya titik tukar. Runtime native (`ort` crate, PCM lewat IPC
biner) masuk sebagai **P3b** setelah angka WebGPU ada: kalau WebGPU di
WKWebView < 1,5 s/segmen, native ditunda; kalau tidak, native dikerjakan.

## 5. Struktur kode

```
packages/
  proof-stem/src/proof-stem/
    scnet-*.ts                  ← tidak disentuh
  vocal-split/                  ← paket baru, netral platform (tidak impor @tauri-apps)
    src/
      catalog.ts                ← VOCAL_MODELS: id, label, bytes, sha256, params MDX
      mdx-stft.ts               ← STFT/iSTFT n_fft 7680, hop 1024, crop 3072, [4,F,T] layout
      mdx-separate.ts           ← segmen 261 120, overlap, Hann, trim, compensate, denoise
      mdx-model.ts              ← load ORT (pola scnet-model.ts), run per segmen
      split.worker.ts           ← init / separate / cancel, progres per segmen
      split-job.ts              ← orkestrasi main thread: asset → worker → 2 asset baru
      VocalSplitDialog.tsx      ← popup konfigurasi
      __tests__/
        stft-roundtrip.test.ts  ← null test: STFT→iSTFT SNR > 100 dB tanpa model
        segment-stitch.test.ts  ← overlap+Hann menjumlah ke 1,0 di setiap sampel
        catalog.test.ts         ← bytes/sha256 TS == Rust (pola model-bytes.test.ts)
  studio/
    src/StudioPage.tsx          ← slot `extras.toolbarActions` di samping SnapToggle
    src/studio/store.ts         ← `insertLanesBelow(laneId, lanes[])` satu langkah undo
    src/studio/timeline/LaneImportOverlay.tsx ← tahap job split
apps/desktop/src/
  vocal-split/register.ts       ← memasang tombol + dialog ke extras
  platform/local-commands.ts    ← `ScnetModelId` → `ModelId` diperluas: 'kim-vocal-2'
crates/desktop-host/src/model.rs ← ModelId::KimVocal2, bytes, sha256, nama berkas
```

Bagian paling kaku adalah **kontrak `ModelId`**: ia dipakai di TS
(`packages/platform/src/host.ts`), Rust (`model.rs`), dan tes kontrak
(`crates/desktop-host/src/tests.rs`). Tipe `ScnetModelId` sebaiknya di-rename
jadi `ModelId` generik dengan nilai `'base' | 'large' | 'kim-vocal-2'` — satu
rename, tiga tempat, dijaga tes yang sudah ada.

## 6. Fase

Urutan mengikuti docs/09: yang bisa membatalkan seluruhnya dibuktikan
lebih dulu, selagi kodenya masih kecil untuk dibuang.

### P0 — Transform benar tanpa model (1–2 hari)

`mdx-stft.ts` + `mdx-separate.ts` dengan model **identitas** (output = input).

**Done:** file 30 detik masuk → keluar, SNR > 100 dB, termasuk di sambungan
segmen dengan overlap 0 dan 0,25; tes `stft-roundtrip` dan `segment-stitch`
hijau di `bun test`. Jangan pernah men-debug model dan transform sekaligus.

### P1 — Benchmark jujur di mesin target (1 hari) — GERBANG

Halaman `/proof-stem` diberi mode kedua: pilih `Kim_Vocal_2`, jalankan pada
lagu 4 menit, catat RTF pada 4/8 thread WASM dan (kalau tersedia) WebGPU,
puncak memori, di macOS dan Windows.

**Done:** satu tabel angka nyata di §4 dokumen ini, dan keputusan runtime
ditulis di §2 butir 2. Ini hari ke-3, bukan setelah UI jadi.

### P2 — Model masuk pipa desktop (1 hari)

`ModelId` diperluas, `model.rs` tahu Kim_Vocal_2, `model_download` /
`model_read` bekerja untuknya, tes kontrak hijau, `catalog.test.ts` menjaga
angka TS == Rust.

**Done:** `cargo test -p daw-desktop-host` dan `bun test` hijau; unduhan
pertama 66,8 MB tampil progresnya lewat `daw://model-progress`.

### P3 — UI + commit ke proyek (2–3 hari)

Tombol SPLIT, dialog, job + progres di lane, `insertLanesBelow`, undo satu
langkah, mute lane sumber, semua kondisi tepi §3c.

**Done:** drop lagu → SPLIT → PISAHKAN → dua lane VOCALS/INST dengan `start`
dan `len` identik → play bersama tidak ada underrun → `⌘Z` mengembalikan
proyek → batal di tengah tidak meninggalkan lane setengah jadi. Null-test
docs/09 masih lulus. Tes `app-web-imports.test.ts` masih hijau (web tidak
tahu fitur ini ada).

### P4 — Kualitas & polish (1 hari, opsional)

Denoise, pilihan overlap 0,5, perbandingan A/B dengan output UVR pada 3 lagu
(korelasi > 0,99 terhadap UVR dengan setelan sama, sebagai bukti transform
kita sama dengan rujukan).

**Total realistis: 1–1,5 minggu**, gerbang pembatalan di hari ke-3.

## 7. Yang harus diputuskan sebelum P2

1. **Lisensi bobot.** Kode UVR MIT. Bobot Kim_Vocal_2 dibuat oleh KimberleyJSN
   dan disebar lewat rilis UVR tanpa berkas lisensi eksplisit di mirror
   HuggingFace. Karena §2 butir 3 memutuskan **tidak me-rehost** — user
   mengunduh sendiri dari sumber publik, sama seperti UVR — lubang docs/14 ini
   tertutup di kedua platform. Yang tersisa hanya mencantumkan atribusi di
   dialog model.
2. **Kalau P1 gagal gerbang**, urutan mundur: (a) WebGPU kalau belum diukur;
   (b) `ort` crate native dengan PCM lewat `Response` biner (pola
   `youtube_bytes`); (c) model lebih kecil (`UVR-MDX-NET-Voc_FT`, arsitektur
   sama, cukup ganti katalog). Server-side tidak masuk daftar — docs/14 sudah
   menolaknya sebagai keputusan produk.
3. **Posisi lane hasil**: di bawah lane sumber (asumsi §3a) atau selalu lane
   #1 dan #2.

## 8. Utang yang sengaja ditinggalkan

- Batch banyak clip sekaligus.
- Model MDX lain di katalog (arsitektur sama, hanya parameter beda; katalog
  sudah dirancang untuk itu tapi UI-nya belum).
- Cache hasil split per `(assetHash, modelId, overlap, denoise)` supaya split
  ulang clip yang sama instan.
- Web: **bukan utang, tapi fase P5 yang belum dijadwalkan.** `packages/vocal-split`
  netral platform, unduhan client-side sudah lolos COEP (§2 butir 3), dan
  tombolnya disuntik `apps/web` lewat `StudioExtras` yang sama. Gerbang P1
  harus diulang di Chrome dan Safari desktop; iOS disembunyikan sejak awal
  (batas memori per tab, docs/14). Risiko khas web: Safari bisa membersihkan
  OPFS saat storage penuh, jadi status model di dialog harus jujur
  ("siap" / "perlu unduh 66,8 MB") dengan tombol unduh terpisah.
