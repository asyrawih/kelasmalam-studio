#!/usr/bin/env bash
#
# Rakit `.vercel/output` (Build Output API v3) untuk deploy `--prebuilt`.
#
# KENAPA PREBUILT, BUKAN GIT INTEGRATION VERCEL:
# `pnpm build` menjalankan `build:wasm`, yang butuh Rust nightly + rust-src +
# wasm-bindgen-cli + binaryen, dan `-Z build-std` mengompilasi ulang `std`.
# Build image Vercel tidak punya semua itu; memasangnya tiap build berarti
# belasan menit dan bergantung pada cache yang tidak dijamin. Jadi CI yang
# membangun (Rust-nya memang sudah ada di sana untuk `cargo test`), lalu Vercel
# hanya menerima hasilnya.
#
# KONSEKUENSI YANG HARUS DIINGAT: pada deploy `--prebuilt`, `vercel.json` TIDAK
# dibaca. Konfigurasi rute/header datang dari `.vercel/output/config.json`, yang
# disalin dari `deploy/vercel-config.json`. Itu satu-satunya sumber kebenaran —
# sengaja tidak ada `vercel.json` di repo ini supaya tidak ada dua berkas yang
# saling bertentangan dan hanya satu yang benar-benar berlaku.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.vercel/output"
CONFIG="$ROOT/deploy/vercel-config.json"
DIST="$ROOT/web/dist"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

log "Build artefak WASM"
"$ROOT/scripts/build-wasm.sh"

log "Cek budget ukuran"
"$ROOT/scripts/size-check.sh"

log "Build frontend"
( cd "$ROOT/web" && npm run build )

# Worklet WAJIB berupa JavaScript. `audioWorklet.addModule()` memuatnya sebagai
# classic script; TypeScript mentah atau satu `import` saja = SyntaxError yang
# baru muncul di runtime produksi. Pernah terjadi: `main.tsx` memuat worklet
# lewat `new URL(...)` biasa dan Vite menyalin berkas .ts apa adanya.
log "Verifikasi hasil build"
if compgen -G "$DIST/assets/*.ts" > /dev/null; then
  echo "GAGAL: ada berkas .ts mentah di dist/assets — worklet tidak dikompilasi." >&2
  exit 1
fi
WORKLET="$(ls "$DIST"/assets/worklet-processor-*.js 2>/dev/null | head -1 || true)"
if [ -z "$WORKLET" ]; then
  echo "GAGAL: worklet-processor-*.js tidak ada di dist/assets." >&2
  exit 1
fi
# Pola ini SENGAJA sempit: `import` harus langsung diikuti `(`, `{`, `*`, atau
# kutip — bentuk statement/ekspresi yang sesungguhnya. Versi longgar sebelumnya
# ikut menerima spasi sebagai penutup, sehingga kalimat biasa di dalam string
# (mis. pesan error "import non-RT dipanggil...") dibaca sebagai import dan
# build gagal tanpa sebab. Penjaga sebenarnya ada di `bundleWorklet()`
# (vite.config.ts) yang memeriksa chunk sebelum di-emit; yang di sini lapis
# kedua untuk menangkap perubahan pipeline.
if grep -qE '(^|[^A-Za-z0-9_$.])import[[:space:]]*[({*'"'"'"]' "$WORKLET"; then
  echo "GAGAL: worklet masih mengandung \`import\` — addModule() akan gagal." >&2
  exit 1
fi
for v in mt st; do
  [ -f "$DIST/../src/wasm/$v/engine_bg.wasm" ] || {
    echo "GAGAL: artefak $v tidak ada." >&2; exit 1; }
done

log "Rakit .vercel/output"
rm -rf "$OUT"
mkdir -p "$OUT/static"
cp "$CONFIG" "$OUT/config.json"
cp -R "$DIST"/. "$OUT/static/"

printf '\nSelesai. Isi %s:\n' "$OUT"
du -sh "$OUT/static" | sed 's/^/  /'
echo "  config.json <- deploy/vercel-config.json"
echo
echo "Deploy:  vercel deploy --prebuilt --prod"
