# Bagian 4 — Build System & Tooling

## Layout workspace

```
crates/
  dsp/            no_std-compatible, ZERO dependensi wasm. Biquad, comp, smoother,
                  resampler, SIMD mix, fastmath. Di-test & di-benchmark native.
  rt/             primitif lock-free: SPSC ring, SeqLock, layout SAB, arena/pool,
                  rt_guard (allocator penjaga untuk tes). no_std-compatible.
  timeline-core/  model data (Clip/Track/Project), dua koordinat space,
                  tempo map, konversi sample↔pixel, snap. Murni matematika,
                  no_std-compatible, property-tested.
  engine/         merangkai semuanya: ProcessPlan, VoicePool, Transport,
                  render_block(). Bergantung pada dsp + rt + timeline-core.
                  TIDAK bergantung wasm-bindgen.
  export/         offline render loop + WAV writer + dither. Bergantung engine.
  wasm-bridge/    SATU-SATUNYA crate yang tahu wasm-bindgen. Tipis.
                  Dua surface: raw (no_mangle, untuk worklet) & bindgen (untuk
                  main thread + worker).
  native-host/    [dev only] binary cpal untuk memainkan engine di desktop.
```

### Kenapa `dsp` (dan `timeline-core`) HARUS compile native

Ini bukan kemurnian arsitektur — ini kecepatan iterasi, dan bedanya besar:

1. **Unit test + `proptest`.** Property test seperti "biquad lowpass tidak pernah
   menghasilkan NaN untuk input apa pun dan koefisien valid apa pun" butuh
   ribuan kasus. Di native: 0.2 detik. Lewat `wasm-pack test --headless`: puluhan
   detik plus flakiness browser.
2. **`criterion` benchmark.** Angka ns/iter yang stabil dan berbanding. Di
   browser tidak ada timer presisi (`performance.now()` di-*coarsen* jadi
   ~100 µs demi Spectre) — benchmark mikro praktis mustahil. Aturan praktis:
   WASM ≈ 1.5–3× lebih lambat dari native untuk kode float scalar, dan mendekati
   native untuk kode SIMD128. Jadi optimasi di native tetap transfer.
3. **Debugging dengan `cpal`.** `crates/native-host` memutar engine lewat
   speaker asli. Kamu bisa pakai `dbg!`, `rr`/lldb, perf profiler yang benar
   (`cargo flamegraph`), dan mendengar hasilnya. Debugging audio di dalam
   AudioWorklet itu: tidak ada breakpoint yang berguna (menghentikan audio
   thread = xrun), `console.log` mengubah timing, DevTools profiler tidak
   menampilkan worklet dengan baik.
4. **Fuzzing** (`cargo-fuzz`) hanya jalan native.

Konsekuensi aturan: `dsp`, `rt`, `timeline-core`, `engine`, `export` **tidak
boleh** meng-`use wasm_bindgen` atau `web_sys`. Ada tes CI yang menegakkannya
(`cargo tree -p dsp | grep -q wasm-bindgen && exit 1`).

## `wasm-pack` vs `cargo build` + `wasm-bindgen` CLI

Kita butuh **dua artefak berbeda** dari workspace yang sama:

| Artefak | Konsumen | Target wasm-bindgen | Format bundle |
|---|---|---|---|
| `engine.wasm` + glue | AudioWorklet (classic script!) + main thread | `web` | IIFE untuk worklet, ESM untuk main |
| `export.wasm` + glue | Web Worker (module worker) | `web` | ESM |

`wasm-pack` bagus untuk **satu** paket npm konvensional. Untuk kasus dua-artefak
dengan flag build berbeda (`+atomics` untuk engine, opsional untuk export) dan
post-processing khusus, `wasm-pack` lebih menghalangi daripada membantu:
`--target no-modules` tidak bisa dicampur per-entry, dan hook build-nya terbatas.

**Keputusan: `cargo build` + `wasm-bindgen` CLI manual**, di-orkestrasi oleh
`scripts/build-wasm.sh`. Sekitar 40 baris shell, kontrol penuh, dan mudah
dipahami saat ada yang salah. `wasm-pack` tetap dipakai untuk **`wasm-pack test
--headless --chrome`** di CI (di sana ia memang alat terbaik).

```bash
# scripts/build-wasm.sh (ringkas — file lengkap ada di repo)
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals \
           -C link-arg=--max-memory=2147483648 \
           -C link-arg=--import-memory \
           -C link-arg=--shared-memory" \
cargo +nightly build -p wasm-bridge --release \
      --target wasm32-unknown-unknown \
      -Z build-std=std,panic_abort \
      -Z build-std-features=panic_immediate_abort

wasm-bindgen target/wasm32-unknown-unknown/release/wasm_bridge.wasm \
      --out-dir web/src/wasm --target web --no-typescript=false

wasm-opt -O4 --enable-simd --enable-threads --enable-bulk-memory \
      --strip-debug --strip-producers \
      -o web/src/wasm/wasm_bridge_bg.wasm web/src/wasm/wasm_bridge_bg.wasm
```

## Build profile

```toml
[profile.release]
opt-level     = 3
lto           = "fat"
codegen-units = 1
panic         = "abort"
strip         = true

[profile.release.package."*"]
opt-level = 3
```

- `lto = "fat"` penting di sini: inlining lintas-crate (dsp → engine) adalah
  sumber percepatan terbesar. `thin` kehilangan sebagian.
- `codegen-units = 1` menambah waktu build ~2× tapi memberi 5–15% di hot loop.
- `panic = "abort"` menghapus seluruh mesin unwinding → binary lebih kecil dan
  tidak ada landing pad di hot path. Dengan `-Z build-std-features=panic_immediate_abort`,
  bahkan string pesan panic ikut hilang (menghemat ~40 KB).
- `opt-level = "z"` **tidak** dipakai untuk engine — kita menukar ukuran demi
  kecepatan di sini. Untuk `export` (yang tidak realtime) `opt-level = 3` juga,
  karena kecepatan encode terasa oleh user.

Lalu **`wasm-opt`** (dari binaryen), yang melakukan optimasi yang LLVM tidak
lakukan pada level WASM: `-O4`, `--strip-debug`, `--strip-producers`
(menghapus section metadata toolchain), `--strip-dwarf`. Tambahan ~10–20%
kecepatan dan ~15% ukuran.

**Budget ukuran: engine module < 300 KB gzipped.** Di-enforce di CI:

```yaml
- run: |
    SIZE=$(gzip -c web/src/wasm/wasm_bridge_bg.wasm | wc -c)
    echo "engine gz: $SIZE"
    test "$SIZE" -lt 307200 || { echo "SIZE BUDGET EXCEEDED"; exit 1; }
```

Yang biasanya membengkakkan: `std::fmt` (dari `format!`/`Debug`), `serde_json`
(pakai `postcard` di jalur WASM), dan panic messages. `twiggy top` untuk
mendiagnosis.

## Vite config

Tiga hal yang non-obvious:

1. **Worklet harus jadi file terpisah dengan URL sendiri.** `audioWorklet.addModule()`
   menerima URL, bukan modul. Dan file itu dimuat sebagai **classic script**,
   jadi tidak boleh mengandung `import`.

   Solusinya: `?url` import di dev, dan **entry Rollup terpisah dengan
   `format: 'iife'`** di build:

   ```ts
   // di kode aplikasi
   import workletUrl from './audio/worklet-processor.ts?worker&url';
   await ctx.audioWorklet.addModule(workletUrl);
   ```
   Vite 5 menangani `?worker&url` untuk worker; untuk worklet kita definisikan
   input tambahan di `build.rollupOptions.input` + `output.format:'iife'` via
   plugin kecil. Lihat `web/vite.config.ts` di repo — ada plugin
   `audioWorkletPlugin()` 20 baris yang mem-build entry worklet sebagai IIFE
   dan mengembalikan URL hash-nya.

2. **`optimizeDeps.exclude`** untuk paket WASM. Pre-bundler esbuild Vite akan
   mencoba memproses glue wasm-bindgen dan merusak resolusi `new URL('...wasm',
   import.meta.url)`. Selalu:
   ```ts
   optimizeDeps: { exclude: ['@daw/wasm'] }
   ```

3. **`build.target: 'esnext'`** — dibutuhkan untuk top-level await (dipakai
   loader WASM), `import.meta.url`, dan supaya esbuild tidak men-downlevel
   `BigInt` literal (kita pakai `BigInt64Array` untuk playhead u64).

Plus `server.headers` COOP/COEP dari Bagian 1d, dan `worker.format: 'es'`.

## CI

```yaml
jobs:
  native:
    - cargo fmt --check
    - cargo clippy --workspace --all-targets -- -D warnings
    - cargo test  --workspace                     # unit + proptest
    - cargo bench --bench render -- --save-baseline pr   # bandingkan vs main
    - cargo test -p engine --features rt-guard    # deteksi alokasi di RT path
  wasm:
    - wasm-pack test --headless --chrome crates/wasm-bridge
    - ./scripts/build-wasm.sh && ./scripts/size-check.sh
  web:
    - pnpm -C web test        # termasuk tes sinkronisasi layout SAB Rust↔TS
    - pnpm -C web build
  golden:
    - cargo test -p export --test null_test        # bounce == realtime capture
```

Tes `null_test` adalah yang paling berharga: me-render project referensi lewat
`render_block` dua kali dengan jalur berbeda (simulasi realtime blok-128 vs
offline batch) dan memverifikasi **sample-exact identik**. Ini yang menjaga
janji "satu fungsi render dipakai keduanya" tidak diam-diam rusak.
