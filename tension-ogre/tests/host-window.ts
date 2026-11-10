// The window a windowed fixture needs, created by the guest.
//
// Before the programmatic window API, `renderer=gl3plus` meant "Ogre, make
// yourself a window" — the adapter's `auto` fallback. That fallback is gone:
// since E1a there is no path in the backend that creates a window, because a
// window is the guest's to create and the host's to own. So a fixture that wants
// pixels creates the host's window itself, exactly as a game would.
//
// `Vulkan` and not `Gpu`: Ogre consumes the host's `VkSurfaceKHR`
// (`host_surface`), and `SDL_Vulkan_CreateSurface` requires a window created
// with `SDL_WINDOW_VULKAN`. The host publishes the surface inside
// `createWindow`, so the `ogre.init` that follows finds it.
//
// ── the two-window defect, recorded rather than fixed ────────────────────
//
// Under `--renderer=gl3plus` this helper still creates the host's window, and
// **GL3+ creates a second one**. Only the second is used: the GL3+ plugin
// cannot consume a `VkSurfaceKHR` — `third_party/patches/ogre-external-surface.patch`
// touches `RenderSystems/Vulkan/*` only — so it ignores the parameter and calls
// `createRenderWindow`, which opens its own GLX window. The pixel clauses
// screenshot that one, which is why the cases pass and prove "GL3+ renders"
// rather than "one window".
//
// It is left as-is because the fix is measured-correct up to teardown and then
// the process crashes, here, deterministically:
//
//   1. **Skipping the host window is not enough.** `ogre::init` refuses
//      `-ENODEV` when `target=auto` has no host surface
//      (`tension-ogre/src/adapter.cpp`, "target=auto requires a host window"),
//      and it does so without looking at which render system was asked for. A
//      GL3+ case that creates no window fails at init.
//   2. **Narrowing that refusal to the render systems that can adopt a surface
//      works, and then teardown crashes.** With the check narrowed to Vulkan
//      (GL3+ may open its own window under `auto`; `swapchain` and Vulkan stay
//      strict) one window opens and every pixel clause still passes —
//      `ACID 8/8 passed`, same pixels — and the process dies with SIGSEGV at
//      exit. 20 of 20 runs on the previous pass, 3 of 3 re-measured.
//
// ── which code dies, and why it is not ours ──────────────────────────────
//
// The first version of this note blamed llvmpipe's JIT. That was wrong, and the
// correction is what makes the next attempt cheap:
//
//   * The faulting thread is **fresh**, not the render thread's stack: its
//     backtrace ends at libc's `start_thread` and `rax == rip` — an indirect
//     jump into an address with no mapping. A thread spawned during teardown
//     runs code that has already been unmapped.
//   * `LD_DEBUG=files` ends the unload cascade at the **WSL D3D12 driver**:
//     `RenderSystem_GL3Plus` → `libGLX_mesa` → `libgallium-26.2.6` →
//     `libd3d12` → `libd3d12core` → the AMD shader compiler (`amdxc64.so`).
//   * Not llvmpipe: under `LIBGL_ALWAYS_SOFTWARE=1` or `GALLIUM_DRIVER=llvmpipe`
//     the same own-window path exits 0.
//   * Not a race with compile threads: 800 ms of sleep before
//     `root_->shutdown()` changes nothing (3 of 3 still crash).
//   * It **is** that driver: preloading `libd3d12core.so`, `libd3d12.so` and
//     `amdxc64.so` with `RTLD_NODELETE`, so teardown cannot unmap them, makes
//     the own-window path exit 0 — 3 of 3, one window. Preloading
//     `libgallium`/`libGLX_mesa`/`libGL` the same way does not help.
//
// The driver spawns a thread into code it is in the middle of unloading, after
// `destroyRenderWindow`, inside the DSO's own teardown. No Ogre toggle reaches
// it: the D3D12 chain is dropped by the GL context's destruction, not by Ogre's
// plugin unload.
//
// Two ways out, both larger than this fixture:
//
//   a. Keep the driver resident for the process lifetime once a GPU renderer is
//      up (Linux: `RTLD_NODELETE` on the loader's driver DSOs). Removes the
//      hazard for every driver, and adds engine policy for a driver bug.
//   b. Remove the own-window path instead of making it quiet: publish a surface
//      GL3+ can adopt, so the GL3+ cases use the host's window as Vulkan's do.
//      That is the GL-surface publication pass, not a fixture change.
//
// Until one lands the second window stays, and the cases keep testing what they
// were built to test.
//
// Reads `--renderer=` itself rather than taking a parameter: every fixture parses
// its own arguments slightly differently, and a helper that answers one question
// should not need to be threaded through fourteen of them.

import { arg, argCount } from "../../tension-framework/assembly/io";
import * as platform from "../../tension-framework/assembly/platform";

/**
 * Create the host's window if this run is windowed and does not have one.
 *
 * Returns `true` when the renderer has a window to adopt *or* needs none — the
 * NULL renderer case, and the case where a previous call already made one.
 * Returns `false` only when a window was wanted and the host refused, which is a
 * fixture failure rather than a skip: the pixel clauses would otherwise run
 * against nothing.
 */
export function ensureHostWindow(width: i32, height: i32): bool {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
    // A fixture that names a target or expects a refusal is *testing* target
    // behaviour, so it owns the decision: creating a window here would satisfy
    // the very requirement the case exists to see refused.
    if (value.startsWith("--target=") || value == "--expect-init-refusal") return true;
  }
  // The NULL render system has no window to adopt; `metal` is refused by the
  // backend for its own reasons and must not be turned into a window request.
  if (renderer == "null" || renderer == "metal") return true;
  // Already there — a fixture that initialises two renderers in one process
  // (the resource-async drop case) must not try to create a second window.
  if (platform.hasSurface()) return true;

  const config = new platform.WindowConfig();
  config.target = platform.WindowTarget.Vulkan;
  // The fixture's own canvas size: the renderer adopts the host's size, so this
  // is what makes its frame the size its pixel clauses assert. The adapter's
  // `windowSize` is then ignored on this path — the host's window wins, which is
  // the ownership rule made visible.
  config.width = <u32>width;
  config.height = <u32>height;
  config.title = "tension-ogre test";
  const window = platform.createWindow(config);
  return window.isValid();
}
