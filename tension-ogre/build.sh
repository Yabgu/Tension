#!/bin/sh
# tension-ogre build recipe — the capability adapter, and the OGRE-Next
# discovery behind it.
#
# Produces: tension-ogre/build/libtension_ogre.so, the shared object
# tension-core dlopens for `--capability`.
#
# OGRE_NEXT_REF = v3.0.0 (75643c3997f5b6d2aa1d7bd8400b9be6736d9908)
#   https://github.com/OGRECave/ogre-next
#   Verified against the Arch package ogre-next 3.0.0-2. The build checks the
#   version with `pkg-config --atleast-version=3.0.0 OGRE-Next`; the SHA is
#   documentation and the source-build recipe's checkout ref — no wire format
#   reads it (DESIGN.md §5.1).
#
# Modes: --print-pin, --check, --clean, or the build itself.
#
# Environment:
#   TENSION_OGRE_BACKEND=ogre|none  (default: ogre)
#       `ogre` links OGRE-Next and drives a real render system (NULL for the
#       headless gate, GL3+ for a window). `none` is the explicit opt-in for a
#       machine without OGRE-Next: no OGRE headers, no OGRE libraries, and the
#       only renderer it can satisfy is `renderer=null`.
#   TENSION_OGRE_PREFIX=<prefix>    a hand-built OGRE-Next install, instead of
#                                   the one pkg-config knows about.
#   CXX=<compiler>
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out="$here/build"
backend=${TENSION_OGRE_BACKEND:-ogre}
pin='v3.0.0 (75643c3997f5b6d2aa1d7bd8400b9be6736d9908)'

case "${1:-}" in
    --print-pin)
        echo "OGRE-Next $pin"
        exit 0
        ;;
    --check)
        if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists OGRE-Next; then
            echo "tension-ogre: OGRE-Next $(pkg-config --modversion OGRE-Next) via pkg-config"
            echo "  plugin dir: $(pkg-config --variable=plugindir OGRE-Next 2>/dev/null || echo '-')"
        else
            echo "tension-ogre: OGRE-Next not found via pkg-config"
        fi
        echo "tension-ogre: pinned against $pin"
        echo "tension-ogre: backend=$backend (default; `none` opts out of OGRE)"
        exit 0
        ;;
    --test)
        # The unit tests need no OGRE: the loader's worker reads bytes and the
        # backend is a mock, the config decoder is pure parsing.
        mkdir -p "$out/tests"
        "${CXX:-c++}" -std=c++17 -O1 -Wall -Wextra -I"$here/include" -I"$here/src" \
            "$here/src/config.cpp" "$here/tests/config_test.cpp" \
            -o "$out/tests/config_test" || exit 1
        "${CXX:-c++}" -std=c++17 -O1 -Wall -Wextra -I"$here/include" -I"$here/src" \
            "$here/src/loader.cpp" "$here/tests/loader_test.cpp" \
            -o "$out/tests/loader_test" -lpthread || exit 1
        "$out/tests/config_test" || exit 1
        "$out/tests/loader_test" || exit 1
        exit 0
        ;;
    --clean)
        rm -rf "$out"
        echo "tension-ogre: removed $out"
        exit 0
        ;;
esac

if [ "$backend" != ogre ] && [ "$backend" != none ]; then
    echo "tension-ogre: TENSION_OGRE_BACKEND=$backend is not a backend." >&2
    echo "  Use ogre (link OGRE-Next) or none (build without it)." >&2
    exit 1
fi

if ! command -v "${CXX:-c++}" >/dev/null 2>&1; then
    echo "tension-ogre: ${CXX:-c++} not found on PATH." >&2
    echo "  Install a C++ compiler (package: gcc or clang) and retry; the" >&2
    echo "  adapter is C++17 (src/*.cpp)." >&2
    exit 1
fi

ogre_include=
ogre_lib=
plugin_dir=
if [ "$backend" = ogre ]; then
    if [ -n "${TENSION_OGRE_PREFIX:-}" ]; then
        ogre_include="-isystem $TENSION_OGRE_PREFIX/include -isystem $TENSION_OGRE_PREFIX/include/OGRE-Next"
        ogre_lib="-L$TENSION_OGRE_PREFIX/lib -lOgreNextMain"
        plugin_dir="$TENSION_OGRE_PREFIX/lib/OGRE-Next"
    elif command -v pkg-config >/dev/null 2>&1 && pkg-config --atleast-version=3.0.0 OGRE-Next; then
        # -isystem, not -I: OGRE's headers are not warning-clean, and its
        # warnings are not ours to answer for.
        ogre_include=$(pkg-config --cflags OGRE-Next | sed 's/-I/-isystem /g')
        ogre_lib=$(pkg-config --libs OGRE-Next)
        plugin_dir=$(pkg-config --variable=plugindir OGRE-Next 2>/dev/null || true)
        media_dir="$(pkg-config --variable=prefix OGRE-Next 2>/dev/null)/share/OGRE-Next/Media"
    else
        echo "tension-ogre: OGRE-Next >= 3.0.0 not found via pkg-config." >&2
        echo "  Remedies, in order of preference:" >&2
        echo "    install the package            (Arch: pacman -S ogre-next)" >&2
        echo "    point at a prefix you built    TENSION_OGRE_PREFIX=<prefix>" >&2
        echo "    build without OGRE at all      TENSION_OGRE_BACKEND=none" >&2
        exit 1
    fi

fi

# Exactly one backend file: each defines `make_backend`, so compiling both is a
# duplicate symbol, and the choice is the build's to make (B.2b.2).
if [ "$backend" = ogre ]; then
    sources="$here/src/config.cpp $here/src/status.cpp $here/src/loader.cpp $here/src/backend_ogre.cpp $here/src/adapter.cpp"
else
    sources="$here/src/config.cpp $here/src/status.cpp $here/src/loader.cpp $here/src/backend_none.cpp $here/src/adapter.cpp"
fi

# -std=c++17: the adapter uses <thread>, <condition_variable> and structured
#   declarations of the standard library's types.
# -fPIC: the object is dlopen'd, not linked into a PIE.
# -Wall -Wextra: warnings are the point of a build recipe that a reviewer reads.
# -lpthread is not optional: the render thread and its condvar need it.
mkdir -p "$out"
# shellcheck disable=SC2086  # the flag lists are deliberate word splits
"${CXX:-c++}" -std=c++17 -O2 -fPIC -Wall -Wextra \
    -I"$here/include" -I"$here/src" -I"$here/../tension-core/include" $ogre_include \
    ${plugin_dir:+-DTENSION_OGRE_PLUGIN_DIR="\"$plugin_dir\""} \
    ${media_dir:+-DTENSION_OGRE_MEDIA_DIR="\"$media_dir\""} \
    -DTENSION_OGRE_BACKEND="${backend}" \
    $sources \
    -shared -o "$out/libtension_ogre.so" \
    $ogre_lib -lpthread

echo "tension-ogre: $out/libtension_ogre.so (backend $backend)"
if [ "$backend" = ogre ]; then
    echo "tension-ogre: linked against OGRE-Next; plugins from ${plugin_dir:-<pkg-config>}"
fi
