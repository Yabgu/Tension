#!/usr/bin/env bash
# bootstrap.sh — build Ogre-Next, and the FreeImage it links, from the
# pinned submodules.
#
# Builds third_party/ogre-next into third_party/ogre-next-build and
# installs it into third_party/ogre-next-install, from where
# tension-ogre/build.sh picks it up (with the system install as the
# fallback for contributors who have not run this). third_party/freeimage
# is built first and installed into third_party/freeimage-install; the
# FreeImage step below explains why OGRE cannot be built without it.
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
# freetype2, glu, libxaw, libxrandr, rapidjson, tinyxml, ziplib,
# vulkan-icd-loader. FreeImage is not on that list: it comes from the
# third_party/freeimage submodule and its codecs (zlib, libpng, libjpeg,
# libtiff, OpenJPEG, webp, libraw, OpenEXR) are bundled, so no freeimage
# package is needed on the host. On Debian the Vulkan build additionally
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
FI_SRC="$HERE/freeimage"
FI_BUILD="$HERE/freeimage-build"
FI_INSTALL="$HERE/freeimage-install"

FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        *) echo "bootstrap: unknown argument '$arg' (want --force)" >&2; exit 2 ;;
    esac
done

# 1. The submodules have to be there — initialise them on a fresh clone.
if [ ! -f "$SRC/CMakeLists.txt" ]; then
    echo "bootstrap: third_party/ogre-next is empty; initialising the submodule"
    git -C "$ROOT" submodule update --init --recursive third_party/ogre-next
fi
if [ ! -f "$FI_SRC/CMakeLists.txt" ]; then
    echo "bootstrap: third_party/freeimage is empty; initialising the submodule"
    git -C "$ROOT" submodule update --init --recursive third_party/freeimage
fi

# 2. FreeImage, from its own submodule.
#
# This is not a preference, it is how OGRE's build is written. OgreMain's
# CMakeLists seeds BROKEN_FILES_IN_UNITY_BUILD with src/OgreFreeImageCodec2.cpp
# unconditionally, and create_unity_build_files() puts that SEPARATE list back
# into the target even when OGRE_UNITY_BUILD is off
# (CMake/Utils/OgreAddTargets.cmake) — so the translation unit is always
# compiled and linked. OGRE_CONFIG_ENABLE_FREEIMAGE=OFF only clears the codec
# *registration* (OGRE_NO_FREEIMAGE in OgreBuildSettings.h); it does not take
# the file out of the target, and the disable path's list(REMOVE_ITEM) cannot
# cancel it because the two spell the path differently. Measured with the flag
# OFF and no FreeImage installed, the build dies on the target's last object:
#
#   OgreFreeImageCodec2.cpp:48:10: fatal error: FreeImage.h: No such file
#   or directory
#
# With the flag OFF and FreeImage present it links, but OGRE is then left with
# no PNG/JPEG decoder at all — the adapter decodes every texture through
# Ogre::Image2::load — so the flag stays ON below and this step is required.
#
# The fork: WinMerge/freeimage is the maintained 3.19.x line with a CMake
# build. Upstream's own tree stops at 3.18.0 and this repository's submodule
# mirrors what the distro packages actually ship. The default branch of the
# fork is `winmerge`; the pin below is that branch's tip.

fi_flags=(
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_PREFIX="$FI_INSTALL"
    # Shared, not static: the bundled codecs are separate CMake targets,
    # so only the shared library is one self-contained file for OGRE to
    # link. A static build would need every codec archive on OGRE's link
    # line, which FindFreeImage does not provide.
    -DBUILD_SHARED_LIBS=ON
    -DFREEIMAGE_STATIC=OFF
    -DBUILD_TESTS=OFF
    # No camera RAW. LibRawLite is the only bundled codec under a copyleft
    # licence — LGPL-2.1 *or* CDDL-1.0 at the recipient's choice — and it is
    # compiled into libfreeimage statically, so leaving it in means electing
    # one of those and living with its terms. Nothing here reads camera RAW:
    # the loader sniffs PNG/DDS magic and the adapter hands bytes to
    # Ogre::Image2, which never opens a .CR2/.NEF/.DNG. The fork supports the
    # switch properly — PluginRAW.cpp has an #else stub that keeps the RAW
    # slot in FREE_IMAGE_FORMAT occupied, precisely so the FIF_* constants in
    # FreeImage.h stay aligned with the runtime plugin indices (its own
    # comment cites issue #38). Every remaining bundled codec is permissive:
    # zlib, libpng, IJG, libtiff, libwebp, libdeflate, OpenJPEG, OpenEXR,
    # Imath, OpenJPH, Zstd.
    -DBUILD_LIBRAWLITE=OFF
)
case "$(uname -s)" in
    *MINGW*|*MSYS*|*CYGWIN*|*Windows*)
        fi_flags+=(-G Ninja)
        ;;
    Linux*)
        # The layout of the distro package this repository was measured
        # against: libfreeimage.so.3 (+ the .so link) and freeimage.pc.
        fi_flags+=(-DFREEIMAGE_LINUX_PACKAGE_LAYOUT=ON)
        ;;
esac

# An install is a build here too: header + library on disk means done — but
# only if it was built from *these* flags. The stamp records the flag set, so
# changing one above (this is how BUILD_LIBRAWLITE=OFF arrived) rebuilds
# instead of silently reusing a library that still carries the old code. An
# install that predates the stamp has no recorded flags and so counts as
# stale, which is deliberate: it was built by an older script.
fi_stamp="$FI_INSTALL/.bootstrap-flags"
fi_want_stamp="$(printf '%s\n' "${fi_flags[@]}")"
fi_installed=0
if [ -f "$FI_INSTALL/include/FreeImage.h" ] && [ -n "$(find "$FI_INSTALL" \
        \( -iname 'libfreeimage.so*' -o -iname 'libfreeimage.a' \
           -o -iname 'freeimage.dll' -o -iname 'libfreeimage.dll.a' \) \
        -print -quit 2>/dev/null)" ] && [ -f "$fi_stamp" ] \
        && [ "$(cat "$fi_stamp")" = "$fi_want_stamp" ]; then
    fi_installed=1
fi

if [ "$fi_installed" -eq 0 ] || [ "$FORCE" -eq 1 ]; then
    if [ -d "$FI_INSTALL" ] && [ -f "$FI_INSTALL/include/FreeImage.h" ]; then
        echo "bootstrap: FreeImage is installed but not with this flag set — rebuilding"
    fi
    echo "bootstrap: building FreeImage ($FI_BUILD -> $FI_INSTALL)"
    cmake -S "$FI_SRC" -B "$FI_BUILD" "${fi_flags[@]}"
    cmake --build "$FI_BUILD" -j"$(nproc)"
    cmake --install "$FI_BUILD"
    printf '%s\n' "$fi_want_stamp" > "$fi_stamp"
else
    echo "bootstrap: in-tree FreeImage already installed — reusing it."
fi

# Where it landed: take the directory from the library itself. It is not
# always $FI_INSTALL/lib — CMAKE_INSTALL_LIBDIR is "lib64" on some 64-bit hosts
# and multiarch on Debian — and the RUNPATH below has to name the real one.
if [ ! -f "$FI_INSTALL/include/FreeImage.h" ]; then
    echo "bootstrap: FreeImage install has no FreeImage.h at $FI_INSTALL/include" >&2
    exit 1
fi
fi_lib="$(find "$FI_INSTALL" \( -iname 'libfreeimage.so*' -o -iname 'libfreeimage.a' \
        -o -iname 'libfreeimage.dll.a' -o -iname 'freeimage.lib' \) \
        -print -quit 2>/dev/null)"
if [ -z "$fi_lib" ]; then
    echo "bootstrap: FreeImage install has no library under $FI_INSTALL" >&2
    exit 1
fi
fi_lib_dir="$(dirname "$fi_lib")"

# 3. Idempotence: an install is a build; don't redo it unless asked.
# This runs *after* FreeImage, because a flag change there (a different
# codec set) has to be able to rebuild without --force; an early exit
# here would never reach that check.
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
# FreeImage, built in step 2: point OGRE's FindFreeImage at that install.
# FindFreeImage derives its search paths from FREEIMAGE_HOME
# (CMake/Packages/FindFreeImage.cmake -> create_search_paths), and OGRE
# prepends CMAKE_PREFIX_PATH for its plain find_path/find_library calls. Both
# are passed so the probe does not depend on the environment, and so that
# reconfiguring an existing build tree keeps finding it.
extra_flags+=(
    "-DFREEIMAGE_HOME=$FI_INSTALL"
    "-DCMAKE_PREFIX_PATH=$FI_INSTALL"
)
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
            # libOgreNextMain.so records a DT_NEEDED on libfreeimage.so.3, and
            # this install sits outside the loader's default path. Bake the
            # directory in as a RUNPATH so every consumer resolves it without
            # environment help: the adapter is dlopen'd by tension-core, the
            # test runner and the example runners alike.
            "-DCMAKE_INSTALL_RPATH=$fi_lib_dir"
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
    # ON, not OFF: step 2 builds FreeImage so the library is there either
    # way, and OFF would leave OGRE with no PNG/JPEG decoder at all —
    # OGRE_NO_FREEIMAGE=1 in OgreBuildSettings.h skips the codec registration
    # in OgreRoot.cpp, while the codec object is still compiled and linked
    # (see step 2). The adapter decodes every texture through
    # Ogre::Image2::load, so OFF means no textures.
    -DOGRE_CONFIG_ENABLE_FREEIMAGE=ON
    -DOGRE_CONFIG_ENABLE_JSON=ON
    -DOGRE_CONFIG_ENABLE_ZIP=ON
)

echo "bootstrap: configuring ($SRC -> $BUILD)"
t0=$(date +%s)
cmake -S "$SRC" -B "$BUILD" "${FLAGS[@]}" "${extra_flags[@]}"

# FreeImage is required (step 2), and the option is a cmake_dependent_option
# ("Enable FREEIMAGE if FreeImage_FOUND, else FALSE"): a probe that comes up
# empty turns the codec off *silently* at configure time. Hold the configure to
# it here instead of discovering a missing texture decoder at run time.
if ! grep -q '^#define OGRE_NO_FREEIMAGE 0' "$BUILD/include/OgreBuildSettings.h"; then
    echo "bootstrap: OGRE's configure did not find FreeImage — the codec is off" >&2
    echo "bootstrap: expected FreeImage.h in $FI_INSTALL/include and a library in $fi_lib_dir" >&2
    echo "bootstrap: (-DFREEIMAGE_HOME=$FI_INSTALL was passed; check the configure output above)" >&2
    exit 1
fi

echo "bootstrap: building with $(nproc) jobs"
cmake --build "$BUILD" -j"$(nproc)"

echo "bootstrap: installing to $INSTALL"
cmake --install "$BUILD"

# 4. The Vulkan plugin is what this build is for — a configure that dropped
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
