#!/usr/bin/env bash
# Build and run the ozz loading probe (chunk 19, 19f-b).
#
#   ./test-ozz.sh
#
# No window and no renderer: the probe only reads bytes. The volume is passed
# on both flags on purpose — `--res` mounts it for the `tension::res`
# capability (which `resReadFile` reads), and `--tns=` is the guest's own
# argument, which it hands to `ogre.mountTns` (the OGRE capability's mount).
# The two capabilities keep separate mount tables, and the probe checks both.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
core="${TENSION_CORE:-$root/tension-core/target/debug/tension-core}"
adapter="${TENSION_OGRE_DSO:-$root/tension-ogre/build/libtension_ogre.so}"

if [ ! -x "$core" ]; then
    echo "no interpreter at $core — build it with:" >&2
    echo "  cargo build --manifest-path $root/tension-core/Cargo.toml --no-default-features" >&2
    exit 2
fi
if [ ! -f "$adapter" ]; then
    echo "animated-character: building the OGRE adapter (tension-ogre/build.sh)..." >&2
    "$root/tension-ogre/build.sh" >/dev/null
fi

cd "$here"
hash=$("$core" layout-hash)
bash "$root/tension-framework/build.sh" --hash "$hash" >/dev/null
if [ ! -x node_modules/.bin/asc ]; then
    npm install --silent
fi
./node_modules/.bin/asc ozz-load.ts \
    --config ../../../tension-framework/build/session.asconfig.json \
    -o build/ozz-load.wasm

bash ./pack.sh >/dev/null

exec "$core" --res "$here/build/assets.tns" --capability "$adapter" \
    "$here/build/ozz-load.wasm" "--tns=$here/build/assets.tns" --renderer=null
