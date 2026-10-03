#!/usr/bin/env bash
# Build the input-camera example and run it.
#
#   ./run.sh                            a window: WASD moves, the mouse turns,
#                                       escape quits
#   TENSION_OGRE_HEADLESS=1 ./run.sh    refuses: no window means no input
#
# It is the only example that loads two capabilities — the renderer and the
# input DSO — so it exports TENSION_EXTRA_CAPABILITY, which examples/ogre/run.sh
# turns into a second --capability for the host.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
if [ ! -f "$root/tension-input/build/libtension_input.so" ]; then
    echo "input-camera: building the input capability (tension-input/build.sh)..."
    "$root/tension-input/build.sh" >/dev/null
fi
export TENSION_EXTRA_CAPABILITY="$root/tension-input/build/libtension_input.so"
exec "$here/../run.sh" "$here" "$@"
