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
// Scope: RESIZE is the only kind in this ABI version. Kinds are additive, so a
// future host may accept more; a guest must treat an unknown kind as a refusal
// rather than assume.

/** `tension::platform.control(kind, a0, a1, a2, a3) -> i32`. */
@external("tension::platform", "control")
declare function controlRaw(kind: u32, a0: i32, a1: i32, a2: i32, a3: i32): i32;

/** `tension::platform.surface_width() -> u32`. */
@external("tension::platform", "surface_width")
declare function surfaceWidthRaw(): u32;

/** `tension::platform.surface_height() -> u32`. */
@external("tension::platform", "surface_height")
declare function surfaceHeightRaw(): u32;

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
