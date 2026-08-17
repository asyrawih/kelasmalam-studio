#!/usr/bin/env bash
# Gate ukuran engine: < 300 KB gzipped per artefak (docs/04-build.md).
# Yang biasanya membengkakkan: std::fmt (format!/Debug), serde_json (pakai
# postcard di jalur WASM), dan pesan panic. Diagnosa dengan `twiggy top`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIMIT="${SIZE_LIMIT_BYTES:-307200}"   # 300 KiB
STATUS=0

check() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo "error: $f tidak ada — jalankan ./scripts/build-wasm.sh dulu" >&2
    return 1
  fi
  local gz
  gz=$(gzip -9 -c "$f" | wc -c | tr -d ' ')
  printf '%-40s %8s bytes gz (limit %s)\n' "${f#"$ROOT"/}" "$gz" "$LIMIT"
  if [ "$gz" -ge "$LIMIT" ]; then
    echo "SIZE BUDGET EXCEEDED: ${f#"$ROOT"/}" >&2
    return 1
  fi
}

check "$ROOT/web/src/wasm/mt/engine_bg.wasm" || STATUS=1
check "$ROOT/web/src/wasm/st/engine_bg.wasm" || STATUS=1

exit "$STATUS"
