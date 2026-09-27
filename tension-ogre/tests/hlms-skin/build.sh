#!/bin/bash
# Build the HlmsPbs-subclass reference. The binary is `probe`, beside these sources
# (and gitignored — it is a build product, not a fixture).
#
#	set -e so a compile failure is a non-zero exit. Beware piping this script into
#	grep: the pipeline's status is grep's, so a failed build looks like a success.
set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

g++ -O0 -g -std=c++17 -o "$here/probe" "$here/main.cc" "$here/HlmsTensionSkin.cpp" \
    $(pkg-config --cflags OGRE-Next) \
    -isystem /usr/include/OGRE-Next/Hlms/Common \
    -isystem /usr/include/OGRE-Next/Hlms/Pbs \
    -isystem /usr/include/OGRE-Next/Hlms/Unlit \
    $(pkg-config --libs OGRE-Next) -lOgreNextHlmsPbs -lOgreNextHlmsUnlit

echo "built $here/probe"
