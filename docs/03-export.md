# Bagian 3 — Export Pipeline (WAV / MP3 / OGG, semuanya client-side)

## 3a. Offline render architecture

### Kenapa instance engine KEDUA, dan kenapa state di-serialize

Export **tidak boleh** lewat AudioWorklet. Alasan yang sering disebut ("supaya
cepat") benar tapi bukan yang utama. Yang utama:

1. **Realtime terikat wall-clock.** AudioWorklet memanggil `process()` 375×/detik,
   tidak peduli seberapa cepat CPU. Render 5 menit = 5 menit. Offline loop
   memanggil `render_block` secepat CPU sanggup — 5 menit audio bisa selesai
   dalam 5 detik.
2. **Export merusak transport realtime.** Kalau memakai engine yang sama, playhead
   harus dipindah ke 0 dan di-*run*, artinya user tidak bisa mendengar apa pun
   selama export, dan state transport-nya ternoda.

**Kenapa sharing engine state antar instance adalah pabrik bug** — ini pertanyaan
yang tepat, dan jawabannya konkret:

- Engine punya **state DSP yang berevolusi**: state biquad (`s1`,`s2`), envelope
  compressor, isi delay line reverb, posisi fractional cursor voice, nilai
  smoother. Kalau dua thread memproses blok dari state yang sama, hasilnya bukan
  "sedikit beda" — hasilnya **rusak dan non-deterministik**. Reverb tail dari
  playback realtime akan bocor ke output export.
- Membuatnya thread-safe berarti menambahkan lock ke state DSP → melanggar
  aturan real-time safety Bagian 1c.
- Bahkan tanpa lock: playhead. Realtime ada di bar 40, export butuh mulai dari
  bar 0. Satu playhead tidak bisa berada di dua tempat.

Jadi: **yang di-share hanyalah data yang immutable selama export**, yaitu
**asset PCM** (di WASM shared linear memory, read-only). Yang di-*serialize* dan
dikirim ke worker adalah **project model** (clip, track, param, tempo map, graph)
— objeknya kecil (puluhan KB JSON/postcard) dan snapshot-nya konsisten.

```
Main thread                     Export worker
───────────────────────────────────────────────────────────────
project.snapshot()  ─postMessage(bytes + SAB)─►  Engine::from_snapshot(bytes)
                                                 engine.assets = view SAB (read-only)
                                                 loop { render_block() }
```

Snapshot memakai `serde` + `postcard` (binary, no_std-friendly, kecil & cepat).
Format JSON hanya untuk file project di disk (lihat `schema/project.schema.json`).

### Render loop: batch + yield

```
BATCH = 100 blok = 12800 frame ≈ 267 ms audio @48k
```

Kenapa batch dan bukan per-blok:

- `postMessage` per blok = 375 pesan/detik audio × ratusan detik = puluhan ribu
  pesan. Overhead serialisasi + wake main thread jauh melebihi kerja render.
- Per-blok juga tidak berguna: progress bar tidak perlu update >30 Hz.
- Batch 100 blok memberi progress granularity ~0.27 detik audio; untuk lagu
  5 menit = 1125 update. Terlalu banyak. **Throttle tambahan di sisi worker:
  kirim progress maksimal 20×/detik wall-clock**, atau setiap 1% — mana yang
  lebih jarang.

Kenapa harus *yield* sama sekali (worker punya thread sendiri):
- Supaya `onmessage` worker bisa jalan (menerima cancel via postMessage, kalau
  tidak pakai SAB).
- Supaya progress benar-benar terkirim (worker yang sibuk penuh tetap mengirim,
  tapi yield membuat pola-nya rapi).
- Yield pakai `await Promise.resolve()` (microtask, ~0 biaya) **tidak cukup** —
  itu tidak menjalankan message queue. Harus macrotask: `await new Promise(r =>
  setTimeout(r, 0))` atau `MessageChannel` ping (lebih cepat, tidak kena clamp
  4 ms). Kita pakai `MessageChannel`.

### Progress + cancellation

**Progress** dilaporkan sebagai:
```ts
{ type:'progress', rendered: number /*frames*/, total: number,
  stage: 'render'|'encode', etaMs: number }
```
ETA dihitung dari throughput rata-rata bergerak (EMA) frame/ms, bukan dari
sample pertama — throughput awal selalu pesimis (JIT belum panas).

**Cancellation** lewat `Atomics.load(flags, EXPORT_CANCEL)` yang dicek
**sekali per batch** (bukan per blok — 375 atomic load/detik untuk hal yang
berubah sekali seumur hidup itu boros, walau murah). Ordering `Relaxed`: telat
267 ms untuk membatalkan itu tidak masalah.

Kalau SAB tidak tersedia (degraded mode), cancel lewat `postMessage` yang
terbaca saat yield — sama saja efeknya karena kita memang yield tiap batch.

Setelah cancel: worker membuang buffer, mengirim `{type:'cancelled'}`, dan
**tidak** memanggil encoder. Sink di-`abort()` — apa yang sudah ditulis dibuang,
termasuk swap file di disk (lihat 3b).

## 3b. WAV encoder (pure Rust, `wasm32-unknown-unknown`)

Kode: [`crates/export/src/wav.rs`](../crates/export/src/wav.rs)

### hound + Cursor

Tidak ada filesystem di WASM, jadi:
```rust
let mut cursor = Cursor::new(Vec::<u8>::with_capacity(estimated));
let mut w = hound::WavWriter::new(&mut cursor, spec)?;
```
`hound` murni Rust, tidak ada `build.rs` yang memanggil cc, compile mulus ke
`wasm32-unknown-unknown`. Untuk 32-bit float, `spec.sample_format =
SampleFormat::Float`; untuk 16/24-bit, `Int`.

### Dither f32 → 16-bit: kenapa TPDF, bukan RPDF

Kuantisasi tanpa dither menghasilkan **error yang berkorelasi dengan sinyal** —
terdengar sebagai distorsi harmonik dan "kekasaran" di tail yang meluruh, bukan
sebagai noise. Dither adalah noise yang ditambahkan **sebelum** kuantisasi untuk
men-dekorelasi error itu.

- **RPDF** (rectangular, 1 LSB, satu sumber uniform): men-dekorelasi *mean* error,
  tapi **variansi error masih bergantung sinyal** → terdengar sebagai "noise
  modulation": noise floor yang naik-turun mengikuti musik. Ini artefak yang
  jelas terdengar di fade-out.
- **TPDF** (triangular, 2 LSB, jumlah dua sumber uniform independen): membuat
  **mean *dan* variansi error independen dari sinyal**. Noise floor-nya konstan,
  ~4.77 dB lebih tinggi dari RPDF, tapi *stationary* — telinga jauh lebih
  toleran terhadap noise konstan daripada noise yang bermodulasi. Ini standar
  industri.

```rust
// TPDF: dua RNG uniform independen dijumlahkan
let d = (rng.next_f32() - rng.next_f32()) * lsb;   // rentang ±1 LSB, segitiga
let y = (x * scale + d).round().clamp(min, max) as i32;
```

RNG-nya harus cepat dan tidak alokasi: xorshift128+ atau PCG32 (`crates/export/src/dither.rs`).
Seed dari parameter export supaya **reproducible** — dua export dengan setelan
sama menghasilkan file byte-identik, yang penting untuk tes null.

**Noise shaping (opsional, di belakang flag):** filter error kuantisasi kembali
ke input dengan kurva yang memindahkan energi noise ke >15 kHz di mana telinga
kurang sensitif. Bentuk sederhana yang terbukti: 2nd-order error feedback dengan
koefisien "E-weighted". Efeknya ~10 dB perceived noise floor lebih rendah di
16-bit. **Tidak untuk MVP**: menambah state, dan salah implementasi bisa membuat
filter tidak stabil. Ditawarkan sebagai opsi "16-bit + noise shaping" nanti.

Dither **hanya** untuk 16-bit (dan opsional 24-bit — di 24-bit noise floor sudah
di bawah noise floor ruang mana pun, jadi default: mati). **Tidak pernah** untuk
32-bit float.

### 24-bit packing

Rust tidak punya `i24`. hound menerima `i32` dengan `bits_per_sample = 24` dan
menuliskan 3 byte little-endian. Kalau menulis manual:

```rust
#[inline]
fn write_i24_le(out: &mut Vec<u8>, v: i32) {
    let v = v.clamp(-8_388_608, 8_388_607);
    out.push((v         & 0xFF) as u8);
    out.push(((v >> 8)  & 0xFF) as u8);
    out.push(((v >> 16) & 0xFF) as u8);
}
```
Perhatikan: `clamp` ke rentang 24-bit **sebelum** shift, dan `>> ` pada `i32`
adalah arithmetic shift, jadi byte ke-3 sudah membawa bit tanda dengan benar.

### Streaming lewat sink

Render 10 menit stereo 24-bit = 48000×600×2×3 = **172 MB**. Satu `Vec<u8>`
sebesar itu di WASM memaksa `memory.grow` besar (dan di 32-bit WASM, ruang
alamat total hanya 4 GB — dengan asset PCM yang juga besar, ini nyata).

Pola yang dipakai:

1. Tulis **header WAV** dulu dengan ukuran placeholder.
2. Render + encode dalam **chunk 4 MiB**. Tiap chunk selesai:
   - worker `postMessage` chunk sebagai `ArrayBuffer` **transferable**
     (zero-copy: buffer berpindah kepemilikan, tidak dikopi)
   - Rust me-*reset* `Vec` chunk (`clear()`, kapasitas dipertahankan → nol alokasi
     setelah chunk pertama)
3. Chunk diserahkan ke sebuah **sink** (`web/src/studio/export/sinks.ts`) dan
   segera dilupakan. `runExport` tidak pernah memegang lebih dari satu chunk.
4. Selesai: **patch header** (ukuran RIFF & data chunk sudah diketahui) ditulis
   menimpa posisi 0, lalu sink ditutup.

Ada tiga sink, dan pilihannya menentukan batas ukuran file:

| Sink | Ke mana | Batas |
|---|---|---|
| `FileSystemSink` | `createWritable()` → disk, per chunk | ukuran disk |
| `PostMessageSink` | worker → main thread, transferable | (meneruskan saja) |
| `BlobSink` | `BlobPart[]` di memori | RAM/limit Blob browser |

**Kenapa lapisan ini ada.** Versi sebelumnya menumpuk SELURUH file di satu
`BlobPart[]`, dan worker menambah satu tahap lagi: `blob.arrayBuffer()`, yaitu
satu ArrayBuffer sebesar seluruh export. Semua kerja streaming di sisi Rust
dibayar ulang di boundary JS, dan export panjang gagal di sana — bukan di
engine. `BlobSink` masih melakukan hal yang sama, tapi sekarang ia adalah
*fallback* yang dipilih secara sadar untuk browser tanpa File System Access
(Firefox, Safari), bukan satu-satunya jalur.

Pada pembatalan atau kegagalan, sink di-`abort()`: `FileSystemSink` membuang
swap file-nya sehingga tidak ada berkas separuh jadi yang tertinggal di disk
terlihat seperti export yang berhasil.

### Di mana export dijalankan, dan kenapa itu soal memori

Export studio berjalan di **worker**, dengan artefak **`st`** yang memory-nya
sendiri (`studio/export/worker-host.ts` + `audio/export-worker.ts`). Main thread
memegang dua hal yang tidak diseberangkan: tujuan berkasnya (`ExportSink`) dan
PCM-nya.

Alasan yang biasa disebut — "supaya UI tidak membeku" — bukan alasan utamanya.
Yang menentukan: **linear memory wasm tidak pernah menyusut.** Render menaruh
seluruh PCM project di linear memory, dan `OfflineRender::drop` memang
membebaskannya — tapi hanya ke alokator DI DALAM wasm. Halaman yang sudah
ditumbuhkan tetap milik instance itu sampai instance-nya sendiri hilang.

Konsekuensinya kalau export berjalan di instance main thread: satu export
project 400 MiB membuat tab menahan 400 MiB itu sampai halaman di-reload,
walaupun export-nya sudah lama selesai. Tidak ada API untuk mengembalikannya —
`memory.shrink` tidak ada.

Worker punya satu langkah yang tidak dimiliki main thread: `terminate()`.
Instance-nya hilang, memory-nya hilang, dan yang kembali ke sistem operasi bukan
cuma PCM-nya melainkan seluruh runtime export. Karena itu `terminate()` dipanggil
di `finally` — sukses, gagal, maupun batal.

Syaratnya varian `st`, bukan `mt`. Varian `mt` meng-IMPORT memory bersama milik
main thread dan worklet; export di atasnya akan menumbuhkan memory yang SAMA
dengan yang dipakai playback, dan `terminate()` tidak membebaskan apa pun.
Render offline satu thread (lihat `OfflineRenderer`), jadi tidak ada yang hilang.

**Jalur cadangan.** Kalau `Worker` tidak ada, atau worker gagal **sebelum satu
byte pun ditulis** ke sink (modul worker tidak bisa dimuat, encoder lazy-nya
tidak hidup di worker), export diulang di main thread. Ia berfungsi penuh —
hanya saja memorinya tidak bisa dikembalikan. Batas "sebelum byte pertama" itu
yang membuat pengulangannya aman: sesudah sebagian file ditulis, mengulang
berarti berkas berisi dua export yang disambung.

### PCM ditarik sepotong demi sepotong

`ExportAssetSource` menjawab satu potong (`PCM_CHUNK_FRAMES`, 1 MiB) per
permintaan, bukan seluruh channel satu asset. Dua sumber memakainya:

- **`audioBufferPcmSource`** (main thread) membaca dari cache preview lewat
  `copyFromChannel`, **bukan** `getChannelData`. Di Gecko, panggilan pertama
  `getChannelData` membangkitkan salinan JS penuh per channel yang menempel pada
  `AudioBuffer` selama ia hidup — untuk export itu berarti satu salinan permanen
  dari seluruh audio project, muncul saat export berjalan dan tidak pernah
  kembali sesudahnya. `copyFromChannel` membaca dari penyimpanan yang sama tanpa
  membangkitkannya, dengan satu buffer antara sebesar satu potongan yang dipakai
  ulang.
- **worker** meminta potongan itu lewat `postMessage` dan menyalinnya ke linear
  memory. `postMessage` MENYALIN, jadi mengirim seluruh PCM di muka berarti satu
  salinan penuh project di heap JS worker.

Potongan yang dikembalikan hanya sah **sampai permintaan berikutnya** (buffer
antaranya dipakai ulang). `fillAsset` dan `worker-host` sama-sama menyalinnya
segera; `pcm-source.test.ts` yang menjaga kontrak itu tetap berlaku.

Efek sampingnya di `fillAsset`: pengisian asset sekarang `await`, jadi view ke
linear memory diambil ULANG tiap potong — lihat docs/05 §WASM memory growth.

### Batas 4 GiB WAV

WAV klasik menyimpan ukuran RIFF **dan** ukuran data di field 32-bit, jadi
batasnya `2^32 - 1 - 36` byte data:

| Format (stereo @48k) | Byte/frame | Batas |
|---|---|---|
| PCM 16-bit | 4 | ~6,2 jam |
| PCM 24-bit | 6 | ~4,1 jam |
| Float 32-bit | 8 | ~3,1 jam |

Angkanya dihitung `WavStreamWriter::max_frames()` dan **hanya** di sana; sisi JS
membacanya lewat `Encoder.limitFrames()`. Export yang melewatinya ditolak
sebelum blok pertama dirender — bukan di byte terakhir, dan bukan (seperti
sebelumnya) dijepit diam-diam dengan `saturating_add` sehingga file selesai
dengan panjang yang bohong.

Untuk melewati batas itu diperlukan **RF64**, yang belum ada. Sementara ini
jalan keluarnya: FLAC, bit depth lebih rendah, atau rentang yang lebih pendek —
dan pesan errornya menyebutkan ketiganya.

## 3c. MP3 & OGG — analisis toolchain

### Verifikasi fakta yang kamu sebutkan

| Klaim | Status |
|---|---|
| LAME & libvorbis adalah C library | ✅ Benar |
| `mp3lame-encoder`, `vorbis_rs` adalah FFI binding, tidak link di `wasm32-unknown-unknown` | ✅ Benar. `wasm32-unknown-unknown` tidak punya libc/C toolchain; `cc` crate tidak bisa membangun sumber C untuk target itu tanpa sysroot. (`wasm32-wasi` *bisa* dengan wasi-sdk, tapi worker browser bukan lingkungan WASI — butuh shim, dan itu jalur lain lagi.) |
| Tidak ada pure-Rust MP3 **encoder** production-grade | ✅ Benar sepanjang pengetahuan saya. `puremp3`, `symphonia`, `minimp3-rs` semuanya **decoder**. Yang paling dekat dengan encoder pure-Rust adalah port dari **Shine** (encoder MP3 fixed-point yang sederhana) — Shine hanya CBR, kualitasnya di bawah LAME pada bitrate yang sama, dan port Rust-nya bukan proyek yang dipelihara serius. **Jangan taruh ini di jalur kritis produk.** |
| `lewton` = decoder saja, crate `ogg` = container saja | ✅ Benar. Tidak ada Vorbis encoder pure-Rust. |
| Opus | Encoder referensi (libopus) juga C. `audiopus` = binding. Ada usaha port Rust tapi tidak production-grade. **Tapi**: browser sendiri bisa meng-encode Opus lewat `MediaRecorder` (WebM/Opus) dan `WebCodecs` `AudioEncoder` — nol byte tambahan. Lihat catatan di bawah. |

**Kesimpulan jujur: ekosistem C tetap tak terhindarkan untuk encoding lossy di
2026.** Encoder psikoakustik yang matang butuh 20+ tahun tuning; tidak ada
insentif ekonomi untuk menulis ulang di Rust, dan hasil port yang setengah jadi
lebih buruk daripada memakai C yang sudah teruji.

### Perbandingan jalur

| | **A — emcc sidecar sendiri** | **B — encoder WASM siap pakai** | **C — pure Rust** |
|---|---|---|---|
| **Apa** | Compile LAME + libvorbis + wrapper C tipis via `emcc` → `encoders.wasm` | Pakai artefak yang sudah dibangun & teruji: `lamejs` (MP3, JS murni port LAME), `@breezystack/lamejs`, `ogg-vorbis-encoder-js` (emcc libvorbis), atau `ffmpeg.wasm` audio-build | Shine-port (MP3), tidak ada (Vorbis) |
| **Ukuran** | LAME ~150–250 KB gz, libvorbis ~250–400 KB gz | lamejs ~50 KB gz (JS), ogg-vorbis-encoder-js ~350 KB gz, **ffmpeg.audio.wasm ~5 MB** | ~40 KB |
| **Build complexity** | Tinggi: emsdk di CI, patch build system LAME/vorbis, tuning `-O3 -msimd128 -sMODULARIZE -sEXPORTED_FUNCTIONS`, reproducibility | Nol — `pnpm add` | Rendah |
| **Kecepatan encode**<br/>(5 menit stereo, laptop 4-core) | LAME wasm ≈ **3–6 s** (≈50–100× realtime) | lamejs (JS) ≈ **10–20 s** (≈15–30× realtime) · libvorbis wasm ≈ **6–12 s** · ffmpeg.wasm ≈ **10–25 s** + 2–5 s load | Shine sangat cepat tapi kualitas rendah |
| **Memory copy** | PCM harus **dikopi** dari linear memory engine ke linear memory encoder. Dua modul WASM = dua ruang memori terpisah; tidak bisa di-share kecuali sengaja dibangun dengan `--shared-memory` yang sama (rumit & rapuh). Biaya: 1 salinan chunk (mis. 4 MB) — **~1 ms per 4 MB, dapat diabaikan** dibanding waktu encode | Sama (1 salinan) + untuk ffmpeg **2 salinan ekstra** (tulis WAV ke MEMFS, baca output dari MEMFS) | Nol (in-process) |
| **Lisensi** | LAME = **LGPL 2.1**. Dipakai sebagai library terpisah yang dapat diganti → kewajiban: sebut lisensi, sediakan sumber LAME + kemampuan mengganti library. Untuk WASM yang di-*bundle*, tafsir aman: distribusikan `encoders.wasm` sebagai file terpisah (bukan di-inline ke bundle utama) + sediakan source & build script. libvorbis = BSD-like (bebas) | Sama untuk LAME. ffmpeg build bisa GPL kalau ada komponen GPL — **cek build flags**; ffmpeg LGPL-only build aman | Shine = LGPL juga |
| **Maintenance** | Kamu yang memelihara build C. Tapi stabil (LAME praktis beku sejak 3.100) | Bergantung maintainer paket. lamejs stabil/beku | Kamu memelihara encoder — **tidak realistis** |
| **Kontrol (VBR, q setting)** | Penuh: `lame_set_VBR`, quality preset, tag | lamejs: CBR + VBR terbatas. ogg-vorbis-encoder-js: quality -0.1..1.0 penuh | — |

### Rekomendasi

**MVP: JALUR B, tapi BUKAN ffmpeg.wasm.**

- **WAV** → Rust `hound`, in-process. Selalu tersedia, nol dependensi, ini format
  default export.
- **MP3** → `lamejs` (port JS dari LAME, ~50 KB, tidak ada WASM sama sekali,
  tidak ada masalah cross-origin/COEP, `import()` dinamis). Kecepatannya cukup:
  5 menit stereo ≈ 10–20 s — **melewati** target 15 s hanya di kasus terburuk,
  dan bisa dikejar dengan menjalankannya di worker terpisah (paralel dengan
  render) atau memecah ke 2–4 worker per-segmen lalu menyambung frame MP3
  (MP3 frame-independent kalau tanpa bit reservoir antar-segmen; sambungan di
  batas frame aman untuk CBR).
- **OGG** → `ogg-vorbis-encoder-js` (emcc libvorbis, ~350 KB gz), **lazy-load**
  hanya saat user memilih OGG.

Alasan menolak ffmpeg.wasm untuk MVP: 5 MB unduhan, waktu instantiasi 2–5 detik,
MEMFS round-trip yang menambah 2 salinan, API `exec()` berbasis argumen CLI yang
sulit di-progress-report, dan risiko lisensi tergantung build. Kita hanya butuh
dua encoder; membawa seluruh ffmpeg untuk itu tidak proporsional. ffmpeg.wasm
baru masuk akal kalau nanti butuh **impor** format eksotis atau **video**.

**Versi matang: JALUR A**, satu sidecar `encoders.wasm` berisi LAME + libvorbis +
(opsional) libopus + FLAC, dibangun dengan `emcc -O3 -msimd128`, di-*modularize*,
dengan wrapper C tipis:

```c
// encoders/wrapper.c
void*  enc_mp3_new(int sr, int ch, int kbps, int vbr_q);
int    enc_mp3_write(void* h, const float* l, const float* r, int n, unsigned char* out);
int    enc_mp3_flush(void* h, unsigned char* out);
void   enc_mp3_free(void* h);
// ... enc_vorbis_* serupa
```

Keuntungannya: 3–5× lebih cepat dari lamejs, VBR penuh, satu artefak untuk semua
format, SIMD. Biayanya: emsdk di CI. Pindah dari B ke A **tidak mengubah
arsitektur** — antarmuka `Encoder` di `web/src/encoders/types.ts` sama, hanya
implementasinya yang ditukar. Itulah sebabnya B aman dipilih sekarang.

**Catatan Opus / WebCodecs:** kalau target-nya "file kecil untuk dibagikan",
`AudioEncoder` (WebCodecs) bisa meng-encode Opus/AAC **native, nol byte
tambahan, sangat cepat**, tersedia di Chrome/Edge/Safari 16.4+. Kekurangannya:
output-nya harus dimasukkan ke container sendiri (WebM/MP4 muxer, ~20 KB JS),
dan Firefox baru menyusul. Layak ditambahkan sebagai format "OPUS (cepat)" —
tapi MP3 tetap wajib karena kompatibilitas universal.

### Antarmuka encoder (agar jalur bisa ditukar)

```ts
export interface Encoder {
  readonly mime: string;
  readonly ext: string;
  init(opts: { sampleRate: number; channels: number }): Promise<void>;
  /** planar f32, panjang bebas. Mengembalikan chunk terenkode (boleh kosong). */
  encode(planar: Float32Array[]): Uint8Array;
  finish(): Uint8Array;
}
```
Implementasi: `WavEncoder` (memanggil WASM Rust), `Mp3LameJsEncoder`,
`OggVorbisEncoder`, nanti `SidecarEncoder`.

## 3d. File delivery

### Blob + object URL (baseline, jalan di mana saja)

```ts
const blob = new Blob(parts, { type: encoder.mime });
const url = URL.createObjectURL(blob);
const a = Object.assign(document.createElement('a'), { href: url, download: name });
a.click();
// Jangan revoke langsung — Safari membutuhkan URL tetap hidup saat unduhan dimulai.
setTimeout(() => URL.revokeObjectURL(url), 60_000);
```

**Lifecycle `revokeObjectURL`** penting: object URL menahan Blob di memori/disk
sampai di-revoke **atau dokumen dibongkar**. Untuk export 170 MB yang dilakukan
berulang, lupa revoke = kebocoran nyata. Aturan di kode ini: setiap
`createObjectURL` didaftarkan ke `ObjectUrlRegistry` yang me-revoke setelah 60 s
dan pada `beforeunload`.

### File System Access API (progressive enhancement)

```ts
if ('showSaveFilePicker' in window) {
  const handle = await window.showSaveFilePicker({
    suggestedName: name,
    types: [{ description: 'Audio', accept: { [encoder.mime]: ['.' + encoder.ext] } }],
  });
  const w = await handle.createWritable();
  for await (const chunk of stream) await w.write(chunk);   // streaming, memori konstan
  await w.close();
}
```

Keunggulannya bukan sekadar UX: **memori konstan**. Chunk ditulis langsung ke
disk, tidak pernah ada Blob 170 MB. Untuk export panjang inilah jalur yang benar.

Feature detection wajib: Firefox dan Safari belum mendukung (per 2026 Safari
punya dukungan sebagian lewat OPFS saja, bukan `showSaveFilePicker`). Fallback
ke jalur Blob otomatis. Perlu **user gesture** — picker harus dipanggil dari
handler klik tombol EXPORT, **sebelum** render mulai, bukan setelah. Jadi urutan
UI-nya: klik EXPORT → (opsional) pilih lokasi → render → tulis.
