# 14 — Stem separation ML (SCNet): kelayakan & rencana

Status: **kajian**, belum ada kode. Dokumen ini menjawab satu pertanyaan —
apakah SCNet bisa hidup di repo ini — dan kalau bisa, lewat jalan mana.

## Jawaban singkat

**Bisa.** Bukan karena optimisme, tapi karena sudah ada yang menjalankannya:
SCNet base di-export ke ONNX (44,5 MB fp32) dan dijalankan di browser lewat
ONNX Runtime Web dengan WASM SIMD + multi-thread pada **2,83× realtime** —
lagu 51 detik selesai dalam 18 detik ([elicwhite/scnet-web-wasm][ref]).

Syarat mutlak implementasi itu adalah `COOP: same-origin` +
`COEP: require-corp` + `SharedArrayBuffer`. Di repo ini ketiganya bukan
tambahan yang harus diperjuangkan — ia **fondasi arsitektur sejak M0**
(docs/01 §1d, `web/vite.config.ts`, `web/public/_headers`,
`deploy/nginx.conf`). Prasyarat terberat proyek lain sudah lunas di sini.

Tapi ia **bukan** pengganti docs/11 §B, dan tidak boleh dijual sebagai itu.

## Kenapa keputusan docs/11 tidak batal

docs/11 §B menolak stem separation ML dengan empat alasan. Tiga di antaranya
sudah berubah, satu tetap berdiri:

| Alasan docs/11 | Sekarang |
|---|---|
| "bobot model 20–80 MB" | Benar: SCNet base 10,6 M parameter → ONNX fp32 **44,5 MB** (fp16 22,6 MB) |
| "render offline bermenit-menit" | Berubah: **2,83× realtime** di 16 thread; lagu 4 menit ≈ 85 detik |
| "tidak punya FFT sama sekali" | Tetap benar, dan tetap tidak perlu — STFT dikerjakan di worker TS, bukan di crate Rust |
| "tidak punya backend" | **Tetap benar dan tetap dipertahankan.** Semua tetap di browser |

Yang **tidak** berubah sama sekali: ini job offline satu kali, bukan knob live.
Itulah kenapa ia tidak menggantikan apa pun.

### SCNet dan mid/side adalah dua produk berbeda

- **docs/11 §B (mid/side + crossover)** — slider yang bergerak sambil audio
  berbunyi, dievaluasi di graf Web Audio, transparan secara aritmetika saat
  bypass, opsional di-bake. Biayanya nol saat tidak dipakai.
- **SCNet** — tombol yang ditekan sekali, menunggu 1–2 menit, menghasilkan
  4 asset baru (vocals/drums/bass/other) di 4 lane.

Tidak ada satu pun dari keduanya yang bisa memainkan peran satunya. SCNet tidak
bisa jadi slider live; mid/side tidak akan pernah memisahkan drum dari bass.
Menambah SCNet berarti **menambah**, bukan mengganti — dan `StemSection.tsx`
yang sekarang tetap apa adanya.

## Angka yang menentukan

Diukur pada implementasi rujukan, mesin 16 thread:

| Konfigurasi | Per chunk | Realtime factor |
|---|---|---|
| WASM 16 thread + SIMD | 3,2 s | **2,83×** ← jalur produksi |
| WASM single-thread (tanpa COOP/COEP) | — | 0,52× |
| WebGPU (ORT, LSTM jatuh ke CPU) | 12,6 s | 0,87× |

Model: SCNet base, chunk ≈ 476 frame STFT (≈ 11 detik pada hop 1024, n_fft 4096).
Kualitas referensi paper: **SDR 9,0 dB** di MUSDB18-HQ, waktu inferensi CPU
hanya 48% dari HT-Demucs.

**Angka 2,83× itu di 16 thread.** Skala kasarnya linear terhadap jumlah thread,
jadi mesin 4 core kemungkinan ada di ~0,7× realtime → lagu 4 menit ≈ 5–6 menit.
Itu tebakan, dan tebakan tidak boleh masuk roadmap: lihat spike S1.

## Tiga tabrakan yang khas repo ini

Tiga hal berikut tidak dialami demo standalone mana pun, karena demo tidak punya
audio thread realtime yang harus dijaga.

### 1. Kontensi thread dengan AudioWorklet

ORT-web men-spawn thread sebanyak `navigator.hardwareConcurrency`. Worker pool
repo ini sudah sengaja dibatasi `hardwareConcurrency - 2` (ARCHITECTURE.md)
justru supaya audio thread tidak kelaparan. Menjalankan separation dengan
setelan default ORT saat transport playing = underrun (docs/05).

Aturannya: `ort.env.wasm.numThreads = max(1, hardwareConcurrency - 2)`, **dan**
job separation ditolak saat transport sedang playing (atau transport di-stop
lebih dulu, dengan konfirmasi). Ini bukan tuning performa; ini menjaga janji
nomor 2 di ARCHITECTURE.md.

### 2. `COEP: require-corp` mematikan jalur default ORT

Default ORT-web mengambil artefak `.wasm`-nya dari CDN (jsdelivr). Dengan
`require-corp` di `web/public/_headers`, fetch itu **diblokir**. Wajib set
`ort.env.wasm.wasmPaths` ke aset yang di-host sendiri.

Ini punya bentuk kegagalan yang sama persis dengan bug `wasm-urls.ts`: bisa
hidup di satu lingkungan dan mati di lingkungan lain, dengan gejala yang
menyamar jadi "modelnya rusak". Tulis sebagai URL literal self-host sejak baris
pertama, jangan pernah mengandalkan default.

### 3. Budget ukuran

`scripts/size-check.sh` menjaga engine < 300 KB gz. ORT-web wasm (~3 MB gz) +
model 44,5 MB adalah **~15× seluruh `web/dist` sekarang (4,6 MB)**.

Konsekuensi yang harus diterima secara sadar:
- Nol byte dari ini boleh masuk bundle utama. Lazy-load penuh, hanya saat user
  menekan tombolnya.
- Unduhan pertama ~50 MB butuh progress bar-nya sendiri dan tombol batal.
- Hasil unduhan di-cache (Cache API atau `persist/db` yang sudah ada), supaya
  ongkos itu dibayar sekali per browser, bukan sekali per lagu.
- `size-check.sh` tidak perlu diubah — ia menjaga engine, dan engine memang
  tidak ikut membengkak. Justru itu poinnya.

## Di mana ia menempel

Job offline yang menghasilkan asset baru adalah pola yang **sudah ada dan sudah
terbukti** di repo ini — `timeline/stem-bake.ts` melakukan persis itu hari ini.

```
UI: tombol SPLIT (panel clip)
  └─► separate-worker.ts            ← worker baru, pola sama dgn import/export-worker
        ├─ ORT-web session (lazy, self-host wasmPaths, numThreads = cores-2)
        ├─ STFT/iSTFT radix-2 di TS (n_fft 4096, hop 1024)
        └─ per chunk ≈ 11 s → progress ke UI (low-rate postMessage, bukan per-frame)
  └─► 4 × AudioBuffer
        ├─ registerBuffer() + assetFromBuffer()   ← sudah dipakai stem-bake
        ├─ saveAsset()                             ← persist/db, sudah ada
        └─ studioActions: 4 lane baru
```

Yang **tidak** tersentuh: engine Rust, worklet, layout SAB, SPSC ring, format
project, dan seluruh jalur realtime. Itulah alasan utama fitur ini layak — ia
menempel di pinggir sistem, bukan menembusnya.

Gating kapabilitas masuk ke `web/src/audio/caps.ts` yang sudah ada: butuh
`isolated && sab && wasmThreads && simd`. Kalau tidak terpenuhi, tombolnya tidak
ditampilkan, dan alasannya ditulis dengan pola kalimat `degradedReasons()`.

FFT tetap tidak masuk crate Rust. Implementasi rujukan memakai radix-2
Cooley-Tukey ~40 baris JS; naive DFT terukur 97 detik per STFT dan FFT
membuatnya 0,4 detik — jadi ini satu-satunya bagian yang **wajib** ditulis
benar, bukan ditulis sederhana dulu.

## Rencana: 4 spike, yang paling bisa membunuh lebih dulu

Urutan ini mengikuti prinsip docs/09: buktikan yang bisa membatalkan seluruhnya
selagi kodenya masih kecil untuk dibuang.

### S0 — Export ONNX yang terverifikasi (2–3 hari) ⚠️ RISIKO TERTINGGI

`torch.stft`/`torch.istft` tidak punya padanan ONNX yang stabil, jadi yang
di-export hanya inti jaringan (encoder + separation + decoder); FFT internal
diganti perkalian matriks DFT yang diprakomputasi (`MatMulRFFT`/`MatMulIRFFT`,
basis ~0,9 MB). Ini sudah dikerjakan orang di [scnet-web-wasm][ref] (MIT), jadi
tugas di sini adalah **mereproduksi dan memverifikasi**, bukan meneliti.

**Done:** file `.onnx` ada, plus tes numerik melawan PyTorch pada 10 detik audio
acuan dengan korelasi > 0,999. Kalau ini gagal, spike lain tidak ada gunanya.

### S1 — Benchmark jujur di mesin target (1 hari) — GERBANG

Halaman kosong, ORT-web, model hasil S0. Ukur RTF pada 4/8/16 thread dan puncak
memori, di Chrome **dan** Safari desktop.

**Done:** satu tabel angka nyata.
**Gate berhenti:** kalau lagu 4 menit di mesin 8-core > 5 menit, atau puncak
memori > 2 GB, fitur ini tidak dilanjutkan sebagai fitur browser. Keputusan itu
diambil di hari ke-4, bukan setelah UI-nya jadi.

### S2 — STFT/iSTFT + rekonstruksi (1–2 hari)

**Done:** decode → STFT → iSTFT → buffer identik dengan input pada SNR > 100 dB,
**tanpa model sama sekali**. Null test, semangat yang sama dengan M4 docs/09:
jangan pernah men-debug model dan transform sekaligus.

### S3 — Integrasi (2–3 hari)

Worker, progress + batal, cache model, 4 lane bernama, gating `caps.ts`,
penolakan saat transport playing.

**Done:** drop lagu → tombol SPLIT → 4 lane vocals/drums/bass/other → play
bersama → tidak ada underrun, dan null-test docs/09 masih lulus.

**Total realistis: 1,5–2 minggu kerja fokus**, dengan gerbang pembatalan di hari
ke-4.

## Yang harus diputuskan sebelum S0

1. **Lisensi bobot.** Kode SCNet dan scnet-web-wasm MIT, tapi checkpoint
   pretrained-nya datang dari rilis ZFTurbo (Music-Source-Separation-Training)
   dan dilatih di MUSDB18-HQ. Lisensi checkpoint berdiri sendiri dan harus
   dibaca sebelum di-host — terutama kalau produk ini komersial. Ini satu-satunya
   risiko non-teknis di dokumen ini, dan yang paling sering dilewatkan.
2. **fp32 atau fp16.** fp16 menghemat 22 MB unduhan, tapi WASM EP tidak punya
   kernel fp16 — ia akan di-cast dan bisa lebih lambat. Default: **fp32 untuk
   WASM**; fp16 hanya berguna kalau suatu saat pindah ke WebGPU.
3. **iOS.** Batas memori per-tab hampir pasti membuatnya OOM. Sembunyikan di
   iOS sejak awal; gagal di tengah setelah mengunduh 44 MB adalah pengalaman
   terburuk yang bisa diberikan.

## WebGPU: jangan, dan ini alasannya

Jaringan separation SCNet berisi 12 node BiLSTM. WebGPU EP di ORT-web tidak
punya kernel LSTM, jadi setiap node jatuh ke CPU dan menjadi barrier sinkronisasi
— terukur **0,87× realtime, lebih lambat dari WASM**, dengan utilisasi GPU ~20%.
Memperbaikinya berarti menulis LSTM WGSL sendiri (PoC-nya ada dan cepat, tapi
akurasinya turun ke korelasi 0,91 setelah 6 layer).

Jadi WASM + SIMD + thread adalah jalur produksi, dan WebGPU tetap di daftar
"sengaja ditunda" docs/09 — sekarang dengan angka, bukan dengan dugaan.

## Kalau S1 gagal

Urutan mundurnya, dari yang paling menjaga arsitektur:

1. **Chunk lebih pendek + antrean latar** — job berjalan sambil user mengedit,
   dengan thread dibatasi lebih ketat. Menukar waktu tunggu dengan kelancaran.
2. **Model lebih kecil** — Band-SCNet: 2,59 M parameter, SDR 7,79 dB, dirancang
   causal/real-time. Kualitas turun ~1,2 dB tapi ukuran dan biayanya turun jauh
   lebih banyak.
3. **Server-side** — kualitas terbaik dan tercepat, tapi membatalkan "tidak punya
   backend" yang sampai sekarang menjadi salah satu batasan pembentuk arsitektur
   ini. Kalau ini yang dipilih, ia keputusan produk, bukan keputusan teknis.

## Kesimpulan

Repo ini justru termasuk yang **paling siap** menerima SCNet, karena hal paling
sulitnya — cross-origin isolation, SharedArrayBuffer, worker pool, job offline
yang menghasilkan asset, penyimpanan IndexedDB — semuanya sudah ada dan sudah
dipakai. Yang tersisa adalah 44,5 MB unduhan, satu worker, satu FFT, dan
disiplin agar ia tidak pernah menyentuh audio thread.

Kelayakannya tinggi. Yang perlu dijaga adalah ekspektasi: ini fitur "tekan lalu
tunggu", dan ia hidup **di samping** docs/11 §B, bukan menggantikannya.

[ref]: https://github.com/elicwhite/scnet-web-wasm
