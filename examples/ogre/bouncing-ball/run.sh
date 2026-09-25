#!/usr/bin/env bash
# Build the bouncing-ball example and run it.
#
#   ./run.sh                            a window: a bouncing ball
#   TENSION_OGRE_HEADLESS=1 ./run.sh    structural only: no display needed
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$here/../run.sh" "$here" "$@"
