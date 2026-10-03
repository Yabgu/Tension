# third_party — Ogre-Next, from source

`ogre-next/` is a submodule of [Ogre-Next](https://github.com/OGRECave/ogre-next)
pinned at `475f783d76` (2026-09-07). Not the newest release tag: v3.0.0 is
788 commits / 23 months behind, and every existing measurement in this
repository ran against the master commit — the CI packages it
(`ci/ogre-next-pkg/ogre-next-git-r14734.475f783d76-2-*.pkg.tar.zst`), and the
system install is built from it. Moving the pin is a `git checkout <ref>`
inside the submodule plus a commit here.

## Bootstrap

    third_party/bootstrap.sh          # configure, build, install (skips if done)
    third_party/bootstrap.sh --force  # reconfigure, rebuild, reinstall

Needs (Arch names, the PKGBUILD's dependency set): `cmake git glslang
spirv-tools vulkan-headers mesa freeimage freetype2 glu libxaw libxrandr
rapidjson tinyxml zziplib vulkan-icd-loader`.

It builds into `third_party/ogre-next-build/` and installs into
`third_party/ogre-next-install/` — both gitignored. The flag set mirrors the
AUR `ogre-next-git` PKGBUILD minus what we do not use: GL3Plus + Vulkan
render systems, the HLMS / Overlay / PlanarReflections / MeshLod components,
no samples, no tests, no docs. Two deliberate changes: `OGRE_BUILD_TOOLS=ON`
(cheap and occasionally useful), and `OGRE_INSTALL_SAMPLES=ON` — which,
despite the name, is what installs the **Media tree** (the Hlms material
JSONs and `resources2.cfg` the adapter reads; measured: with it off,
`share/OGRE-Next/Media` is absent and the Hlms has no materials to load).
Nothing is built from `Samples/`. A cold configure + build + install takes a
few minutes on 16 cores; the script reports its own timing.

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
  (`ldd` clean). It still cannot load as shipped by upstream — see below —
  which is exactly the thing a source build lets us fix.

## Vulkan: the measured state (round 21a)

`RenderSystem_Vulkan.so` — the system package's and this build's alike —
references 36 glslang symbols but carries **no DT_NEEDED for libglslang**.
Upstream's `RenderSystems/Vulkan/CMakeLists.txt` links only `${OGRE_NEXT}Main`
and the Vulkan libraries, so both builds leave those symbols undefined (a
shared library links with unresolved symbols by default). Measured with a raw
loader probe:

    dlopen(RenderSystem_Vulkan.so, RTLD_NOW)  ->  undefined symbol:
                                                  glslang::TProgram::getInfoLog
    dlopen(libglslang.so.16, RTLD_GLOBAL) first, then the plugin  ->  loads

OGRE loads plugins with `RTLD_LAZY | RTLD_LOCAL`, and the binding is eager
for these references, so lazy does not rescue it. The fix belongs in the
consumer: the adapter must put `libglslang` into the global scope before it
lets OGRE install the Vulkan plugin. That wiring, plus the backend's Vulkan
render-system names, is next round's work; until then the adapter still
refuses `renderer=vulkan` with `-ENOSYS`.

## What it does not buy

Native Wayland. Ogre-Next 3.0's render systems are X11-only on Linux (GL3Plus
via GLX, Vulkan via XCB); upstream has no Wayland window support and a fork
would be needed to add it. The window stays XWayland. Out of scope here.
