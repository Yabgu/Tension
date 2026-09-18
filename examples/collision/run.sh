#!/usr/bin/env bash
# Build the collision demo, run it, and render the animation.
#
#   ./run.sh
#
# Writes two gitignored outputs next to this script:
#   positions.dat  — the CSV the guest prints (t x0 y0 r0 x1 y1 r1)
#   collision.gif  — the animated GIF gnuplot renders from it
#
# GNUPLOT=/path/to/gnuplot overrides which gnuplot is used.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core="${TENSION_CORE:-$here/../../tension-core/target/debug/tension-core}"
gnuplot_bin="${GNUPLOT:-gnuplot}"

cd "$here"

# 1. the guest's build dependencies (a fresh clone has none), then the guest
if [ ! -x node_modules/.bin/asc ]; then
    echo "collision: installing the guest's build dependencies (npm install)..."
    npm install --silent
fi
npm run --silent build

# 2. run the guest; its stdout is the CSV. The banner lines start with '#',
#    so gnuplot skips them.
"$core" build/game.wasm > positions.dat

# 3. render
if ! command -v "$gnuplot_bin" >/dev/null 2>&1; then
    echo "collision: gnuplot not found on PATH." >&2
    echo "  positions.dat is written and collision.gnuplot is ready;" >&2
    echo "  install gnuplot (or set GNUPLOT=/path/to/gnuplot) and rerun." >&2
    exit 1
fi
"$gnuplot_bin" collision.gnuplot

# 4. report
echo "positions.dat: $here/positions.dat"
echo "collision.gif: $here/collision.gif"
