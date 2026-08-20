# Bagian 5 — Failure Modes & Mitigasi

## Underrun (xrun)

### Apa yang browser lakukan

Kalau `process()` melebihi deadline, browser **tidak crash dan tidak melempar
error**. Yang terjadi: audio callback berikutnya dari sistem audio menemukan
buffer belum terisi, dan hardware memainkan apa yang ada — biasanya buffer lama
atau nol. Terdengar sebagai klik/pop atau potongan senyap. Chrome mencatat ini
sebagai `AudioContext` "glitch" di internal metrics tapi tidak mengeksposnya
secara langsung.

Kalau `process()` **melempar exception**, itu lain cerita: node masuk state
error permanen, `process()` tidak pernah dipanggil lagi, output senyap selamanya.
Ini yang terjadi kalau Rust `panic!` (trap `unreachable`). Karena itu aturan
"no panic" di Bagian 1c bukan estetika — ia mencegah kematian total.

### Cara mendeteksi

Dua sinyal, keduanya dipakai:

1. **Gap pada `currentFrame`.** Di worklet, `currentFrame` bertambah tepat
   `frames` per callback dalam kondisi normal. Kalau ia melompat lebih jauh,
   berarti ada callback yang dilewati:
   ```ts
   const expected = this.lastFrame + 128;
   if (this.lastFrame >= 0 && currentFrame > expected) {
     const lost = (currentFrame - expected) / 128;
     Atomics.add(this.i32, XRUN_COUNT, lost);
   }
   this.lastFrame = currentFrame;
   ```
2. **Self-timing.** Ukur durasi `render_block` di dalam Rust dengan
   `currentTime` delta yang dilewatkan dari JS (worklet tidak punya timer
   presisi tinggi sendiri; `performance.now()` tidak ada di
   AudioWorkletGlobalScope pada beberapa implementasi). Praktisnya: worklet
   mengukur `performance.now()` kalau tersedia, dan menulis
   `cpu_load_q16 = elapsed / deadline` (Q16) ke SAB dengan EMA. UI menampilkan
   meter CPU. Kalau load >0.7 secara berkelanjutan, kita sudah tahu xrun akan
   datang **sebelum** terjadi.

### Degradation strategy

Berjenjang, dipicu oleh `cpu_load` EMA, dengan histeresis (naik di 0.75,
turun di 0.55) supaya tidak berkedip:

| Level | Pemicu | Aksi |
|---|---|---|
| 0 | load < 0.75 | normal |
| 1 | load > 0.75 | Turunkan kualitas *non-esensial*: reverb dari 8 ke 4 comb line, resampler dari sinc ke cubic, matikan analyzer spectrum (UI-only) |
| 2 | load > 0.85 | **Bypass FX pada track yang di-mute atau tidak terdengar** (peak < -60 dBFS selama >1 s). Ini gratis secara persepsi |
| 3 | load > 0.92 atau xrun terdeteksi | Bypass insert chain per-track mulai dari track dengan prioritas terendah (urutan ditentukan user, default: urutan track terbalik). Kirim notifikasi UI "FX di-bypass karena beban CPU" |
| 4 | xrun berulang >5×/detik | Hentikan playback, tampilkan dialog: sarankan **freeze track** |

**Freeze** adalah mitigasi struktural yang sesungguhnya: render satu track
(dengan seluruh insert chain-nya) ke asset PCM baru lewat export worker, lalu
mainkan asset itu tanpa FX. Biaya CPU turun dari "N efek" jadi "satu clip".
Ini fitur yang sama-sama dipakai semua DAW dan wajib ada sebelum klaim
"32 track".

## WASM memory growth

**Masalah:** `memory.grow` **men-detach** `ArrayBuffer` lama. Semua
`Float32Array`/`Uint8Array` JS yang menunjuk ke linear memory jadi **kosong
(byteLength 0)** — tanpa exception, tanpa peringatan. Kode yang membaca dari
view lama diam-diam membaca nol. Gejalanya: audio tiba-tiba senyap, atau
waveform jadi garis lurus.

(Untuk *shared* memory, `growable SharedArrayBuffer` tidak men-detach di
spesifikasi terbaru — tapi view lama tetap hanya melihat panjang lama. Jangan
mengandalkan perbedaan ini.)

Tiga mitigasi, **dipakai bersama**:

**1. Pre-reserve saat instantiasi.** Ini yang utama untuk audio thread:

```ts
const memory = new WebAssembly.Memory({
  initial: 256,        // 16 MiB — engine + scratch
  maximum: 32768,      // 2 GiB — batas atas, TIDAK dialokasi di awal
  shared: true,
});
```
Untuk shared memory, `maximum` **wajib**. Reservasi ruang alamat itu murah
(virtual, bukan fisik). Lalu di sisi Rust, semua buffer engine dialokasi di
`engine_new()` — setelah itu audio thread tidak pernah memicu grow karena
tidak pernah alokasi (aturan 1c). **Growth hanya terjadi saat import asset**,
yang dilakukan oleh worker/main thread.

**2. Re-acquire view setelah setiap panggilan yang bisa alokasi.** Pola wajib
di sisi JS:

```ts
// SALAH — cache view
class Bad { buf = new Float32Array(memory.buffer, ptr, len); }

// BENAR — view diambil ulang, murah (~50ns), dan selalu valid
function view(ptr: number, len: number): Float32Array {
  return new Float32Array(memory.buffer, ptr, len);   // memory.buffer diambil segar
}
```
Di worklet, view untuk output di-cache **tapi** di-validasi:
```ts
if (this.outView.length === 0 || this.memBuffer !== memory.buffer) {
  this.memBuffer = memory.buffer;
  this.outView = new Float32Array(memory.buffer, this.outPtr, 256);
}
```
Cek `this.memBuffer !== memory.buffer` adalah satu perbandingan referensi per
blok — tidak terukur biayanya, dan menangkap semua kasus.

**3. Ia tidak pernah menyusut — jadi yang tumbuh besar harus punya tempat untuk
mati.** `memory.grow` ada; `memory.shrink` tidak. Membebaskan buffer di sisi
Rust hanya mengembalikannya ke alokator di dalam wasm; halaman yang sudah
ditumbuhkan tetap dipegang instance itu selama instance-nya hidup.

Gejalanya bukan crash melainkan angka yang tidak mau turun: sesudah satu export
besar selesai, tab menahan ratusan MiB sampai di-reload, dan snapshot memori
menunjukkan `SharedArrayBuffer`/`ArrayBuffer` sebesar puncak export walaupun
tidak ada lagi yang memakainya.

Dua akibat praktis:

- **Jangan menghitung sisa memori sebagai `plafon − byteLength`.** Sesudah satu
  export, `byteLength` masih sebesar puncaknya walaupun ruangnya siap dipakai
  ulang, dan rumus itu akan menolak export berikutnya selamanya. Angka yang
  benar datang dari Rust (`assetBytesLive`/`assetBytesPeak`) — lihat
  `memoryHeadroomBytes` di `studio/export/wasm-engine.ts`.
- **Pekerjaan yang menumbuhkan memory secara besar dan sesekali dijalankan di
  worker dengan memory SENDIRI (varian `st`), lalu di-`terminate()`.** Itu
  satu-satunya cara mengembalikan halamannya ke sistem operasi. Export memakai
  jalur ini (docs/03 §Di mana export dijalankan). Memakai varian `mt` di sana
  tidak menolong: memory-nya milik bersama dengan main thread dan worklet, jadi
  yang tumbuh tetap tinggal sesudah worker-nya mati.

Aturan re-acquire di atas berlaku juga **lintas `await`**, bukan cuma lintas
panggilan wasm: setiap `await` memberi giliran ke kode lain yang bisa
menumbuhkan memory. `fillAsset` di `run-export.ts` mengambil ulang view-nya
setiap potong PCM karena sumbernya boleh async — tanpa itu, sisa potongannya
diam-diam ditulis ke buffer yang sudah tidak dibaca siapa pun.

Aturan tambahan: **jangan pernah mengirim pointer WASM lewat postMessage tanpa
generasi memori.** Kalau worker memberi tahu main thread "asset ada di ptr X",
sertakan `memGeneration` yang di-increment tiap grow.

## Tab throttling

Di background tab:
- `requestAnimationFrame` **berhenti total**.
- `setTimeout`/`setInterval` di-clamp ke ≥1000 ms (dan bisa di-freeze penuh
  kalau tab masuk "frozen" state).
- **AudioWorklet tetap jalan** selama `AudioContext` tidak di-suspend — audio
  adalah alasan eksplisit browser tidak membekukan tab. Worker juga tetap jalan
  (tapi timer-nya di-throttle).

Implikasi:

1. **Meter UI harus tahan gap.** rAF berhenti → tidak ada pembacaan meter →
   saat kembali ke foreground, nilai peak yang tersimpan di SAB adalah nilai
   *terakhir yang ditulis audio thread*, bukan akumulasi. Kalau UI naif
   menerapkan "decay per frame", ia akan melihat satu frame dengan delta 30
   detik dan meter melompat. **Solusi: decay berbasis waktu, bukan per-frame:**
   ```ts
   const dt = now - lastFrameTime;
   display = Math.max(target, display - DECAY_DB_PER_SEC * dt / 1000);
   ```
   Dan clamp `dt` ke maksimum 100 ms supaya lompatan besar hanya menghasilkan
   satu langkah decay.

2. **Peak-hold harus ditulis oleh audio thread**, bukan dihitung UI. Audio
   thread menulis `peak` sebagai maksimum sejak pembacaan terakhir; UI menulis
   balik "sudah dibaca" (satu `Atomics.store` ke field `ack`). Dengan begitu,
   puncak yang terjadi saat tab di background tidak hilang.

3. **Progress export**: worker tetap merender di background, tapi
   `postMessage`-nya baru diproses main thread saat aktif kembali. Itu tidak
   masalah — pesan mengantre. Yang perlu dijaga: jangan buat backlog ribuan
   pesan (throttle 20 Hz dari 3a sudah menanganinya). Untuk notifikasi selesai
   saat tab tidak aktif, pakai `Notification` API atau ubah `document.title`.

4. **`setTimeout` untuk yield di export worker** kena clamp 1000 ms di
   background → export jadi 1000× lebih lambat. **Inilah alasan kita pakai
   `MessageChannel` untuk yield, bukan `setTimeout`** — MessageChannel tidak
   di-throttle.

## Safari-specific

| Isu | Detail | Mitigasi |
|---|---|---|
| **User gesture** | `AudioContext` dibuat dalam state `suspended`; `resume()` hanya berhasil di dalam handler event user (click/touchend/keydown). Safari lebih ketat dari Chrome dan juga me-*suspend* ulang saat tab tidak aktif lama. | Satu "audio unlock" gate: aplikasi tidak membuat AudioContext sampai user menekan tombol apa pun. Simpan `ctx` global, panggil `resume()` di **setiap** handler klik (idempoten & murah). Tampilkan overlay "KLIK UNTUK MENGAKTIFKAN AUDIO" kalau `ctx.state !== 'running'`. |
| **`sampleRate` quirks** | Safari di macOS mengikuti sample rate device (bisa 44100, 48000, atau bahkan 96000 kalau interface eksternal). Meminta `new AudioContext({sampleRate: 48000})` **didukung** di Safari modern tapi memicu resampling internal (biaya + kualitas). Di iOS, rate bisa berubah saat headphone dicolok. | **Jangan paksa sample rate.** Ambil `ctx.sampleRate` sebagai kebenaran dan inisialisasi engine dengannya. Semua koefisien filter dihitung dari `sample_rate` runtime. Tangani `statechange` dan bandingkan `ctx.sampleRate`; kalau berubah → rebuild engine (dan re-render peak asset tidak perlu, karena asset disimpan di rate aslinya + resample saat import... lihat catatan di 6b: kalau device rate berubah, asset yang sudah di-resample ke rate lama perlu di-resample ulang — simpan juga PCM asli untuk project besar, atau terima biaya re-import). |
| **Render quantum** | Semua browser memakai 128. Spesifikasi kini mengizinkan `renderSizeHint` ('hardware'), tapi engine kita memang tidak mengasumsikan 128 — `render_block` menerima `frames: usize`. Yang di-hardcode hanya ukuran scratch buffer (dialokasi untuk `MAX_BLOCK = 1024`). | Sudah ditangani secara desain. |
| **SharedArrayBuffer** | Safari mendukung SAB sejak 15.2 **dengan syarat cross-origin isolation** — sama seperti Chrome/Firefox. Yang belum: `COEP: credentialless` (harus `require-corp`), dan `Atomics.waitAsync` baru muncul belakangan. | Kita tidak memakai `credentialless` maupun `waitAsync`. Jalur degraded (Bagian 1d) tetap disiapkan untuk WebView/iframe. |
| **`AudioWorklet` + WASM** | Ada bug historis Safari di mana modul WASM besar lambat di-instantiate di worklet. Sudah membaik, tapi tetap: instantiate di constructor (bukan di `process()` pertama). | Sudah ditangani (1a). |
| **OPFS** | Safari mendukung OPFS dan `createSyncAccessHandle` (di Worker). `showSaveFilePicker` **tidak** ada. | Export fallback ke Blob download; OPFS dipakai untuk backing store project (6a). |

---

## Stack bersama antar-thread di varian `mt`

**Gejala.** Panic yang berpindah-pindah tempat dan tidak pernah menunjuk
penyebabnya:

```
attempted to take ownership of Rust value while it was borrowed
index out of bounds: the len is 0 but the index is 0   (crates/export/src/wav.rs)
RuntimeError: memory access out of bounds               (di dalam free())
```

Selalu saat COMPILE, selalu di tempat yang berbeda, dan tidak pernah bisa
diulang persis. Menjalankan jalur export yang sama di Node — dengan snapshot,
`registerAsset`, render, dan encode yang identik — selalu bersih.

**Penyebab.** Varian `mt` di-link dengan `--import-memory --shared-memory`, dan
modul yang sama di-instantiate di banyak thread di atas **satu** linear memory:
main thread (bindgen), AudioWorklet (raw), import/export worker. Global
WebAssembly bersifat per-instance, jadi tiap thread memang punya
`__stack_pointer` sendiri — tapi semuanya **diinisialisasi ke nilai yang sama**
(`-zstack-size=1048576`). Semua thread karenanya menumbuhkan stack-nya di
rentang alamat yang persis sama dan saling menimpa bingkai.

Korban yang meledak hampir tidak pernah pelakunya. Yang paling sering kena
adalah export, karena ia satu-satunya yang memakai stack dalam-dalam sementara
worklet berjalan tanpa henti.

**Bukti.** Dua instance di atas satu memory, satu memanggil `engine_process`
nonstop:

| Yang dilakukan thread kedua | Hasil export di thread pertama |
|---|---|
| hanya instantiate, tidak memanggil apa pun | 40 putaran bersih |
| memanggil fungsi tanpa bingkai (`abi_version`) berulang | 40 putaran bersih |
| `engine_process` berulang (bingkai nyata) | **rusak dalam < 3 putaran** |
| `engine_process` berulang, stack terpisah | 40 putaran bersih |

Pola itu menunjuk stack, bukan heap: kerusakan hanya muncul kalau thread kedua
benar-benar MEMAKAI kedalaman stack.

**Perbaikan.** `scripts/build-wasm.sh` mengekspor `__stack_pointer` untuk varian
`mt`, dan setiap thread mengarahkan stack-nya ke blok sendiri sebelum panggilan
wasm pertamanya — lihat `web/src/audio/thread-stack.ts`. Blok-nya dialokasi di
**main thread** (`LoadedWasm.newThreadStack()`), bukan di thread yang
bersangkutan: mengalokasi dari dalam thread baru berarti `malloc` sendiri sudah
berjalan di atas stack yang bertabrakan.

Dijaga oleh `web/src/audio/thread-stack.test.ts`: satu tes memastikan artefak
`mt` benar-benar mengekspor `__stack_pointer` (menangkap penyebabnya langsung),
satu lagi menjalankan ulang situasi race di atas (menangkap kelas kerusakannya
walau penyebabnya kelak berubah).

**Catatan diagnostik.** Panic di artefak produksi muncul sebagai
`RuntimeError: unreachable executed` tanpa pesan apa pun, karena
`panic_immediate_abort`. Untuk membaca pesan Rust yang sebenarnya:

```
DEBUG_PANIC=1 ./scripts/build-wasm.sh
```

lalu bangun ulang tanpa flag itu setelah selesai.
