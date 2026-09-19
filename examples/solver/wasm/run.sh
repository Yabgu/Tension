#!/usr/bin/env bash
# Run the solver demo against the built guest.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core="${TENSION_CORE:-$here/../../../tension-core/target/debug/tension-core}"
exec "$core" "$here/build/game.wasm" "$@"
