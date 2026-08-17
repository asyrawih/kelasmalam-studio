#!/usr/bin/env bash
# Build dua artefak WASM dari crate `daw-wasm` (crates/wasm-bridge):
#
#   web/src/wasm/mt/  → engine-mt : +atomics +simd128, shared/imported memory.
#                       Dipakai kalau crossOriginIsolated === true.
#   web/src/wasm/st/  → engine-st : TANPA atomics, memory biasa (non-shared).
#                       Jalur degraded (docs/01 §1d) — build +atomics tidak akan
#                       jalan sama sekali tanpa shared memory, jadi butuh
#                       artefak kedua, bukan sekadar feature flag runtime.
#
# Lihat docs/04-build.md (kenapa cargo+wasm-bindgen manual, bukan wasm-pack).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
OUT_BASE="$ROOT/web/src/wasm"
PKG="daw-wasm"
LIB="daw_wasm"          # nama lib = nama package dengan '-' → '_'
OUT_NAME="engine"       # menghasilkan engine.js + engine_bg.wasm
TRIPLE="wasm32-unknown-unknown"

# --- prasyarat -------------------------------------------------------------
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' tidak ditemukan di PATH. $2" >&2
    exit 1
  }
}
need cargo   "install rustup: https://rustup.rs"
need wasm-bindgen "cargo install wasm-bindgen-cli --version 0.2"
need wasm-opt     "install binaryen (brew install binaryen / apt install binaryen)"

# Versi wasm-bindgen CLI harus SAMA PERSIS dengan versi crate wasm-bindgen,
# kalau tidak glue-nya akan mismatch dengan section __wbindgen di .wasm.
CLI_VER="$(wasm-bindgen --version | awk '{print $2}')"
CRATE_VER=""
if [ -f "$ROOT/Cargo.lock" ]; then
  CRATE_VER="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[",]/,""); print $3; exit}' "$ROOT/Cargo.lock")"
fi
if [ -n "$CRATE_VER" ] && [ "$CLI_VER" != "$CRATE_VER" ]; then
  echo "warning: wasm-bindgen CLI $CLI_VER != crate $CRATE_VER (jalankan: cargo install -f wasm-bindgen-cli --version $CRATE_VER)" >&2
fi

# --- flag ------------------------------------------------------------------
# Flag multi-thread sudah ada di .cargo/config.toml. Kita set ulang di sini
# secara eksplisit supaya skrip ini tetap benar walau dipanggil dengan
# RUSTFLAGS dari luar (env var MENGGANTI rustflags dari config, bukan menambah).
RUSTFLAGS_MT="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 \
-C link-arg=--import-memory \
-C link-arg=--shared-memory \
-C link-arg=--max-memory=2147483648 \
-C link-arg=-zstack-size=1048576"

# Varian ST: tanpa atomics dan tanpa shared/imported memory. SIMD tetap boleh —
# SIMD tidak butuh cross-origin isolation (docs/01 §1d tabel).
RUSTFLAGS_ST="-C target-feature=+bulk-memory,+mutable-globals,+simd128"

BUILD_STD_ARGS=(-Z build-std=std,panic_abort -Z build-std-features=panic_immediate_abort)

# Fitur wasm yang boleh dipakai wasm-opt — DIDAFTAR SATU PER SATU, jangan `-all`.
#
# `-all` pernah dipakai di sini dengan alasan yang masuk akal (rustc terus
# menambah fitur default; `nontrapping-float-to-int` sempat menjatuhkan build).
# Tapi `-all` juga menyalakan proposal yang MASIH EKSPERIMEN di binaryen —
# sejak binaryen 132 termasuk `custom-descriptors`, yang MENGUBAH ENCODING
# section import. Hasilnya: file .wasm yang tidak bisa di-compile browser
# maupun Node sama sekali ("unknown import kind 0x7f"), padahal wasm-opt keluar
# dengan status 0 dan ukurannya terlihat wajar. Itu kegagalan diam: satu-satunya
# gejalanya adalah engine tidak pernah bisa dimuat.
#
# Daftar di bawah = fitur yang benar-benar di-emit rustc untuk target kita.
# Kalau toolchain naik dan wasm-opt mengeluh soal fitur yang belum terdaftar,
# TAMBAHKAN fitur itu ke sini — jangan kembali ke `-all`.
WASM_OPT_FEATURES=(--enable-bulk-memory
                   --enable-mutable-globals
                   --enable-simd
                   --enable-nontrapping-float-to-int
                   --enable-sign-ext
                   --enable-multivalue
                   --enable-reference-types
                   --enable-extended-const)
WASM_OPT_ARGS_MT=(-O4 "${WASM_OPT_FEATURES[@]}" --enable-threads
                  --strip-debug --strip-producers --strip-dwarf)
WASM_OPT_ARGS_ST=(-O4 "${WASM_OPT_FEATURES[@]}" --disable-threads
                  --strip-debug --strip-producers --strip-dwarf)

# build_variant <nama> <outdir> <rustflags> <wasm-opt args...>
build_variant() {
  local name="$1"; shift
  local outdir="$1"; shift
  local flags="$1"; shift
  local optargs=("$@")

  echo "==> build $name"
  rm -rf "$outdir"
  mkdir -p "$outdir"

  # Target dir terpisah per varian: RUSTFLAGS berbeda = artefak berbeda, dan
  # cargo akan me-rebuild seluruh dunia bolak-balik kalau berbagi direktori.
  local tdir="$TARGET_DIR/wasm-$name"

  RUSTFLAGS="$flags" cargo build \
    -p "$PKG" \
    --release \
    --target "$TRIPLE" \
    --target-dir "$tdir" \
    "${BUILD_STD_ARGS[@]}"

  local wasm="$tdir/$TRIPLE/release/$LIB.wasm"
  [ -f "$wasm" ] || { echo "error: artefak tidak ditemukan: $wasm" >&2; exit 1; }

  wasm-bindgen "$wasm" \
    --out-dir "$outdir" \
    --out-name "$OUT_NAME" \
    --target web \
    --typescript

  echo "--> wasm-opt $name"
  wasm-opt "${optargs[@]}" \
    -o "$outdir/${OUT_NAME}_bg.wasm" \
       "$outdir/${OUT_NAME}_bg.wasm"

  # Artefak WAJIB bisa di-compile mesin wasm sungguhan sebelum dianggap jadi.
  # wasm-opt bisa keluar dengan status 0 dan tetap menulis modul yang ditolak
  # browser (lihat catatan WASM_OPT_FEATURES) — satu-satunya cara mengetahuinya
  # adalah benar-benar meng-compile hasilnya.
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      try { new WebAssembly.Module(fs.readFileSync(process.argv[1])); }
      catch (e) {
        console.error("error: artefak " + process.argv[1] + " ditolak WebAssembly: " + e.message);
        process.exit(1);
      }
    ' "$outdir/${OUT_NAME}_bg.wasm"
  else
    echo "warning: node tidak ada — artefak $name tidak diverifikasi" >&2
  fi

  local raw gz
  raw=$(wc -c < "$outdir/${OUT_NAME}_bg.wasm" | tr -d ' ')
  gz=$(gzip -9 -c "$outdir/${OUT_NAME}_bg.wasm" | wc -c | tr -d ' ')
  printf '    %s: %s bytes (%s gzipped)\n' "$name" "$raw" "$gz"
}

build_variant mt "$OUT_BASE/mt" "$RUSTFLAGS_MT" "${WASM_OPT_ARGS_MT[@]}"
build_variant st "$OUT_BASE/st" "$RUSTFLAGS_ST" "${WASM_OPT_ARGS_ST[@]}"

echo "==> selesai. Loader di web/src/audio memilih mt/ atau st/ berdasarkan crossOriginIsolated."
