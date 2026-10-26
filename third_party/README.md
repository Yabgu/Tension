# third_party — Ogre-Next and FreeImage, from source

`ogre-next/` is a submodule of [Ogre-Next](https://github.com/OGRECave/ogre-next)
pinned at `475f783d76` (2026-09-07). Not the newest release tag: v3.0.0 is
788 commits / 23 months behind, and every existing measurement in this
repository ran against the master commit — the CI packages it
(`ci/ogre-next-pkg/ogre-next-git-r14734.475f783d76-2-*.pkg.tar.zst`), and the
system install is built from it. Moving the pin is a `git checkout <ref>`
inside the submodule plus a commit here.

`freeimage/` is a submodule of [WinMerge/freeimage](https://github.com/WinMerge/freeimage)
pinned at `6bf6929b96` (FreeImage 3.19.25, the fork's `winmerge` branch, which
is its default). That fork is the maintained 3.19.x line with a CMake build;
the upstream SourceForge tree stops at 3.18.0, which is what the fork's own
`master` branch still is. It is a submodule and not a host package because
OGRE cannot be configured without FreeImage either way — see below.

## Bootstrap

    third_party/bootstrap.sh          # configure, build, install (skips if done)
    third_party/bootstrap.sh --force  # reconfigure, rebuild, reinstall

Needs (Arch names, the PKGBUILD's dependency set): `cmake git glslang
spirv-tools vulkan-headers mesa freetype2 glu libxaw libxrandr rapidjson
tinyxml zziplib vulkan-icd-loader`. FreeImage is not on that list — it is
built from `freeimage/` and bundles its own codecs (zlib, libpng, libjpeg,
libtiff, OpenJPEG, webp, libraw, OpenEXR), so no `freeimage` host package is
needed.

It builds into `third_party/ogre-next-build/` and installs into
`third_party/ogre-next-install/`, and builds FreeImage into
`third_party/freeimage-build/` / `third_party/freeimage-install/` — all
four gitignored. FreeImage is built first and its install is handed to
OGRE's `find_package(FreeImage)` (`-DFREEIMAGE_HOME`, `CMAKE_PREFIX_PATH`);
on Linux the OGRE libraries also record it as a `DT_RUNPATH`, so
`libOgreNextMain.so` resolves `libfreeimage.so.3` without
`LD_LIBRARY_PATH` help. There is no equivalent on Windows, where DLLs are
found through `PATH`: put `third_party/freeimage-install/bin` on it before
running the host.

The flag set mirrors the AUR `ogre-next-git` PKGBUILD minus what we do not
use: GL3Plus + Vulkan render systems, the HLMS / Overlay / PlanarReflections /
MeshLod components, no samples, no tests, no docs. Two deliberate changes:
`OGRE_BUILD_TOOLS=ON` (cheap and occasionally useful), and
`OGRE_INSTALL_SAMPLES=ON` — which,
despite the name, is what installs the **Media tree** (the Hlms material
JSONs and `resources2.cfg` the adapter reads; measured: with it off,
`share/OGRE-Next/Media` is absent and the Hlms has no materials to load).
Nothing is built from `Samples/`. A cold configure + build + install takes a
few minutes on 16 cores; the script reports its own timing.

## FreeImage is not optional (upstream build bug)

`OGRE_CONFIG_ENABLE_FREEIMAGE=OFF` does not remove FreeImage from the build,
so neither does it remove the dependency. In `OgreMain/CMakeLists.txt` the
unity-build exclusion list is seeded with `src/OgreFreeImageCodec2.cpp`
unconditionally, and `create_unity_build_files()`
(`CMake/Utils/OgreAddTargets.cmake`) puts that `SEPARATE` list back into the
target even when `OGRE_UNITY_BUILD` is off — outside the `if(OGRE_UNITY_BUILD)`
block. The disable path's `list(REMOVE_ITEM)` names the file by absolute path
while the exclusion list names it relatively, so it cannot cancel it either.

What `OFF` actually does is set `OGRE_NO_FREEIMAGE 1` in `OgreBuildSettings.h`,
which skips the codec *registration* in `OgreRoot.cpp`. The translation unit
is still compiled and linked, and it still needs `FreeImage.h` and the
library. Measured with `OFF` and no FreeImage installed:

    OgreFreeImageCodec2.cpp:48:10: fatal error: FreeImage.h: No such file or directory

— on the target's last object, after the other 295 have built. That is why
bootstrap builds FreeImage regardless, and why the flag is `ON` there: with
`OFF` and the library present, OGRE links but has no PNG/JPEG decoder at all,
and the adapter decodes every texture through `Ogre::Image2::load`.

## Licensing: permissive only

FreeImage is dual-licensed **FIPL-1.0 or GPLv2**, at your choice, and FIPL is
file-level copyleft (it descends from MPL 1.1): §3.7 permits combining it into
a Larger Work and §3.6 permits distributing the executable under a licence of
your choice. Tension stays MIT. What it owes is the FIPL text and a pointer to
the FreeImage source — both automatic here, since the source is this submodule
and `cmake --install` puts `license-fi.txt` in
`freeimage-install/share/licenses/`.

`libfreeimage.so` is not one licence, though: its codecs are compiled in
statically (`DT_NEEDED` is only libc/libstdc++/libm/libgcc). `BUILD_LIBRAWLITE`
is **OFF** deliberately. LibRawLite is LGPL-2.1-or-CDDL-1.0 — the only
copyleft codec in the set — and dropping it removes the election question
entirely. Every remaining bundled codec is permissive: zlib, libpng, IJG
(libjpeg), libtiff, libwebp, libdeflate, OpenJPEG, OpenEXR, Imath, OpenJPH,
Zstd.

The switch is safe because the fork implements it properly:
`Source/FreeImage/PluginRAW.cpp` has an `#else` branch that still defines
`InitRAW` as a stub. That keeps the RAW slot in `FREE_IMAGE_FORMAT` occupied,
so `FreeImage.h`'s compile-time `FIF_*` values stay aligned with the runtime
plugin indices (the fork's own comment cites issue #38). Measured after the
change: `FIF_PNG` is still 13, `FIF_RAW` 34, `FIF_WEBP` 35, extensions correct
for all 40 formats, `FreeImage_FIFSupportsReading(FIF_RAW)` false, zero
`libraw` symbols in the library, and 1.5 MB off its size.

Nothing here reads camera RAW: the loader sniffs PNG/DDS magic and the
adapter hands bytes to `Ogre::Image2`, which never opens a `.CR2`/`.NEF`/`.DNG`.
Turning it back on is one flag in `bootstrap.sh`, and it reinstates the
LGPL-2.1/CDDL choice — elect CDDL if that ever happens, not LGPL-2.1, because
CDDL's larger-work clause avoids LGPL §6 relinking obligations for a
statically-linked library.

Also keep `BUILD_LIBHEIF` and `BUILD_LIBJXL` **OFF** (they default off). The
fork's HEIF stack is libheif + libde265 under LGPL-3.0-or-later, compiled
statically even when FreeImage is shared; its own README states distributors
must then meet LGPL source and relinking obligations. HEIF/AVIF is the one
codec choice that would put a static LGPL-3 library inside the shipped `.so`.

## How the tree prefers it

`tension-ogre/build.sh` uses the in-tree install when
`third_party/ogre-next-install/lib/libOgreNextMain.so` exists; the system
install (pkg-config) remains the fallback, so a contributor who never runs
bootstrap still builds against the distro package. The example and test
runners put `third_party/ogre-next-install/lib` on `LD_LIBRARY_PATH` when it
exists: the in-tree libraries live outside the loader's default path, and the
soname (`libOgreNextMain.so.4.0`) is identical to the system package's — the
path is what decides which one a process gets.

## What it buys

- A pinned, reproducible Ogre-Next: libraries, plugins, headers, media.
- Control of the build: plugin directory, media tree, and the render systems
  the adapter links against.
- The **Vulkan plugin exists and all of its DT_NEEDED entries resolve**
  (`ldd` clean). It cannot load by itself — upstream never links glslang —
  which the adapter now compensates for (see below).

## Vulkan: the measured state (round 21b)

`RenderSystem_Vulkan.so` — the system package's and this build's alike —
references 36 glslang symbols with **no DT_NEEDED for libglslang**: upstream's
`RenderSystems/Vulkan/CMakeLists.txt` links only `${OGRE_NEXT}Main` and the
Vulkan libraries, so both builds leave those symbols undefined. It is an
upstream link-line omission, not a packaging defect. Measured with a raw
loader probe:

    dlopen(RenderSystem_Vulkan.so, RTLD_NOW)  ->  undefined symbol:
                                                  glslang::TProgram::getInfoLog
    dlopen(libglslang.so.16, RTLD_GLOBAL) first, then the plugin  ->  loads

OGRE loads plugins with `RTLD_LAZY | RTLD_LOCAL`, and the binding is eager
for these references, so lazy does not rescue it. The fix therefore lives in
the consumer: `tension-ogre`'s backend calls `ensure_glslang_global()` (a
`dlopen("libglslang.so.16", RTLD_NOW | RTLD_GLOBAL)`) before `Ogre::Root` is
constructed, and only for the Vulkan renderer.

Measured after the change: the plugin loads, the window opens on "Vulkan
Rendering Subsystem", the camera example flies under `TENSION_RENDERER=vulkan`
(handle, input attach and all), and the device is the **AMD Radeon iGPU**
(RADV RENOIR, vendor 0x1002 device 0x1636) — the first device OGRE
enumerates, not the NVIDIA GTX 1660 Ti.

`TENSION_RENDERER` selects the renderer: `auto` (Vulkan → GL3Plus → Null,
tried in order), or a single `vulkan` / `gl3plus` / `null`. Unset, the guest
config's choice is honored. An explicit choice — environment or guest —
refuses rather than silently falling back; only `auto` chains. Every run logs
`ogre: renderer = <name> (source: ...)`.

The readback works (round 21d): the earlier Vulkan crash was the adapter
arming the window download from the guest's thread — on Vulkan that flag
destroys and recreates the swapchain, racing the frame that still held the
old one (`OgreVulkanWindow.cpp:722`). Armed on the render thread, and
normalised to RGBA8 with `PixelFormatGpuUtils::bulkPixelConversion` (the
Vulkan swapchain is BGRA where GL3+ is RGBA), every tier pixel case runs
under Vulkan. One gap remains, documented in `tension-ogre/DESIGN.md` §15: a guest-built
(hand-built v1) mesh renders under GL3+ but not Vulkan — winding, attribute
set, capture timing and the serializer shape are all measured out (round
21g: serializing the hand-built mesh and re-importing it exactly as the
loader does still reads 0 px under Vulkan). The tier's
`procedural-gl3plus` case is GL3Plus-only until further diagnosis.

## What it does not buy

Native Wayland. Ogre-Next 3.0's render systems are X11-only on Linux (GL3Plus
via GLX, Vulkan via XCB); upstream has no Wayland window support and a fork
would be needed to add it. The window stays XWayland. Out of scope here.
