#!/usr/bin/env bash
# Run the demo game against the packed volume.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core="${TENSION_CORE:-$here/../../tension-core/target/debug/tension-core}"
exec "$core" --res "$here/game.tns" "$here/build/game.wasm" "$@"
