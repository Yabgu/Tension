#!/usr/bin/env bash
# Pack the fixtures' shared resource tree into build/fixtures.tns.
#
# One volume for every fixture (DESIGN.md §12): the tests share assets because
# they are tests. run.sh calls this once, then hands each fixture the path.
#
# Usage: pack.sh [output.tns]   (default: ../build/fixtures.tns)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
packer="${TENSION_PACK:-$here/../../tension-res/zig-out/bin/tension-pack}"
out="${1:-$here/../build/fixtures.tns}"
mkdir -p "$(dirname "$out")"
exec "$packer" "$here/resources" -o "$out" -v
