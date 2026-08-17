# DawOnWeb

DAW (Digital Audio Workstation) yang berjalan di browser. Engine audio, DSP,
timeline, dan export ditulis dalam **Rust** dan dikompilasi ke
`wasm32-unknown-unknown`; UI-nya **TypeScript + React 18 + Vite**. Host realtime-nya
adalah **AudioWorklet**, dengan komunikasi lock-free lewat `SharedArrayBuffer`
(SPSC ring + SeqLock) — tidak ada data per-frame yang lewat `postMessage`.

Fungsi render yang sama (`Engine::render_block`) dipakai untuk playback realtime
**dan** untuk bounce offline, sehingga null-test (bounce vs capture realtime)
valid sebagai tes korektnes.

## Prasyarat

- Rust nightly (otomatis lewat `rust-toolchain.toml`) + target `wasm32-unknown-unknown`
- `wasm-bindgen-cli` 0.2.x — `cargo install wasm-bindgen-cli`
- `binaryen` (untuk `wasm-opt`) — `brew install binaryen` / `apt install binaryen`
- Node 20+ dan pnpm 9+

## Quickstart

```bash
pnpm install
pnpm build:wasm        # build engine-mt + engine-st ke web/src/wasm/
pnpm dev               # Vite dev server (sudah mengirim header COOP/COEP)
```

Perintah lain:

```bash
pnpm test              # cargo test --workspace + tes web
pnpm build             # build wasm + bundle produksi ke web/dist
pnpm size-check        # gate ukuran: engine < 300 KB gzipped
cargo run -p daw-native-host --release   # putar engine lewat speaker (dev/profiling)
```

> **Catatan COOP/COEP.** `SharedArrayBuffer` hanya aktif kalau
> `crossOriginIsolated === true`. Untuk produksi lihat `deploy/nginx.conf`.
> Tanpa isolasi, aplikasi tetap jalan dalam *degraded mode* (command lewat
> `postMessage`, export single-thread) memakai artefak `web/src/wasm/st/`.

## Struktur

```
crates/dsp/            filter, kompresor, mixing SIMD, fastmath  (no_std, native-testable)
crates/rt/             SPSC ring, SeqLock, layout SAB, pool      (no_std)
crates/timeline-core/  model project, tempo map, snap            (no_std)
crates/engine/         ProcessPlan, VoicePool, Transport, render_block()
crates/export/         render offline + WAV writer + dither
crates/wasm-bridge/    satu-satunya crate yang tahu wasm-bindgen
crates/native-host/    [dev] host cpal untuk debugging di desktop
web/                   UI React + Vite, worklet, worker
scripts/               build-wasm.sh, size-check.sh
deploy/                nginx.conf (COOP/COEP + mime wasm)
```

## Dokumentasi

Mulai dari **[ARCHITECTURE.md](ARCHITECTURE.md)** — di sana ada index ke seluruh
dokumen desain (`docs/00`–`docs/09`). `docs/00-api-contract.md` dan
`docs/04-build.md` sifatnya **mengikat**: jangan diubah tanpa memperbarui
dokumennya lebih dulu.
