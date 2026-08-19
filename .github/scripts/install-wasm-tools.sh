#!/usr/bin/env bash
#
# Pasang perkakas build WASM di runner: `wasm-bindgen` + `wasm-opt` (binaryen).
# Keduanya diambil sebagai BINARI SIAP PAKAI dari rilis resmi masing-masing.
#
# KENAPA BUKAN `cargo install wasm-bindgen-cli`:
# perintah itu mengompilasi CLI-nya dari source di setiap runner — 60 detik yang
# dibayar hanya untuk mendapatkan berkas yang sudah tersedia jadi di halaman
# rilis wasm-bindgen. Tarball resminya < 5 detik.
#
# Efek samping yang ikut hilang: `cargo install` harus dijalankan dengan
# toolchain STABIL (dependensi transitifnya menuntut rustc lebih baru dari pin
# nightly kita), jadi CI dulu memasang SATU TOOLCHAIN TAMBAHAN semata-mata untuk
# mengompilasi perkakas yang tidak ikut ke artefak. Tanpa `cargo install`,
# toolchain stabil itu tidak dibutuhkan sama sekali.
#
# KENAPA BUKAN `apt-get install binaryen`:
# apt di runner bisa menggantung tanpa batas (lihat apt-install.sh) dan versinya
# ikut apa pun yang kebetulan ada di Ubuntu. Tarball rilis binaryen dipin di
# bawah, jadi hasil `wasm-opt` reproducible antar-run.
#
# VERSI wasm-bindgen TIDAK ditulis di sini. Ia dibaca dari Cargo.lock, karena
# CLI dan crate HARUS sama persis: kalau beda, glue yang dihasilkan tidak cocok
# dengan section __wbindgen di .wasm dan modulnya gagal dimuat.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Binaryen dipin. Daftar fitur eksplisit di scripts/build-wasm.sh ditulis
# terhadap perilaku versi ini — lihat catatan WASM_OPT_FEATURES di sana soal
# `custom-descriptors` yang menghancurkan artefak secara diam-diam kalau
# `-all` dipakai. Menaikkan angka di bawah = jalankan build + size gate lagi.
BINARYEN_VERSION="${BINARYEN_VERSION:-version_132}"

PREFIX="${WASM_TOOLS_PREFIX:-$HOME/.wasm-tools}"
mkdir -p "$PREFIX/bin"

fetch() {
  # --retry-all-errors: kegagalan sesaat di CDN GitHub tidak boleh
  # menjatuhkan build. --max-time: lebih baik gagal cepat daripada
  # menggantung seperti apt.
  curl --silent --show-error --fail --location \
       --retry 5 --retry-all-errors --retry-delay 3 \
       --connect-timeout 15 --max-time 300 "$1"
}

# --- wasm-bindgen ----------------------------------------------------------
WBG="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[",]/,""); print $3; exit}' "$ROOT/Cargo.lock")"
[ -n "$WBG" ] || { echo "error: versi wasm-bindgen tidak terbaca dari Cargo.lock" >&2; exit 1; }

echo "==> wasm-bindgen $WBG (dari Cargo.lock)"
fetch "https://github.com/rustwasm/wasm-bindgen/releases/download/${WBG}/wasm-bindgen-${WBG}-x86_64-unknown-linux-musl.tar.gz" \
  | tar -xz -C "$PREFIX/bin" --strip-components=1 \
        "wasm-bindgen-${WBG}-x86_64-unknown-linux-musl/wasm-bindgen"

# --- binaryen --------------------------------------------------------------
# HANYA `bin/wasm-opt` yang diekstrak. Tarball-nya 117 MB dan hampir seluruhnya
# berisi perkakas yang tidak dipanggil siapa pun di sini (wasm-fuzz-*, wasm2c,
# binaryen-unittests, dan libbinaryen.a sebesar puluhan MB). Menulis semuanya ke
# disk runner memakan waktu lebih lama daripada mengunduhnya.
#
# `wasm-opt` aman berdiri sendiri: tidak ada satu pun berkas .so di tarball —
# pustakanya ditautkan statis, jadi `lib/` tidak dibutuhkan saat runtime.
echo "==> binaryen $BINARYEN_VERSION (hanya wasm-opt)"
fetch "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
  | tar -xz -C "$PREFIX/bin" --strip-components=2 \
        "binaryen-${BINARYEN_VERSION}/bin/wasm-opt"

export PATH="$PREFIX/bin:$PATH"

# Perkakas yang terpasang tapi tidak bisa dijalankan (mis. pustaka bersama
# binaryen tidak ikut ter-ekstrak) akan gagal jauh di kemudian hari dengan
# pesan yang tidak menunjuk ke sini. Jadi buktikan sekarang.
wasm-bindgen --version
wasm-opt --version

# Jadikan permanen untuk step-step berikutnya dalam job yang sama.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$PREFIX/bin" >> "$GITHUB_PATH"
fi
