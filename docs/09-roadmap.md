# Bagian 9 — Roadmap M0–M9

Urutan ini disusun dengan satu prinsip: **buktikan yang paling bisa membunuh
proyek lebih dulu, sebelum membangun apa pun yang lebar.**

Tiga hal di proyek ini punya sifat "kalau tidak bisa, seluruh arsitektur harus
dirombak": WASM dengan shared memory di dalam AudioWorklet, SPSC ring lewat SAB,
dan kesetaraan render realtime vs offline. Ketiganya diselesaikan di M1–M4,
saat kode masih cukup kecil untuk dibuang. Mixer cantik dengan 32 track tidak
ada gunanya kalau di M6 baru ketahuan Safari menolak instantiasi modul.

Setiap milestone punya **definisi "done" yang bisa dijalankan atau dilihat**.
Kalau definisinya berbunyi "terasa lancar" atau "sudah rapi", itu bukan definisi
dan milestone-nya belum selesai.

Bagi yang belum pernah menyentuh audio realtime: baca docs/01 §"Kenapa
`Atomics.wait` HARAM" dan docs/05 §Underrun sebelum M1. Dua halaman itu
menjelaskan kenapa banyak aturan di sini terlihat berlebihan padahal tidak.

---

## M0 — Cross-origin isolation & kerangka build

**Kenapa duluan:** tanpa `crossOriginIsolated === true`, `SharedArrayBuffer`
tidak ada, dan seluruh arsitektur ini tidak bisa dijalankan sama sekali. Ini
lima baris konfigurasi yang bisa menggagalkan segalanya, jadi selesaikan di hari
pertama, bukan saat deploy.

Isi:
- Cargo workspace + `.cargo/config.toml` dengan RUSTFLAGS atomics (docs/04)
- Vite dev server dengan header COOP/COEP, `web/public/_headers`, `deploy/nginx.conf`
- Toolchain nightly + `rust-src` + `-Z build-std`
- Satu crate `daw-rt` kosong yang berhasil di-build ke `wasm32-unknown-unknown`

**Done:**
```
pnpm run dev
# di console browser:
crossOriginIsolated                    // → true
new SharedArrayBuffer(64)              // → tidak melempar
```
Diverifikasi di Chrome **dan** Safari. Ditambah `pnpm run build && npx serve`
pada hasil build produksi — bukan hanya di dev server, karena header dev dan
header produksi datang dari dua tempat berbeda dan sering beda.

---

## M1 — WASM hidup di dalam AudioWorklet  ⚠️ RISIKO TERTINGGI

**Kenapa di sini:** ini taruhan terbesar. Instantiasi WASM di worklet harus
**sinkron** (tidak boleh `await` di constructor `AudioWorkletProcessor`), harus
memakai shared memory yang diimpor dari luar, dan Safari punya sejarah buruk
dengan modul besar (docs/05 §Safari). Kalau ini gagal, rencana cadangannya
adalah jalur degraded di docs/01d — dan itu keputusan arsitektur, bukan tambalan.

Isi:
- `WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true })`
- Transfer `WebAssembly.Module` (bukan bytes) lewat `processorOptions`
- `new WebAssembly.Instance(module, { env: { memory } })` di constructor
- `Engine::new()` + `render_block()` yang mengisi output dengan sine 440 Hz
- Pola re-acquire view dari docs/05 §WASM memory growth

**Done:** terdengar sine 440 Hz bersih dari `render_block` Rust selama 60 detik
tanpa satu pun klik. Diverifikasi juga bahwa `panic!` yang sengaja dipasang
membuat node mati permanen — supaya tim melihat sendiri kenapa aturan "no panic"
ada, sekali saja, lalu hapus.

---

## M2 — SAB: command ring + transport + meter  ⚠️ RISIKO TINGGI

**Kenapa di sini:** ini kontrak yang paling mahal untuk diubah belakangan.
Setiap komponen UI dan setiap crate bergantung pada offset di docs/01. Salah
memory ordering di sini menghasilkan bug yang muncul satu kali per jam di mesin
tertentu saja — jenis bug yang paling mahal di seluruh proyek.

Isi:
- `crates/rt/src/layout.rs` + `web/src/audio/sab-layout.ts`
- SPSC ring: producer di JS, consumer di Rust (`Release`/`Acquire`, docs/01)
- SeqLock transport + meter block
- `OP_TRANSPORT_PLAY/STOP/SEEK`
- Satu rAF loop bersama dengan decay berbasis waktu (docs/05, docs/08 §8d)

**Done:**
1. `cargo test layout` mengeluarkan JSON offset dan `pnpm test` membandingkannya
   — beda satu byte pun gagal.
2. Klik Play → playhead di UI maju sesuai jam audio, drift < 1 blok setelah 5 menit.
3. Kirim 10.000 command dalam satu burst → `cmd_read_idx` mencapai `cmd_write_idx`,
   tidak ada command hilang, `xrun_count` tetap 0.
4. **Tes throttling:** pindah ke tab lain 30 detik, kembali → meter tidak melompat
   dan tidak "jatuh" sekaligus. Ini menguji clamp `dt` 100 ms secara langsung.

---

## M3 — Import asset & peak pyramid

**Kenapa di sini:** M1–M2 membuktikan pipa; M3 mengisinya dengan audio sungguhan.
Ini juga milestone pertama yang menyentuh `memory.grow`, satu-satunya sumber
detach view (docs/05).

Isi:
- import-worker: Symphonia decode → PCM f32 planar ke WASM linear memory
- Resample saat import kalau rate file ≠ `ctx.sampleRate` (docs/06b)
- Peak pyramid 64/512/4096 dibangun di worker
- `AssetPool` ref-counted + `memGeneration` di setiap pesan pointer

**Done:** drop file WAV 10 menit → decode selesai dengan progress, waveform
tergambar, dan playback satu clip full-length **null-test bit-exact** terhadap
file sumber (gain 1.0, tanpa FX). Kalau tidak bit-exact, ada bug resample atau
bug indexing — dan lebih baik ketahuan sekarang daripada setelah 20 track.

Ditambah: import 2 GB worth of audio sampai `memory.grow` benar-benar terjadi,
lalu pastikan audio tidak senyap. Ini menguji pola re-acquire view.

---

## M4 — Offline render & null-test bounce  ⚠️ RISIKO TINGGI

**Kenapa sebelum fitur:** aturan emas nomor 3 bilang realtime dan offline memakai
`render_block` yang sama. Kalau klaim itu tidak diuji **sekarang**, ia akan
pelan-pelan menjadi tidak benar, dan pada M9 tidak ada yang tahu sejak kapan.
Null-test adalah satu-satunya tes korektnes objektif yang dimiliki proyek ini.

Isi:
- `OfflineRenderer` di export-worker dengan instance Engine kedua
- `Engine::from_snapshot`
- `WavStreamWriter` (Float32 dulu — dither/24-bit menyusul)
- Yield pakai `MessageChannel`, **bukan** `setTimeout` (docs/05 §Tab throttling)

**Done:** rekam output realtime 30 detik, bounce range yang sama offline,
kurangkan keduanya → residual **< −120 dBFS** (idealnya bit-exact untuk f32).
Ditambah: export berjalan di background tab dengan kecepatan yang sama seperti
foreground — ini yang membuktikan `MessageChannel` benar-benar tidak di-throttle.

---

## M5 — Timeline & editing non-destruktif

Baru di sini UI mulai lebar. Fondasinya sudah aman.

Isi:
- `Clip`/`Track`/`Project` lengkap + serde + JSON schema
- Move / trim / split / delete lewat command (docs/08 §8c)
- Micro-fade otomatis 2–5 ms di setiap batas clip (docs/06d) — di engine
- Undo/redo command-pattern dengan inverse
- Canvas arrangement: virtualisasi viewport + cache redraw-on-change
- Hit-testing + pointer capture + snap dengan modifier override

**Done:**
1. Split satu clip **tepat di tengah fade-in**, mainkan → tidak ada klik dan
   bentuk fade gabungan identik dengan sebelum split (bandingkan bounce-nya).
2. 32 track × 20 clip, scroll dan zoom tetap ≥ 55 fps di laptop kelas menengah.
3. 50 operasi edit acak → undo 50× → bounce **bit-exact** dengan bounce awal.
   Ini menguji bahwa setiap inverse benar-benar inverse.

---

## M6 — Gain staging & mixer

Isi:
- Signal flow lengkap urutan pasti (docs/07): clip gain → fade → track insert →
  fader → pan → send → bus → master
- Fader taper + pan law −3 dB equal-power
- Semua gain lewat `Smoother`
- Meter per track + master, param block untuk drag
- Soft-clip / limiter master

**Done:**
1. Geser fader secepat mungkin selama 10 detik → tidak ada zipper noise, dan ring
   **tidak** penuh (buktikan jalur param block dipakai, bukan ring — docs/08 §8a).
2. Pan sweep penuh kiri→kanan pada sine → total power konstan ±0.1 dB.
3. Sum 32 track sine identik → hasilnya persis 32× satu track sebelum limiter.
4. Null-test M4 masih lulus.

---

## M7 — FX chain

Isi:
- Biquad TDF-II + EQ parametrik, compressor, insert chain per-track
- `enum` dispatch `FxNode`, topo-sort `ProcessGraph`
- Param block untuk knob, `OP_FX_*` untuk struktur
- Kurva respons EQ digambar di canvas + tes yang membandingkan rumus TS vs Rust
- Blok analyzer di SAB (celah docs/08 §8e nomor 1)

**Done:**
1. Sine sweep lewat EQ peaking +6 dB @ 1 kHz Q=1 → magnitude terukur cocok
   dengan respons teoretis dalam ±0.1 dB.
2. Kurva EQ di UI dan respons terukur engine tumpang tindih.
3. Compressor: sine −6 dBFS, threshold −12, ratio 4:1 → gain reduction terukur
   6 dB, waktu attack/release sesuai spesifikasi ±10%.
4. Bypass 32 chain saat playing → tidak ada klik.
5. Null-test M4 masih lulus **dengan FX aktif**.

---

## M8 — Varispeed

Isi:
- `FracCursor` f64 + cubic Hermite 4-point
- `effective_ratio = clip_ratio × master_ratio`
- Geometri timeline: `timeline_len = source_len / ratio`
- Waveform dibaca dengan stride × ratio (bukan regenerate)
- Ramp saat ratio berubah ketika playing

**Done:**
1. Clip ratio 0.5 → durasi timeline persis 2×, pitch turun persis satu oktaf
   (verifikasi FFT).
2. Trim dan split pada clip ratio 0.75 mendarat di posisi source yang benar —
   ini tes off-by-one dua koordinat space (Bagian 8d), tulis test tabel untuk
   ratio 0.5 / 0.75 / 1.0 / 1.5 / 2.0.
3. Ubah ratio saat playing → tidak ada klik.
4. Terima aliasing pada ratio > 1.0 dan **catat di UI** — jangan diam-diam.

---

## M9 — Export lengkap, ketahanan & rilis

Isi:
- WAV 16/24-bit + TPDF dither, MP3 (lamejs), OGG (lazy-load)
- Tangga degradasi docs/05 level 0–4 dengan histeresis
- Freeze track
- Deteksi xrun + notifikasi UI
- Handling `statechange` / perubahan `sampleRate` Safari
- Overlay "klik untuk mengaktifkan audio"

**Done:**
1. Export 10 menit ke ketiga format, semuanya terbuka benar di Audacity/ffmpeg,
   durasi tepat.
2. WAV 16-bit: noise floor menunjukkan dither TPDF (bukan truncation) —
   verifikasi dengan sine −90 dBFS, tidak ada distorsi harmonik.
3. Beban CPU dipaksa naik → level degradasi naik 0→3 dan turun lagi dengan
   histeresis, tanpa berkedip.
4. Freeze satu track dengan 5 FX → CPU turun terukur, dan hasilnya **null-test**
   dengan track yang belum di-freeze.
5. Cabut/colok headphone di macOS saat playing → engine rebuild, audio kembali.

---

## Yang sengaja ditunda, dan alasannya

Menunda bukan berarti lupa. Ini daftar yang **sadar** tidak dikerjakan, supaya
tidak ada yang diam-diam mengerjakannya di sela-sela M5.

| Ditunda | Alasan |
|---|---|
| **Time-stretch (WSOLA / phase vocoder)** | Varispeed sudah memberi 90% nilai produk dengan 10% kompleksitas. Phase vocoder butuh lookahead yang bertabrakan dengan render quantum 128 dan lebih baik di-pre-render di worker. Arsitekturnya sudah disiapkan (`speed_ratio` + dua koordinat space) sehingga penambahannya nanti bukan perombakan. |
| **MIDI: Piano Roll & Step Sequencer** | Butuh `MidiClip`, instrument node, dan voice allocator — tiga subsistem yang belum ada keputusan desainnya. Panelnya dibangun sebagai shell statis (docs/08 §8c) supaya design utuh secara visual tanpa berpura-pura berfungsi. |
| **Per-clip FX** | Bagian 6e: voice management + tail handling saat playhead keluar clip adalah masalah yang sulit (reverb tail terpotong). Per-track memberi hasil yang hampir sama untuk sebagian besar kasus. Field `Clip.insert_chain` tetap ada di model agar project file tidak perlu migrasi. |
| **Recording / `getUserMedia`** | Input capture adalah pipa realtime kedua dengan masalah latensi dan monitoring sendiri. MVP ini adalah editor, bukan perekam. |
| **WebGL/WebGPU waveform** | Canvas2D dengan virtualisasi + cache sudah memenuhi target M5 (32×20 clip @ 55 fps). Optimasi tanpa pengukuran adalah tebakan; naikkan hanya kalau M5 gagal. |
| **OPFS sebagai backing store** | Baru perlu saat project melebihi memory budget. Sampai ada yang benar-benar kehabisan memori, ini kompleksitas tanpa pembeli. |
| **Multi-bus / send lengkap** | Satu master bus dulu. Jumlah bus belum ditentukan (celah docs/08 §8e nomor 3) dan menentukannya sekarang berarti menebak. |
| **Sidecar LAME (emcc)** | lamejs cukup untuk MVP. Pindah kalau kualitas atau kecepatan terbukti jadi keluhan nyata. |

## Catatan urutan

Kalau ada tekanan untuk memindahkan sesuatu lebih awal, satu-satunya urutan yang
**tidak boleh** diganggu adalah **M1 → M2 → M4**. Ketiganya adalah taruhan
arsitektur. Sisanya boleh ditukar sesuai kebutuhan produk.

Dan M4 tidak selesai sekali lalu dilupakan: null-test dijalankan ulang sebagai
bagian dari definisi "done" M6, M7, dan M9. Ia adalah kenari di tambang batu
bara proyek ini.
