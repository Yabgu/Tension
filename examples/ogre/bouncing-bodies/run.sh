#!/usr/bin/env bash
# Build the bouncing-bodies example and run it.
#
#   ./run.sh                            a window, and a box of falling bodies
#   TENSION_OGRE_HEADLESS=1 ./run.sh    structural only: no display needed
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$here/../run.sh" "$here" "$@"
