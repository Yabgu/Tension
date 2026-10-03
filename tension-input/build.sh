#!/bin/sh
# tension-input build recipe — the input capability's DSO.
#
# Produces: tension-input/build/libtension_input.so, the shared object
# tension-core dlopens for `--capability`.
#
# The capability's design is INPUT.md at the repo root; its wire is
# include/tension_input.h. It links SDL3 — and only SDL3: the host never names
# it, and this DSO is where the platform lives (INPUT.md §3 Q6).
#
# Modes: --check, --clean, or the build itself.
#
# Environment:
#   CXX=<compiler>
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out="$here/build"

case "${1:-}" in
    --check)
        if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists sdl3; then
            echo "tension-input: SDL3 $(pkg-config --modversion sdl3) via pkg-config"
        else
            echo "tension-input: SDL3 not found via pkg-config"
            echo "  Remedies: install it (Arch: pacman -S sdl3)"
            exit 1
        fi
        exit 0
        ;;
    --clean)
        rm -rf "$out"
        echo "tension-input: removed $out"
        exit 0
        ;;
esac

if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists sdl3; then
    echo "tension-input: SDL3 not found via pkg-config." >&2
    echo "  Install SDL3 (Arch: pacman -S sdl3) and retry." >&2
    exit 1
fi
if ! command -v "${CXX:-c++}" >/dev/null 2>&1; then
    echo "tension-input: ${CXX:-c++} not found on PATH." >&2
    exit 1
fi

mkdir -p "$out"
# -std=c++17: the adapter uses <thread>, <condition_variable> and the standard
#   library's types, like tension-ogre's.
# -fPIC: the object is dlopen'd, not linked into a PIE.
# -Wall -Wextra: warnings are the point of a build recipe a reviewer reads.
# -lpthread is not optional: the SDL thread and its condvars need it.
"${CXX:-c++}" -std=c++17 -O2 -fPIC -Wall -Wextra \
    -I"$here/include" -I"$here/../tension-core/include" \
    $(pkg-config --cflags sdl3) \
    "$here/src/adapter.cpp" "$here/src/input.cpp" \
    -shared -o "$out/libtension_input.so" \
    $(pkg-config --libs sdl3) -lpthread

echo "tension-input: $out/libtension_input.so"
if command -v objdump >/dev/null 2>&1; then
    needed=$(objdump -p "$out/libtension_input.so" | awk '/NEEDED/ {print "  " $2}')
    [ -n "$needed" ] && { echo "tension-input: DT_NEEDED:"; echo "$needed"; }
fi
