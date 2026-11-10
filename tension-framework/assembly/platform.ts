// The guest's half of the window-control bus: `tension::platform`.
//
// The host owns the window. This module is how a guest asks for it to change —
// there is no other path, and deliberately no callback path in this ABI
// version: a guest learns the result by **polling** `surfaceWidth()` /
// `surfaceHeight()`, the same shape `tension::input.state` and `.pad` already
// use. The alternative, a control callback, is the v7 dispatcher and is not
// here.
//
//   if (platform.hasSurface() && platform.surfaceWidth() < 800) {
//     platform.resize(800, 600);
//   }
//   // …next frame, or later in the same one after the host drains:
//   const w = platform.surfaceWidth();   // 800, once the window system agreed
//
// **`control` returns "queued", not "applied".** The host drains its queue once
// per frame, on the thread that owns the window, because SDL's window API is
// not thread-safe and this is wasm. So a resize requested in frame N is
// normally visible in frame N+1. Code that resizes and then immediately reads
// the size back in the same frame will see the old value — correctly.
//
// **0 means "the host owns no window".** `surfaceWidth()` and `surfaceHeight()`
// return 0 when the process ran without `--window`, which is the default.
// `hasSurface()` exists so callers do not have to spell that comparison
// themselves: a real window is never 0-sized, but a zero comparison reads like a
// bug to the next person.
//
// This is the *window* question, not the Vulkan question. Whether the host has
// created a `VkSurfaceKHR` is a renderer's business and is invisible here, on
// purpose: a guest asking how big its window is must not depend on whether
// something has claimed the surface for swapchain work.
//
// Scope: RESIZE is the only *control* kind, and it is the mutation path a
// layer takes. Window creation is not a control message: the guest calls
// `createWindow` and the host creates it synchronously, because the guest's next
// instruction may claim the window for a renderer and a queued creation would be
// a frame too late.

// The launcher's arguments: `windowRequest()` reads them, and it is the only
// reader in this file. `io` imports nothing, so there is no cycle.
import { arg, argCount, print } from "./io";

/** `tension::platform.control(kind, a0, a1, a2, a3) -> i32`. */
@external("tension::platform", "control")
declare function controlRaw(kind: u32, a0: i32, a1: i32, a2: i32, a3: i32): i32;

/** `tension::platform.surface_width() -> u32`. */
@external("tension::platform", "surface_width")
declare function surfaceWidthRaw(): u32;

/** `tension::platform.surface_height() -> u32`. */
@external("tension::platform", "surface_height")
declare function surfaceHeightRaw(): u32;

/** `tension::platform.create_window(cfgPtr, cfgLen) -> i32`: the window id, or
 *  a negative errno. */
@external("tension::platform", "create_window")
declare function createWindowRaw(cfgPtr: u32, cfgLen: u32): i32;

/** `tension::platform.close_window(id) -> i32`. */
@external("tension::platform", "close_window")
declare function closeWindowRaw(id: u32): i32;

/** `tension::platform.window_info(id, outPtr) -> i32`. */
@external("tension::platform", "window_info")
declare function windowInfoRaw(id: u32, outPtr: u32): i32;

/** The control kinds this ABI defines (`tension_ctrl_kind`). */
export enum ControlKind {
  /** `a0` = width, `a1` = height. Clamping is the host's call. */
  Resize = 1,
}

/** What a refusal from `control` means. */
export enum ControlError {
  /** The kind is not one this host knows. */
  UnknownKind = -22,
  /** The host's queue share is full: try again next frame, do not spin. */
  QueueFull = -28,
}

/**
 * Whether the host owns a window at all.
 *
 * False when the process was started without `--window`, and false for a
 * capability-only run with no host window.
 */
export function hasSurface(): bool {
  return surfaceWidthRaw() != 0;
}

/** The host surface's width in pixels, or 0 when there is none. */
export function surfaceWidth(): u32 {
  return surfaceWidthRaw();
}

/** The host surface's height in pixels, or 0 when there is none. */
export function surfaceHeight(): u32 {
  return surfaceHeightRaw();
}

/**
 * Ask the host to resize the window.
 *
 * Returns 0 when the message was queued, or a negative [`ControlError`]:
 * -22 for a kind the host does not know, -28 when the host's queue is full.
 *
 * -28 is not a failure to retry in a tight loop — it means this frame already
 * has more window requests than the host will take, and the caller should drop
 * the request and try next frame. A guest that spams this is exactly what the
 * queue's bound exists for.
 *
 * A width or height below 1 is refused here rather than queued: the host clamps,
 * but sending a nonsense size wastes a frame and hides the caller's bug.
 */
export function resize(width: i32, height: i32): i32 {
  if (width < 1 || height < 1) return ControlError.UnknownKind;
  return controlRaw(ControlKind.Resize, width, height, 0, 0);
}

// ── the programmatic window API (ABI v7) ────────────────────────────────────
//
// The runtime takes no window flag: an application that wants a window asks for
// one. This is the top of that path, and the shape is deliberately the plainest
// thing that works:
//
//   const win = platform.createWindow(cfg);
//   if (!win.isValid()) { /* no display, or already created */ }
//   // …later, every frame:
//   const info = win.info();          // width == 0 when there is no window
//
// **`createWindow` is synchronous**, unlike `resize`. The host creates the
// window on the interpreter thread inside this call, so a guest can claim it for
// a renderer on the very next line. The cost is that a slow window system stalls
// one call; the alternative — queue it — means the renderer's `init` runs before
// the window exists, which is the ordering bug this exists to avoid.
//
// **`info()` on no window is not an error.** It returns a zeroed record with
// `width == 0`, because a frame loop should not have to treat "I have no window"
// as a failure. `win.isValid()` and `info().width > 0` agree.

/** Where the window's pixels are meant to go. The value picks the flags the
 *  host creates the window with, and on Windows the difference decides whether
 *  a Vulkan loader is required at all. */
export enum WindowTarget {
  /** An ordinary window; no graphics API is promised anything. */
  Plain = 0,
  /** The window will be handed to SDL_GPU (Vulkan on Linux, D3D12/Metal
   *  elsewhere). No `VULKAN` flag: SDL_GPU builds its own surface. */
  Gpu = 1,
  /** The window will be handed to `SDL_Vulkan_CreateSurface`. Required if you
   *  want `VkSurfaceKHR` from the host — an `ogre` renderer on the host's
   *  surface. */
  Vulkan = 2,
}

export enum WindowMode {
  Windowed = 0,
  Fullscreen = 1,
  BorderlessFullscreen = 2,
}

/** `TENSION_WINDOW_FLAG_*`. OR these together. */
export enum WindowFlags {
  None = 0,
  Resizable = 1,
  Decorated = 2,
  AlwaysOnTop = 4,
  Hidden = 8,
  HighDpi = 16,
}

/** What `createWindow` takes. Construct it, set the fields, pass it. */
export class WindowConfig {
  target: WindowTarget = WindowTarget.Plain;
  width: u32 = 1280;
  height: u32 = 720;
  mode: WindowMode = WindowMode.Windowed;
  flags: u32 = WindowFlags.Resizable | WindowFlags.Decorated | WindowFlags.HighDpi;
  /** `I32.MIN_VALUE` = let the window system place it. */
  x: i32 = I32.MIN_VALUE;
  y: i32 = I32.MIN_VALUE;
  /** 0 = no bound. */
  minWidth: u32 = 0;
  minHeight: u32 = 0;
  maxWidth: u32 = 0;
  maxHeight: u32 = 0;
  title: string = "Tension";
}

/** A window's state, as `info()` returns it. */
export class WindowInfo {
  /** Logical units. **0 means there is no window** — the whole headless guard. */
  width: u32 = 0;
  height: u32 = 0;
  /** Drawable pixels. Equal to `width`/`height` on a 1x display. */
  pixelWidth: u32 = 0;
  pixelHeight: u32 = 0;
  /** Display scale x 1000; 1000 is 1.0. */
  dpiScaleMilli: u32 = 1000;
  mode: WindowMode = WindowMode.Windowed;
  focused: bool = false;
  minimized: bool = false;
  /** The user asked to close it. Latched, not an edge. */
  closeRequested: bool = false;
}

/// The bytes `tension_window_config` occupies, including `struct_size`.
const WINDOW_CONFIG_BYTES: u32 = 56;
/// The bytes `tension_window_info` writes.
const WINDOW_INFO_BYTES: u32 = 40;

/** A window handle. Ids are 1-based, so `handle == 0` means "no window". */
export class Window {
  handle: u32;
  /** The errno `createWindow` returned, or 0. */
  error: i32;

  constructor(handle: u32, error: i32) {
    this.handle = handle;
    this.error = error;
  }

  isValid(): bool {
    return this.handle > 0;
  }

  /** This window's state. On `!isValid()` every field is zero, `width`
   *  included — not an error code, so an update loop needs no branch. */
  info(): WindowInfo {
    const out = new WindowInfo();
    if (!this.isValid()) return out;
    const staging: u32 = <u32>heap.alloc(WINDOW_INFO_BYTES);
    const rc = windowInfoRaw(this.handle, staging);
    if (rc == 0) {
      out.width = load<u32>(staging + 4);
      out.height = load<u32>(staging + 8);
      out.pixelWidth = load<u32>(staging + 12);
      out.pixelHeight = load<u32>(staging + 16);
      out.dpiScaleMilli = load<u32>(staging + 20);
      out.mode = load<u32>(staging + 24) as WindowMode;
      out.focused = load<u32>(staging + 28) != 0;
      out.minimized = load<u32>(staging + 32) != 0;
      out.closeRequested = load<u32>(staging + 36) != 0;
    }
    heap.free(staging);
    return out;
  }

  /** Destroy the window. Refused with -EBUSY while a renderer holds its
   *  swapchain: close the canvas first. 0 when it is already gone. */
  close(): i32 {
    if (!this.isValid()) return 0;
    return closeWindowRaw(this.handle);
  }
}

/**
 * Create the host's window.
 *
 * One window per process. A second call answers -EBUSY (`Window.error`), and so
 * does closing a window a renderer still holds.
 *
 * The title is a UTF-8 string copied into guest memory for the call; the host
 * copies it into the window and keeps nothing.
 */
export function createWindow(config: WindowConfig): Window {
  const staging: u32 = <u32>heap.alloc(WINDOW_CONFIG_BYTES);
  const titleBytes = String.UTF8.encode(config.title, false);
  const titlePtr: u32 = titleBytes.byteLength > 0 ? <u32>heap.alloc(titleBytes.byteLength) : 0;
  if (titlePtr != 0) {
    memory.copy(<usize>titlePtr, changetype<usize>(titleBytes), titleBytes.byteLength);
  }

  store<u32>(staging + 0, WINDOW_CONFIG_BYTES);
  store<u32>(staging + 4, config.target);
  store<u32>(staging + 8, config.width);
  store<u32>(staging + 12, config.height);
  store<u32>(staging + 16, config.mode);
  store<u32>(staging + 20, config.flags);
  store<i32>(staging + 24, config.x);
  store<i32>(staging + 28, config.y);
  store<u32>(staging + 32, config.minWidth);
  store<u32>(staging + 36, config.minHeight);
  store<u32>(staging + 40, config.maxWidth);
  store<u32>(staging + 44, config.maxHeight);
  store<u32>(staging + 48, titlePtr);
  store<u32>(staging + 52, titleBytes.byteLength);

  const rc = createWindowRaw(staging, WINDOW_CONFIG_BYTES);
  heap.free(staging);
  if (titlePtr != 0) heap.free(titlePtr);

  return rc > 0 ? new Window(<u32>rc, 0) : new Window(0, rc);
}

// ── the launcher's argv contract ────────────────────────────────────────────
//
// The runtime takes no window flag. `--window` left the command line when a
// guest could create its own window (ABI v7), and the size a renderer uses is
// the size the guest asks for. That leaves one question: where does a window
// size declared in a project's `tension.config.json` become a real window?
//
// The answer is these three arguments, and this parser:
//
//   --window=1280x720   the window (and canvas) size
//   --title=My Game     the window title
//   --headless          do not ask for a window at all
//
// The `tension` CLI turns the config into them, so every template and every
// generated project agrees about the spelling. `wantsWindow()` in the examples
// predates this and reads `--windowed`; both still work, and a guest that reads
// neither gets the default it always got.
//
// **A malformed value falls back to the default and says so.** The CLI
// validates the config before it spawns anything, so this is unreachable from
// `tension dev`. When it is reached — a hand-run binary, a stale script, a typo
// typed straight into a shell — a printed line and a sane window are a better
// answer than a trap, because the failure a trap produces is *no window at all*
// from an argument nobody thought of as configuration.

/** A window size request, as the launcher passes it. */
export class WindowRequest {
  /** Width in pixels. `--window=WxH`, default 1280. */
  width: i32 = 1280;
  /** Height in pixels. `--window=WxH`, default 720. */
  height: i32 = 720;
  /** The window title. `--title=…`, default "Tension". */
  title: string = "Tension";
  /** `--headless`: the guest must not ask for a window. */
  headless: bool = false;
}

/// The largest dimension any backend accepts (`tension-ogre`'s config
/// validation refuses `windowSize` outside `1..16384`, and a size a renderer
/// refuses is a window that never appears).
const MAX_WINDOW_DIMENSION: i32 = 16384;

/**
 * Read the launcher's window arguments.
 *
 * Call once, near the top of `_start_game`, before any renderer is
 * initialised — `Canvas.windowedOrOffscreen` and `ogre.initWindowed` both take
 * the size and neither can change it afterwards.
 */
export function windowRequest(): WindowRequest {
  const out = new WindowRequest();
  for (let i = 0; i < argCount(); i++) {
    const value = arg(i);

    if (value == "--headless") {
      out.headless = true;
      continue;
    }
    if (value.startsWith("--title=")) {
      out.title = value.slice(8);
      continue;
    }
    if (value.startsWith("--window=")) {
      // `WxH`, strictly. `1280by720` and `1280` are not sizes, and splitting on
      // the wrong character would produce a window of width 0 — which the host
      // refuses, which is a window that silently does not open.
      const spec = value.slice(9);
      const at = spec.indexOf("x");
      if (at <= 0 || at == spec.length - 1) {
        print("windowRequest: --window=" + spec + " is not WxH; keeping " +
              out.width.toString() + "x" + out.height.toString());
        continue;
      }
      const width = I32.parseInt(spec.slice(0, at));
      const height = I32.parseInt(spec.slice(at + 1));
      if (width < 1 || height < 1 || width > MAX_WINDOW_DIMENSION || height > MAX_WINDOW_DIMENSION) {
        print("windowRequest: --window=" + spec + " is outside 1.." +
              MAX_WINDOW_DIMENSION.toString() + "; keeping " +
              out.width.toString() + "x" + out.height.toString());
        continue;
      }
      out.width = width;
      out.height = height;
      continue;
    }
  }
  return out;
}
