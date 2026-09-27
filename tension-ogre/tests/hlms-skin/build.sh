#!/bin/bash
# Build the HlmsPbs-subclass reference. The binary lands under tension-ogre/build/
# (gitignored), never beside the sources.
#
#	set -e so a compile failure is a non-zero exit. Beware piping this script into
#	grep: the pipeline's status is grep's, so a failed build looks like a success.
set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out="$here/../../build/hlms-skin"
mkdir -p "$out"

g++ -O0 -g -std=c++17 -o "$out/hlms-skin" "$here/main.cc" "$here/HlmsTensionSkin.cpp" \
    $(pkg-config --cflags OGRE-Next) \
    -isystem /usr/include/OGRE-Next/Hlms/Common \
    -isystem /usr/include/OGRE-Next/Hlms/Pbs \
    -isystem /usr/include/OGRE-Next/Hlms/Unlit \
    $(pkg-config --libs OGRE-Next) -lOgreNextHlmsPbs -lOgreNextHlmsUnlit

echo "built $out/hlms-skin"
