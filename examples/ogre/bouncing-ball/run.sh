#!/usr/bin/env bash
# Build the bouncing-ball example and run it.
#
#   ./run.sh                              headless: submit, no pixels
#   TENSION_OGRE_WINDOW_TEST=1 ./run.sh   GL3+: a real window and a screenshot
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
    echo "bouncing-ball: building the OGRE adapter (tension-ogre/build.sh)..."
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
    echo "bouncing-ball: installing the guest's build dependencies (npm install)..."
    npm install --silent
fi
npm run --silent build

if [ "${TENSION_OGRE_WINDOW_TEST:-0}" = "1" ]; then
    exec "$core" --capability "$adapter" build/game.wasm --renderer=gl3plus
fi
exec "$core" --capability "$adapter" build/game.wasm --renderer=null
