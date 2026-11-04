#!/bin/sh
# tension-ogre build recipe — the capability adapter, and the OGRE-Next
# discovery behind it.
#
# Produces: tension-ogre/build/libtension_ogre.so, the shared object
# tension-core dlopens for `--capability`.
#
# OGRE_NEXT_PIN = 475f783d76f21b530e718aab4a548cdd9a222e50
#   https://github.com/OGRECave/ogre-next — the submodule gitlink
#   `third_party/ogre-next` is checked out at, and what `bootstrap.sh` builds
#   (it builds the submodule as checked out; it does not read this file).
#   Deliberately *not* the v3.0.0 tag's commit (75643c3997f5…): the pin is 788
#   commits past it, and every measurement in this repository ran against it
#   (third_party/README.md). Moving the pin is a `git checkout` in the
#   submodule plus an update here.
#   The version floor the build enforces is separate and unchanged:
#   `pkg-config --atleast-version=3.0.0 OGRE-Next`. No wire format reads either
#   (DESIGN.md §5.1).
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
pin_sha='475f783d76f21b530e718aab4a548cdd9a222e50'
pin="$pin_sha (v3.0.0-788-g475f783d76)"
ntdll_lib=
case "$(uname -s)" in
    *MINGW*|*MSYS*|*CYGWIN*|*Windows*) ntdll_lib="-lntdll" ;;
esac

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
        if [ -f "$here/../third_party/ogre-next-install/lib/libOgreNextMain.so" ]; then
            echo "tension-ogre: in-tree Ogre-Next at third_party/ogre-next-install (preferred)"
        fi
        # The submodule is what `bootstrap.sh` builds, so its HEAD is the revision
        # the measurements were taken against. Comparing the gitlink is an exact,
        # cheap check — and the drift it catches is real: this file used to name
        # the v3.0.0 tag commit while the submodule sat 788 commits past it.
        sub="$here/../third_party/ogre-next"
        if [ -e "$sub/.git" ]; then
            head_sha=$(git -C "$sub" rev-parse HEAD 2>/dev/null || true)
            if [ -n "$head_sha" ]; then
                if [ "$head_sha" != "$pin_sha" ]; then
                    echo "tension-ogre: MISMATCH — submodule HEAD is $head_sha" >&2
                    echo "               but the pin in this file is $pin_sha" >&2
                    echo "               (update the pin here, or check that commit out in the submodule)" >&2
                    exit 1
                fi
                echo "tension-ogre: submodule HEAD matches the pin ($pin_sha)"
            fi
        fi
        echo "tension-ogre: pinned against $pin"
        echo "tension-ogre: backend=$backend (default; 'none' opts out of OGRE)"
        exit 0
        ;;
    --test)
        # The unit tests need no OGRE: the loader's worker reads bytes and the
        # backend is a mock, the config decoder is pure parsing. The loader
        # reads through the mount table now (chunk 11), so these tests link
        # tension-res too — the same static archive tension-core links.
        res_dir="$here/../tension-res"
        if [ ! -f "$res_dir/zig-out/lib/libtension_res.a" ] && [ -f "$res_dir/zig-out/lib/tension_res.lib" ]; then
            cp "$res_dir/zig-out/lib/tension_res.lib" "$res_dir/zig-out/lib/libtension_res.a"
        fi
        if [ ! -f "$res_dir/zig-out/lib/libtension_res.a" ]; then
            echo "tension-ogre: $res_dir/zig-out/lib/libtension_res.a is missing." >&2
            echo "  Build it first: (cd $res_dir && zig build -Doptimize=ReleaseSafe)" >&2
            exit 1
        fi
        mkdir -p "$out/tests"
        "${CXX:-c++}" -std=c++17 -O1 -Wall -Wextra -I"$here/include" -I"$here/src" \
            "$here/src/config.cpp" "$here/tests/config_test.cpp" \
            -o "$out/tests/config_test" || exit 1
        "${CXX:-c++}" -std=c++17 -O1 -Wall -Wextra -I"$here/include" -I"$here/src" \
            -I"$res_dir/include" \
            "$here/src/loader.cpp" "$here/src/mounts.cpp" "$here/tests/loader_test.cpp" \
            -o "$out/tests/loader_test" \
            "$res_dir/zig-out/lib/libtension_res.a" -lpthread $ntdll_lib || exit 1
        "${CXX:-c++}" -std=c++17 -O1 -Wall -Wextra -I"$here/include" -I"$here/src" \
            "$here/src/scene.cpp" "$here/tests/scene_test.cpp" \
            -o "$out/tests/scene_test" || exit 1
        "$out/tests/config_test" || exit 1
        "$out/tests/scene_test" || exit 1
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
        prefix=$(CDPATH= cd -- "$TENSION_OGRE_PREFIX" && pwd)
        # The Hlms headers include their siblings by bare name
        # (`#include "OgreHlmsBufferManager.h"`), so the three Hlms include
        # roots are not optional — the in-tree and pkg-config branches below
        # both add them. Without them this branch cannot compile
        # `hlms_tension_skin.cpp`, which is why a relocated prefix (the shape
        # `packages/ogre-next` uses) did not build.
        ogre_include="-isystem $prefix/include -isystem $prefix/include/OGRE-Next"
        ogre_include="$ogre_include -isystem $prefix/include/OGRE-Next/Hlms/Common -isystem $prefix/include/OGRE-Next/Hlms/Unlit -isystem $prefix/include/OGRE-Next/Hlms/Pbs"
        # The Hlms classes live in their own libraries, not in OgreNextMain —
        # the adapter links the two it uses directly.
        ogre_lib="-L$prefix/lib -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsPbs"
        plugin_dir="$prefix/lib/OGRE-Next"
        # `packages/ogre-next` is a **flat package**, not an install prefix:
        # `lib/`, `include/` and `Media/` sit at its root — its README says
        # exactly that, and the packer (`scripts/build-native.mjs`) writes the
        # Hlms shaders to `Media/`. A real Ogre-Next install puts them under
        # `share/OGRE-Next/Media` instead, and this branch used to assume only
        # that shape: built against the package, it compiled in
        # `packages/ogre-next/share/OGRE-Next/Media`, a directory the packer
        # never creates. Every Hlms start then failed with "Data folder provided
        # contains no valid template shader files" and the only way to run a
        # guest was to override `TENSION_OGRE_MEDIA_DIR` by hand.
        #
        # Keyed on `Hlms/` rather than on the directory: an install prefix can
        # have `share/OGRE-Next/Media` half-created by another tool, and the
        # question here is which tree actually holds the shaders.
        if [ -d "$prefix/Media/Hlms" ]; then
            media_dir="$prefix/Media"
        elif [ -d "$prefix/share/OGRE-Next/Media/Hlms" ]; then
            media_dir="$prefix/share/OGRE-Next/Media"
        else
            # Neither: name the package layout, which is what TENSION_OGRE_PREFIX
            # is for. The runtime reports the missing folder by name.
            media_dir="$prefix/Media"
        fi
    elif [ -f "$here/../third_party/ogre-next-install/lib/libOgreNextMain.so" ]; then
        # In-tree first: `third_party/bootstrap.sh` built Ogre-Next from the
        # pinned submodule. Preferred over the system install because the
        # source build is the one this project controls — and the one whose
        # Media tree is installed for the Hlms. Remove or rename the
        # directory to fall back to the system install below.
        in_tree=$(CDPATH= cd -- "$here/../third_party/ogre-next-install" && pwd)
        ogre_include="-isystem $in_tree/include -isystem $in_tree/include/OGRE-Next"
        ogre_include="$ogre_include -isystem $in_tree/include/OGRE-Next/Hlms/Common -isystem $in_tree/include/OGRE-Next/Hlms/Unlit -isystem $in_tree/include/OGRE-Next/Hlms/Pbs"
        ogre_lib="-L$in_tree/lib -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsPbs"
        plugin_dir="$in_tree/lib/OGRE-Next"
        media_dir="$in_tree/share/OGRE-Next/Media"
    elif command -v pkg-config >/dev/null 2>&1 && pkg-config --atleast-version=3.0.0 OGRE-Next; then
        # -isystem, not -I: OGRE's headers are not warning-clean, and its
        # warnings are not ours to answer for.
        ogre_include=$(pkg-config --cflags OGRE-Next | sed 's/-I/-isystem /g')
        # The Hlms classes live in their own libraries, not in OgreNextMain,
        # and their headers include siblings by bare name.
        ogre_lib="$(pkg-config --libs OGRE-Next) -lOgreNextHlmsUnlit -lOgreNextHlmsPbs"
        ogre_include="$ogre_include -isystem $(pkg-config --variable=includedir OGRE-Next)/OGRE-Next/Hlms/Common -isystem $(pkg-config --variable=includedir OGRE-Next)/OGRE-Next/Hlms/Unlit -isystem $(pkg-config --variable=includedir OGRE-Next)/OGRE-Next/Hlms/Pbs"
        plugin_dir=$(pkg-config --variable=plugindir OGRE-Next 2>/dev/null || true)
        media_dir="$(pkg-config --variable=prefix OGRE-Next 2>/dev/null)/share/OGRE-Next/Media"
    else
        # An OGRE-Next that pkg-config knows but that is older than the pin is
        # "found, not usable", not missing: name the version so the reader does
        # not go install the same one again.
        pc_state="not found"
        if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists OGRE-Next 2>/dev/null; then
            pc_state="found $(pkg-config --modversion OGRE-Next 2>/dev/null || echo '?'), need >= 3.0.0"
        fi
        echo "tension-ogre: OGRE-Next >= 3.0.0 not found — cannot build the adapter." >&2
        echo "  Looked for, in this order:" >&2
        echo "    \$TENSION_OGRE_PREFIX               (unset)" >&2
        echo "    third_party/ogre-next-install      (no lib/libOgreNextMain.so)" >&2
        echo "    OGRE-Next >= 3.0.0 via pkg-config  ($pc_state)" >&2
        echo "" >&2
        echo "  Preferred: build the pinned Ogre-Next from the submodule —" >&2
        echo "    third_party/bootstrap.sh" >&2
        echo "  It installs into third_party/ogre-next-install, which this script" >&2
        echo "  picks up ahead of any system package (see third_party/README.md)." >&2
        echo "" >&2
        echo "  Or install Ogre-Next >= 3.0.0 system-wide so pkg-config finds it" >&2
        echo "  (Arch: pacman -S ogre-next)." >&2
        echo "" >&2
        echo "  Or build the adapter without OGRE — renderer=null is all it can" >&2
        echo "  satisfy then:" >&2
        echo "    TENSION_OGRE_BACKEND=none $0" >&2
        exit 1
    fi

fi

# Exactly one backend file: each defines `make_backend`, so compiling both is a
# duplicate symbol, and the choice is the build's to make (B.2b.2).
#
# Chunk 11: `mounts.cpp` (the Tension Volume mount table) joins every build, and
# the static archive it drives is linked in. The archive is the same one
# `tension-core/build.rs` links (`zig build -Doptimize=ReleaseSafe`);
# `--exclude-libs,ALL` keeps its ~120 exported symbols out of this DSO's
# dynamic table — the adapter's own entry points are the ones that must be
# visible to dlopen.
res_dir="$here/../tension-res"
if [ ! -f "$res_dir/zig-out/lib/libtension_res.a" ] && [ -f "$res_dir/zig-out/lib/tension_res.lib" ]; then
    cp "$res_dir/zig-out/lib/tension_res.lib" "$res_dir/zig-out/lib/libtension_res.a"
fi
if [ ! -f "$res_dir/zig-out/lib/libtension_res.a" ]; then
    echo "tension-ogre: $res_dir/zig-out/lib/libtension_res.a is missing." >&2
    echo "  Build it first: (cd $res_dir && zig build -Doptimize=ReleaseSafe)" >&2
    exit 1
fi
res_include="-I$res_dir/include"
res_archive="$res_dir/zig-out/lib/libtension_res.a"
if [ "$backend" = ogre ]; then
    sources="$here/src/config.cpp $here/src/status.cpp $here/src/scene.cpp $here/src/loader.cpp $here/src/mounts.cpp $here/src/backend_ogre.cpp $here/src/hlms_tension_skin.cpp $here/src/adapter.cpp"
else
    sources="$here/src/config.cpp $here/src/status.cpp $here/src/scene.cpp $here/src/loader.cpp $here/src/mounts.cpp $here/src/backend_none.cpp $here/src/adapter.cpp"
fi

# -std=c++17: the adapter uses <thread>, <condition_variable> and structured
#   declarations of the standard library's types.
# -fPIC: the object is dlopen'd, not linked into a PIE.
# -Wall -Wextra: warnings are the point of a build recipe that a reviewer reads.
# -lpthread is not optional: the render thread and its condvar need it.
# The wire records the adapter decodes are generated from the schema in the
# repository root. Regenerate before compiling so a schema edit is never half
# applied; `test.sh --codegen` is the drift gate.
node "$here/../tools/codegen/generate.mjs" \
    --schema "$here/../schema/ogre.json" \
    --out-ts "$here/../tension-framework/assembly/ogre/generated" \
    --out-h "$here/src/generated" >/dev/null || {
    echo "tension-ogre: the codegen step failed (schema/ogre.json)" >&2
    exit 1
}

mkdir -p "$out"
# RUNPATH, so a relocated adapter finds its own libraries instead of relying on
# `LD_LIBRARY_PATH` being set by whatever launches it. Two spellings, both
# relative to the DSO's own directory:
#   $ORIGIN                        a self-contained drop (all libs beside it)
#   $ORIGIN/../../tension-ogre-next/lib   npm's flat layout, where the packages
#                                  are siblings under node_modules/@yabgu_gm/
# The second is what `file:` dependencies produce; the first is what a tarball
# install or a plain copy produces. Listing both costs nothing and means the
# same .so works in either arrangement.
#
# `--disable-new-dtags` makes the linker emit DT_RPATH rather than DT_RUNPATH.
# Deliberate: DT_RPATH is consulted *before* `LD_LIBRARY_PATH`, DT_RUNPATH after.
# The in-tree sonames (`libOgreNextMain.so.4.0`) are identical to a distro
# package's, so the search order is what decides which one a process gets —
# third_party/README.md is explicit that the path must win.
# Two sibling spellings, because the DSO is reached both ways:
#   .../tension-ogre/lib         npm's symlink, so the package name is the
#                                directory name (tension-ogre-next)
#   .../ogre/lib                 the realpath of that symlink, which is what
#                                glibc uses for $ORIGIN, and where the sibling
#                                is `ogre-next` (the repository's own name)
rpath='$ORIGIN:$ORIGIN/../../tension-ogre-next/lib:$ORIGIN/../../tension-freeimage/lib:$ORIGIN/../../ogre-next/lib:$ORIGIN/../../freeimage/lib'
# shellcheck disable=SC2086  # the flag lists are deliberate word splits
"${CXX:-c++}" -std=c++17 -O2 -fPIC -Wall -Wextra \
    -I"$here/include" -I"$here/src" -I"$here/../tension-core/include" $res_include $ogre_include \
    ${plugin_dir:+-DTENSION_OGRE_PLUGIN_DIR="\"$plugin_dir\""} \
    ${media_dir:+-DTENSION_OGRE_MEDIA_DIR="\"$media_dir\""} \
    -DTENSION_OGRE_BACKEND="${backend}" \
    $sources \
    -shared -o "$out/libtension_ogre.so" \
    $ogre_lib $res_archive -Wl,--exclude-libs,ALL -Wl,--disable-new-dtags,-rpath,"$rpath" -lpthread $ntdll_lib

echo "tension-ogre: $out/libtension_ogre.so (backend $backend)"
if [ "$backend" = ogre ]; then
    echo "tension-ogre: linked against OGRE-Next; plugins from ${plugin_dir:-<pkg-config>}"
fi
