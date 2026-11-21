# WB1 — make the Windows native build reproducible

Round: **WB1 — a build that works on a fresh machine, not one that works on this
one.** 2026-11-21. Branch `wb1/native-build` (off `main` `56ddabb`). Nothing
pushed; `main` untouched.

## Phase 0 — inventory before any change

```
git -C C:\work\Tension rev-parse HEAD         8e63bd36… (was on w3/prologue-end; branched from main)
git -C C:\work\Tension rev-parse --abbrev-ref HEAD   w3/prologue-end -> wb1/native-build
git -C C:\work\Tension status --short          (empty)
main                                           56ddabb

node --version         v26.12.1
cmake --version        cmake version 4.4.4
ninja --version        1.13.2
g++ --version          g++.exe (MinGW-W64 x86_64-ucrt-posix-seh, built by Brecht Sanders, r3) 16.2.0
rustc --version        rustc 1.99.0 (b940084d7 2026-09-28)
cargo --version        cargo 1.99.0 (5f94df478 2026-08-27)

$MSYSTEM               UCRT64
pacman -Q | wc -l      391
mingw-w64-ucrt-x86_64-sdl3       3.4.20-1
mingw-w64-ucrt-x86_64-freetype   2.15.0-1
mingw-w64-ucrt-x86_64-rapidjson  1.1.0-8
mingw-w64-ucrt-x86_64-zlib       1.4-2
```

**The four packages the failing log called missing were already installed.**
`C:\msys64\ucrt64\include\rapidjson\document.h` and friends are on disk. What was
missing was not a package: the build was looking for them with a different
`pkg-config`.

Vulkan: `VULKAN_SDK` was **empty in the build shell**, and the machine value is
`C:\VulkanSDK\1.4.363.0`. The shell predated the installer. OGRE's `FindVulkan`
reads `$ENV{VULKAN_SDK}` and nothing else, so CMake found the SDK only by
leftover cache state, not by search.

The failing command and its log: `npm run build`, saved at
`%TEMP%\wb1-build-fail.txt`. First error, byte for byte:

```
C:/work/Tension/third_party/ogre-next/RenderSystems/Vulkan/src/OgreVulkanRootLayout.cpp:47:10: fatal error: rapidjson/document.h: No such file or directory
```

## Phase 1 — what the engine actually needs on Windows

**The render system: Vulkan, and only Vulkan.** `tension-ogre/src/backend_ogre.cpp:246-253`
maps the renderer id to a plugin; the engine's windowed path asks for Vulkan.
Measured on the built engine (`examples/ogre/hello-triangle`, windowed):

```
core: create_window: 640x480 target=Vulkan on 'windows' (SDL 3.4.20)
ogre: renderer = vulkan (source: guest config)
ogre: Vulkan plugin loading with the host's instance (2 extension(s), no layers)
ogre: window "Tension" 640x480 created (Vulkan Rendering Subsystem)
```

The host also creates the Vulkan instance and surface itself
(`tension-core/src/platform.rs`), so Vulkan is not a plugin choice that could be
swapped out at build time: without it there is no renderer and no surface.
**D3D11 is already `OFF`** in the bootstrap's flags; GL3Plus is still built but
the engine does not select it on this platform. So the fix may not disable
Vulkan, and rapidjson (which only the Vulkan root-layout parser needs) is not
dead weight.

**The `FALSE` / `/opt OFF` lines mean "not installed", not "not built".**
`third_party/ogre-next/CMake/Utils/OgreConfigTargets.cmake:92` is
`ogre_install_target(TARGETNAME SUFFIX EXPORT)`; `EXPORT` is the third argument,
so `FALSE` (for components) and `/opt` (the plugins' install subdirectory, a
string and therefore truthy-ish but not the export flag) are simply the value
passed at those call sites. `OgreNextHlmsPbs FALSE` and
`OgreNextHlmsUnlit FALSE` still install — the engine's PBS/Unlit material
libraries are present in `third_party/ogre-next-install/lib/Release/` and the
adapter links `OgreNextHlmsUnlit`/`OgreNextHlmsPbs` from it. Nothing is missing.

**Which optional packages matter:** only three of the eighteen probed change
anything on this build, and OGRE gates each behind `cmake_dependent_option`
(`CMakeLists.txt:503`, `:557`, `:565`) — so a missing one removes a component
*silently*:

- `freetype2` → `OGRE_BUILD_COMPONENT_OVERLAY` (the text overlay). Present.
- `Rapidjson` → Hlms JSON materials **and** the Vulkan root layout. Blocking.
- `zzip-zlib-config` → `OGRE_CONFIG_ENABLE_ZIP` (ZIP resource locations).
  Unsatisfiable from MSYS2 (see Phase 4); Tension reads ECMA-208 paks, not zips,
  so this one is genuinely unused here.

The rest (`FreeImage`, `DearImgui`, `RenderDoc`, `AMDAGS`, `OpenVR`, `Remotery`,
`POCO`, `TBB`, `GLSL_Optimizer`, `HLSL2GLSL`, `SDL2`, `TinyXML`, `CppUnit`,
`wxWidgets`) gate features this engine does not use, or are FreeImage which this
tree deliberately removed (STBI replaced it).

## Phase 2 — the fix

Two defects, one shape: **things that are installed were invisible.**

**(a) The wrong `pkg-config`.** CMake's `find_program` took the first
`pkg-config`/`pkgconf` on `PATH`. On this machine that is WinLibs'
`pkgconf.exe` (present because it supplies `gfortran` and `cc.exe` for the Rust
build script). Measured: it lists **6** packages. MSYS2 UCRT64's
`pkg-config.exe` lists **238**. Every dependency OGRE probes for is in the
difference.

Fixed by pinning the executable in the configure — the same binary the
project's own toolchain layer already resolves:

```
-DPKG_CONFIG_EXECUTABLE=C:/msys64/ucrt64/bin/pkg-config.exe
```

and, on Windows, naming MSYS2's two `pkgconfig` directories in the child's
`PKG_CONFIG_PATH` so the search path is a stated fact rather than a property of
where the binary sits.

**(b) The Vulkan SDK, invisible to a shell opened before it was installed.**
`bootstrap.mjs` now discovers it (`$VULKAN_SDK`, then the
`C:\VulkanSDK\<version>` layout the installer leaves) and hands it to OGRE's own
`OGRE_VULKAN_SDK` cache variable. It is **blocking**: a machine without it gets
an error naming the download page *before* the configure, instead of a build that
succeeds and ships an engine with no renderer.

**(c) The same SDK, one layer up.** OGRE's install carries the plugin's headers
but not the SDK's, and `OgreVulkanQueue.h:37` includes `<vulkan/vulkan_core.h>`.
The adapter therefore needs the SDK too — a prerequisite of the *adapter*, not of
OGRE, which is why it only surfaced after a successful six-minute OGRE build:

```
packages/ogre-next-win32-x64/include/OGRE-Next/RenderSystems/Vulkan/include/OgreVulkanQueue.h:37:10:
fatal error: vulkan/vulkan_core.h: No such file or directory
```

Fixed by a `TENSION_VULKAN_SDK` cache variable in `tension-ogre/CMakeLists.txt`,
passed by `build-native.mjs` (the real adapter path) and `build-ogre.mjs` (the
standalone one). Discovery lives in `scripts/lib/toolchain.mjs` — one function,
three callers, so they cannot disagree about which SDK is in play.

**No third-party code vendored, no `third_party/ogre-next` source changed, no
render system disabled.**

## Phase 3 — the failure is legible now

`scripts/bootstrap.mjs` gained `--requirements` (report and exit) and a
pre-flight that runs **before CMake configures**, both reading
[`scripts/prerequisites.json`](prerequisites.json) — the same file the docs point
at, so the declaration and the check cannot drift.

**Passing:**

```
bootstrap: prerequisites for win32/x64
  Rapidjson          present 1.1.0                                blocking     Hlms JSON materials and the Vulkan root layout
  freetype2          present 26.7.20                              feature gap  OGRE_BUILD_COMPONENT_OVERLAY (the text overlay)
  zzip-zlib-config   MISSING - no MSYS2 package provides it       feature gap  ZIP resource locations (OGRE_CONFIG_ENABLE_ZIP)
  Vulkan SDK         present C:/VulkanSDK/1.4.363.0               blocking     RenderSystem_Vulkan and the host's Vulkan surface
```

**Failing** — produced by actually removing the package
(`pacman -R mingw-w64-ucrt-x86_64-rapidjson`), not by faking it:

```
bootstrap: warning: zzip-zlib-config is not installed — ZIP archive resource locations are switched off silently
bootstrap:          no MSYS2 package provides it: ...
bootstrap: missing prerequisites for win32/x64
bootstrap:   Rapidjson          → pacman -S mingw-w64-ucrt-x86_64-rapidjson
bootstrap:                        Hlms JSON materials and the Vulkan root layout; without it the build fails: rapidjson/document.h not found
bootstrap: run the commands above, then this script again.
```

Exit 1, **before** the configure — the earlier behaviour was exit 1 about two
hundred objects later with a header path and no package name. The package was
then reinstalled and the check re-run passing.

The check asks the same `pkg-config` CMake is told to use, so the two cannot
disagree about whether a package is present.

## Phase 4 — the rest of the gap

| package | needed by | engine feature affected | blocking? |
|---|---|---|---|
| `Rapidjson` | OGRE Vulkan root layout + Hlms JSON materials | Hlms JSON materials; the Vulkan renderer's root layout | **yes** — build fails |
| `Vulkan SDK` | OGRE `RenderSystem_Vulkan`, the adapter's `#include <vulkan/vulkan_core.h>`, the host's own instance/surface | every windowed frame | **yes** — no renderer at all |
| `freetype2` | `OGRE_BUILD_COMPONENT_OVERLAY` | text overlay | no — component silently dropped |
| `zzip-zlib-config` | `OGRE_CONFIG_ENABLE_ZIP` | ZIP resource locations | no — and **unsatisfiable from MSYS2**: `zziplib` installs `zziplib.pc` (plus four `zzip*.pc` siblings), never `zzip-zlib-config.pc`, which is the name OGRE probes. Verified with `mingw-w64-ucrt-x86_64-zziplib 0.13.80-1` installed and OGRE still writing `OGRE_NO_ZIP_ARCHIVE 1`. Tension reads ECMA-208 paks (`tension-res`), not zips. |
| `FreeImage` | OGRE's codec | none — this tree replaced it with STBI deliberately | no |
| `DearImgui` | `OGRE_BUILD_COMPONENT_DEAR_IMGUI` | editor debug UI | no |
| `RenderDoc` | `OGRE_CONFIG_RENDERDOC_INTEGRATION` | programmatic frame capture | no |
| `AMDAGS` | D3D11 vendor extensions | none — D3D11 is `OFF` | no |
| `OpenVR` | VR | none | no |
| `Remotery` | profiling | none | no |
| `POCO` | OGRE's own samples/tools | none | no |
| `TBB` | `OGRE_CONFIG_ENABLE_TBB_SCHEDULER` | scheduler backend (std is used) | no |
| `GLSL_Optimizer`, `HLSL2GLSL` | GLES2 shader paths | none — GLES is off | no |
| `SDL2` | OGRE's sample windows | none — the host owns the window | no |
| `TinyXML`, `CppUnit`, `wxWidgets` | OGRE samples/tests/tools | none — samples and tests are `OFF` | no |

The two non-blocking gaps that a person could otherwise mistake for working
(`freetype2`, `zzip`) are now named at build time as warnings; the rest are
inert here.

## Phase 5 — proof

1. **`npm run build` exits 0.** Log: `%TEMP%\wb1-final-build.log`.
2. **A second `npm run build`: 151 s, and no OGRE work at all** — `bootstrap:`
   produced **0** lines and `Configuring OGRE` **0** lines; the time is the
   adapter's reconfigure plus the Rust/guest builds. (The first full build after
   a clean tree was 186 s because the adapter had to compile.)
3. **The example runs end to end** — `examples/io`, `npm start`, exit 0:

```
=== TensionCore demo game ===
Arguments passed to the game:
  count = 3
  arg[0] = "alpha"
  arg[1] = "beta"
  arg[2] = "gamma"

Say something and press enter:
You said: hello from the terminal
--- end ---
```

4. **The pre-flight, failing and passing** — Phase 3 above.
5. **The renderer survives** — no render system was disabled, and the Vulkan path
   was measured working after the fix (`hello-triangle`, windowed, logs in
   Phase 1). `third_party/ogre-next-install/bin/Release/` carries
   `RenderSystem_Vulkan.dll` (1,358,161 bytes), `RenderSystem_GL3Plus.dll` and
   `RenderSystem_NULL.dll`.

## Files changed

- `scripts/prerequisites.json` (new) — the machine-readable list, one source for the check and the docs.
- `scripts/bootstrap.mjs` — pin `PKG_CONFIG_EXECUTABLE`, `PKG_CONFIG_PATH`; discover and require the Vulkan SDK; pre-flight and `--requirements`; warn on the two silently-dropped components.
- `scripts/lib/toolchain.mjs` — `findVulkanSdk()`, shared by all three callers.
- `scripts/build-native.mjs` — pass `TENSION_VULKAN_SDK` to the adapter configure.
- `scripts/build-ogre.mjs` — the same, for the standalone adapter path.
- `tension-ogre/CMakeLists.txt` — the `TENSION_VULKAN_SDK` cache variable and its include directory.
- `AGENTS.md` — the Windows prerequisites section now names `--requirements`, the Vulkan SDK, and the pkg-config hazard.
- `package.json`, `package-lock.json` — rewritten by the project's own `npm run compiler:vendor` (the W1 re-vendor mismatch blocked `build:framework`; the brief allows fixing this because it blocked the build). No script lines changed.

## What this round did not do

- No compiler (`TensionScript`) source change.
- No debugger work; no conformance run.
- No `third_party/ogre-next` source change — the bootstrap's own patches are
  applied for the build and reverted after, as designed; `git status` in the
  submodule is clean.
- No render system disabled; nothing made optional to get green.
