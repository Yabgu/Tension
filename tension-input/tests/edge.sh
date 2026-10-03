#!/bin/sh
# edge.sh — the end-to-end edge test: a real device, a real guest.
#
#   bash tension-input/tests/edge.sh            (20 s)
#   EDGE_SECONDS=30 bash tension-input/tests/edge.sh
#
# The probe window ("tension-input", 320x200) appears and takes the pointer.
# While it runs: move the mouse, then press a few keys. The guest prints every
# event the session delivers and a summary at the end.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/.." && pwd)
repo=$(CDPATH= cd -- "$root/.." && pwd)
framework="$repo/tension-framework"
core=${TENSION_CORE:-$repo/tension-core/target/debug/tension-core}
dso=$root/build/libtension_input.so
out="$root/build"
seconds=${EDGE_SECONDS:-20}

[ -x "$core" ] || { echo "edge: build the interpreter first (cargo build)" >&2; exit 1; }
"$root/build.sh" >/dev/null
hash=$("$core" layout-hash)
bash "$framework/build.sh" --hash "$hash" >/dev/null
"$framework/node_modules/.bin/asc" "$here/guest-input.ts" \
    --config "$framework/build/session.asconfig.json" -o "$out/guest-input.wasm"

echo "==================================================================="
echo " edge test: ${seconds} s. Move the MOUSE, then press a few KEYS."
echo "==================================================================="
exec "$core" --capability "$dso" "$out/guest-input.wasm" --edge --seconds="$seconds"
