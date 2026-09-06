#!/usr/bin/env bash
#
# Rilis aplikasi desktop (docs/20 §4 D6, docs/22) — DARI MESIN LOKAL.
#
# KENAPA BUKAN GITHUB ACTIONS:
# sertifikat Developer ID, sesi notarization, dan kunci privat updater semuanya
# ada di mesin pengembang; runner macOS/Windows GitHub lambat, jarang tersedia,
# dan tiap run harus mengimpor sertifikat itu ke keychain sementara. Untuk satu
# orang yang merilis dari satu Mac, itu lapisan yang tidak membeli apa pun.
# Skrip ini melakukan hal yang sama, langkah demi langkah, dan bisa dijalankan
# ulang: tiap langkah memeriksa hasil langkah sebelumnya, bukan mengasumsikan.
#
# Windows TIDAK bisa dibangun dari macOS: bundler .msi (WiX) dan NSIS butuh
# perkakas Windows, dan WebView2 bootstrapper hanya dirakit di sana. `.msi` +
# `-setup.exe` dibuat dengan skrip INI di mesin Windows (Git Bash), lalu
# `latest.json`-nya digabung — lihat --merge dan docs/22 §5.
#
#   scripts/release-desktop.sh                       # arsitektur mesin ini
#   scripts/release-desktop.sh --targets aarch64,x86_64
#   scripts/release-desktop.sh --publish             # + draft GitHub Release
#   scripts/release-desktop.sh --dry-run             # cetak langkah, jangan jalankan
#
# Opsi:
#   --targets a,b     aarch64 dan/atau x86_64 (macOS); x86_64 (Windows).
#   --publish         buat/pakai draft release desktop-v<versi>, unggah semua
#                     artefak + latest.json. Tanpa ini, GitHub tidak disentuh.
#   --merge <file>    latest.json dari mesin lain (mis. hasil Windows) yang
#                     platform-nya dipertahankan saat menulis latest.json baru.
#   --notes <file>    catatan rilis (masuk ke latest.json `notes` dan badan
#                     release). Default: satu baris berisi versi.
#   --skip-wasm       pakai web/src/wasm yang sudah ada (SKIP_WASM=1).
#   --skip-web        pakai web/dist yang sudah ada (SKIP_WEB_BUILD=1).
#   --unsigned        build uji: lepas semua env APPLE_* dan TAURI_SIGNING_*
#                     walau ada di shell/.env.release — tidak ada codesign,
#                     tidak ada kiriman ke notarization Apple, tidak ada
#                     artefak updater. Tidak bisa digabung dengan --publish.
#   --dry-run         cetak setiap perintah tanpa menjalankannya.
#
# Env (boleh lewat `.env.release` di root repo — sudah di-gitignore lewat `.env*`):
#   VITE_ROBLOX_API, VITE_LIBRARY_API      ditanam Vite saat build (seperti ci.yml)
#   APPLE_SIGNING_IDENTITY                 "Developer ID Application: Nama (TEAMID)"
#   APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID    notarization lewat Apple ID, ATAU
#   APPLE_API_KEY + APPLE_API_ISSUER (+ APPLE_API_KEY_PATH)   lewat App Store Connect API
#   TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD)  kunci minisign updater (isi berkas
#                                            atau path-nya; Tauri menerima keduanya)
# Semua env di atas dibaca LANGSUNG oleh tauri-cli/bundler — skrip ini hanya
# memeriksa mana yang ada dan mengatakan apa akibatnya kalau tidak ada.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAURI_DIR="$ROOT/desktop/src-tauri"
TAURI_CONF="$TAURI_DIR/tauri.conf.json"
OUT_ROOT="$ROOT/dist-desktop"

# Nama berkas unduhan. BUKAN productName ("KELAS MALAM STUDIO"): GitHub
# mengganti spasi di nama aset menjadi titik, jadi URL yang ditulis ke
# latest.json dari nama berkas lokal tidak akan pernah cocok dengan URL aset
# yang sungguhan. Tanpa spasi = nama lokal dan nama di GitHub identik.
SLUG="KelasMalamStudio"

# --- opsi ------------------------------------------------------------------
TARGETS_ARG=""
PUBLISH=0
DRY_RUN=0
MERGE_FILE=""
NOTES_FILE=""
SKIP_WASM="${SKIP_WASM:-0}"
SKIP_WEB_BUILD="${SKIP_WEB_BUILD:-0}"
UNSIGNED=0

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --targets)   TARGETS_ARG="${2:-}"; shift 2 ;;
    --targets=*) TARGETS_ARG="${1#*=}"; shift ;;
    --publish)   PUBLISH=1; shift ;;
    --merge)     MERGE_FILE="${2:-}"; shift 2 ;;
    --notes)     NOTES_FILE="${2:-}"; shift 2 ;;
    --skip-wasm) SKIP_WASM=1; shift ;;
    --skip-web)  SKIP_WEB_BUILD=1; shift ;;
    --unsigned)  UNSIGNED=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "error: opsi tidak dikenal: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33mPERHATIAN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mGAGAL:\033[0m %s\n' "$*" >&2; exit 1; }

# Semua perintah yang mengubah sesuatu lewat sini: dicetak dulu (dengan quoting
# yang bisa di-copy), dijalankan hanya kalau bukan --dry-run.
run() {
  printf '    $'; printf ' %q' "$@"; printf '\n'
  [ "$DRY_RUN" = 1 ] || "$@"
}

# --- .env.release ------------------------------------------------------------
# Disumber SEBELUM apa pun dibaca dari env. `set -a` supaya tiap baris KEY=val
# di berkas itu ikut diekspor ke cargo/vite tanpa harus ditulis `export`.
if [ -f "$ROOT/.env.release" ]; then
  log "Memuat .env.release"
  set -a; . "$ROOT/.env.release"; set +a
  note "dimuat (isinya tidak dicetak)"
fi

# --unsigned SETELAH .env.release: yang dilepas adalah gabungan env shell dan
# berkas itu. Kredensial Apple yang tertinggal di profil shell pengembang
# sudah pernah membuat "build uji" diam-diam mengirim .app ke notarization —
# ini penjaganya, bukan sekadar kenyamanan.
if [ "$UNSIGNED" = 1 ]; then
  [ "$PUBLISH" = 0 ] || die "--unsigned tidak bisa dipakai bersama --publish: hasilnya tidak boleh naik ke release."
  unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD \
        APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
        APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH \
        TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

# --- OS & target -------------------------------------------------------------
case "$(uname -s)" in
  Darwin)                 OS=macos ;;
  MINGW*|MSYS*|CYGWIN*)   OS=windows ;;
  *) die "OS $(uname -s) bukan target rilis desktop (docs/20 §1f: macOS + Windows)." ;;
esac

# --targets menerima nama arsitektur pendek; triple Rust diturunkan di sini
# supaya pemanggil tidak perlu hafal `-apple-darwin` / `-pc-windows-msvc`.
if [ -z "$TARGETS_ARG" ]; then
  case "$(uname -m)" in
    arm64|aarch64) TARGETS_ARG=aarch64 ;;
    x86_64|amd64)  TARGETS_ARG=x86_64 ;;
    *) die "arsitektur $(uname -m) tidak dikenal; sebutkan --targets" ;;
  esac
fi

TRIPLES=()
ARCHES=()
IFS=',' read -r -a _arches <<< "$TARGETS_ARG"
for a in "${_arches[@]}"; do
  case "$OS/$a" in
    macos/aarch64)   TRIPLES+=(aarch64-apple-darwin) ;;
    macos/x86_64)    TRIPLES+=(x86_64-apple-darwin) ;;
    windows/x86_64)  TRIPLES+=(x86_64-pc-windows-msvc) ;;
    windows/aarch64) die "Windows ARM64 belum jadi target rilis (docs/20 §1f hanya menyebut x86_64)." ;;
    *) die "target '$a' tidak dikenal untuk $OS (pakai aarch64 / x86_64)" ;;
  esac
  ARCHES+=("$a")
done

# --- 1. prasyarat -------------------------------------------------------------
log "1/7 Prasyarat ($OS, target: ${TRIPLES[*]})"

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' tidak ada di PATH. $2"
  note "$1: $(command -v "$1")"
}
need cargo        "install rustup: https://rustup.rs"
need node         "Node 20+ (vite, dan penggabung latest.json di bawah)"
if [ "$SKIP_WASM" != 1 ]; then
  need wasm-bindgen "cargo install wasm-bindgen-cli --version <sama dengan Cargo.lock>"
  need wasm-opt     "brew install binaryen"
fi
cargo tauri --version >/dev/null 2>&1 || die "'cargo tauri' tidak ada: cargo install tauri-cli --version ^2 (atau brew install cargo-tauri)"
note "cargo tauri: $(cargo tauri --version)"

for t in "${TRIPLES[@]}"; do
  rustup target list --installed 2>/dev/null | grep -qx "$t" \
    || die "target Rust '$t' belum terpasang: rustup target add $t"
  note "rustup target: $t terpasang"
done

if [ "$PUBLISH" = 1 ]; then
  need gh "brew install gh, lalu gh auth login"
  gh auth status >/dev/null 2>&1 || die "gh belum login: gh auth login"
fi

if [ "$OS" = macos ]; then
  # Signing & notarization: tauri-bundler membaca env ini SENDIRI. Yang
  # dilakukan di sini hanya mengatakan terang-terangan hasil seperti apa yang
  # akan keluar — supaya "kenapa Gatekeeper menolak .dmg-nya" terjawab sebelum
  # build 10 menit selesai, bukan sesudahnya.
  if [ "$UNSIGNED" = 1 ]; then
    note "--unsigned: env APPLE_* dan TAURI_SIGNING_* dilepas; build uji lokal"
  fi
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    note "codesign: $APPLE_SIGNING_IDENTITY"
    security find-identity -v -p codesigning 2>/dev/null | grep -q "$APPLE_SIGNING_IDENTITY" \
      || warn "identitas itu tidak terlihat di keychain (security find-identity). Bundler akan gagal saat codesign."
    if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
      note "notarization: Apple ID $APPLE_ID (team $APPLE_TEAM_ID)"
    elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
      note "notarization: App Store Connect API key $APPLE_API_KEY"
    else
      warn "APPLE_SIGNING_IDENTITY ada tapi kredensial notarization tidak (APPLE_ID+APPLE_PASSWORD+APPLE_TEAM_ID, atau APPLE_API_KEY+APPLE_API_ISSUER). .dmg ditandatangani tapi TIDAK ter-notarize: Gatekeeper menolaknya di mesin lain."
    fi
    xcrun --find notarytool >/dev/null 2>&1 || warn "xcrun notarytool tidak ditemukan — butuh Xcode 13+ / Command Line Tools."
  else
    warn "APPLE_SIGNING_IDENTITY kosong: .app/.dmg TIDAK ditandatangani dan tidak di-notarize. Cukup untuk uji lokal; Gatekeeper menolaknya di mesin lain."
  fi
else
  note "Windows: penandatanganan Authenticode diatur lewat bundle.windows.certificateThumbprint / signCommand di tauri.conf.json (docs/22 §4b). Tanpa itu SmartScreen menahan installer."
fi

# Tanpa kunci privat, tauri-cli MENOLAK build begitu createUpdaterArtifacts
# aktif ("A public key has been found, but no private key"). Daripada
# `--no-sign` — yang juga mematikan codesign macOS dan Authenticode —
# createUpdaterArtifacts dimatikan lewat overlay --config: bundel .dmg/.msi
# tetap jadi, hanya .app.tar.gz + .sig (dan karenanya latest.json) yang tidak.
UPDATER_ARTIFACTS=1
TAURI_EXTRA_ARGS=()
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  UPDATER_ARTIFACTS=0
  TAURI_EXTRA_ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
  warn "TAURI_SIGNING_PRIVATE_KEY kosong: artefak updater (.app.tar.gz/.sig) dan latest.json TIDAK dibuat. Build ini tidak bisa dipakai sebagai target update. Lihat docs/22 §2."
else
  note "updater: kunci privat ada; artefak updater akan ditandatangani"
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]; then
    warn "TAURI_SIGNING_PRIVATE_KEY_PASSWORD tidak diset: tauri-cli akan MEMINTA password di terminal (set ke string kosong kalau kuncinya tanpa password)."
  fi
fi

# --- 2. versi ---------------------------------------------------------------
log "2/7 Versi"
"$ROOT/scripts/desktop-version.sh" --check
VERSION="$("$ROOT/scripts/desktop-version.sh")"
TAG="desktop-v$VERSION"
OUT="$OUT_ROOT/$VERSION"
note "versi $VERSION, tag $TAG, keluaran $OUT"
if ! git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  note "tag $TAG belum ada di repo lokal (dibuat saat draft release di-publish, atau: git tag $TAG)"
fi

# Pemilik repo & endpoint diturunkan dari config updater — satu sumber, supaya
# URL di latest.json tidak bisa menunjuk ke repo yang berbeda dengan yang
# dipoll aplikasi.
ENDPOINT="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.plugins.updater.endpoints[0])' "$TAURI_CONF")"
GH_REPO="$(printf '%s' "$ENDPOINT" | sed -E 's#^https://github\.com/([^/]+/[^/]+)/.*$#\1#')"
[ "$GH_REPO" != "$ENDPOINT" ] || die "endpoint updater bukan URL GitHub Releases: $ENDPOINT"
note "repo GitHub: $GH_REPO (dari plugins.updater.endpoints)"
PUBKEY="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.plugins.updater.pubkey)' "$TAURI_CONF")"
case "$PUBKEY" in
  TODO*) warn "plugins.updater.pubkey masih placeholder — aplikasi yang dirilis TIDAK akan pernah bisa memverifikasi update. docs/22 §2." ;;
esac

# --- 3. wasm ------------------------------------------------------------------
log "3/7 WASM (engine mt + st)"
if [ "$SKIP_WASM" = 1 ]; then
  for v in mt st; do
    [ -f "$ROOT/web/src/wasm/$v/engine_bg.wasm" ] || die "SKIP_WASM tapi web/src/wasm/$v/engine_bg.wasm tidak ada."
  done
  note "lewati (artefak mt/st sudah ada)"
else
  run "$ROOT/scripts/build-wasm.sh"
fi

# --- 4. web ---------------------------------------------------------------------
log "4/7 Frontend (vite build → web/dist)"
if [ "$SKIP_WEB_BUILD" = 1 ]; then
  [ -f "$ROOT/web/dist/index.html" ] || die "SKIP_WEB_BUILD tapi web/dist/index.html tidak ada."
  note "lewati (web/dist sudah ada)"
else
  [ -x "$ROOT/web/node_modules/.bin/vite" ] || die "web/node_modules/.bin/vite tidak ada: cd web && npm ci"
  # Alamat backend ditanam SAAT BUILD (sama dengan job web di ci.yml). Kosong
  # bukan error — halaman yang bergantung padanya berkata "belum dipasang" —
  # tapi untuk rilis publik itu hampir pasti bukan yang dimaksud.
  [ -n "${VITE_ROBLOX_API:-}" ]  || warn "VITE_ROBLOX_API kosong — halaman /roblox akan UI ONLY di build ini."
  [ -n "${VITE_LIBRARY_API:-}" ] || warn "VITE_LIBRARY_API kosong — kepustakaan daring tidak terpasang di build ini."
  ( cd "$ROOT/web" && run ./node_modules/.bin/vite build )
fi

# --- 5. tauri build per target ---------------------------------------------------
log "5/7 cargo tauri build"
case "$OS" in
  macos)   BUNDLES=(app dmg) ;;
  windows) BUNDLES=(msi nsis) ;;
esac
# `--bundles` eksplisit: bundle.targets di tauri.conf.json memuat keempat
# format untuk dua OS, dan yang tidak berlaku di OS ini tidak perlu dilaporkan
# bundler sebagai "dilewati".
for t in "${TRIPLES[@]}"; do
  note "target $t"
  # `${arr[@]+"${arr[@]}"}`: array kosong + `set -u` di bash 3.2 (bawaan
  # macOS) adalah "unbound variable" — dan array ini memang kosong tepat pada
  # jalur rilis sungguhan (kunci updater ada).
  ( cd "$TAURI_DIR" && run cargo tauri build --target "$t" --bundles "${BUNDLES[@]}" ${TAURI_EXTRA_ARGS[@]+"${TAURI_EXTRA_ARGS[@]}"} )
done

# --- 6. kumpulkan artefak ----------------------------------------------------------
log "6/7 Kumpulkan artefak → $OUT"
run mkdir -p "$OUT"

# Satu berkas: cari di direktori bundel, salin dengan nama slug. `find` karena
# nama asli mengandung spasi ("KELAS MALAM STUDIO_0.1.0_aarch64.dmg") dan
# `.app.tar.gz` TIDAK memuat versi maupun arsitektur — dua target macOS akan
# saling menimpa kalau disalin apa adanya.
collect() {
  local dir="$1" pattern="$2" dest="$3"
  if [ "$DRY_RUN" = 1 ]; then
    note "(dry-run) $dir/$pattern → $(basename "$dest")"
    return 0
  fi
  local src
  src="$(find "$dir" -maxdepth 1 -name "$pattern" -type f 2>/dev/null | head -n 1 || true)"
  [ -n "$src" ] || return 1
  run cp -f "$src" "$dest"
}

# Platform yang baru dibangun di mesin ini: "key|url-file|sig-file", dipakai
# langkah 7. Platform dari --merge / dari release yang sudah ada TIDAK lewat
# sini — mereka dibaca dari latest.json-nya sendiri.
BUILT_PLATFORMS=()
for i in "${!TRIPLES[@]}"; do
  t="${TRIPLES[$i]}"; arch="${ARCHES[$i]}"
  BDIR="$ROOT/target/$t/release/bundle"
  case "$OS" in
    macos)
      collect "$BDIR/dmg" "*.dmg" "$OUT/${SLUG}_${VERSION}_${arch}.dmg" \
        || die "tidak ada .dmg di $BDIR/dmg — build gagal diam-diam?"
      if [ "$UPDATER_ARTIFACTS" = 1 ]; then
        collect "$BDIR/macos" "*.app.tar.gz"     "$OUT/${SLUG}_${VERSION}_${arch}.app.tar.gz" \
          || die "createUpdaterArtifacts aktif tapi .app.tar.gz tidak ada di $BDIR/macos"
        collect "$BDIR/macos" "*.app.tar.gz.sig" "$OUT/${SLUG}_${VERSION}_${arch}.app.tar.gz.sig" \
          || die ".app.tar.gz.sig tidak ada di $BDIR/macos"
        BUILT_PLATFORMS+=("darwin-${arch}|${SLUG}_${VERSION}_${arch}.app.tar.gz|${SLUG}_${VERSION}_${arch}.app.tar.gz.sig")
      fi
      ;;
    windows)
      # Nama Tauri memakai `x64`, bukan `x86_64`; ikuti kebiasaan itu untuk
      # installer supaya user Windows melihat nama yang lazim.
      collect "$BDIR/msi"  "*.msi"        "$OUT/${SLUG}_${VERSION}_x64.msi" \
        || die "tidak ada .msi di $BDIR/msi"
      collect "$BDIR/nsis" "*-setup.exe"  "$OUT/${SLUG}_${VERSION}_x64-setup.exe" \
        || die "tidak ada -setup.exe di $BDIR/nsis"
      if [ "$UPDATER_ARTIFACTS" = 1 ]; then
        collect "$BDIR/msi"  "*.msi.sig"       "$OUT/${SLUG}_${VERSION}_x64.msi.sig" \
          || die ".msi.sig tidak ada di $BDIR/msi"
        collect "$BDIR/nsis" "*-setup.exe.sig" "$OUT/${SLUG}_${VERSION}_x64-setup.exe.sig" \
          || die "-setup.exe.sig tidak ada di $BDIR/nsis"
        # NSIS, bukan MSI, sebagai target updater: installer NSIS-lah yang
        # membawa bootstrapper WebView2 (webviewInstallMode: embedBootstrapper)
        # dan mendukung mode `passive` yang dipakai updater tanpa dialog penuh.
        BUILT_PLATFORMS+=("windows-x86_64|${SLUG}_${VERSION}_x64-setup.exe|${SLUG}_${VERSION}_x64-setup.exe.sig")
      fi
      ;;
  esac
done
[ "$DRY_RUN" = 1 ] || ls -la "$OUT"

# --- 7. latest.json (+ publish) --------------------------------------------------
log "7/7 latest.json"
LATEST="$OUT/latest.json"

if [ "$PUBLISH" = 1 ]; then
  # Draft release dibuat SEBELUM latest.json ditulis: kalau mesin lain (Windows)
  # sudah mengunggah latest.json-nya ke draft yang sama, platform miliknya
  # diambil dulu dan digabung — bukan ditimpa.
  if gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
    note "release $TAG sudah ada di $GH_REPO — dipakai ulang"
    if [ "$DRY_RUN" = 1 ]; then
      note "(dry-run) gh release download $TAG -p latest.json → gabung"
    else
      REMOTE_TMP="$(mktemp -d)"
      if gh release download "$TAG" --repo "$GH_REPO" -p latest.json -D "$REMOTE_TMP" >/dev/null 2>&1; then
        note "latest.json dari release diunduh untuk digabung"
        [ -z "$MERGE_FILE" ] || warn "--merge diberikan DAN release sudah punya latest.json; keduanya digabung, yang dibangun di sini menang."
        MERGE_REMOTE="$REMOTE_TMP/latest.json"
      fi
    fi
  else
    NOTES_ARGS=(--notes "Kelas Malam Studio $VERSION")
    [ -z "$NOTES_FILE" ] || NOTES_ARGS=(--notes-file "$NOTES_FILE")
    # --draft: tidak muncul di /releases/latest sampai di-publish, jadi
    # aplikasi yang sudah terpasang tidak melihat versi setengah jadi.
    # --target HEAD: tag dibuat di commit ini saat draft di-publish (kalau
    # tagnya belum ada).
    run gh release create "$TAG" --repo "$GH_REPO" --draft \
      --title "Kelas Malam Studio $VERSION" "${NOTES_ARGS[@]}" \
      --target "$(git -C "$ROOT" rev-parse HEAD)"
  fi
fi

if [ "$UPDATER_ARTIFACTS" = 1 ] || [ -n "$MERGE_FILE" ] || [ -n "${MERGE_REMOTE:-}" ]; then
  NOTES_TEXT="Kelas Malam Studio $VERSION"
  [ -z "$NOTES_FILE" ] || NOTES_TEXT="$(cat "$NOTES_FILE")"
  if [ "$DRY_RUN" = 1 ]; then
    note "(dry-run) tulis $LATEST: version=$VERSION, platform baru: ${BUILT_PLATFORMS[*]:-(tidak ada)}, gabung: ${MERGE_FILE:-—} ${MERGE_REMOTE:-}"
  else
    # Urutan prioritas (rendah → tinggi): latest.json yang sudah ada di $OUT,
    # --merge, latest.json dari release, lalu platform yang BARU dibangun.
    # `version` harus sama di semua sumber — latest.json 0.1.0 dari Windows
    # tidak boleh digabung ke rilis 0.1.1.
    node - "$LATEST" "$VERSION" "$GH_REPO" "$TAG" "$OUT" "$NOTES_TEXT" \
         "${MERGE_FILE:-}" "${MERGE_REMOTE:-}" "${BUILT_PLATFORMS[@]+"${BUILT_PLATFORMS[@]}"}" <<'EOF'
const fs = require("fs");
const [out, version, repo, tag, dir, notes, mergeFile, mergeRemote, ...built] = process.argv.slice(2);
const platforms = {};
for (const src of [out, mergeFile, mergeRemote]) {
  if (!src || !fs.existsSync(src)) continue;
  const j = JSON.parse(fs.readFileSync(src, "utf8"));
  if (j.version !== version) {
    console.error(`GAGAL: ${src} adalah latest.json versi ${j.version}, bukan ${version}`);
    process.exit(1);
  }
  Object.assign(platforms, j.platforms || {});
}
for (const spec of built) {
  const [key, file, sig] = spec.split("|");
  platforms[key] = {
    signature: fs.readFileSync(`${dir}/${sig}`, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
  };
}
const doc = { version, notes, pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`    ${out}`);
for (const [k, v] of Object.entries(platforms)) console.log(`      ${k}: ${v.url}`);
const wanted = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"];
const missing = wanted.filter((k) => !(k in platforms));
if (missing.length) console.log(`    belum ada platform: ${missing.join(", ")} (bangun di mesin yang sesuai, lalu --merge / --publish ke tag yang sama)`);
EOF
  fi
else
  note "tidak ada artefak updater dan tidak ada --merge: latest.json tidak ditulis."
fi

if [ "$PUBLISH" = 1 ]; then
  log "Unggah ke draft release $TAG"
  if [ "$DRY_RUN" = 1 ]; then
    note "(dry-run) gh release upload $TAG --clobber $OUT/*"
  else
    # --clobber: menjalankan ulang skrip untuk versi yang sama mengganti aset
    # lama, bukan gagal karena "asset already exists".
    UPLOADS=()
    for f in "$OUT"/*; do UPLOADS+=("$f"); done
    run gh release upload "$TAG" --repo "$GH_REPO" --clobber "${UPLOADS[@]}"
    note "draft: https://github.com/$GH_REPO/releases/tag/$TAG"
    note "publish dari halaman itu setelah semua platform terunggah dan latest.json lengkap."
  fi
else
  note "tanpa --publish: tidak ada yang dikirim ke GitHub. Artefak ada di $OUT"
fi

log "Selesai."
