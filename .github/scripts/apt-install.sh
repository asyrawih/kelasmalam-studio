#!/usr/bin/env bash
#
# Pasang paket sistem di runner GitHub — DENGAN batas waktu.
#
# KENAPA SKRIP INI ADA, bukan `sudo apt-get update && sudo apt-get install`:
# apt tidak punya timeout jaringan default. Kalau mirror Ubuntu di runner
# berhenti merespons di tengah transfer, apt MENUNGGU SELAMANYA — bukan gagal,
# bukan retry, hanya diam. Gejalanya di Actions: satu step berjalan puluhan
# menit tanpa satu baris log baru, lalu dibunuh timeout job.
#
# Itu benar-benar terjadi di sini (run 32296099238, 19 Agt 2026): step
# "binaryen (wasm-opt)" menggantung 45 menit setelah baris
#
#     Get:5 https://archive.ubuntu.com/ubuntu noble-security InRelease [126 kB]
#
# dan seluruh pipeline — CI maupun deploy — ikut mati bersamanya. Build-nya
# sendiri tidak lambat; apt-lah yang menggantung.
#
# Tiga lapis penjaga di bawah:
#   1. Acquire::*::Timeout — apt menyerah pada koneksi yang mandek, bukan
#      menunggu tanpa batas.
#   2. `timeout` — batas keras kalau apt tetap menggantung di luar lapisan (1),
#      mis. saat menunggu lock dpkg.
#   3. Perulangan — kegagalan mirror biasanya sesaat; percobaan kedua lewat.
#
# ForceIPv4: runner punya alamat IPv6 tapi rute ke mirror sering blackhole.
# Tanpa ini apt menghabiskan seluruh timeout-nya di alamat yang tidak pernah
# menjawab sebelum akhirnya jatuh ke IPv4.
set -euo pipefail

[ "$#" -gt 0 ] || { echo "penggunaan: apt-install.sh <paket>..." >&2; exit 2; }

export DEBIAN_FRONTEND=noninteractive

APT_OPTS=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o Acquire::ForceIPv4=true
)

for attempt in 1 2 3; do
  if timeout 180 sudo apt-get update -qq "${APT_OPTS[@]}" &&
     timeout 300 sudo apt-get install -y -qq --no-install-recommends "${APT_OPTS[@]}" "$@"; then
    echo "==> terpasang: $*"
    exit 0
  fi
  echo "apt gagal atau melewati batas waktu (percobaan $attempt/3) — ulangi" >&2
  sleep 5
done

echo "error: apt gagal 3 kali untuk: $*" >&2
exit 1
