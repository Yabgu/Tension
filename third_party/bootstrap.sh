#!/usr/bin/env bash
# bootstrap.sh — build Ogre-Next from the pinned submodule.
#
# Builds third_party/ogre-next into third_party/ogre-next-build and
# installs it into third_party/ogre-next-install, from where
# tension-ogre/build.sh picks it up (with the system install as the
# fallback for contributors who have not run this).
#
# Why in-tree: the distro package's RenderSystem_Vulkan.so carries no
# DT_NEEDED for glslang — upstream's link line never names it — so the
# plugin cannot load there. Building from source is where that can be
# fixed: the Linux branch below hands OGRE's FindVulkan the glslang
# library in place of the shaderc_combined it wants. The flag set mirrors
# the AUR PKGBUILD (~/src/ogre-next-git), minus what we do not use.
#
# Packages this needs (Arch names, per the PKGBUILD): cmake, git,
# glslang, spirv-tools, vulkan-headers, mesa, plus the runtime deps
# freeimage, freetype2, glu, libxaw, libxrandr, rapidjson, tinyxml,
# ziplib, vulkan-icd-loader. On Debian the Vulkan build additionally
# needs glslang-dev (headers, and the static libglslang.a it ships in
# place of a shared glslang), spirv-tools (glslang's static archive calls
# into it — libSPIRV-Tools-opt/.a; installed as glslang-dev's dependency),
# libvulkan-dev, and the XCB development pair libxcb-randr0-dev
# libx11-xcb-dev; the preflight in the Linux branch below names whatever
# is missing.
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
is_installed=0
if [ -d "$INSTALL/share/OGRE-Next/Media" ] && { [ -f "$INSTALL/lib/libOgreNextMain.so" ] || [ -f "$INSTALL/lib/libOgreNextMain.dll.a" ] || [ -f "$INSTALL/bin/libOgreNextMain.dll" ]; }; then
    is_installed=1
fi
# The Vulkan plugin is part of what this install is for, and its absence
# is not "built already, nothing to do": it is the silent-drop failure the
# Linux branch below describes. Without this, a tree that has everything
# *except* the Vulkan render system would make this script a no-op.
if [ "$is_installed" -eq 1 ] && [ -z "$(find "$INSTALL" -name 'RenderSystem_Vulkan.*' -print -quit 2>/dev/null)" ]; then
    is_installed=0
fi
if [ "$is_installed" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
    echo "bootstrap: in-tree Ogre-Next already exists — nothing to do."
    echo "bootstrap: use --force to rebuild."
    exit 0
fi

if [ "$FORCE" -eq 1 ]; then
    echo "bootstrap: --force — reconfiguring and rebuilding"
fi

# Library directories to search on a Unix host: pkg-config's glslang
# libdir first (Debian and Arch both ship glslang.pc), then the usual
# places — /usr/lib/$(uname -m)-linux-gnu is Debian's multiarch directory.
unix_lib_dirs=()
glslang_pc_libdir="$(pkg-config --variable=libdir glslang 2>/dev/null || true)"
[ -n "$glslang_pc_libdir" ] && unix_lib_dirs+=("$glslang_pc_libdir")
unix_lib_dirs+=("/usr/lib/$(uname -m)-linux-gnu" /usr/lib64 /usr/lib /usr/local/lib)

# linkable_lib <filename> — echo the first matching <filename> found, or
# fail. The name has to be the link-time one (libxcb-randr.so); a
# runtime-only install's versioned file (libxcb-randr.so.0) is what the
# loader loads, not what the linker accepts.
linkable_lib() {
    local dir
    for dir in "${unix_lib_dirs[@]}"; do
        [ -e "$dir/$1" ] && { printf '%s\n' "$dir/$1"; return 0; }
    done
    return 1
}

# find_glslang_lib — the glslang library to link the Vulkan render system
# against: the shared one where the distro ships it (Arch), its versioned
# soname, or the static archive (Debian 13 ships glslang only as
# libglslang.a). The static one is PIC here — measured: linking it into a
# shared object takes, and the plugin then carries the symbols itself.
find_glslang_lib() {
    local dir name
    for dir in "${unix_lib_dirs[@]}"; do
        for name in "$dir"/libglslang.so "$dir"/libglslang.so.* "$dir"/libglslang.a; do
            [ -e "$name" ] && { printf '%s\n' "$name"; return 0; }
        done
    done
    return 1
}

# find_spirv_tools_libs — the SPIRV-Tools libraries glslang's *static*
# archive calls into, optimizer first: its SpvTools object references
# spvtools:: passes and the link stops at `undefined symbol:
# spvtools::CreateLocalMultiStoreElimPass` without them (measured on
# Debian 13; Debian ships both in the spirv-tools package, which
# glslang-dev depends on). A shared glslang carries its own dependencies,
# so this is only consulted for the .a — see the Linux branch.
find_spirv_tools_libs() {
    local opt base
    opt="$(linkable_lib libSPIRV-Tools-opt.so || linkable_lib libSPIRV-Tools-opt.a || true)"
    base="$(linkable_lib libSPIRV-Tools.so || linkable_lib libSPIRV-Tools.a || true)"
    [ -n "$opt" ] && [ -n "$base" ] || return 1
    printf '%s;%s\n' "$opt" "$base"
}

extra_flags=()
# Whether this platform's flag set is supposed to produce the Vulkan
# render system; the post-install check at the bottom holds the build to it.
vulkan_expected=0
case "$(uname -s)" in
    *MINGW*|*MSYS*|*CYGWIN*|*Windows*)
        extra_flags+=(
            -G Ninja
            "-DCMAKE_CXX_FLAGS=-U_WIN32_WINNT -D_WIN32_WINNT=0x0600"
            "-DCMAKE_C_FLAGS=-U_WIN32_WINNT -D_WIN32_WINNT=0x0600"
            -DOGRE_BUILD_RENDERSYSTEM_D3D11=OFF
            -DVulkan_SHADERC_LIB_REL=/ucrt64/lib/libglslang.dll.a
            -DVulkan_SHADERC_LIB_DBG=/ucrt64/lib/libglslang.dll.a
        )
        vulkan_expected=1
        ;;
    Linux*)
        # OGRE's FindVulkan (CMake/Packages/FindVulkan.cmake, a copy of
        # CMake's) requires a `shaderc_combined` library — an artifact only
        # the LunarG Vulkan SDK installs — and CMake's
        # cmake_dependent_option() then forces the whole Vulkan render
        # system off *silently* when it is missing: the configure exits 0,
        # the cache even keeps OGRE_BUILD_RENDERSYSTEM_VULKAN=ON as an
        # internal entry, and the install ships no RenderSystem_Vulkan.so
        # (measured on Debian 13, 2026-10-11 — the in-tree install here had
        # GL3Plus and NULL and nothing else).
        #
        # Point that variable at glslang instead: it is the library whose
        # symbols RenderSystem_Vulkan calls (36 undefined glslang:: symbols
        # otherwise; third_party/README.md). The MSYS2 branch above makes
        # the same substitution with libglslang.dll.a.
        #
        # Where the distro ships glslang as a static archive, SPIRV-Tools
        # has to be named too: glslang's SpvTools object references
        # spvtools:: passes and the link stops at `undefined symbol:
        # spvtools::CreateLocalMultiStoreElimPass` without it (measured on
        # Debian 13). Both go on the link line as one semicolon-separated
        # list — FindVulkan passes the value straight through to the
        # (otherwise unchanged) upstream link line, where the order
        # matters: glslang first, then SPIRV-Tools-opt, then SPIRV-Tools.
        glslang_include=""
        glslang_pc_include="$(pkg-config --variable=includedir glslang 2>/dev/null || true)"
        for dir in "$glslang_pc_include" /usr/include /usr/local/include; do
            [ -n "$dir" ] || continue
            [ -f "$dir/glslang/Public/ShaderLang.h" ] && { glslang_include="$dir"; break; }
        done
        glslang_lib="$(find_glslang_lib || true)"
        shader_libs="$glslang_lib"
        spirv_libs=""
        case "$glslang_lib" in
            *.a)
                spirv_libs="$(find_spirv_tools_libs || true)"
                [ -n "$spirv_libs" ] && shader_libs="$glslang_lib;$spirv_libs"
                ;;
        esac
        missing=()
        [ -n "$glslang_lib" ] || missing+=("the glslang library (libglslang.so or libglslang.a)")
        [ -n "$glslang_include" ] || missing+=("the glslang headers (glslang/Public/ShaderLang.h)")
        case "$glslang_lib" in
            *.a) [ -n "$spirv_libs" ] || missing+=("SPIRV-Tools (libSPIRV-Tools-opt and libSPIRV-Tools, which glslang's static archive calls into)") ;;
        esac
        # FindVulkan also needs the loader and its headers; without them it
        # fails the same silent way, so name them here too.
        [ -f /usr/include/vulkan/vulkan.h ] || missing+=("the Vulkan headers (vulkan/vulkan.h, libvulkan-dev)")
        linkable_lib libvulkan.so >/dev/null || missing+=("the Vulkan loader's development files (libvulkan.so, libvulkan-dev)")
        # The XCB window is Linux's only Vulkan window, and upstream links
        # it by bare name (`xcb-randr X11-xcb`), so the -dev packages have
        # to be installed or the plugin will not link.
        linkable_lib libxcb-randr.so >/dev/null || missing+=("xcb-randr's development files (libxcb-randr.so)")
        linkable_lib libX11-xcb.so >/dev/null || missing+=("X11-xcb's development files (libX11-xcb.so)")
        if [ "${#missing[@]}" -gt 0 ]; then
            echo "bootstrap: the Vulkan render system needs libraries that are not installed:" >&2
            printf 'bootstrap:   %s\n' "${missing[@]}" >&2
            echo "bootstrap: install them and run this again, e.g." >&2
            echo "bootstrap:   Debian/Ubuntu:  sudo apt install glslang-dev spirv-tools libxcb-randr0-dev libx11-xcb-dev" >&2
            echo "bootstrap:   Arch:           sudo pacman -S glslang spirv-tools libxcb libx11" >&2
            exit 1
        fi
        extra_flags+=(
            "-DVulkan_SHADERC_LIB_REL=$shader_libs"
            "-DVulkan_SHADERC_LIB_DBG=$shader_libs"
            # Always, even when it is /usr/include: FindVulkan leaves this
            # variable as Vulkan_SHADERC_INCLUDE_DIR-NOTFOUND when it finds
            # nothing (there is no shaderc/shaderc.h to find — we put
            # glslang's libraries in the variable instead), and OGRE's
            # FindVulkan does not list it among the values
            # find_package_handle_standard_args requires, so the configure
            # gets all the way to the render system and then dies with
            # "Found relative path while evaluating include directories"
            # (measured, Debian 13, 2026-10-11).
            "-DVulkan_SHADERC_INCLUDE_DIR=$glslang_include"
        )
        vulkan_expected=1
        ;;
    # Other Unix hosts (macOS, the BSDs) are left alone: Vulkan there needs
    # MoltenVK or another window backend, which this script has never built.
    # vulkan_expected stays 0, so the check at the bottom does not demand it.
esac

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
cmake -S "$SRC" -B "$BUILD" "${FLAGS[@]}" "${extra_flags[@]}"

echo "bootstrap: building with $(nproc) jobs"
cmake --build "$BUILD" -j"$(nproc)"

echo "bootstrap: installing to $INSTALL"
cmake --install "$BUILD"

# 3. The Vulkan plugin is what this build is for — a configure that dropped
# it must not read as success. The undefined-glslang check is the measured
# load failure: OGRE installs its plugins with RTLD_LAZY | RTLD_LOCAL and
# these references bind eagerly, so an unresolved glslang:: symbol is a
# plugin that cannot be loaded at all (third_party/README.md).
if [ "$vulkan_expected" -eq 1 ]; then
    vulkan_rs="$(find "$INSTALL" -name 'RenderSystem_Vulkan.*' -print -quit 2>/dev/null || true)"
    if [ -z "$vulkan_rs" ]; then
        echo "bootstrap: RenderSystem_Vulkan was not built — the Vulkan render system is off" >&2
        echo "bootstrap: the configure did not pick up the flags above; check its output for Vulkan" >&2
        exit 1
    fi
    case "$(uname -s)" in
        *MINGW*|*MSYS*|*CYGWIN*|*Windows*) ;;  # nm -D does not apply to PE
        *)
            if nm -D --undefined-only "$vulkan_rs" 2>/dev/null | grep -qE 'glslang|spvtools'; then
                echo "bootstrap: $vulkan_rs still has undefined glslang/SPIRV-Tools symbols — it cannot load" >&2
                exit 1
            fi
            ;;
    esac
fi

t1=$(date +%s)
echo "bootstrap: done in $((t1 - t0))s — $INSTALL/lib/libOgreNextMain.so"
if [ "$vulkan_expected" -eq 1 ]; then
    echo "bootstrap: vulkan render system: $vulkan_rs"
fi
