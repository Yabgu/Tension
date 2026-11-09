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
