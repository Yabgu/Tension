#!/usr/bin/env bash
# Build the hello-mesh example and run it.
#
#   ./run.sh                            a window: a screenshot, and a summary
#   TENSION_OGRE_HEADLESS=1 ./run.sh    structural only: no display needed
#
# A window is the default because that is what a reader running an example
# wants to see. With no DISPLAY and no WAYLAND_DISPLAY there is nothing to
# open one on, so it falls back to the headless path and says why. The test
# suite keeps the opposite default (tension-ogre/tests/run.sh): CI has no
# display, and headless is the shape CI needs.
#
# Everything it needs is checked or built first: the interpreter, the OGRE
# adapter, the framework's generated session config, and the guest's own build
# dependencies.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
core="${TENSION_CORE:-$root/tension-core/target/debug/tension-core}"
adapter="${TENSION_OGRE_DSO:-$root/tension-ogre/build/libtension_ogre.so}"
framework="$root/tension-framework"

if [ ! -x "$core" ]; then
    echo "no interpreter at $core — build it with:" >&2
    echo "  cargo build --manifest-path $root/tension-core/Cargo.toml --no-default-features" >&2
    exit 2
fi
if [ ! -f "$adapter" ]; then
    echo "hello-mesh: building the OGRE adapter (tension-ogre/build.sh)..."
    "$root/tension-ogre/build.sh" >/dev/null
fi

cd "$here"

# The guest's asc flags come from the framework's generator, run against this
# interpreter's layout hash: the arena's memory relation has one source of
# truth, and a stale copy of it produces a guest the host refuses.
hash=$("$core" layout-hash)
bash "$framework/build.sh" --hash "$hash" >/dev/null

# A fresh clone has no build dependencies.
if [ ! -x node_modules/.bin/asc ]; then
    echo "hello-mesh: installing the guest's build dependencies (npm install)..."
    npm install --silent
fi
npm run --silent build

renderer=gl3plus
if [ "${TENSION_OGRE_HEADLESS:-0}" = "1" ]; then
    echo "TENSION_OGRE_HEADLESS=1: no window; structural only"
    renderer=null
elif [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    echo "no display available; falling back to renderer=null"
    renderer=null
fi
exec "$core" --capability "$adapter" build/game.wasm --renderer="$renderer"
