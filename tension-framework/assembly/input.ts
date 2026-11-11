// The input capability's guest SDK: the seven verbs and the two records.
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
/** Copy out the UTF-8 typed since the last call; `cap <= 0` probes. */
@external("tension::input", "text")
declare function textRaw(handle: i32, ptr: u32, cap: i32): i32;
/** Release the handle. The SDL subsystem stays up for the next open. */
@external("tension::input", "close")
declare function closeRaw(handle: i32): i32;

// --- the wire constants (tension_input.h) ----------------------------------

/** What a token is.
 *
 * **Ignored since v7.** The host owns the window, and a capability joins it by
 * subscribing to its events rather than by naming a surface — so `attach`
 * accepts the four arguments it always did and reads only the handle. Pass
 * `Kind.OwnSurface` and zeros; the values stay so a guest built against v6 keeps
 * working, and `kind` stops meaning anything rather than becoming a different
 * kind of failure.
 */
export enum Kind {
  /** No token. The honest spelling of "ignore the rest" in v7 — pass this and
   * zeros. (In v6 it meant "make your own window"; input no longer owns one.) */
  OwnSurface = 0,
  /** An X11 window id in `lo` — what `ogre::window_handle` used to hand over. */
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
/** The modifier set after the last key transition (`MOD_*` bits below). */
export const STATE_MODIFIERS_OFFSET: u32 = 88;

/**
 * The state record's `modifiers` bits.
 *
 * The wire's own numbering (`tension_adapter.h`, `TENSION_KEY_MOD_*`), which the
 * host translates from SDL's word — a guest is not linked against SDL and must
 * not spell its constants. The left and right halves of a pair collapse into one
 * bit: a caller asking "is shift held" is asking about the keyboard, not about a
 * hand.
 */
export const MOD_SHIFT: u32 = 1 << 0;
export const MOD_CTRL: u32 = 1 << 1;
export const MOD_ALT: u32 = 1 << 2;
export const MOD_SUPER: u32 = 1 << 3;
export const MOD_CAPS: u32 = 1 << 4;
export const MOD_NUM: u32 = 1 << 5;
export const MOD_MODE: u32 = 1 << 6;

/**
 * The bytes of typed text one `text()` call may hand back.
 *
 * The mirror's own buffer is the limit (256 bytes, ~16 frames of fast typing at
 * 60 Hz), and a caller reads once per frame, so this is a bound on a bound.
 * Stated here because the buffer a caller passes must be at least this in the
 * class's convenience path below.
 */
export const TEXT_CAPACITY: i32 = 256;

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

/** Send the handle's four attach words. `kind`/`lo`/`hi` are ignored since v7:
 * the host owns the window and this capability joins it by subscribing. The
 * verb takes four arguments because a v6 guest must keep linking, and `kind` is
 * still range-checked (0..4) so a nonsense value is refused rather than
 * silently dropped. */
export function attach(handle: i32, kind: Kind, lo: i32, hi: i32): i32 {
  return attachRaw(handle, kind, lo, hi);
}

/** The 64-bit-token spelling of `attach`, kept for the same reason: the two
 * halves are the same two arguments. The token it used to carry —
 * `ogre.windowHandle()`'s answer — is itself deprecated and answers 0 under a
 * v7 host, which is why passing it here is now the same as passing zeros. */
export function attachToken(handle: i32, kind: Kind, token: u64): i32 {
  return attachRaw(handle, kind, <i32>(token & 0xFFFFFFFF), <i32>(token >>> 32));
}

/**
 * Relative mouse mode: grab the pointer, deliver raw deltas.
 *
 * Queued through the host's control executor — there is no window here to
 * attach to — so the request is applied by the host loop, and the RELATIVE flag
 * in `state()` reports the request the host accepted.
 */
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

/**
 * Copy the UTF-8 typed since the previous call into `out`, and return how many
 * bytes were written — 0 on almost every frame.
 *
 * `cap <= 0` probes: the pending count is returned and nothing is consumed or
 * written. A `cap` smaller than the pending count is `-ENOSPC` with the text
 * **kept**, so a caller can retry with the size a probe reported rather than
 * losing a keystroke. That is why the doc comment to the verb says a caller
 * should probe first, and why `Snapshot.textInput()` does.
 */
export function text(handle: i32, out: usize, cap: i32): i32 {
  return textRaw(handle, <u32>out, cap);
}

/** How many typed bytes are waiting, without consuming them. */
export function textSize(handle: i32): i32 {
  return textRaw(handle, 0, 0);
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
  /** The modifier set after the last key transition (`MOD_*`). */
  modifiers: u32 = 0;
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
    s.modifiers = load<u32>(ptr + STATE_MODIFIERS_OFFSET);
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

// --- the safe read ---------------------------------------------------------

/**
 * A frame's input, read through a buffer this class owns.
 *
 * ## What it replaces
 *
 * Every guest that reads input wrote the same four things by hand: a
 * `memory.data(96, 8)` block, a call to `state(handle, ptr)`, `load<u32>` at
 * `ptr + 16 + (scancode >> 5) * 4` for the held-key set, and a copy of that set
 * from last frame for edge detection. `apps/docs` does exactly this, with the
 * `16` written out in the app because the constant lives in this file.
 *
 * Three of those four are places to be wrong the same way — the offset, the
 * bitmap width, the order of the latch — and none of them is the guest's
 * business. `Snapshot` owns the block, decodes with this file's own offsets, and
 * keeps the previous frame's key set so `pressed` is a method rather than a
 * convention.
 *
 * ## `read()` consumes the motion delta
 *
 * That is the capability's contract (`state()` at the top of this file): the
 * delta accumulated since the previous call. So `read()` once per frame, and
 * `mouseDx`/`mouseDy` are what happened since the last `read()` — not since the
 * last `mouseX` read, because there is no such thing.
 *
 * ## Edges
 *
 * `read()` latches the frame it is about to replace *before* the call, so
 * `pressed` is "held now, not held at the last `read`". A first `read` sees a
 * zeroed previous set, so the first frame reports no spurious presses — which is
 * the behaviour a windowed app needs, where input attaches several frames after
 * the first draw.
 *
 * One allocation per frame: none. The block and the latch are allocated in the
 * constructor.
 */
export class Snapshot {
  /** The 96-byte state record. `dataStart` is the address; nothing else is. */
  private block: Uint8Array;
  /** Last frame's 256-bit key set, for `pressed`/`released`. */
  private previousKeys: Uint32Array;
  /** Last frame's button mask. */
  private previousButtons: u32 = 0;
  /** The capability's handle, or `<= 0` for one that never opened. */
  handle: i32;

  // --- the record, decoded ------------------------------------------------
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
  /** The modifier set after the last key transition (`MOD_*`). */
  modifiers: u32 = 0;
  /** False until a `read()` has succeeded. */
  valid: bool = false;

  /**
   * The scratch buffer `textInput()` decodes from.
   *
   * A field rather than a local so the address it takes is stable for the life
   * of the object: the verb writes into guest memory through `guest_write`, and
   * an address into a collected local is an address into freed memory.
   */
  private textBuffer: Uint8Array = new Uint8Array(TEXT_CAPACITY);

  constructor(handle: i32) {
    this.handle = handle;
    this.block = new Uint8Array(<i32>STATE_SIZE);
    this.previousKeys = new Uint32Array(8);
  }

  /**
   * Open the capability and take a handle.
   *
   * A refusal answers a snapshot with `handle <= 0`: every `read` fails, every
   * query answers false, and a caller draws without input rather than branching
   * on an errno. `open` takes no meaningful flags in v7 — the host owns the
   * window — so there is nothing to pass.
   */
  static open(): Snapshot {
    return new Snapshot(openRaw(0));
  }

  /** Take a snapshot of an already-open handle, for a caller that owns one. */
  static from(handle: i32): Snapshot {
    return new Snapshot(handle);
  }

  /** Release the handle. The SDL subsystem stays up for the next `open`. */
  close(): i32 {
    const rc = closeRaw(this.handle);
    this.valid = false;
    return rc;
  }

  /**
   * Whether this handle is attached to the host's window.
   *
   * `attach` is the verb behind it, and it may answer `-ENODEV` for a few frames
   * while the window comes up — the input layer joins the window rather than
   * owning one. So a caller retries rather than treating a failure as fatal;
   * `-EBUSY` from an already-attached handle is the same state, said differently.
   */
  attach(): bool {
    if (this.handle <= 0) return false;
    const rc = attachRaw(this.handle, <i32>Kind.OwnSurface, 0, 0);
    return rc == 0 || rc == -16; // 0 attached, -EBUSY already attached
  }

  /**
   * Fill the record from the capability. Returns false when there is nothing to
   * read — no handle, nothing attached, or a refused record — in which case the
   * decoded fields keep the previous read's values and `valid` is false.
   */
  read(): bool {
    if (this.handle <= 0) {
      this.valid = false;
      return false;
    }
    // Latch the frame that is about to be replaced, before it is replaced.
    // Reading the latch out of the live block after the call would compare the
    // new set with itself and report no edges at all.
    for (let i: i32 = 0; i < 8; i++) this.previousKeys[i] = this.keyWord(i);
    this.previousButtons = this.mouseButtons;

    const got: i32 = stateRaw(this.handle, <u32>this.block.dataStart, <i32>STATE_SIZE);
    if (got <= 0) {
      this.valid = false;
      return false;
    }

    const at = this.block.dataStart;
    this.version = load<u32>(at + STATE_VERSION_OFFSET);
    this.flags = load<u32>(at + STATE_FLAGS_OFFSET);
    this.padsPresent = load<u32>(at + STATE_PADS_OFFSET);
    this.mouseButtons = load<u32>(at + STATE_BUTTONS_OFFSET);
    this.mouseDx = load<i32>(at + STATE_MOUSE_DX_OFFSET);
    this.mouseDy = load<i32>(at + STATE_MOUSE_DY_OFFSET);
    this.mouseDxf = load<f32>(at + STATE_MOUSE_DXF_OFFSET);
    this.mouseDyf = load<f32>(at + STATE_MOUSE_DYF_OFFSET);
    this.mouseX = load<i32>(at + STATE_MOUSE_X_OFFSET);
    this.mouseY = load<i32>(at + STATE_MOUSE_Y_OFFSET);
    this.wheelX = load<f32>(at + STATE_WHEEL_X_OFFSET);
    this.wheelY = load<f32>(at + STATE_WHEEL_Y_OFFSET);
    this.seq = load<u64>(at + STATE_SEQ_OFFSET);
    this.modifiers = load<u32>(at + STATE_MODIFIERS_OFFSET);
    this.valid = true;
    return true;
  }

  // --- modifiers -----------------------------------------------------------

  /** Whether `bits` are all in the modifier set this frame. */
  mods(bits: u32): bool {
    return this.valid && (this.modifiers & bits) == bits;
  }

  get shift(): bool { return this.mods(MOD_SHIFT); }
  get ctrl(): bool { return this.mods(MOD_CTRL); }
  get alt(): bool { return this.mods(MOD_ALT); }
  /** The Super/Windows/Command key. `meta`, not `super`: the latter is a
   *  keyword in this language, so a getter named for it does not parse. */
  get meta(): bool { return this.mods(MOD_SUPER); }

  /**
   * The text typed since the previous call, as a string, consumed by reading.
   *
   * Empty on almost every frame, and it allocates only when it is not — a
   * `String` cannot be avoided for a caller that wants to append to a field, and
   * the allocation is proportional to what a human typed rather than to the
   * frame rate.
   *
   * Probes first, so a `-ENOSPC` cannot happen: the mirror keeps the text until
   * it is actually read out, and this reads with the size the probe reported.
   */
  textInput(): string {
    if (this.handle <= 0) return "";
    const pending: i32 = textSize(this.handle);
    if (pending <= 0) return "";
    if (pending > this.textBuffer.length) return "";  // larger than the mirror allows
    const got: i32 = textRaw(this.handle, <u32>this.textBuffer.dataStart, <i32>this.textBuffer.length);
    if (got <= 0) return "";
    return String.UTF8.decodeUnsafe(changetype<usize>(this.textBuffer.dataStart), <usize>got, false);
  }

  /**
   * The text typed since the previous call, as raw UTF-8 bytes, consumed.
   *
   * Returns the byte count, or `-ENOSPC` when `out` is smaller than what is
   * pending — in which case nothing was consumed, so a caller that sizes `out`
   * from `textSize()` never loses a keystroke. For a text field that edits
   * bytes this is the cheaper path: no string, no decode.
   */
  readText(out: Uint8Array): i32 {
    if (this.handle <= 0) return 0;
    return textRaw(this.handle, <u32>out.dataStart, <i32>out.length);
  }

  /** How many typed bytes are waiting, without consuming them. */
  textPending(): i32 {
    if (this.handle <= 0) return 0;
    return textSize(this.handle);
  }

  // --- queries -------------------------------------------------------------

  attached(): bool {
    return this.valid && (this.flags & STATE_ATTACHED) != 0;
  }

  focused(): bool {
    return this.valid && (this.flags & STATE_FOCUSED) != 0;
  }

  relative(): bool {
    return this.valid && (this.flags & STATE_RELATIVE) != 0;
  }

  /** Whether one scancode (SDL numbering) is held in the current frame. */
  held(scancode: u32): bool {
    if (!this.valid || scancode >= 256) return false;
    return (this.keyWord(<i32>(scancode >> 5)) & (1 << (scancode & 31))) != 0;
  }

  /** Whether it went down since the previous `read`. */
  pressed(scancode: u32): bool {
    if (!this.valid || scancode >= 256) return false;
    const word = <i32>(scancode >> 5);
    const bit: u32 = 1 << (scancode & 31);
    return (this.previousKeys[word] & bit) == 0 && (this.keyWord(word) & bit) != 0;
  }

  /** Whether it came up since the previous `read`. */
  released(scancode: u32): bool {
    if (!this.valid || scancode >= 256) return false;
    const word = <i32>(scancode >> 5);
    const bit: u32 = 1 << (scancode & 31);
    return (this.previousKeys[word] & bit) != 0 && (this.keyWord(word) & bit) == 0;
  }

  /** Whether SDL mouse button `n` (1-based, as SDL numbers them) is held. */
  buttonHeld(n: u32): bool {
    return this.valid && n >= 1 && n <= 32 && (this.mouseButtons & (1 << (n - 1))) != 0;
  }

  /** Whether it went down since the previous `read`. */
  buttonPressed(n: u32): bool {
    if (!this.valid || n < 1 || n > 32) return false;
    const bit: u32 = 1 << (n - 1);
    return (this.mouseButtons & bit) != 0 && (this.previousButtons & bit) == 0;
  }

  /** The data address, for the verbs. Framework use; see `Bytes.address`. */
  address(): usize {
    return this.block.dataStart;
  }

  /** One 32-bit word of the held-key set, from the record. */
  private keyWord(index: i32): u32 {
    return load<u32>(this.block.dataStart + STATE_KEYS_OFFSET + <usize>(index * 4));
  }
}
