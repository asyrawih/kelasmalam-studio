# Bagian 1 — Thread Topology & Memory Architecture

## 1a. Instantiasi WASM di dalam AudioWorklet

### Masalahnya

`AudioWorkletGlobalScope` itu scope yang sangat miskin. Tidak ada `window`,
`document`, `fetch`, `XMLHttpRequest`, `importScripts`, `WebAssembly.instantiateStreaming`.
Yang ada: `sampleRate`, `currentTime`, `currentFrame`, `registerProcessor`,
`TextEncoder/Decoder`, `WebAssembly` (constructor-nya ada), dan `MessagePort`.

Artinya modul WASM harus **datang dari luar**, dan instantiasi harus **selesai
sebelum `process()` pertama dipanggil** — atau `process()` harus punya jalur
"belum siap → output silence".

### Pattern yang benar

```
MAIN THREAD                                AUDIOWORKLET THREAD
───────────────────────────────────────────────────────────────────────
1. fetch('engine_bg.wasm')                 
2. WebAssembly.compile(bytes) → Module     
3. new WebAssembly.Memory({                
     initial, maximum, shared: true })     
4. ctx.audioWorklet.addModule(worklet.js)  → registerProcessor('daw-engine')
5. new AudioWorkletNode(ctx,'daw-engine',
     {processorOptions:{module, memory,
        sabControl, sampleRate}})          → constructor(options) jalan di worklet
                                             6. new WebAssembly.Instance(
                                                  options.processorOptions.module,
                                                  imports)          ← SINKRON, OK
                                             7. instance.exports.engine_new(...)
                                             8. this.ready = true
9. node.connect(ctx.destination)           → process() mulai dipanggil
```

Kunci-kuncinya:

- **`WebAssembly.Module` itu structured-cloneable.** Bisa dikirim lewat
  `postMessage` / `processorOptions`. Yang tidak cloneable adalah `Instance`.
  Jadi kompilasi sekali di main thread (mahal, ~10–50ms untuk 300KB), lalu
  instantiate murah (<1ms) di tiap thread.
- **Lewatkan lewat `processorOptions`, bukan `port.postMessage`.**
  `processorOptions` dieksekusi di dalam constructor processor, yang dijamin
  jalan **sebelum** `process()` pertama. Kalau pakai `port.postMessage`, pesan
  masuk lewat task queue worklet dan bisa saja `process()` sudah dipanggil
  duluan → harus punya guard silence. `processorOptions` menghilangkan race itu.
- **`new WebAssembly.Instance()` (sinkron) legal di worklet** untuk modul yang
  sudah dikompilasi. Yang dilarang di banyak konteks adalah kompilasi sinkron
  modul >4KB (`new WebAssembly.Module(bytes)`), bukan instantiasi.
- **Memory dibuat di main thread**, dengan `shared: true`, lalu di-*import* oleh
  instance. Ini yang membuat linear memory Rust terlihat oleh main thread,
  worklet, dan worker sekaligus — asset PCM tidak perlu dikopi ke mana-mana.

### Glue code wasm-bindgen di worklet

`wasm-bindgen --target web` menghasilkan ESM dengan `default export init(url)`
yang memanggil `fetch` + `instantiateStreaming`. Di worklet itu mati.

Dua jalan, saya rekomendasikan yang pertama:

**(1) `--target web` + `initSync()` — REKOMENDASI.**
Sejak wasm-bindgen 0.2.8x, glue `--target web` juga meng-export `initSync(module)`
yang menerima `WebAssembly.Module` (atau `{module, memory}`) dan instantiate
sinkron. Tapi output-nya ESM, dan `audioWorklet.addModule()` memuat file sebagai
**classic script**, bukan module — `import` statement akan error.

Solusinya: **bundle worklet sebagai IIFE terpisah**. Vite di-konfigurasi dengan
entry kedua (`worklet-processor.ts`) yang di-build `format: 'iife'`, glue
wasm-bindgen ikut ter-inline ke dalamnya. Satu file classic script, tidak ada
`import`, `initSync` tersedia. Lihat `web/vite.config.ts`.

**(2) `--target no-modules`.** Menghasilkan `wasm_bindgen` sebagai global UMD-ish.
Bisa di-`addModule` langsung karena classic script. Tapi glue-nya menyentuh
`self`/`window` di beberapa jalur dan tipe TS-nya lebih jelek. Dipakai kalau
bundling IIFE ternyata merepotkan.

**(3) Yang paling aman untuk hot path: jangan pakai glue sama sekali di worklet.**
Kalau surface Rust→JS di audio thread hanya `engine_new`, `engine_process`,
`engine_frame_ptr` — semuanya `#[no_mangle] extern "C"` dengan argumen numerik —
maka worklet cukup memanggil `instance.exports.*` langsung. Tidak ada glue,
tidak ada string marshalling, tidak ada `JsValue` di hot path. **Ini yang dipakai
proyek ini**: crate `wasm-bridge` punya dua surface —
`raw` (no_mangle, dipakai worklet) dan `bindgen` (dipakai main thread & worker
untuk hal yang tidak realtime seperti load project, decode, export).

## 1b. Lock-free communication — SharedArrayBuffer layout

### Kenapa bukan postMessage

`postMessage` untuk parameter per-frame gagal karena tiga hal:
1. **Alokasi**: tiap pesan mengalokasi objek → GC pressure di main thread; GC
   pause 10ms = 4 blok audio hilang.
2. **Latency jitter**: pesan masuk task queue worklet, di-drain di antara
   `process()` call, tanpa jaminan waktu. Fader gerak → suara berubah 1–3 frame
   render kemudian, tidak deterministik.
3. **Tidak sample-accurate**: tidak ada cara menyatakan "ubah nilai ini di sample
   ke-N di dalam blok".

SAB + atomics menyelesaikan ketiganya: nol alokasi, latensi = satu blok,
dan command bisa membawa timestamp sample.

### Peta memori (SAB kontrol, terpisah dari WASM linear memory)

Total 64 KiB, semua offset kelipatan 64 byte (cache line) untuk menghindari
**false sharing** — kalau dua field yang ditulis dua thread berbeda berada di
cache line yang sama, tiap tulis membatalkan cache line thread lain
(cache-line ping-pong), dan di audio thread itu terlihat sebagai jitter.

```
OFFSET   SIZE    ALIGN  W     R     ISI
──────────────────────────────────────────────────────────────────────────────
                          ── BLOCK 0: TRANSPORT STATE (audio→UI) ──
0x0000   4       64     AUD   UI    seq (SeqLock; ganjil = sedang ditulis)
0x0004   4                          state: 0=stop 1=play 2=record
0x0008   8                          playhead_samples : u64 (BigInt64)
0x0010   8                          loop_start : u64
0x0018   8                          loop_end : u64
0x0020   4                          xrun_count : u32   (lihat Bagian 5)
0x0024   4                          cpu_load_q16 : u32 (fraksi deadline, Q16)
0x0028   24                         — padding —
                          ── BLOCK 1: COMMAND RING (UI→audio, SPSC) ──
0x0040   4       64     UI    AUD   cmd_write_idx : u32 (atomic)
0x0044   60                         — padding (isolasi cache line producer) —
0x0080   4       64     AUD   UI    cmd_read_idx : u32 (atomic)
0x0084   60                         — padding (isolasi cache line consumer) —
0x00C0   16384   64     UI    AUD   cmd_data[1024] × 16 byte
                                      u8  op
                                      u8  flags
                                      u16 target_id
                                      u32 param_id
                                      u64 at_sample  (0 = ASAP)
                                      (payload f32/u32 di-overlap dgn param_id
                                       lewat union — lihat rt::Command)
                          ── BLOCK 2: PARAM BLOCK (UI→audio, double-buffer) ──
0x40C0   4       64     UI    AUD   param_gen : u32 (atomic, generation counter)
0x40C4   60                         — padding —
0x4100   8192   64      UI    AUD   param_slot_a[2048] : f32
0x6100   8192   64      UI    AUD   param_slot_b[2048] : f32
                          ── BLOCK 3: METER FEEDBACK (audio→UI, SeqLock) ──
0x8100   4       64     AUD   UI    meter_seq : u32
0x8104   60                         — padding —
0x8140   1056   64      AUD   UI    meter[33] × 32B  (32 track + master)
                                      f32 peak_l, peak_r      (post-ballistics)
                                      f32 rms_l,  rms_r
                                      f32 gain_reduction_db
                                      u32 clip_hold_frames
                                      u64 — padding ke 32B —
                          ── BLOCK 4: FLAGS ──
0x8580   4       64     UI    WRK   export_cancel : u32 (0/1)
0x8584   4              UI    AUD   panic_flag / engine_fault : u32
0x8588   ...                        — padding —
──────────────────────────────────────────────────────────────────────────────
TOTAL    0x8600 (34304 B) → alokasi 65536 B, sisanya cadangan
```

Kanonik-nya ada di dua tempat yang **harus dijaga sinkron**:
`crates/rt/src/layout.rs` dan `web/src/audio/sab-layout.ts`. Ada tes yang
mem-verifikasi keduanya (`cargo test layout` mengeluarkan JSON offset,
`pnpm test` membandingkannya dengan konstanta TS).

### Memory ordering — keputusan per kasus

Ringkasnya: **Release pada penulis, Acquire pada pembaca, untuk index yang
mem-publish data.** Relaxed hanya untuk counter yang tidak melindungi data lain.

| Lokasi | Operasi | Ordering | Alasan |
|---|---|---|---|
| `cmd_write_idx` store (UI) | `store(Release)` | Release | Menjamin penulisan `cmd_data[i]` **terlihat lebih dulu** oleh consumer. Tanpa Release, audio thread bisa melihat index maju tapi payload belum ter-flush → memproses sampah. |
| `cmd_write_idx` load (audio) | `load(Acquire)` | Acquire | Pasangan dari Release di atas. Setelah load ini, semua tulis producer sebelum store terlihat. |
| `cmd_read_idx` store (audio) | `store(Release)` | Release | Mem-publish "slot ini bebas dipakai lagi" setelah consumer selesai *membaca* payload. Tanpa Release, producer bisa menimpa slot yang masih dibaca. |
| `cmd_read_idx` load (UI) | `load(Acquire)` | Acquire | Untuk hitung ruang kosong. |
| `param_gen` (UI) | `store(Release)` setelah tulis slot | Release | Publikasi slot double-buffer. |
| `param_gen` (audio) | `load(Acquire)` | Acquire | Slot aktif = `gen & 1`. Audio thread baca slot `gen & 1`, UI selalu tulis ke `(gen+1) & 1` lalu increment. |
| `meter_seq` (audio) | `store(seq+1, Relaxed)`; `fence(Release)`; tulis data; `store(seq+2, Release)` | SeqLock | Writer tidak pernah blok. Reader baca seq → data → seq lagi; kalau berubah atau ganjil, ulangi. Reader (UI) boleh spin sebentar; **writer (audio) tidak pernah menunggu siapa pun.** |
| `xrun_count` | `fetch_add(Relaxed)` | Relaxed | Statistik murni, tidak melindungi data lain. |
| `export_cancel` | `store/load(Relaxed)` | Relaxed | Flag boolean tunggal; keterlambatan visibilitas beberapa mikrodetik tidak masalah. Dicek 1× per batch, bukan per blok. |

### Kenapa `Atomics.wait` HARAM di audio thread

1. **Spesifikasi melarangnya.** `Atomics.wait` melempar `TypeError` di thread
   yang tidak boleh blok. Main thread jelas dilarang; AudioWorklet thread di
   implementasi saat ini juga tidak boleh blok — dan bahkan kalau diizinkan:
2. **Blok = xrun, bukan "lambat sedikit".** Audio thread punya deadline keras
   2.67 ms. Kalau ia menunggu thread lain, thread lain itu bisa saja sedang
   di-preempt OS atau sedang GC. Tidak ada batas atas waktu tunggu →
   dijamin glitch.
3. **Priority inversion.** Audio thread berprioritas tinggi menunggu lock yang
   dipegang thread berprioritas normal yang sedang tidak dijadwalkan. Ini
   penyakit klasik audio realtime.

Aturannya: audio thread **hanya boleh** `Atomics.load` / `Atomics.store` /
`fetch_add`, dan semua algoritmanya harus wait-free — kalau data belum siap,
ia mengambil keputusan dan jalan terus (pakai nilai lama, output silence,
skip command), tidak pernah menunggu.

`Atomics.wait`/`notify` boleh dipakai di **export worker** (bukan realtime) —
mis. menunggu perintah baru — dan `Atomics.notify` boleh dipanggil dari mana saja.

### Sisi Rust

Karena SAB adalah *shared* WebAssembly memory yang sama dengan linear memory
Rust, struktur di atas bisa dipetakan langsung sebagai `&'static` slice atomics:

```rust
// crates/rt/src/ring.rs — lihat file untuk versi lengkap
pub struct SpscRing {
    write: &'static AtomicU32,
    read:  &'static AtomicU32,
    data:  *mut Command,     // 1024 slot, power-of-two
    mask:  u32,
}
```

Ini butuh build flags khusus:

```
-C target-feature=+atomics,+bulk-memory,+mutable-globals
-Z build-std=std,panic_abort
```

**Kenapa:**
- `+atomics` mengaktifkan opcode `i32.atomic.*` di WASM. Tanpa ini,
  `AtomicU32::load` dikompilasi jadi load biasa — *tetap compile*, tetap
  "jalan", tapi tanpa jaminan atomicity/ordering. Ini kelas bug yang paling
  menyakitkan: benar 99.9% waktu, korup sesekali di mesin tertentu.
- `+bulk-memory` diperlukan karena dengan shared memory, `memory.init`/`memory.copy`
  dipakai untuk inisialisasi data segment (segment pasif) — data segment aktif
  tidak boleh di shared memory.
- `+mutable-globals` untuk stack pointer per-thread.
- `build-std` wajib karena `std` yang di-*ship* rustup dikompilasi **tanpa**
  fitur atomics. Mencampur std non-atomic dengan crate atomic = ABI mismatch
  (TLS model berbeda) → error link atau crash runtime. Karena itu butuh
  toolchain nightly + `rust-src`.

Konsekuensinya modul WASM meng-*import* memory (bukan mendefinisikannya) dan
`--shared-memory` harus dilewatkan ke `wasm-bindgen`/linker. Lihat
`.cargo/config.toml` dan `scripts/build-wasm.sh`.

## 1c. Real-time safety rules di Rust

### Yang DILARANG di dalam `process()` / `render_block()`

| Dilarang | Kenapa | Ganti dengan |
|---|---|---|
| `Vec::new/push/resize`, `Box::new`, `String`, `format!` | allocator bisa mengambil lock global, dan di WASM bisa memicu `memory.grow` (menginvalidasi semua view JS — lihat Bagian 5) | pre-alokasi saat init; arena/pool |
| `panic!`, `unwrap`, `expect`, index out-of-range, slice `[a..b]` yang bisa gagal | `panic = "abort"` → `unreachable` trap → **AudioContext mati permanen**, node tidak bisa dipulihkan | `get`/`get_unchecked` yang sudah di-invariant-kan, `debug_assert!` |
| `Mutex`, `RwLock`, `RefCell::borrow_mut` | blocking / bisa panic saat borrow konflik | atomics, SPSC ring, `&mut` eksklusif |
| `Rc`, `Arc` clone/drop | refcount = atomic RMW + kemungkinan drop → dealloc | index (`u32` handle) ke dalam arena |
| `dyn Trait` di inner loop | dispatch tak terprediksi, cache miss | `enum` dispatch (`FxNode`) — jumlah efek terbatas & diketahui |
| I/O apa pun, `console.log`, `postMessage` | crossing JS boundary + alokasi | tulis ke ring/SAB, UI yang membaca |
| `f64` trig/exp di inner loop | mahal | precompute koefisien saat parameter berubah, bukan per-sample |

### Menegakkannya

1. **`#![forbid(unsafe_op_in_unsafe_fn)]` + review manual** untuk `unsafe`.
2. **Allocator penjaga** di build dev: global allocator custom yang men-set
   flag `IN_RT_SECTION` → kalau alokasi terjadi saat flag menyala, `debug_assert!`
   meledak di tes. Lihat `crates/rt/src/rt_guard.rs`. Ini menangkap alokasi
   tak sengaja (mis. `collect()` yang lolos review) di CI, bukan di produksi.
3. **`panic = "abort"`** di profil release + **fuzzing** (`cargo-fuzz`) pada
   `render_block` dengan parameter acak & graph acak, memastikan tidak ada
   jalur panic. Di dev, `panic = "unwind"` supaya tes bisa `should_panic`.
4. **Benchmark sebagai gate CI**: `criterion` mengukur `render_block` 32 track
   di native; regresi >10% = build merah. Native ≈ 2–4× lebih cepat dari WASM,
   jadi target native adalah ~0.4 ms untuk headroom 1.3 ms di WASM.

### Pattern arena/pool untuk voice

Voice = satu clip yang sedang berbunyi (punya fractional cursor, state fade,
state FX per-clip). Jumlahnya dinamis, tapi **batas atasnya ditentukan saat init**.

```rust
pub struct VoicePool {
    voices: Box<[Voice]>,      // dialokasi SEKALI, mis. 256
    free:   Box<[u16]>,        // stack index bebas
    free_len: usize,
    active: Box<[u16]>,        // index aktif, dipakai untuk iterasi
    active_len: usize,
}
impl VoicePool {
    #[inline] pub fn alloc(&mut self) -> Option<u16> { /* pop dari free */ }
    #[inline] pub fn free(&mut self, id: u16)        { /* push ke free */ }
}
```

Kalau pool habis: **voice stealing** (matikan voice tertua/terpelan dengan
micro-fade 2 ms), bukan alokasi. Kebijakan "gagal dengan anggun" ini yang
membedakan engine realtime dari kode biasa.

### Ownership engine

```rust
// Satu-satunya pemilik. Hidup di WASM linear memory, pointer-nya dipegang worklet.
pub struct Engine {
    graph:      ProcessGraph,      // urutan node hasil topo-sort (precomputed)
    scratch:    ScratchBuffers,    // semua buffer kerja, pre-allocated
    voices:     VoicePool,
    transport:  Transport,
    cmd_rx:     SpscConsumer,      // ujung baca ring
    meters:     MeterWriter,       // ujung tulis SeqLock
    assets:     AssetTable,        // hanya BACA di RT; mutasi lewat command
}
impl Engine {
    pub fn process(&mut self, out_l: &mut [f32; 128], out_r: &mut [f32; 128]) { .. }
}
```

Tidak ada `Rc`/`Arc`/`Mutex` di mana pun di dalamnya. Worklet memegang pointer
mentah hasil `Box::into_raw`, dan `engine_process(ptr)` melakukan
`&mut *(ptr as *mut Engine)`. Aman karena hanya satu thread yang pernah
menyentuh pointer itu (invariant yang ditegakkan oleh desain, bukan compiler —
didokumentasikan di `wasm-bridge/src/raw.rs`).

## 1d. COOP/COEP

SharedArrayBuffer hanya tersedia kalau `crossOriginIsolated === true`, yang butuh
dua header di dokumen utama:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`require-corp` berarti **semua sub-resource lintas origin harus opt-in**
(`Cross-Origin-Resource-Policy: cross-origin` atau CORS). Praktisnya: self-host
semua font/gambar, atau pakai `credentialless` (Chrome/Edge; Safari belum).

### (1) Vite dev server

```ts
// web/vite.config.ts
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
preview: { headers: { /* sama */ } },
```

### (2) Produksi

**Cloudflare Pages / Netlify** — file `web/public/_headers`:
```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable
```

**nginx** — `deploy/nginx.conf`:
```nginx
add_header Cross-Origin-Opener-Policy   "same-origin"   always;
add_header Cross-Origin-Embedder-Policy "require-corp"  always;
add_header Cross-Origin-Resource-Policy "same-origin"   always;
types { application/wasm wasm; }
gzip_types application/wasm application/javascript text/css;
```

### (3) Fallback runtime — degraded mode

```ts
export const CAPS = {
  isolated: globalThis.crossOriginIsolated === true,
  sab: typeof SharedArrayBuffer !== 'undefined',
  simd: await wasmFeatureDetect.simd(),
};
```

Kalau `isolated === false` (mis. di-embed di iframe pihak ketiga, atau ada CDN
yang tak mau kirim CORP), **aplikasi tetap jalan** dengan penurunan berikut:

| Fitur | Isolated | Degraded (tanpa SAB) |
|---|---|---|
| Playback realtime multi-track | ✅ | ✅ — engine tetap jalan di worklet, memory non-shared |
| Param/command dari UI | ✅ SAB ring, ~2.7 ms | ⚠️ `port.postMessage` batched per rAF, ~16–30 ms, tetap sample-accurate di dalam blok |
| Meter | ✅ SAB SeqLock, zero-copy | ⚠️ postMessage 30 Hz, throttled |
| Asset PCM share antar thread | ✅ satu salinan | ❌ harus di-*transfer* (ArrayBuffer transferable) atau dikopi — memori 2× saat import |
| Multi-thread render export (rayon) | ✅ | ❌ single-thread, export ~n× lebih lambat |
| Waveform peak generation di worker | ✅ tulis langsung ke shared memory | ⚠️ transfer ArrayBuffer hasil |
| SIMD | ✅ | ✅ (SIMD tidak butuh isolasi) |

Deteksi ini juga menentukan build WASM mana yang di-load: build `+atomics`
**tidak akan jalan** tanpa shared memory, jadi ada dua artefak
(`engine-mt.wasm`, `engine-st.wasm`) dan loader memilih saat runtime.
Biayanya ~300 KB tambahan yang hanya diunduh di jalur degraded.
