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

cat <<HEADER
===================================================================
 edge test — the end-to-end input measurement (${seconds} s)
===================================================================
What it does:  the guest opens the input capability, attaches to its own
               window, turns on relative mouse mode, and subscribes to
               INPUT_KEY (class 6) and INPUT_MOUSE (class 7). It then runs
               wait(16) + drain(6) + drain(7) and prints every event the
               session delivers, with a summary at the end.

What you do:   1. watch for a 320x200 window titled 'tension-input'
               2. move the MOUSE SLOWLY for ~5 s
               3. move the MOUSE QUICKLY for ~5 s
               4. press a few KEYS (arrows, WASD) for ~5 s
               5. CLICK a mouse button, then SCROLL the wheel
               6. pause ~5 s between phases so they separate in the output

Expected:      keys as  "KEY   flags=0x… keycode=0x… scancode=N"
               buttons/wheel as  "MOUSE shape=… a=… b=0x… f0=… f1=…"
               motion as the state's accumulated delta ("epochs with
               motion", "accumulated delta"), one per epoch — not one
               event per device sample.
               If the window does not take focus, CLICK IT: keys need
               focus, and on Wayland the compositor decides.
===================================================================
HEADER
exec "$core" --capability "$dso" "$out/guest-input.wasm" --edge --seconds="$seconds"
