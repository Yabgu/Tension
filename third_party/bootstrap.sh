#!/usr/bin/env bash
# bootstrap.sh — build Ogre-Next from the pinned submodule.
#
# Builds third_party/ogre-next into third_party/ogre-next-build and
# installs it into third_party/ogre-next-install, from where
# tension-ogre/build.sh picks it up (with the system install as the
# fallback for contributors who have not run this).
#
# Why in-tree: the Arch ogre-next-git package's RenderSystem_Vulkan.so
# carries no DT_NEEDED for glslang, so the plugin cannot load there.
# Building from source lets the Vulkan render system link glslang
# properly (and pins the code). The flag set mirrors the AUR PKGBUILD
# (~/src/ogre-next-git), minus what we do not use.
#
# Packages this needs (Arch names, per the PKGBUILD): cmake, git,
# glslang, spirv-tools, vulkan-headers, mesa, plus the runtime deps
# freeimage, freetype2, glu, libxaw, libxrandr, rapidjson, tinyxml,
# zziplib, vulkan-icd-loader.
#
# Usage:
#   third_party/bootstrap.sh          # skip if already installed
#   third_party/bootstrap.sh --force  # reconfigure, rebuild, reinstall

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$HERE/ogre-next"
BUILD="$HERE/ogre-next-build"
INSTALL="$HERE/ogre-next-install"

FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        *) echo "bootstrap: unknown argument '$arg' (want --force)" >&2; exit 2 ;;
    esac
done

# 1. The submodule has to be there — initialise it on a fresh clone.
if [ ! -f "$SRC/CMakeLists.txt" ]; then
    echo "bootstrap: third_party/ogre-next is empty; initialising the submodule"
    git -C "$ROOT" submodule update --init --recursive third_party/ogre-next
fi

# 2. Idempotence: an install is a build; don't redo it unless asked.
# The media tree is part of "installed": without it the Hlms has no
# materials (see the OGRE_INSTALL_SAMPLES note below).
if [ -f "$INSTALL/lib/libOgreNextMain.so" ] && [ -d "$INSTALL/share/OGRE-Next/Media" ] && [ "$FORCE" -eq 0 ]; then
    echo "bootstrap: $INSTALL/lib/libOgreNextMain.so already exists — nothing to do."
    echo "bootstrap: use --force to rebuild."
    exit 0
fi

if [ "$FORCE" -eq 1 ]; then
    echo "bootstrap: --force — reconfiguring and rebuilding"
fi

FLAGS=(
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_PREFIX="$INSTALL"
    # Render systems: GL3Plus (the adapter's default) and Vulkan (the
    # point of this build — the system package's Vulkan plugin cannot
    # load).
    -DOGRE_BUILD_RENDERSYSTEM_GL3PLUS=ON
    -DOGRE_BUILD_RENDERSYSTEM_VULKAN=ON
    # Components the adapter uses.
    -DOGRE_BUILD_COMPONENT_HLMS_PBS=ON
    -DOGRE_BUILD_COMPONENT_HLMS_UNLIT=ON
    -DOGRE_BUILD_COMPONENT_MESHLODGENERATOR=ON
    -DOGRE_BUILD_COMPONENT_OVERLAY=ON
    -DOGRE_BUILD_COMPONENT_PLANAR_REFLECTIONS=ON
    # Nothing we do not use (TERRAIN/VOLUME are off by default on this
    # revision; the PKGBUILD's exclusions cover older ones).
    -DOGRE_USE_BOOST=0
    -DOGRE_SIMD_NEON=FALSE
    # No sample code, no tests, no docs; the command-line tools are cheap
    # and occasionally useful.
    -DOGRE_BUILD_SAMPLES2=OFF
    -DOGRE_BUILD_TESTS=OFF
    -DOGRE_BUILD_TOOLS=ON
    # Not "install the demos": upstream hangs the Media tree (the Hlms
    # material JSONs and resources2.cfg the adapter reads) off this flag
    # alone — measured: with it OFF, share/OGRE-Next/Media is absent and
    # the Hlms has no materials to load. Nothing is built from Samples/.
    -DOGRE_INSTALL_SAMPLES=ON
    -DOGRE_INSTALL_SAMPLES_SOURCE=OFF
    -DOGRE_INSTALL_DOCS=0
    # Feature set matching the system package, so behaviour is
    # unchanged when the source switch happens.
    -DOGRE_CONFIG_THREAD_PROVIDER=std
    -DOGRE_CONFIG_ENABLE_FREEIMAGE=ON
    -DOGRE_CONFIG_ENABLE_JSON=ON
    -DOGRE_CONFIG_ENABLE_ZIP=ON
)

echo "bootstrap: configuring ($SRC -> $BUILD)"
t0=$(date +%s)
cmake -S "$SRC" -B "$BUILD" "${FLAGS[@]}"

echo "bootstrap: building with $(nproc) jobs"
cmake --build "$BUILD" -j"$(nproc)"

echo "bootstrap: installing to $INSTALL"
cmake --install "$BUILD"

t1=$(date +%s)
echo "bootstrap: done in $((t1 - t0))s — $INSTALL/lib/libOgreNextMain.so"
