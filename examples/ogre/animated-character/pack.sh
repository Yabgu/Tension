#!/usr/bin/env bash
# Pack this example's resources/ tree into build/assets.tns with the Zig packer.
#
# The volume is a build product — build/ is gitignored, resources/ is what is
# committed — and run.sh calls this before the guest starts. The packer is
# byte-reproducible: packing the same tree twice produces identical volumes.
#
# Usage: pack.sh [output.tns]   (default: build/assets.tns next to this script)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
packer="${TENSION_PACK:-$here/../../../tension-res/zig-out/bin/tension-pack}"
out="${1:-$here/build/assets.tns}"
mkdir -p "$here/build"
exec "$packer" "$here/resources" -o "$out" -v
