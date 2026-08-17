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

## Deploy (Vercel)

**Modelnya: CI yang membangun, Vercel hanya menerima hasil jadi** (`--prebuilt`).

Engine butuh Rust nightly + `rust-src` + `wasm-bindgen-cli` + `binaryen`, dan
`-Z build-std` mengompilasi ulang `std`. Build image Vercel tidak punya itu;
memasangnya tiap build berarti belasan menit dan bergantung pada cache yang
tidak dijamin. Toolchain-nya sudah ada di CI untuk `cargo test`, jadi
membangunnya di sana gratis.

### Sekali saja

```bash
npx vercel link              # buat/pilih project
cat .vercel/project.json     # { "orgId": "...", "projectId": "..." }
```

Lalu tambahkan tiga secret di GitHub (**Settings → Secrets and variables → Actions**):

| Secret | Dari mana |
|---|---|
| `VERCEL_TOKEN` | <https://vercel.com/account/settings/tokens> → Create Token |
| `VERCEL_ORG_ID` | `orgId` di `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | `projectId` di `.vercel/project.json` |

Scope token **harus cocok** dengan `VERCEL_ORG_ID` (personal vs tim). Kalau
tidak, deploy ditolak dengan "not authorized" yang tidak menyebut penyebabnya.
Token hanya ditampilkan sekali saat dibuat.

### Jalannya

Push ke `main` → `.github/workflows/deploy.yml` menjalankan tes Rust + web,
membangun artefak, lalu deploy ke produksi. `workflow_dispatch` untuk preview.
Tanpa `VERCEL_TOKEN`, workflow tetap membangun dan mengunggah hasilnya sebagai
artifact — tidak gagal.

Deploy manual dari mesin sendiri (memakai sesi `vercel login`, tanpa token):

```bash
./scripts/vercel-build.sh          # wasm → size-check → vite build → verifikasi → .vercel/output
npx vercel deploy --prebuilt --prod
```

### Yang perlu diketahui

- **`vercel.json` TIDAK dibaca** pada deploy `--prebuilt`. Rute dan header
  datang dari `.vercel/output/config.json`, yang disalin dari
  **`deploy/vercel-config.json`** — itu satu-satunya sumber kebenaran untuk
  header.
- `vercel.json` di root **hanya** berisi `"ignoreCommand": "exit 0"`, yang
  membatalkan build yang dipicu integrasi Git Vercel (exit 0 = lewati). Tanpa
  itu, tiap push memicu DUA jalur: CI yang benar, dan build Vercel sendiri yang
  pasti gagal karena runner-nya tidak punya Rust. Berkas ini sengaja tidak
  memuat header apa pun supaya tidak ada dua sumber yang bertentangan.
- `web/public/_headers` ikut ter-copy tapi **tidak berpengaruh di Vercel**; itu
  untuk Cloudflare Pages / Netlify.
- Sourcemap mati di produksi (`VITE_SOURCEMAP=1` untuk menyalakannya).
- `scripts/vercel-build.sh` menggagalkan build kalau menemukan berkas `.ts`
  mentah di `dist/assets` atau `import` yang tersisa di worklet — dua kegagalan
  yang **hanya muncul di produksi**: `audioWorklet.addModule()` memuat berkas
  sebagai classic script, jadi keduanya baru meledak saat runtime.

### Setelah deploy pertama

Tiga hal ini hanya terbukti di lingkungan sungguhan — cek di console:

```js
crossOriginIsolated          // harus true (COOP/COEP aktif)
```

lalu pastikan varian yang termuat **`mt`** (bukan `st`), dan lakukan satu export
WAV sampai berkasnya terunduh.

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
scripts/               build-wasm.sh, size-check.sh, vercel-build.sh
deploy/                vercel-config.json (sumber header/rute produksi)
                       nginx.conf (alternatif self-host: COOP/COEP + mime wasm)
```

## Dokumentasi

Mulai dari **[ARCHITECTURE.md](ARCHITECTURE.md)** — di sana ada index ke seluruh
dokumen desain (`docs/00`–`docs/09`). `docs/00-api-contract.md` dan
`docs/04-build.md` sifatnya **mengikat**: jangan diubah tanpa memperbarui
dokumennya lebih dulu.
