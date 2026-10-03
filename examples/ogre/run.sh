#!/usr/bin/env bash
# Build one OGRE example and run it: the mechanism all five share.
#
#   ./run.sh <example-dir> [args...]     a window, and the example's output
#   TENSION_OGRE_HEADLESS=1 ./run.sh <example-dir>
#                                        structural only: no display needed
#
# Arguments after the example directory go to the guest — the host consumes
# --capability, --tns and --renderer, and everything else is the guest's own.
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
#
# Each example keeps its own `run.sh`: a banner, its usage lines, and a call to
# this script with its own directory.
set -euo pipefail
example="$(cd "${1:?usage: run.sh <example-dir> [args...]}" && pwd)"
shift
name="$(basename "$example")"
root="$(cd "$example/../../.." && pwd)"
core="${TENSION_CORE:-$root/tension-core/target/debug/tension-core}"
adapter="${TENSION_OGRE_DSO:-$root/tension-ogre/build/libtension_ogre.so}"
framework="$root/tension-framework"

# An in-tree Ogre-Next (third_party/bootstrap.sh) lives outside the loader's
# default search path; the adapter and its render systems resolve from there.
in_tree_lib="$root/third_party/ogre-next-install/lib"
if [ -d "$in_tree_lib" ]; then
    export LD_LIBRARY_PATH="$in_tree_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if [ ! -x "$core" ]; then
    echo "no interpreter at $core — build it with:" >&2
    echo "  cargo build --manifest-path $root/tension-core/Cargo.toml --no-default-features" >&2
    exit 2
fi
if [ ! -f "$adapter" ]; then
    echo "$name: building the OGRE adapter (tension-ogre/build.sh)..."
    "$root/tension-ogre/build.sh" >/dev/null
fi

cd "$example"

# The guest's asc flags come from the framework's generator, run against this
# interpreter's layout hash: the arena's memory relation has one source of
# truth, and a stale copy of it produces a guest the host refuses.
hash=$("$core" layout-hash)
bash "$framework/build.sh" --hash "$hash" >/dev/null

# A fresh clone has no build dependencies.
if [ ! -x node_modules/.bin/asc ]; then
    echo "$name: installing the guest's build dependencies (npm install)..."
    npm install --silent
fi
npm run --silent build

# The guest's assets travel as one packed volume (chunk 11). `pack.sh` rebuilds
# it from resources/ — the packer is byte-reproducible — and the guest mounts
# it under "resources/" before the first load.
if [ -f ./pack.sh ]; then
    bash ./pack.sh >/dev/null
fi

renderer=gl3plus
if [ "${TENSION_OGRE_HEADLESS:-0}" = "1" ]; then
    echo "TENSION_OGRE_HEADLESS=1: no window; structural only"
    renderer=null
elif [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    echo "no display available; falling back to renderer=null"
    renderer=null
fi

assets=()
res=()
if [ -f build/assets.tns ]; then
    assets=(--tns="$example/build/assets.tns")
    # The same volume for `tension::res`: `resReadFile` reads the interpreter's
    # `--res` paks, not the OGRE mount — `--tns` feeds the adapter's loader and
    # the two are separate tables (the loading probe measured this). Guests
    # that never read a res file are unaffected; ones that do would otherwise
    # find the volume mounted for OGRE and invisible to their byte reads.
    res=(--res "$example/build/assets.tns")
fi
# Anything left on the command line goes to the guest: `--bodies=N` and
# `--angular` are the guest's own arguments, and this script's job is to hand
# them over rather than to know what they mean.
# Some examples load a second capability (input-camera: the renderer plus the
# input DSO). The host's --capability is repeatable; this is how an example
# asks for another one without the harness knowing what it means.
caps=(--capability "$adapter")
if [ -n "${TENSION_EXTRA_CAPABILITY:-}" ]; then
    caps+=(--capability "$TENSION_EXTRA_CAPABILITY")
fi
exec "$core" "${res[@]}" "${caps[@]}" build/game.wasm "${assets[@]}" --renderer="$renderer" "$@"
