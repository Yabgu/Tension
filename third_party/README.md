# third_party — Ogre-Next, from source

`ogre-next/` is a submodule of [Ogre-Next](https://github.com/OGRECave/ogre-next)
pinned at `475f783d76` (2026-09-07). Not the newest release tag: v3.0.0 is
788 commits / 23 months behind, and every existing measurement in this
repository ran against the master commit — the CI packages it
(`ci/ogre-next-pkg/ogre-next-git-r14734.475f783d76-2-*.pkg.tar.zst`), and the
system install is built from it. Moving the pin is a `git checkout <ref>`
inside the submodule plus a commit here.

`ogre-next/` is the only submodule in this tree. FreeImage used to be a second
one; it was removed — see "FreeImage is gone" below.

## Bootstrap

    npm run bootstrap                  # configure, build, install (skips if done)
    node scripts/bootstrap.mjs --force  # reconfigure, rebuild, reinstall

`npm run build` runs the first form itself when `third_party/ogre-next-install`
is missing or incomplete, then continues. The command is still the way to run
the step on its own or to force a rebuild.

It is `scripts/bootstrap.mjs`, not a shell script: `npm run build` runs the same
steps on every platform, and the platform differences (MSYS2's UCRT64 for the
GNU compilers on Windows, glslang discovery by `pkg-config` or by an installed
header on Linux) live inside it.

Needs (Arch names, the PKGBUILD's dependency set): `cmake git glslang
spirv-tools vulkan-headers mesa freetype2 glu libxaw libxrandr rapidjson
tinyxml zziplib vulkan-icd-loader`. No image-codec package appears on that
list and none is needed: STBI is compiled into `OgreNextMain` itself and is
the only codec this build has (see below).

It builds into `third_party/ogre-next-build/` and installs into
`third_party/ogre-next-install/` — both gitignored. That is the whole
dependency tree: there is no second install to find. On Linux the install's
own `lib` directory is baked in as the `DT_RUNPATH`, so `libOgreNextMain.so`
and the plugins resolve their siblings without `LD_LIBRARY_PATH` help.

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

## FreeImage is gone; upstream assumes it is there

This tree builds Ogre-Next **without** FreeImage. There is no
`third_party/freeimage` submodule, no install of one, and
`scripts/bootstrap.mjs` passes `-DOGRE_CONFIG_ENABLE_FREEIMAGE=OFF` beside
`-DOGRE_CONFIG_ENABLE_STBI=ON` (`bootstrap.mjs:420-421`). STBI — vendored
inside Ogre-Next under `OgreMain/src/stbi/`, public domain — is the only
image codec the build has.

`OFF` alone is not enough, because upstream seeds the unity-build exclusion
list in `OgreMain/CMakeLists.txt` with `src/OgreFreeImageCodec2.cpp`
unconditionally, and `create_unity_build_files()`
(`CMake/Utils/OgreAddTargets.cmake`) puts that `SEPARATE` list back into the
target even when `OGRE_UNITY_BUILD` is off — outside the `if(OGRE_UNITY_BUILD)`
block. The disable path's `list(REMOVE_ITEM)` names the file by absolute path
while the exclusion list names it relatively, so it cannot cancel it either.
What `OFF` does is set `OGRE_NO_FREEIMAGE 1` in `OgreBuildSettings.h`, which
skips the codec *registration* in `OgreRoot.cpp`; the translation unit is
still compiled and linked, and it still needs `FreeImage.h`. Measured with
`OFF` and no FreeImage installed:

    OgreFreeImageCodec2.cpp:48:10: fatal error: FreeImage.h: No such file or directory

— on the target's last object, after the other 295 have built.

`third_party/patches/ogre-no-freeimage-codec.patch` guards that line on
`if (OGRE_CONFIG_ENABLE_FREEIMAGE)`, so the translation unit is never added to
the target and the build completes without FreeImage. `bootstrap.mjs` applies
it before configuring and reverts it afterwards; the patch table in
[`docs/build.md`](../docs/build.md) §4 is the reference.

STBI is therefore not optional either. It defaults to `FALSE` upstream
(`CMakeLists.txt:556`), and with both codecs off the build still succeeds but
no PNG/JPEG/TGA loads — every texture through `Ogre::Image` fails at runtime.
`tension-ogre/tests/probe_stbi_codec.cpp` exists because a build with no codec
at all once passed the whole suite.

## Licensing: the election FreeImage forced, and no longer does

Removing FreeImage removed the only licence election in this tree's native
stack. FreeImage is dual-licensed **FIPL-1.0 or GPLv2**, FIPL being
file-level copyleft descended from MPL 1.1, and its codec set was not
uniform: LibRawLite is LGPL-2.1-or-CDDL-1.0, and the HEIF stack is
LGPL-3.0-or-later — both compiled in statically even when the library was
shared. Staying permissive therefore meant per-codec flags
(`BUILD_LIBRAWLITE=OFF`, `BUILD_LIBHEIF`/`BUILD_LIBJXL` off) rather than one
decision, and a contributor could reinstate a copyleft obligation by flipping
one of them.

None of that survives the removal. STBI is public domain — its header says so
in the first line (`OgreMain/src/stbi/stb_image.h`: "stb_image - v2.27 -
public domain image loader") — so the codec the tree actually compiles in
carries no notice to reproduce and no election to make. Tension stays MIT.

If FreeImage is ever brought back, the flags above are the ones to re-check,
and CDDL is the correct election for LibRawLite rather than LGPL-2.1: CDDL's
larger-work clause avoids LGPL §6 relinking obligations for a statically
linked library.

## How the tree prefers it

`scripts/build-native.mjs` uses the in-tree install when
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
under Vulkan. One gap remains: a guest-built
(hand-built v1) mesh renders under GL3+ but not Vulkan — winding, attribute
set, capture timing and the serializer shape are all measured out (round
21g: serializing the hand-built mesh and re-importing it exactly as the
loader does still reads 0 px under Vulkan). The tier's
`procedural-gl3plus` case is GL3Plus-only until further diagnosis.

## What it does not buy

Native Wayland. Ogre-Next 3.0's render systems are X11-only on Linux (GL3Plus
via GLX, Vulkan via XCB); upstream has no Wayland window support and a fork
would be needed to add it. The window stays XWayland. Out of scope here.
