# 10 — Deteksi tempo (BPM)

Pelacak BPM gaya DJ: tiap clip yang berbunyi di playhead menampilkan tempo
materinya, sudah dikalikan kecepatan lane dan transport. Sel **BPM** di readout
strip yang menampilkannya.

Semua analisisnya di Rust/WASM (`crates/analysis`), dijalankan sekali per asset
saat import, di dalam Web Worker.

## Kenapa di WASM, dan kenapa di worker

Beban kerjanya satu lintasan filterbank enam biquad atas SELURUH materi. Diukur
lewat artefak `st` yang sebenarnya:

| materi | durasi | waktu |
|---|---|---|
| lagu #1 | 97 s @48k stereo | 96 ms |
| lagu #2 | 203 s @44.1k stereo | 179 ms |

≈1 ms per detik audio. Di main thread itu terlihat sebagai UI membeku tepat saat
user melepas file — persis momen yang paling tidak boleh terasa patah. Karena
itu `audio/tempo-worker.ts` berdiri sendiri dan memuat varian **`st`**: analisis
tidak berbagi memori dengan thread audio, jadi memory sendiri justru yang benar,
dan `st` tetap bisa dimuat tanpa cross-origin isolation (docs/01 §1d).

## Alur

```
PCM (AudioBuffer)
  └─ studio/analysis/tempo-client.ts   salin + transfer ke worker
       └─ audio/tempo-worker.ts        muat glue st, panggil detectTempo
            └─ daw_analysis::detect_bpm
                 ├─ odf.rs     PCM → onset detection function @200 Hz
                 └─ tempo.rs   ODF → BPM + keyakinan + fase ketukan
       └─ studioActions.setAssetTempo(id, …)
            └─ studio/analysis/playhead-tempo.ts   clip aktif × kecepatan
                 └─ studio/shell/BpmCell.tsx
```

### Harga PCM-nya, dan kenapa antre

`detect_bpm` membaca materi pada sample rate PENUH — filterbank enam biquad
tanpa desimasi (`odf.rs`), jadi tidak ada versi murah yang bisa dikirim
menggantikannya. Artinya satu asset 28 menit stereo @48k = **610 MiB** PCM yang
harus menyeberang ke worker.

Dua aturan menahan biayanya, dan keduanya tidak terlihat dari hasilnya:

1. **`copyFromChannel`, bukan `getChannelData`.** Salinannya sendiri tidak bisa
   dihindari (buffer yang di-transfer jadi detached, dan audio yang baru
   di-import harus tetap bisa diputar). Yang bisa dihindari adalah salinan
   KEDUA: di Gecko, `AudioBuffer` hasil `decodeAudioData` menyimpan datanya di
   luar heap JS, dan permintaan pertama lewat `getChannelData` memindahkannya ke
   `Float32Array` JS yang menempel pada buffer itu (`mJSChannels`) selama ia
   hidup. Snapshot memori produksi menunjukkannya apa adanya: 6 × 304,9 MiB
   ArrayBuffer, semuanya berakar di `mJSChannels[i]` — tiga stem stereo 27,75
   menit, seluruhnya pindah ke heap JS hanya karena analisis tempo membacanya.

2. **Satu asset pada satu waktu.** Worker menganalisis serial, jadi mengirim
   semuanya di muka tidak mempercepat apa pun — ia hanya menumpuk salinan PCM di
   message queue. Empat stem yang di-drop bersamaan = 2,4 GiB yang menunggu
   giliran. Dengan antrean di `tempo-client.ts`, yang berwujud di luar cache
   preview tidak pernah lebih dari satu asset.

Giliran dilepas pada hasil, pada `tempo-error`, DAN pada `worker.onerror`.
Melewatkan yang terakhir membuat satu worker yang mati menghentikan antrean
selamanya — gejalanya bukan error, melainkan BPM yang tidak pernah muncul untuk
semua file berikutnya.

## Tiga mekanisme yang menentukan hasilnya

Mencari periode itu mudah; yang sulit adalah **ambiguitas oktaf** — lagu 128 BPM
juga sangat periodik pada 64 dan 256. Tiga hal bekerja bersama, dan ketiganya
diperlukan (tiap satu dilepas, ada tes yang jatuh):

1. **Sisir harmonik.** Skor periode `p` = `acf(p) + ½acf(2p) + ¼acf(3p) + ⅛acf(4p)`.
   Mematikan kesalahan tempo-dobel. Toleransi tiap harmonik melebar dengan nomor
   harmoniknya karena periode sejati hampir tidak pernah jatuh di lag bulat.
2. **Prior tempo** (Gauss-log di 120 BPM). Menjaga hasil di rentang yang
   didengar manusia.
3. **Hukuman subdivisi.** Kalau `p` benar, seharusnya tidak ada ketukan di
   tengahnya. Ditimbang oleh prior pada `2·bpm` — kalau tempo ganda itu sendiri
   tidak masuk akal, puncak di `p/2` itu subdivisi 1/8, bukan ketukan.
   Ini satu-satunya yang bisa memisahkan 85 dari 170 BPM, karena keduanya
   simetris persis terhadap pusat prior (√(85·170) = 120.2) sehingga prior pun
   tidak memihak.

ODF dihaluskan (σ 1.5 frame) sebelum autokorelasi. Tanpa itu puncak ACF hanya
selebar satu frame sementara skor dievaluasi di lag bulat, dan kerugian setengah
frame porsinya lebih besar untuk tempo cepat — bias sistematis yang membuat
tempo cepat kalah dari kelipatannya.

## Keyakinan

`confidence` = rata-rata geometrik dari periodisitas (porsi variasi ODF yang
dijelaskan periode itu) dan salience (seberapa menonjol puncaknya). **Skalanya
tidak sesuai intuisi** — diukur pada materi nyata:

| materi | keyakinan |
|---|---|
| derau putih | 0.015 |
| pad ambient tanpa transien | 0.017 |
| burst mirip bicara | 0.046 |
| lagu nyata #1 (155 BPM) | 0.191 |
| lagu nyata #2 (135 BPM) | 0.224 |
| groove sintetis (tes Rust) | 0.45 – 0.60 |

Ambang `TEMPO_UNCERTAIN = 0.1` duduk di celah antara dua kelompok itu. Angka
0.2 yang dipakai lebih dulu SALAH: kedua lagu nyata di atas akan ditandai "tidak
yakin" padahal BPM-nya terbukti benar — tiap potongan 25 detiknya memberi angka
yang sama (155.32 / 155.10 dan 134.99 / 135.10 / 135.05 / 135.07).

## Yang sengaja TIDAK dilakukan

- **Tidak menebak diam-diam.** Materi < 8 detik atau senyap mengembalikan
  `None`, dan UI menampilkannya sebagai "—" dengan alasannya, bukan sebagai 0.
- **Tidak memaksakan satu oktaf.** Oktaf tempo memang tidak selalu bisa
  diputuskan mesin: lagu 170 BPM dengan backbeat sama sahnya didengar sebagai
  85. Sel BPM menyediakan ×2 / ÷2, seperti semua perkakas DJ, dan koreksinya
  disimpan per asset.
- **Belum ada beatgrid.** `beat_offset_sec` sudah dihitung dan dikembalikan,
  tapi belum ada yang menggambarnya. Itu bahan untuk snap-to-beat.
- **Tempo tidak ikut disimpan.** Yang disimpan (nanti, lewat kepustakaan
  eksplisit) hanya byte file asli, jadi tempo dianalisis ulang tiap kali lagunya
  dimuat. Menyimpan hasil turunan berarti satu bentuk data lagi yang bisa basi
  terhadap perbaikan algoritma, dan biayanya cuma ratusan milidetik di worker.
