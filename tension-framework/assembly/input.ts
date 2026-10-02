// The input capability's guest SDK: the six verbs and the two records.
//
// The adapter is `libtension_input.so` (tension-input/), the design is
// INPUT.md, and the wire is tension-input/include/tension_input.h. This module
// is the third reader of that header and invents no field the others do not
// have.
//
// **Two halves, one capability.** Keys, buttons and wheel are edges: they ride
// the session's reserved classes (`INPUT_KEY` 6, `INPUT_MOUSE` 7) and a guest
// subscribes with `session::subscribe` — there is no `input_subscribe`. What a
// frame reads instead is `state()`: held keys, mouse buttons, and the motion
// delta accumulated since the previous call. The delta is *consumed* by the
// read, so a frame that calls `state()` twice gets the second delta, not the
// same one.
//
// **Zero gamepads is normal.** `pad(slot)` answers `-ENOENT` for every slot
// while nothing is attached; that is a state, not an error (INPUT.md §3 Q2).
// Gamepad *edges* need a class the session does not have yet, so a guest that
// wants a pad reads its state here.

// --- the imports (module "tension::input") ---------------------------------

/** Open the capability's session; a handle (> 0), or an errno. */
@external("tension::input", "open")
declare function openRaw(flags: i32): i32;
/** Attach to a surface: `kind` names the token, `lo`/`hi` are its halves. */
@external("tension::input", "attach")
declare function attachRaw(handle: i32, kind: i32, lo: i32, hi: i32): i32;
/** SDL relative mouse mode on/off. */
@external("tension::input", "set_relative")
declare function setRelativeRaw(handle: i32, on: i32): i32;
/** Write a state record into `ptr`; `cap <= 0` probes for the size. */
@external("tension::input", "state")
declare function stateRaw(handle: i32, ptr: u32, cap: i32): i32;
/** Write one gamepad slot's record; `-ENOENT` for an empty slot. */
@external("tension::input", "pad")
declare function padRaw(handle: i32, slot: i32, ptr: u32, cap: i32): i32;
/** Release the handle. The SDL subsystem stays up for the next open. */
@external("tension::input", "close")
declare function closeRaw(handle: i32): i32;

// --- the wire constants (tension_input.h) ----------------------------------

/** What a token is. Kinds 2-4 answer `-ENOSYS` on this build. */
export enum Kind {
  /** input's own surface: input makes and owns a window. No renderer needed. */
  OwnSurface = 0,
  /** An X11 window id in `lo` — what `ogre::window_handle` hands over. */
  X11Window = 1,
  /** A Wayland `wl_surface` pointer in lo/hi. */
  WaylandSurface = 2,
  /** A Win32 `HWND`. */
  Win32Hwnd = 3,
  /** A Cocoa `NSView`/`NSWindow` pointer. */
  CocoaView = 4,
}

/** `input_state`, in bytes. */
export const STATE_SIZE: u32 = 96;
/** `input_pad`, in bytes. */
export const PAD_SIZE: u32 = 48;
/** How many gamepad slots the capability serves. */
export const PAD_SLOTS: u32 = 8;

/** `state.flags` bits. */
export const STATE_ATTACHED: u32 = 1 << 0;
export const STATE_RELATIVE: u32 = 1 << 1;
export const STATE_FOCUSED: u32 = 1 << 2;
export const STATE_POINTER_OVER: u32 = 1 << 3;

/** The state record's field offsets — a guest reads by number, like every
 * other record in this runtime. */
export const STATE_VERSION_OFFSET: u32 = 0;
export const STATE_FLAGS_OFFSET: u32 = 4;
export const STATE_PADS_OFFSET: u32 = 8;
export const STATE_BUTTONS_OFFSET: u32 = 12;
export const STATE_KEYS_OFFSET: u32 = 16;
export const STATE_MOUSE_DX_OFFSET: u32 = 48;
export const STATE_MOUSE_DY_OFFSET: u32 = 52;
export const STATE_MOUSE_DXF_OFFSET: u32 = 56;
export const STATE_MOUSE_DYF_OFFSET: u32 = 60;
export const STATE_MOUSE_X_OFFSET: u32 = 64;
export const STATE_MOUSE_Y_OFFSET: u32 = 68;
export const STATE_WHEEL_X_OFFSET: u32 = 72;
export const STATE_WHEEL_Y_OFFSET: u32 = 76;
export const STATE_SEQ_OFFSET: u32 = 80;

/** The pad record's field offsets. */
export const PAD_FLAGS_OFFSET: u32 = 4;
export const PAD_BUTTONS_OFFSET: u32 = 8;
export const PAD_AXES_OFFSET: u32 = 16;

/** The pad axes, in record order. Sticks are `[-1, 1]`, triggers `[0, 1]`. */
export enum PadAxis {
  LeftX = 0,
  LeftY = 1,
  RightX = 2,
  RightY = 3,
  LeftTrigger = 4,
  RightTrigger = 5,
}

// --- the verbs -------------------------------------------------------------

/** Open the capability. `flags` is reserved and must be 0. */
export function open(flags: i32 = 0): i32 {
  return openRaw(flags);
}

/** Attach to a surface whose token is two halves. */
export function attach(handle: i32, kind: Kind, lo: i32, hi: i32): i32 {
  return attachRaw(handle, kind, lo, hi);
}

/** Attach to a surface whose token is one 64-bit value — the shape
 * `ogre.windowHandle()` answers with. */
export function attachToken(handle: i32, kind: Kind, token: u64): i32 {
  return attachRaw(handle, kind, <i32>(token & 0xFFFFFFFF), <i32>(token >>> 32));
}

/** Relative mouse mode: grab the pointer, deliver raw deltas. */
export function setRelative(handle: i32, on: bool): i32 {
  return setRelativeRaw(handle, on ? 1 : 0);
}

/** The size a state record needs, without writing one. */
export function stateSize(handle: i32): i32 {
  return stateRaw(handle, 0, 0);
}

/**
 * Fill `out` (at least `STATE_SIZE` bytes) with a snapshot.
 *
 * The call consumes the motion delta: the next call reports what has
 * accumulated since this one.
 */
export function state(handle: i32, out: usize): i32 {
  return stateRaw(handle, <u32>out, <i32>STATE_SIZE);
}

/** Fill `out` (at least `PAD_SIZE` bytes) with one slot, or `-ENOENT`. */
export function pad(handle: i32, slot: i32, out: usize): i32 {
  return padRaw(handle, slot, <u32>out, <i32>PAD_SIZE);
}

/** Release the handle. */
export function close(handle: i32): i32 {
  return closeRaw(handle);
}

// --- readings --------------------------------------------------------------

/**
 * A decoded state record. `read` copies the scalars out of a buffer `state`
 * filled, and keeps the address for `keyHeld`, which reads the 256-bit
 * scancode set in place rather than copying 32 bytes per frame.
 */
export class InputState {
  version: u32 = 0;
  flags: u32 = 0;
  padsPresent: u32 = 0;
  mouseButtons: u32 = 0;
  mouseDx: i32 = 0;
  mouseDy: i32 = 0;
  mouseDxf: f32 = 0;
  mouseDyf: f32 = 0;
  mouseX: i32 = 0;
  mouseY: i32 = 0;
  wheelX: f32 = 0;
  wheelY: f32 = 0;
  seq: u64 = 0;
  private keysAt: usize = 0;

  static read(ptr: usize): InputState {
    const s = new InputState();
    s.version = load<u32>(ptr + STATE_VERSION_OFFSET);
    s.flags = load<u32>(ptr + STATE_FLAGS_OFFSET);
    s.padsPresent = load<u32>(ptr + STATE_PADS_OFFSET);
    s.mouseButtons = load<u32>(ptr + STATE_BUTTONS_OFFSET);
    s.mouseDx = load<i32>(ptr + STATE_MOUSE_DX_OFFSET);
    s.mouseDy = load<i32>(ptr + STATE_MOUSE_DY_OFFSET);
    s.mouseDxf = load<f32>(ptr + STATE_MOUSE_DXF_OFFSET);
    s.mouseDyf = load<f32>(ptr + STATE_MOUSE_DYF_OFFSET);
    s.mouseX = load<i32>(ptr + STATE_MOUSE_X_OFFSET);
    s.mouseY = load<i32>(ptr + STATE_MOUSE_Y_OFFSET);
    s.wheelX = load<f32>(ptr + STATE_WHEEL_X_OFFSET);
    s.wheelY = load<f32>(ptr + STATE_WHEEL_Y_OFFSET);
    s.seq = load<u64>(ptr + STATE_SEQ_OFFSET);
    s.keysAt = ptr + STATE_KEYS_OFFSET;
    return s;
  }

  attached(): bool {
    return (this.flags & STATE_ATTACHED) != 0;
  }

  relative(): bool {
    return (this.flags & STATE_RELATIVE) != 0;
  }

  focused(): bool {
    return (this.flags & STATE_FOCUSED) != 0;
  }

  /** Whether one scancode (SDL numbering) is held, from the 256-bit set. */
  keyHeld(scancode: u32): bool {
    if (scancode >= 256) return false;
    return (load<u32>(this.keysAt + (scancode >> 5) * 4) & (1 << (scancode & 31))) != 0;
  }

  /** Whether SDL button `n` (1-based) is held. */
  buttonHeld(n: u32): bool {
    return n >= 1 && n <= 32 && (this.mouseButtons & (1 << (n - 1))) != 0;
  }

  /** One pad axis, from a record `pad()` filled. */
  static padAxis(padPtr: usize, axis: PadAxis): f32 {
    return load<f32>(padPtr + PAD_AXES_OFFSET + <u32>axis * 4);
  }

  /** Whether SDL_GameController button `n` is held, from a pad record. */
  static padButton(padPtr: usize, n: u32): bool {
    return n < 32 && (load<u32>(padPtr + PAD_BUTTONS_OFFSET) & (1 << n)) != 0;
  }
}
