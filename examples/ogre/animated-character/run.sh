#!/usr/bin/env bash
# Build the animated-character example and run it.
#
#   ./run.sh                            a window, and four characters animating
#   TENSION_OGRE_HEADLESS=1 ./run.sh    structural only: no display needed
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$here/../run.sh" "$here" "$@"
