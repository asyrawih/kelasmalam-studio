#!/usr/bin/env bash
#
# Versi aplikasi desktop: SATU sumber, yaitu `[workspace.package] version` di
# Cargo.toml root.
#
# KENAPA BUKAN `version` DI tauri.conf.json:
# `desktop/src-tauri/Cargo.toml` memakai `version.workspace = true`, dan
# tauri-cli (interface/rust.rs, "Couldn't inherit value for `version` from
# workspace") menyelesaikan pewarisan itu sendiri saat membaca manifest. Jadi
# selama tauri.conf.json TIDAK punya field `version`, angka yang masuk ke
# CFBundleShortVersionString (.app), ProductVersion (.msi), nama berkas bundel,
# dan `latest.json` updater semuanya turun dari satu baris di Cargo.toml.
# Menambahkan `version` ke tauri.conf.json berarti membuat sumber kedua yang
# bisa diam-diam tertinggal — skrip ini menganggap keadaan itu sebagai error.
#
#   scripts/desktop-version.sh              # cetak versi, mis. 0.1.0
#   scripts/desktop-version.sh --check      # pastikan tauri.conf.json tidak
#                                           # menyimpang; exit 1 kalau ya
#   scripts/desktop-version.sh --check desktop-v0.1.0
#                                           # + pastikan tag cocok dengan versi
#   scripts/desktop-version.sh --set 0.1.1  # tulis versi baru ke Cargo.toml
#                                           # (dan tauri.conf.json kalau ada
#                                           # field version di sana)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_TOML="$ROOT/Cargo.toml"
TAURI_CONF="$ROOT/desktop/src-tauri/tauri.conf.json"

# Baca `version = "..."` HANYA di dalam blok [workspace.package]. Grep polos
# `^version` akan menangkap versi crate lain kalau suatu hari ada [package] di
# root, dan versi dependensi tidak pernah diawali `version =` di kolom pertama
# kecuali di blok ini — tapi state machine kecil lebih jujur daripada asumsi.
cargo_version() {
  awk '
    /^\[/ { in_pkg = ($0 == "[workspace.package]") }
    in_pkg && /^version[[:space:]]*=/ {
      gsub(/^version[[:space:]]*=[[:space:]]*"|".*$/, ""); print; exit
    }
  ' "$CARGO_TOML"
}

# `null` kalau tauri.conf.json tidak punya field `version` (keadaan normal).
# node dipakai, bukan grep: `"version"` juga muncul di dalam blok lain
# (mis. bundle.windows.wix.version kalau suatu saat ditambahkan).
tauri_version() {
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(c.version == null ? "null" : String(c.version));
  ' "$TAURI_CONF"
}

semver_ok() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]
}

CUR="$(cargo_version)"
[ -n "$CUR" ] || { echo "error: [workspace.package] version tidak ditemukan di $CARGO_TOML" >&2; exit 1; }

case "${1:-}" in
  "")
    printf '%s\n' "$CUR"
    ;;

  --check)
    TV="$(tauri_version)"
    if [ "$TV" != "null" ] && [ "$TV" != "$CUR" ]; then
      echo "error: tauri.conf.json version=$TV != Cargo.toml workspace.package.version=$CUR" >&2
      echo "       hapus field version di tauri.conf.json (Tauri membaca Cargo.toml) atau jalankan: $0 --set $CUR" >&2
      exit 1
    fi
    if [ -n "${2:-}" ]; then
      # Tag rilis WAJIB sama dengan versi: `latest.json` memuat `version`
      # dari bundel, dan URL unduhannya memuat nama tag. Kalau keduanya beda,
      # updater di mesin user memuat berkas dari tag yang salah — atau 404.
      [ "$2" = "desktop-v$CUR" ] || {
        echo "error: tag '$2' tidak cocok dengan versi $CUR (harus 'desktop-v$CUR')" >&2
        exit 1
      }
    fi
    echo "ok: versi desktop $CUR (Cargo.toml${TV:+; tauri.conf.json: $TV})"
    ;;

  --set)
    NEW="${2:-}"
    semver_ok "$NEW" || { echo "error: '$NEW' bukan semver (contoh: 0.1.1)" >&2; exit 1; }
    # awk yang sama dengan pembaca di atas, supaya yang ditulis persis baris
    # yang dibaca — bukan `version` milik blok lain.
    awk -v new="$NEW" '
      /^\[/ { in_pkg = ($0 == "[workspace.package]") }
      in_pkg && /^version[[:space:]]*=/ && !done {
        print "version = \"" new "\""; done = 1; next
      }
      { print }
    ' "$CARGO_TOML" > "$CARGO_TOML.tmp" && mv "$CARGO_TOML.tmp" "$CARGO_TOML"
    if [ "$(tauri_version)" != "null" ]; then
      node -e '
        const fs = require("fs");
        const [path, v] = process.argv.slice(1);
        const c = JSON.parse(fs.readFileSync(path, "utf8"));
        c.version = v;
        fs.writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
      ' "$TAURI_CONF" "$NEW"
    fi
    echo "versi desktop: $CUR -> $NEW"
    echo "berikutnya: cargo update -w (Cargo.lock mencatat versi crate workspace), commit, lalu git tag desktop-v$NEW"
    ;;

  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
