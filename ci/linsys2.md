# Cross-compiling the Windows translation units with LinSYS2

How to compile and validate `RenderSystems/Vulkan/src/Windowing/win32/` on a Linux
host. This is the path used to verify that the Win32 side of
`third_party/patches/ogre-external-surface.patch` actually compiles, rather than
asserting it from a reading of the source.

Measured on 2026-11-07 with `linsys2 r97.20260922.f9edf30`, x86-64 Linux host.

`ci/README.md` covers the Arch container that runs the Linux suites. This is a
different tool: MSYS2's mingw-w64 `ucrt64` environment executed through Wine.

## What LinSYS2 is

`linsys2` runs Windows binaries from an MSYS2/ucrt64 installation inside a Wine
prefix. Two commands matter:

- `linsys2-pacman` — the MSYS2 package manager, so packages land in the MSYS2
  prefix rather than in Arch.
- `linsys2 run -- <program.exe>` — execute a Windows binary with the Wine
  environment configured.

`linsys2 run -- bash` does **not** work. It only launches Windows executables, so
there is no shell in there: invoke `g++.exe`, `cmake.exe` and friends directly.
Linux paths are mapped into the Wine drive namespace automatically
(`/home/x` becomes `Z:/home/x`), so include paths can be written the Linux way.

## Setting up a prefix

```sh
linsys2 init --env ucrt64          # default env; creates/initialises the prefix
linsys2 env                        # prints the resolved paths
```

`init` takes `--prefix` to choose the Wine prefix. The default is
`~/.wine`, **shared with any other Wine application on the machine** — that is a
Wine upgrade risk for the tools other things depend on. If LinSYS2 is used in
CI or on a machine with other Wine workloads, give it its own prefix:

```sh
linsys2 init --env ucrt64 --prefix ~/.local/share/linsys2/wineprefix
```

Layout after init:

- MSYS2 tree: `~/.local/share/linsys2/ucrt64/ucrt64/` (≈1.8 GB)
  - headers: `.../ucrt64/include/`
  - binaries: `.../ucrt64/bin/` (`.exe`)
- Wine prefix: `~/.wine` by default (≈9 GB once it has run)

## Packages

Sync first. `-Sy` is enough when the package set is stable; use `-Syu` when
bumping:

```sh
linsys2-pacman -Syu
linsys2-pacman -Sy mingw-w64-ucrt-x86_64-gcc \
                   mingw-w64-ucrt-x86_64-cmake \
                   mingw-w64-ucrt-x86_64-vulkan-headers
```

Measured package versions on 2026-11-07: `gcc 16.2.0-6`, `cmake 4.4.5-1`,
`vulkan-headers 1~1.4.363.0-1`.

### Gotchas, each of which cost time once

**`gfortran` is not a package.** `mingw-w64-ucrt-x86_64-gfortran` does not exist;
asking for it fails the whole transaction with `target not found`. The compiler
ships inside `mingw-w64-ucrt-x86_64-gcc` and is present after installing it.
Only the *runtime* is separate (`mingw-w64-ucrt-x86_64-libgfortran`).

**`zig` is not in the MSYS2 repositories.** `linsys2-pacman -Ss zig` returns
nothing. Cross-compiling the Zig parts for Windows needs native Linux Zig with
`-target x86_64-windows-gnu`, not MSYS2. Nothing in the C++ validation path
needs it.

**`rust` is available:** `mingw-w64-ucrt-x86_64-rust` (1.99.1-1). Prefer it over
`rustup target add x86_64-pc-windows-gnu` when the goal is to match what an
MSYS2-based CI image will use.

**Vulkan headers are a package, not something to copy.** Use
`mingw-w64-ucrt-x86_64-vulkan-headers`. It installs `vulkan/` and `vk_video/`
into the MSYS2 prefix include directory, which is already on mingw's default
search path — verified with `g++.exe -E -v`, which lists
`.../ucrt64/bin/../../ucrt64/include`. **No `-I` is needed for Vulkan at all.**
Copying headers into a scratch directory is unnecessary and does not survive a
clean machine.

**Never add `-I/usr/include`.** That is the Linux libc. mingw's headers and
glibc's collide immediately, and the first error is a `uintptr_t` redefinition in
`corecrt.h` versus `stdint.h`, which sends you looking at the wrong problem. If a
Linux path is genuinely needed, copy only the specific directory.

**`-DWIN32` / `-D_WIN32` are unnecessary.** The mingw driver defines the platform
macros. Adding them by hand is harmless but invites the idea that the platform
selection is manual.

## The generated header problem

`OgreVulkanBuildSettings.h` is produced by CMake *configure*, not installed as a
package, so a build tree carries the **host's** platform choice. The Linux build
tree at `third_party/ogre-next-build/` defines `OGRE_VULKAN_WINDOW_XCB`;
compiling a `Windowing/win32/` translation unit against that selects the wrong
backend.

A checked-in Win32 copy lives at:

```
third_party/patches/win32-headers/OgreVulkanBuildSettings.h
```

Put it **earlier** on the include path than `third_party/ogre-next-build/include`.
The rest of the generated headers come from the Linux build tree unchanged,
because they are platform-neutral: `OgreBuildSettings.h` carries feature flags
only (verified — no `WIN32`/`LINUX`/`APPLE`/`ANDROID`/`PLATFORM` define appears in
it). `OgreVulkanBuildSettings.h` is the only generated header whose contents vary
by platform, and it varies in one way: which of its five `OGRE_VULKAN_*` symbols
is defined.

A checked-in copy of a generated file goes stale silently, so it is guarded:

```sh
node scripts/check-win32-headers.mjs
```

This compares the overlay's symbol list against the `#cmakedefine` lines in
`third_party/ogre-next/CMake/Templates/OgreVulkanBuildSettings.h.in` in both
directions and fails if upstream added, removed or renamed a symbol. It runs as
the `win32-headers` suite in `npm test`, so it needs no Windows toolchain to
catch drift. Run it after every ogre-next pin bump.

`OgreGL3PlusBuildSettings.h` has the same shape and has **no** Win32 overlay yet.
Nothing compiles a GL3Plus Win32 TU today; if that changes, the overlay is
needed first.

## Compiling a Win32 translation unit

From `third_party/ogre-next`, with the repository root as `$REPO`:

```sh
linsys2 run -- g++.exe -c \
  RenderSystems/Vulkan/src/Windowing/win32/OgreVulkanWin32Window.cpp \
  -o /tmp/OgreVulkanWin32Window.o \
  -DRenderSystem_Vulkan_EXPORTS -DNDEBUG \
  -Wall -Winit-self -Wcast-qual -Wwrite-strings -Wextra -Wno-unused-parameter \
  -Wshadow -Wimplicit-fallthrough -Wsuggest-override -Wno-unused-but-set-parameter \
  -O3 -std=c++17 \
  -I"$REPO/third_party/patches/win32-headers" \
  -IRenderSystems/Vulkan/include -IOgreMain/include \
  -I../ogre-next-build/include -I.
```

Notes:

- Flag set mirrors `RenderSystem_Vulkan`'s own
  (`third_party/ogre-next-build/RenderSystems/Vulkan/CMakeFiles/RenderSystem_Vulkan.dir/flags.make`),
  minus the GNU-only `-fPIC`/`-fvisibility` and the `-pthread`/`-msse` bits MSVC
  would not understand either.
- `-I` order matters. The overlay must precede `../ogre-next-build/include`.
- The compile is object-only (`-c`). There is no Win32 link step: linking needs
  Windows import libraries and a staged DLL closure, which is what a real Windows
  build produces and this validation does not attempt.

Expected result: exit 0, with two warnings that are upstream's, not ours —
`Windowing/win32/OgreVulkanWin32Window.h:87` (a `getCustomAttribute` override not
marked `override`) and `OgreVulkanWin32Window.cpp:254` (an int-to-pointer cast).
If those two disappear, the pin moved; if more appear, the patch changed
behaviour.

### Known gap: the adapter needs a Vulkan plugin header on Win32

The TU above compiles Ogre's own source. `tension-ogre` itself is a different
problem: `tension-ogre/src/backend_ogre.cpp` includes `<OgreVulkanDevice.h>` to
name `Ogre::VulkanExternalInstance` rather than mirror it, and on Linux that
resolves through
`third_party/ogre-next-install/include/OGRE-Next/RenderSystems/Vulkan/include/`
— a path `tension-ogre/CMakeLists.txt` finds with `find_path`.

A Win32 build of the adapter has neither half of that today:

- the install tree is the Linux one, so the header is there but comes from a
  Linux configure, and
- the checked-in overlay (`third_party/patches/win32-headers/`) carries only
  `OgreVulkanBuildSettings.h`, which Ogre's own headers include, not
  `OgreVulkanDevice.h`, and not the `vulkan/vulkan_core.h` that header pulls in.

Documented, not fixed. Closing it means either a Win32 `find_path` entry
pointing at the pacman-installed `mingw-w64-ucrt-x86_64-vulkan-headers` include
dir plus the plugin's own header dir, or extending `check-win32-headers.mjs` to
verify a second header. Nothing compiles `tension-ogre` for Win32 today, so this
is a gap in the platform story rather than a broken build.

## Caching in CI

Both trees are large and stable between runs, so cache them separately:

| path | size | invalidate on |
| --- | --- | --- |
| `~/.local/share/linsys2` | ≈1.8 GB | `linsys2` version, package set |
| `~/.wine` (or the custom prefix) | ≈9 GB | Wine version, prefix recreation |

Key the first on the `linsys2` release string (`linsys2 --version`) plus the
explicit package list; a floating `-Syu` on a cache hit would make the cache
meaningless. Key the second on the Wine version. If the prefix is given its own
`--prefix`, cache that path instead — and note that a warm Wine prefix is what
makes the first `g++.exe` invocation fast; a cold one pays prefix creation once.

## What this does not cover

- **Android.** The `Windowing/Android/` translation unit needs an NDK for
  `<android/native_window.h>`, which is not present on this machine and is not an
  MSYS2 package. It remains compile-unverified.
- **Linking.** Object compilation proves the C++ is valid for the platform. It
  says nothing about whether the resulting DLL would link or run.
- **`cmake.exe`.** Installed and runnable, but a full Win32 Ogre-Next configure
  is not attempted: it needs a Win32 Vulkan SDK, shaderc and glslang, which
  `scripts/bootstrap.mjs` only assembles on a native Windows host. The overlay
  above is what makes configure unnecessary for validating one translation unit.
