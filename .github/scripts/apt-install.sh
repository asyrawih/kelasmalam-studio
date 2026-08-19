#!/usr/bin/env bash
#
# Pasang paket sistem di runner GitHub — DENGAN batas waktu, dan sebisa mungkin
# TANPA `apt-get update`.
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
# dan seluruh pipeline — CI maupun deploy — ikut mati bersamanya.
#
# YANG MENGGANTUNG SPESIFIKNYA `apt-get update`, bukan `apt-get install`.
# Terukur di run 32301316989: tiga percobaan berturut-turut, masing-masing
# berhenti tepat di batas 180 detik pada `update`, tanpa satu baris keluaran.
# Karena itu urutannya dibalik di bawah: COBA PASANG DULU dengan daftar paket
# yang sudah ada di image runner. Daftar itu hampir selalu cukup baru untuk
# menemukan berkas .deb-nya, dan jalur itu tidak menyentuh berkas InRelease yang
# jadi sumber kemacetan. `update` hanya dijalankan kalau jalur cepat gagal —
# mis. saat daftar paketnya memang sudah basi dan URL .deb-nya 404.
#
# Penjaga lain:
#   - Acquire::*::Timeout — apt menyerah pada koneksi mandek, bukan menunggu
#     tanpa batas.
#   - `sudo timeout`, BUKAN `timeout sudo` — supaya SIGTERM mendarat di
#     apt-get yang berjalan sebagai root, bukan di sudo yang harus meneruskannya.
#   - Anggaran waktu TOTAL, bukan per percobaan. Versi sebelumnya memakai tiga
#     percobaan × 180 detik dan tetap menghabiskan 9 menit sebelum menyerah;
#     yang penting bukan berapa kali dicoba, tapi kapan berhenti.
#
# ForceIPv4: runner punya alamat IPv6 tapi rute ke mirror sering blackhole.
# Tanpa ini apt menghabiskan seluruh timeout-nya di alamat yang tidak pernah
# menjawab sebelum akhirnya jatuh ke IPv4.
set -euo pipefail

[ "$#" -gt 0 ] || { echo "penggunaan: apt-install.sh <paket>..." >&2; exit 2; }

export DEBIAN_FRONTEND=noninteractive

BUDGET="${APT_BUDGET_SECONDS:-240}"
END=$(( SECONDS + BUDGET ))

APT_OPTS=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o Acquire::ForceIPv4=true
)

sisa() { echo $(( END - SECONDS )); }

pasang() {
  local t
  t="$(sisa)"
  [ "$t" -gt 10 ] || return 1
  sudo timeout "$t" apt-get install -y --no-install-recommends "${APT_OPTS[@]}" "$@"
}

perbarui() {
  local t
  t="$(sisa)"
  [ "$t" -gt 10 ] || return 1
  # `-q`, bukan `-qq`: saat langkah ini yang macet, keluarannya adalah
  # satu-satunya petunjuk mirror mana yang berhenti menjawab.
  sudo timeout "$t" apt-get update -q "${APT_OPTS[@]}"
}

# --- jalur cepat: daftar paket bawaan image, tanpa menyentuh update ---------
echo "==> coba pasang dengan daftar paket yang sudah ada"
if pasang "$@"; then
  echo "==> terpasang tanpa apt-get update: $*"
  exit 0
fi

# --- jalur lambat: segarkan daftar, lalu pasang -----------------------------
attempt=0
while [ "$(sisa)" -gt 20 ]; do
  attempt=$(( attempt + 1 ))
  echo "==> daftar paket perlu disegarkan (percobaan $attempt, sisa $(sisa)s)"
  if perbarui && pasang "$@"; then
    echo "==> terpasang: $*"
    exit 0
  fi
  sleep 3
done

echo "error: apt tidak menyelesaikan pemasangan dalam ${BUDGET}s: $*" >&2
exit 1
