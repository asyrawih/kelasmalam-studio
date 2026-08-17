KONTEKS PROJECT
================
Saya membangun browser-based DAW dengan arsitektur:
- Rust (compiled ke wasm32-unknown-unknown via wasm-bindgen 0.2.x) sebagai 
  audio engine, DSP core, timeline math, dan offline render/export pipeline
- TypeScript + React 18 (Vite 5) sebagai UI layer
- Web Audio API dengan AudioWorklet sebagai real-time audio host

TARGET SPEC:
- Sample rate: 44100/48000 Hz (mengikuti AudioContext.sampleRate)
- Render quantum: 128 frames (Web Audio spec) — engine harus proses per-128-frame 
  block, TIDAK boleh assume block size lebih besar
- Track count target: 32 stereo tracks simultan dengan per-track insert chain 
  (EQ 4-band + compressor) + 2 send bus (reverb, delay) tanpa dropout di 
  mid-range hardware (4-core laptop)
- Latency budget: proses 128 frames @ 48kHz = 2.67ms deadline per callback. 
  Engine harus selesai < 50% dari deadline (≈1.3ms) untuk headroom
- Internal processing: f32, interleaved HANYA di boundary I/O, internal planar 
  (per-channel slices) untuk SIMD-friendliness
- Export: WAV (16/24-bit PCM + 32-bit float), MP3 (CBR 128/192/320 + VBR), 
  OGG Vorbis (q2–q8), semua di-encode client-side, zero server involvement

=====================================================================
BAGIAN 1 — THREAD TOPOLOGY & MEMORY ARCHITECTURE (jawab paling detail)
=====================================================================
Rancang topology 3-thread berikut dan jelaskan setiap keputusan:

  [Main thread]          [AudioWorklet thread]        [Worker pool]
  React UI               AudioWorkletProcessor        Export render +
  Peak meter read        WASM engine instance         waveform peak gen
  Param writes           process() 128-frame loop     WASM engine instance #2

Pertanyaan spesifik yang harus dijawab:

1a. WASM INSTANTIATION DI AUDIOWORKLET:
    AudioWorkletGlobalScope tidak punya fetch() dan tidak bisa 
    WebAssembly.instantiateStreaming dari URL. Jelaskan pattern yang benar:
    - Compile WebAssembly.Module di main thread
    - Transfer module via port.postMessage (structured clone WASM module)
    - Instantiate SYNCHRONOUSLY di dalam worklet (new WebAssembly.Instance) 
      sebelum process() pertama dipanggil — atau strategi async-safe alternatif
    - Bagaimana handle glue code wasm-bindgen di worklet scope (tidak ada 
      document/window)? Apakah perlu build dengan --target web + manual init, 
      atau --target no-modules?

1b. LOCK-FREE COMMUNICATION — SPSC RING BUFFER:
    Main thread ↔ audio thread TIDAK BOLEH pakai postMessage untuk data 
    per-frame (GC pressure + latency jitter). Rancang:
    - SharedArrayBuffer layout: parameter block (SeqLock atau double-buffer 
      dengan version counter), command queue (SPSC ring untuk event seperti 
      note-on, transport start/stop), dan meter/visualization feedback buffer 
      (audio thread menulis, main thread membaca)
    - Atomics.load/store dengan memory ordering apa untuk setiap kasus? 
      Kapan butuh Atomics.wait/notify (hint: TIDAK PERNAH di audio thread — 
      jelaskan kenapa wait dilarang di real-time context)
    - Wakil struct layout eksplisit: offset byte, alignment, padding untuk 
      menghindari false sharing antar cache line (64-byte)
    - Bagaimana merepresentasikan ring buffer ini DI SISI RUST: 
      core::sync::atomic::AtomicU32 di atas shared memory, dan kenapa 
      wasm shared memory butuh build flag khusus 
      (-C target-feature=+atomics,+bulk-memory,+mutable-globals) + 
      rebuild std (build-std) atau target wasm32-unknown-unknown dengan 
      RUSTFLAGS yang tepat

1c. REAL-TIME SAFETY RULES DI RUST:
    Daftar operasi yang DILARANG di dalam process() path dan bagaimana 
    menegakkannya:
    - Zero heap allocation: semua buffer pre-allocated saat init. Tunjukkan 
      pattern arena/pool untuk voice allocation
    - No panic: panic = unwind = abort di WASM. Strategi: debug_assert! di 
      dev, unchecked math/indexing yang justified di release, atau 
      panic = "abort" + fuzzing di CI
    - No mutex/RefCell borrow di hot path — jelaskan alternatif 
      (atomics, message passing via ring)
    - Bagaimana struktur ownership engine: satu struct Engine yang dimiliki 
      worklet, &mut exclusive, tidak ada Rc/Arc di hot path

1d. COOP/COEP:
    SharedArrayBuffer butuh cross-origin isolation. Berikan konfigurasi 
    eksplisit untuk: (1) Vite dev server headers, (2) production nginx/
    Cloudflare Pages headers, (3) fallback detection di runtime 
    (crossOriginIsolated === false → degraded mode tanpa SAB, jelaskan 
    apa yang masih bisa jalan)

=====================================================================
BAGIAN 2 — DSP ENGINE INTERNALS
=====================================================================
2a. GRAPH PROCESSING:
    - Topological sort dari track graph (track → insert chain → send → 
      bus → master) di-precompute saat graph berubah, BUKAN per-callback
    - Buffer strategy: berapa scratch buffer minimum untuk graph dengan 
      send/return tanpa copy berlebih (buffer lifetime analysis)
    - Parameter smoothing: per-sample linear ramp vs per-block, target 
      ~10-20ms ramp untuk gain/pan untuk hindari zipper noise. Tunjukkan 
      implementasi smoother yang branchless

2b. DSP BLOCKS — berikan implementasi Rust konkret untuk:
    - Biquad TDF-II transposed (Direct Form II Transposed) untuk EQ — 
      kenapa TDF-II lebih baik untuk f32 dibanding DF-I (numerical noise), 
      coefficient calculation dari RBJ Audio EQ Cookbook
    - Feed-forward compressor: envelope follower (attack/release one-pole), 
      soft-knee gain computer di log domain, make-up gain. Sidechain 
      detection: peak vs RMS
    - Denormal protection: WASM tidak punya FTZ/DAZ flag — apakah denormal 
      jadi masalah di WASM runtime (V8/SpiderMonkey), dan pattern DC offset 
      injection atau flush manual jika perlu
    - SIMD: wasm SIMD128 (core::arch::wasm32, v128) — tunjukkan mixing loop 
      (buffer summing) yang di-vectorize manual dengan f32x4, dan feature 
      detection + fallback scalar

2c. SAMPLE-ACCURATE SEQUENCING:
    - Transport clock: u64 sample counter sebagai single source of truth, 
      BUKAN AudioContext.currentTime (jelaskan kenapa: currentTime adalah 
      f64 detik, drift/rounding)
    - Event scheduling: event queue sorted by sample timestamp, di-split 
      pada block boundary — event di tengah block harus memecah proses 
      block jadi sub-block (sample-accurate automation & note timing)
    - Tempo map: konversi PPQ ↔ samples dengan tempo changes, hindari 
      akumulasi floating point error (integer math atau rational arithmetic)

=====================================================================
BAGIAN 3 — EXPORT PIPELINE (WAV/MP3/OGG, semua client-side)
=====================================================================
3a. OFFLINE RENDER ARCHITECTURE:
    - Export TIDAK lewat AudioWorklet. Web Worker terpisah instantiate 
      WASM engine instance KEDUA (state di-serialize dari project model, 
      bukan shared dengan real-time instance — jelaskan kenapa sharing 
      engine state antar instance adalah bug factory)
    - Render loop: process N blocks per iterasi (mis. 100 block batch), 
      yield ke event loop antar batch untuk progress reporting via 
      postMessage — bukan setiap block (message overhead)
    - Progress granularity + cancellation token (Atomics flag yang di-check 
      per batch)

3b. WAV ENCODER (pure Rust, wasm32-unknown-unknown):
    - hound dengan WavWriter<Cursor<Vec<u8>>> (no filesystem di WASM)
    - Dithering saat konversi f32 → 16-bit: TPDF dither implementation 
      (kenapa TPDF bukan RPDF), noise shaping optional
    - 24-bit packing (3-byte little-endian, tidak ada tipe i24 native)
    - Streaming ke Blob parts untuk file besar (hindari 1 Vec<u8> raksasa 
      untuk render 10+ menit)

3c. MP3 & OGG — ANALISIS TOOLCHAIN (bagian paling kritis, jawab jujur 
    dengan trade-off):
    
    FAKTA: LAME dan libvorbis adalah C library. Crate mp3lame-encoder dan 
    vorbis_rs adalah FFI binding — TIDAK link di wasm32-unknown-unknown 
    karena tidak ada C toolchain di target itu.
    
    Bandingkan 3 jalur secara teknis:
    
    JALUR A — Emscripten sidecar module:
    Compile LAME + libvorbis + thin C wrapper via emcc ke WASM module 
    terpisah. JS orchestrator: PCM dari engine module → copy ke encoder 
    module memory → encode. Bahas: build complexity (emsdk di CI), 
    dua memory space terpisah (tidak bisa share linear memory antar 
    module — berapa copy overhead), ukuran binary tambahan
    
    JALUR B — ffmpeg.audio.wasm (~5MB, audio-only build) sebagai encoder 
    module: PCM f32 → WAV in-memory → ffmpeg virtual FS → exec libmp3lame/
    libvorbis → baca output. Bahas: lazy-load strategy (jangan load 5MB 
    saat page load), API overhead, LGPL compliance untuk LAME
    
    JALUR C — Pure Rust encoder:
    MP3: TIDAK ADA pure-Rust MP3 encoder yang production-grade (yang ada 
    hanya decoder: puremp3, symphonia). Konfirmasi/bantah dan sebutkan 
    jika ada perkembangan baru.
    Vorbis: sama, lewton = decoder only, crate `ogg` = container only.
    Alternatif realistis: tawarkan Opus (via bindings juga C...) atau 
    justru rekomendasikan JALUR A/B dan jelaskan kenapa C ecosystem 
    tetap unavoidable untuk encoding di 2026.
    
    REKOMENDASI FINAL: pilih satu jalur untuk MVP dengan justifikasi 
    berbasis: binary size budget, build complexity, encode speed 
    (target: encode 5-menit stereo track < 15 detik di mid hardware), 
    dan maintenance burden.

3d. FILE DELIVERY:
    Blob → URL.createObjectURL → <a download> pattern, revokeObjectURL 
    lifecycle, dan File System Access API (showSaveFilePicker) sebagai 
    progressive enhancement dengan feature detection

=====================================================================
BAGIAN 4 — BUILD SYSTEM & TOOLING
=====================================================================
- Cargo workspace layout dengan crate split: dsp (no_std-compatible, 
  zero wasm deps — bisa di-test native & benchmark dengan criterion), 
  engine (menggunakan dsp), wasm-bridge (wasm-bindgen surface, tipis), 
  export (offline render + wav)
- Kenapa dsp crate harus compile untuk native juga: unit test dengan 
  proptest, benchmark criterion, dan debugging dengan cpal playback 
  native — jauh lebih cepat dari test-in-browser
- wasm-pack vs cargo build + wasm-bindgen CLI manual: mana yang cocok 
  untuk dual-module output (worklet module + worker module)
- Build profile: opt-level = 3, lto = "fat", codegen-units = 1, 
  panic = "abort" — lalu wasm-opt -O3 (atau -O4) pass, dan strip 
  producers section. Target size budget: engine module < 300KB gzipped
- Vite config: worklet file HARUS di-serve sebagai module terpisah 
  (audioWorklet.addModule butuh URL), bahas ?url import + build.target 
  esnext + optimizeDeps.exclude untuk wasm package
- CI: cargo test (native) + wasm-pack test --headless --chrome + 
  size regression check

=====================================================================
BAGIAN 5 — FAILURE MODES (jawab dengan mitigasi konkret)
=====================================================================
- Underrun: process() melebihi deadline → apa yang browser lakukan 
  (glitch, bukan crash), bagaimana detect (currentFrame gap), dan 
  degradation strategy (freeze/bypass FX per-track)
- WASM memory growth: memory.grow menginvalidasi semua TypedArray view 
  ke linear memory di JS — pattern re-acquire view setelah setiap call 
  yang bisa alloc, atau pre-reserve memory maximum di instantiation
- Tab throttling: background tab → rAF mati tapi AudioWorklet tetap 
  jalan — implikasi untuk UI meter sync
- Safari-specific: AudioContext butuh user gesture, sampleRate quirks, 
  SAB support status terkini

FORMAT JAWABAN:
a) ASCII diagram: thread topology + memory map SharedArrayBuffer 
   (offset table)
b) Cargo.toml lengkap semua crate + RUSTFLAGS/build script untuk 
   atomics build
c) Kode Rust: ring buffer SPSC di shared memory, biquad TDF-II, 
   mixing loop SIMD f32x4
d) Kode TS: worklet processor lengkap (instantiation + process loop), 
   export worker dengan progress
e) Vite config + header config production
f) Tabel keputusan MP3/OGG jalur A/B/C dengan rekomendasi final
g) Development roadmap: urutan milestone dengan definisi "done" 
   yang testable per milestone

LEVEL SAYA: paham Rust intermediate (ownership, traits, unsafe dasar) 
dan web dev. Belum pernah: real-time audio programming, lock-free 
programming, WASM threads. Jangan skip penjelasan "kenapa" di 
keputusan arsitektur — saya perlu paham reasoning-nya, bukan cuma copy 
paste.

=====================================================================
BAGIAN 6 — TIMELINE, CLIP MODEL & NON-DESTRUCTIVE EDITING
=====================================================================
6a. CLIP DATA MODEL (fondasi semua editing — rancang dulu sebelum UI):
    Semua edit (cut/trim/split) HARUS non-destructive: sample data asli 
    TIDAK PERNAH dimutasi. Clip = metadata yang mereferensi source asset:

    struct Clip {
        asset_id: AssetId,          // referensi ke PCM source di pool
        source_start: u64,          // offset trim-in (samples, di source)
        source_len: u64,            // panjang region yang dipakai
        timeline_pos: u64,          // posisi di timeline (samples)
        gain: f32,                  // clip gain (linear, dari dB)
        fade_in: FadeSpec,          // durasi + curve (linear/equal-power)
        fade_out: FadeSpec,
        speed_ratio: f64,           // lihat Bagian 8
        insert_chain: Vec<FxId>,    // efek per-clip (opsional, vs per-track)
    }

    Jawab spesifik:
    - Trim kiri/kanan = mutasi source_start/source_len saja. Split di 
      posisi X = 1 clip jadi 2 clip yang share asset_id sama. Tunjukkan 
      operasinya + edge case (split di tengah fade)
    - Asset pool: PCM f32 planar disimpan di WASM linear memory, 
      reference-counted (banyak clip → satu asset). Kapan evict? 
      Bahas juga OPFS (Origin Private File System) sebagai backing 
      store untuk project besar yang melebihi memory budget
    - Undo/redo: karena semua edit adalah mutasi metadata kecil, 
      command pattern dengan inverse operation ATAU immutable snapshot 
      (persistent data structure) — bandingkan, pilih satu
    - Sinkronisasi model: project model hidup di mana? Rekomendasi: 
      single source of truth di Rust (main thread WASM instance atau 
      via SAB), React hanya render dari derived state — bahas 
      alternatifnya dan konsekuensi state duplication

6b. DRAG & DROP + IMPORT PIPELINE:
    - File drop (dragover/drop events) → ArrayBuffer → decode. 
      Bandingkan: AudioContext.decodeAudioData (native, cepat, tapi 
      hasil di JS heap → perlu copy ke WASM memory) vs decode di Rust 
      pakai Symphonia (pure Rust: WAV/MP3/OGG/FLAC decode, langsung 
      ke WASM memory, jalan di Worker). Rekomendasi + justifikasi
    - Decode HARUS di Worker (file 10 menit = ratusan MB PCM, jangan 
      block main thread), progress reporting
    - Sample rate mismatch: file 44.1k di project 48k → resample saat 
      import (offline, kualitas tinggi: windowed-sinc) vs realtime 
      saat playback. Rekomendasi: import-time, jelaskan kenapa
    - Drag PREVIEW di timeline (ghost clip mengikuti cursor + snap) 
      sebelum drop committed

6c. WAVEFORM RENDERING (ini bottleneck UI paling umum di DAW web):
    - Multi-resolution peak pyramid (mipmap): precompute min/max per 
      64/512/4096-sample bucket di Rust (Worker) saat import. Zoom 
      level menentukan level pyramid yang dibaca — TIDAK PERNAH iterate 
      raw samples saat render
    - Render ke canvas: bandingkan Canvas2D per-clip dengan caching 
      (redraw hanya saat zoom/trim berubah) vs WebGL/WebGPU instanced. 
      Rekomendasi untuk 32 track × puluhan clip
    - Virtualisasi: hanya render clip yang visible di viewport
    - Zoom/scroll math (sample↔pixel) sudah di timeline-core crate — 
      definisikan API-nya: fn sample_to_px(s: u64, viewport: &Viewport) 
      -> f32, snap_to_grid dengan tempo map

6d. EDITING INTERACTIONS:
    - Hit-testing (clip body vs trim handle kiri/kanan vs fade handle) 
      di Rust atau JS? (hint: ini murah, JS cukup — jangan over-engineer)
    - Pointer capture untuk drag, modifier keys (snap override), 
      kolisi antar clip di track yang sama: overlap policy (crossfade 
      otomatis vs push vs reject)
    - CLICK-FREE EDITING: setiap boundary clip tanpa fade = potensi 
      click/pop. Kebijakan: micro-fade otomatis (2-5ms) di setiap 
      clip edge — implementasi di engine, bukan UI

6e. EFFECT ROUTING — PER-CLIP vs PER-TRACK:
    User bisa "menambahkan effect di clip". Bahas arsitektur:
    - Per-track insert chain (standar DAW): murah, 32 chain max
    - Per-clip inserts: FX instance hidup selama clip aktif — voice 
      management (aktivasi saat playhead masuk clip, tail handling 
      saat keluar clip — reverb tail terpotong?)
    - Rekomendasi MVP: per-track saja dulu, per-clip menyusul — 
      atau langsung keduanya? Justifikasi berdasarkan CPU budget 
      Bagian 2

=====================================================================
BAGIAN 7 — GAIN STAGING & MIXING (amplify per clip → satu master out)
=====================================================================
- Signal flow lengkap, urutan PASTI (gambarkan):
  source PCM → clip gain → clip fades → [per-clip FX] → track insert 
  chain → track fader → pan → sends (post-fader) → bus → master chain 
  → soft-clip/limiter opsional → output & export
- dB ↔ linear: fader taper law (kenapa fader UI tidak linear-dB; 
  kurva praktis: unity di 75% travel), pan law -3dB equal-power 
  (sin/cos), mono-compat
- Clip gain vs track fader: keduanya smoothed (Bagian 2a smoother), 
  clip gain di-apply saat clip render, fader di track summing
- Headroom & summing: internal f32 tidak clip secara matematis, tapi 
  output DAC clip di ±1.0 — kebijakan master: hard clamp vs soft 
  clipper (tanh/cubic) vs true-peak limiter sederhana. Rekomendasi MVP
- Metering per track + master: peak (dengan decay ballistics) + RMS, 
  ditulis audio thread → SAB meter block (layout dari Bagian 1b) → 
  UI baca via rAF. Clip indicator dengan hold
- "Mixing jadi satu audio" = export pipeline Bagian 3 — pastikan 
  offline render pakai signal flow yang SAMA PERSIS dengan realtime 
  (satu fungsi render_block dipakai keduanya — ini test correctness: 
  bounce harus null-test dengan realtime capture)

=====================================================================
BAGIAN 8 — PLAYBACK SPEED (per-clip DAN global/master)
=====================================================================
8a. KEPUTUSAN FUNDAMENTAL (jawab dulu sebelum implementasi):
    Dua mode mengubah kecepatan:
    (1) VARISPEED / resampling: pitch ikut berubah. Murah. 
        Implementasi: fractional read cursor + interpolasi
    (2) TIME-STRETCH pitch-preserved: pitch tetap. Mahal (WSOLA / 
        phase vocoder). Kualitas tergantung material (WSOLA bagus 
        untuk drum/percussive, phase vocoder untuk tonal/pad)
    Rekomendasi produk: MVP = varispeed (mode "tape"), time-stretch 
    = fase 2. ATAU keduanya sebagai toggle per-clip seperti Ableton 
    (Warp on/off). Pilih dan justifikasi.

8b. VARISPEED ENGINE (implementasi konkret):
    - Fractional cursor f64 per clip-voice, increment = speed_ratio
    - Interpolasi: linear (murah, aliasing saat speedup) vs cubic 
      Hermite vs windowed-sinc polyphase (8-16 tap). Rekomendasi: 
      cubic untuk MVP, sinc menyusul — tunjukkan implementasi cubic 
      Hermite 4-point di Rust
    - Anti-aliasing saat ratio > 1.0 (speedup = konten melebihi 
      Nyquist): butuh lowpass pre-filter yang cutoff-nya mengikuti 
      ratio — atau terima aliasing di MVP (jujur soal trade-off)
    - Ratio berubah saat playing: smoothing ratio (ramp) untuk 
      hindari click, dan efek "tape glide" sebagai bonus естественный

8c. TIME-STRETCH (fase 2, tapi arsitektur disiapkan sekarang):
    - Kandidat: implement WSOLA sendiri di Rust (±300 baris, kualitas 
      ok untuk 0.75x–1.5x) vs signalsmith-stretch (C++, ada Rust 
      binding — cek status WASM compat) vs Rubber Band (GPL! — 
      implikasi lisensi untuk produk komersial). Bandingkan
    - Realtime vs pre-rendered: stretch berat per-clip lebih baik 
      di-PRE-RENDER ke cache buffer saat user mengubah ratio 
      (debounced, di Worker, progress kecil) daripada realtime di 
      audio thread. Bahas kapan masing-masing
    - Latency & lookahead phase vocoder di konteks render quantum 128

8d. INTERAKSI PER-CLIP × GLOBAL SPEED:
    - effective_ratio = clip_ratio × master_ratio
    - Master ratio mengubah SEMUA clip — tapi apakah mengubah tempo 
      transport juga? Definisikan semantik: master varispeed 
      (transport clock tetap, semua audio di-resample) vs tempo 
      change (grid ikut berubah). Untuk DAW audio-clip-based, 
      rekomendasi + konsekuensi ke tempo map Bagian 2c
    - TIMELINE GEOMETRY: clip dengan ratio ≠ 1.0 punya panjang 
      timeline = source_len / ratio. Trim/split/snap/waveform harus 
      pakai timeline-space, konversi ke source-space saat render. 
      Definisikan dua koordinat space ini EKSPLISIT di timeline-core 
      (source samples vs timeline samples) — ini sumber off-by-one 
      bug klasik
    - Waveform rendering clip yang di-stretch: peak pyramid dibaca 
      dengan stride × ratio (murah) — bukan regenerate

=====================================================================
BAGIAN 9 — UI IMPLEMENTATION DARI DESIGN YANG SUDAH ADA
=====================================================================
Component design sudah tersedia. Import dan implementasikan dari 
project berikut:

Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, 
auth via /design-login) to import this project:
https://claude.ai/design/p/4100dc75-ccfa-449d-bb74-1bb2da01df39?file=DAW+Components.dc.html

Focus on these files (the whole project is readable):
- `DAW Components.dc.html`
Also read these files the selection imports:
- `ds-base.js`
- `support.js`

Implement: `DAW Components.dc.html`

Aturan implementasi UI:
- Ikuti struktur komponen, styling, dan token dari design file — 
  JANGAN improvisasi visual sendiri
- Petakan setiap komponen design ke data model Bagian 6 (clip, track, 
  fader, transport) dan sebutkan mapping-nya eksplisit sebelum coding
- Komponen yang butuh rendering performa tinggi (timeline/waveform) 
  boleh diganti canvas di dalam shell komponen design, selama visual 
  akhir match dengan design
- State flow: React components = presentational; semua mutasi lewat 
  command ke engine/model (Bagian 6a), tidak ada logika edit di 
  komponen


h) Definisi lengkap Clip/Track/Project struct (Rust) + JSON schema 
   untuk project file serialization
i) Kode Rust: cubic Hermite resampler + fractional cursor voice
j) Diagram signal flow (Bagian 7) dari clip source sampai master out
k) Tabel mapping komponen design → data model → engine command

