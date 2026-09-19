#!/usr/bin/env bash
# Build the collision demo, run it, and render the animation.
#
#   ./run.sh          (or `npm start`, which is the same thing)
#
# Writes two gitignored outputs next to this script:
#   positions.dat  — the CSV the guest prints (t x0 y0 r0 x1 y1 r1)
#   collision.gif  — the animated GIF gnuplot renders from it
#
# GNUPLOT=/path/to/gnuplot picks a specific gnuplot binary.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core="${TENSION_CORE:-$here/../../../tension-core/target/debug/tension-core}"
gnuplot_bin="${GNUPLOT:-gnuplot}"

# 1. The one dependency this example does not carry itself. Checked first:
#    everything after it is pointless without gnuplot.
if ! command -v "$gnuplot_bin" >/dev/null 2>&1; then
    echo "gnuplot not found. Install it:" >&2
    echo "  Debian/Ubuntu: sudo apt install gnuplot" >&2
    echo "  macOS (brew):  brew install gnuplot" >&2
    exit 1
fi

cd "$here"

# 2. The guest's build dependencies (a fresh clone has none), then the guest.
if [ ! -x node_modules/.bin/asc ]; then
    echo "collision: installing the guest's build dependencies (npm install)..."
    npm install --silent
fi
npm run --silent build

# 3. Run the guest; its stdout is the CSV. The banner lines start with '#',
#    so gnuplot reads only the numeric rows. The count is the fallback path's
#    input (step 4), not the normal one: the script prefers gnuplot's `stats`.
"$core" build/game.wasm > positions.dat
FRAMES=$(grep -c '^[^#]' positions.dat)

# 4. Render. The script counts the frames with `stats`; if that fails — a
#    gnuplot older than 4.6 (2012), which has no `stats` — the same script
#    accepts the count from the shell instead, and that is this retry.
if ! "$gnuplot_bin" collision.gnuplot; then
    echo "gnuplot could not count the frames itself; retrying with N=$FRAMES" >&2
    "$gnuplot_bin" -e "N=$FRAMES" collision.gnuplot
fi

# 5. Report.
echo "wrote positions.dat ($FRAMES frames)"
echo "wrote collision.gif"
