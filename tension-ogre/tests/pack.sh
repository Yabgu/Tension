#!/usr/bin/env bash
# Pack the fixtures' shared resource tree into build/fixtures.tns.
#
# One volume for every fixture (DESIGN.md §12): the tests share assets because
# they are tests. run.sh calls this once, then hands each fixture the path —
# and a second time for resources-noskel, the one volume that is *not* shared
# (chunk 19, 19e-b: the no-skeleton fixture).
#
# Usage: pack.sh [input-dir] [output.tns]
#   (defaults: tests/resources -> ../build/fixtures.tns)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
packer="${TENSION_PACK:-$here/../../tension-res/zig-out/bin/tension-pack}"
in="${1:-$here/resources}"
out="${2:-$here/../build/fixtures.tns}"
mkdir -p "$(dirname "$out")"
exec "$packer" "$in" -o "$out" -v
