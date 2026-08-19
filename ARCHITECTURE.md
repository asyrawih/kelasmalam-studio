# DawOnWeb — Arsitektur

Browser-based DAW. Rust → `wasm32-unknown-unknown` untuk engine/DSP/timeline/export,
TypeScript + React 18 + Vite untuk UI, AudioWorklet sebagai host realtime.

Dokumen ini adalah index. Detail per bagian:

| Dok | Isi |
|---|---|
| [docs/01-threads-memory.md](docs/01-threads-memory.md) | Thread topology, instantiasi WASM di worklet, SAB layout + offset table, SPSC ring, real-time safety, COOP/COEP |
| [docs/02-dsp-engine.md](docs/02-dsp-engine.md) | Graph processing, buffer lifetime, smoothing, biquad TDF-II, compressor, denormal, SIMD, sample-accurate sequencing, **insert FX** (registry, arena, anggaran CPU, bypass) |
| [docs/03-export.md](docs/03-export.md) | Offline render di Worker, WAV + TPDF dither + 24-bit packing, analisis MP3/OGG jalur A/B/C, file delivery |
| [docs/04-build.md](docs/04-build.md) | Cargo workspace, RUSTFLAGS atomics, wasm-pack vs manual, profil rilis, Vite config, CI |
| [docs/05-failure-modes.md](docs/05-failure-modes.md) | Underrun, memory.grow, tab throttling, Safari |
| [docs/06-timeline-clips.md](docs/06-timeline-clips.md) | Clip model non-destruktif, import/decode, waveform pyramid, editing, routing FX (per-clip, per-track, master) |
| [docs/07-gain-speed.md](docs/07-gain-speed.md) | Signal flow, gain staging, metering, varispeed + time-stretch, dua koordinat space |
| [docs/08-ui-mapping.md](docs/08-ui-mapping.md) | Mapping komponen design → data model → engine command |
| [docs/09-roadmap.md](docs/09-roadmap.md) | Milestone M0–M9 dengan definisi "done" yang testable |
| [recordbox/00-plan.md](recordbox/00-plan.md) | Halaman `/dj` — mixer 2 deck ala rekordbox: keputusan, empat utang yang dinyatakan terbuka, fase D0–D9 |

---

## a) Thread topology (high level)

```
┌─────────────────────────── MAIN THREAD (JS/React) ────────────────────────────┐
│  React 18 UI (presentational)                                                 │
│  ProjectStore (mirror read-only dari Rust)  ──► commands ──┐                  │
│  rAF loop: baca METER block dari SAB, gambar canvas         │                 │
│  Waveform canvas draw (baca peak pyramid via SAB view)      │                 │
└─────────────┬───────────────────────────────┬───────────────┼─────────────────┘
              │ postMessage (WASM.Module,      │ SAB (shared) │ SAB (shared)
              │ SAB handles) — SETUP ONLY      │              │
              ▼                                ▼              ▼
┌──────────── AUDIOWORKLET THREAD ─────────────────────────────────────────────┐
│  DawProcessor extends AudioWorkletProcessor                                   │
│  new WebAssembly.Instance(module, {env:{memory: sharedMemory}})  ← SINKRON    │
│  Engine (Rust struct, &mut eksklusif, zero alloc di process())                │
│  process(): 128 frame → drain CommandRing → render_block → tulis METER        │
│  DILARANG: alloc, panic, lock, Atomics.wait, postMessage per-block            │
└───────────────────────────────────────────────────────────────────────────────┘
              ▲ PCM asset (read-only) share via WASM shared linear memory
              │
┌──────────── WORKER POOL (n = navigator.hardwareConcurrency - 2) ─────────────┐
│  import-worker : Symphonia decode → PCM → peak pyramid (mipmap) → SAB        │
│  export-worker : WASM Engine instance #2 (state di-serialize dari project),   │
│                  loop offline: 100 blok/iterasi → progress → encoder          │
│  stretch-worker: pre-render WSOLA/phase-vocoder ke cache buffer (fase 2)      │
└───────────────────────────────────────────────────────────────────────────────┘
              │ PCM f32 interleaved
              ▼
┌──────────── ENCODER (lazy-loaded, terpisah dari engine) ─────────────────────┐
│  WAV  : Rust `hound` di dalam export crate (in-process, no copy antar module) │
│  MP3  : lamejs (MVP)  → sidecar emcc LAME (mature)                            │
│  OGG  : ogg-vorbis-encoder-js (emcc libvorbis, lazy-load)                     │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Aturan emas yang mengikat seluruh desain:**

1. Data per-frame **tidak pernah** lewat `postMessage`. `postMessage` hanya untuk
   setup (transfer `WebAssembly.Module`, handle SAB) dan event low-rate
   (progress export, error).
2. Audio thread **tidak pernah** memblok. Tidak ada `Atomics.wait`, tidak ada
   mutex, tidak ada alokasi, tidak ada `panic!`.
3. Realtime dan offline render memakai **fungsi `render_block` yang sama persis**.
   Ini bukan sekadar DRY — ini yang membuat null-test (bounce vs realtime capture)
   valid sebagai tes korektnes.
4. Single source of truth project model ada di **Rust**. React hanya me-render
   derived state.

## b/c/d/e/f/h/i/j/k

Kode konkret ada di repo ini (bukan di dokumen):

- **b)** `Cargo.toml` (root workspace) + tiap `crates/*/Cargo.toml` + `.cargo/config.toml`
  (RUSTFLAGS atomics) + `web/package.json` + `package.json` root.
- **c)** SPSC ring: `crates/rt/src/ring.rs` · biquad TDF-II: `crates/dsp/src/biquad.rs` ·
  SIMD mixing: `crates/dsp/src/mix.rs`
- **d)** worklet: `web/src/audio/worklet-processor.ts` · export worker:
  `web/src/audio/export-worker.ts`
- **e)** Vite + header produksi: `web/vite.config.ts`, `web/public/_headers`, `deploy/nginx.conf`
- **f)** Tabel keputusan MP3/OGG: [docs/03-export.md §3c](docs/03-export.md)
- **h)** Struct + JSON schema: `crates/timeline-core/src/model.rs`, `schema/project.schema.json`
- **i)** Cubic Hermite + fractional cursor: `crates/dsp/src/resample.rs`
- **j)** Signal flow diagram: [docs/07-gain-speed.md](docs/07-gain-speed.md)
- **k)** Tabel mapping komponen design: [docs/08-ui-mapping.md](docs/08-ui-mapping.md)

Tambahan di luar daftar semula:

- Deteksi tempo (BPM) gaya DJ: `crates/analysis/` + `web/src/audio/tempo-worker.ts` —
  [docs/10-tempo-detection.md](docs/10-tempo-detection.md)
- Beat loop cut & pembuangan stem (mid/side) di Clip Detail —
  [docs/11-beat-loop-stem.md](docs/11-beat-loop-stem.md)
- Seleksi banyak clip (kotak seleksi) & tinggi lane —
  [docs/12-timeline-selection.md](docs/12-timeline-selection.md)
- Toolbar menu ikon + popup (menggantikan rail kanan & kartu Clip Detail) —
  [docs/13-menu-toolbar.md](docs/13-menu-toolbar.md)
- App shell: routing, registry command, dan keyboard yang bisa di-remap —
  [docs/15-app-shell.md](docs/15-app-shell.md). Ia yang membuat pintu masuk
  berikutnya (MIDI, macro, remote) jadi satu penerjemah, bukan satu salinan
  daftar aksi.
- Halaman ketiga `/dj`, mixer DJ 2 deck ala rekordbox — [recordbox/](recordbox/).
  Berbunyi lewat Web Audio (`web/src/dj/audio/`), memakai ulang `AudioContext`
  dan cache PCM milik preview Studio. Menarik jog atau waveform terdengar —
  scrub granular yang meredam source utama selama tangan menempel
  (`dj/audio/scrub-voice.ts`). MASTER TEMPO, scratch (memutar balik), dan
  deteksi key sengaja belum ada, dan halamannya mengatakan itu apa adanya.

## Quickstart

```bash
rustup toolchain install nightly            # butuh -Z build-std untuk atomics
rustup component add rust-src --toolchain nightly
rustup target add wasm32-unknown-unknown --toolchain nightly
cargo install wasm-bindgen-cli wasm-opt

pnpm install
pnpm run build:wasm      # engine + export module
pnpm run dev             # Vite dengan header COOP/COEP
```
