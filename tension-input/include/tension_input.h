/*
 * tension_input — the input capability's boundary header.
 *
 * The counterpart of tension_adapter.h for one capability: it fixes the wasm
 * import surface (`tension::input`) the adapter implements and the two records
 * `input_state` and `input_pad` write into guest memory. The guest SDK
 * (tension-framework/assembly/input.ts) and the adapter's C++ sources both
 * answer to it, and neither invents a field the other does not know.
 *
 * The design is INPUT.md at the repo root; this header is its wire, in C, and
 * where the two disagree INPUT.md is the argument and this is the shape.
 *
 * This header includes no SDL header, on purpose. The adapter's SDL-facing
 * includes live in src/input.cpp, where they cannot leak into the wire
 * contract; the platform lives in the DSO (INPUT.md §3 Q6).
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_INPUT_H
#define TENSION_INPUT_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── the imports this adapter registers ──────────────────────────────── */

/*
 * The wasm-facing surface, module name "tension::input". The guest declares
 * these with `@external("tension::input", ...)`; the adapter registers them
 * through `tension_core_api.register_import`, in `link`. Every parameter and
 * return is `i32`: a 64-bit window token crosses as two halves, because that
 * is the only shape the adapter path exercises today (INPUT.md §3 Q5).
 *
 * Guest pointers are `u32` offsets into the guest's own memory — the adapter
 * reaches that memory only through `guest_read` / `guest_write`, inside a
 * guest-initiated call.
 */

/*
 * `input_open(i32 flags) -> i32`  — verb_id 1, flags 0.
 *
 * Opens the capability's one session (capacity 1) and returns its handle, or:
 *   -EINVAL  `flags` is not 0 (none are defined yet)
 *   -EBUSY   a handle is already open
 *   -ENODEV  the SDL subsystem is not up on this machine (no display, no
 *            driver). The subsystem is retried here, so a later `input_open`
 *            may succeed where an earlier one was refused.
 */
int32_t input_open(int32_t flags);

/*
 * `input_attach(i32 handle, i32 kind, i32 lo, i32 hi) -> i32`  — verb_id 2,
 * flags 0.
 *
 * Attaches the session to a device surface. `kind` names what the token is;
 * `lo`/`hi` are its low and high 32 bits (ignored for kind 0):
 *
 *   0  input's own surface — input creates and owns a window, so a text game
 *      needs no renderer
 *   1  an X11 window id (lo), the token `ogre::window_handle` hands the guest
 *   2  a Wayland `wl_surface` pointer (lo/hi)   — -ENOSYS on this build
 *   3  a Win32 `HWND`                           — -ENOSYS on this build
 *   4  a Cocoa `NSView`/`NSWindow` pointer      — -ENOSYS on this build
 *
 * The DSO forces the SDL video driver that matches the kind and then verifies
 * the attach (a wrong driver returns a live window that is not the target,
 * with no error — measured). Returns 0, or:
 *   -EINVAL  bad handle, or a kind above 4
 *   -ENODEV  no display, or no window could be made
 *   -ENOENT  the token does not name a window
 *   -ENOSYS  a kind this build does not serve
 *   -EBUSY   already attached
 *   -EIO     SDL refused, or the attach did not verify
 *
 * The first ~500 ms of motion events after a successful attach are discarded:
 * they are the window settling under the pointer, not input (INPUT.md Q5).
 */
int32_t input_attach(int32_t handle, int32_t kind, int32_t lo, int32_t hi);

/*
 * `input_set_relative(i32 handle, i32 on) -> i32`  — verb_id 3, flags 0.
 *
 * Turns SDL's relative mouse mode on (grab + raw deltas) or off (absolute
 * window coordinates). Off at attach; a game that wants mouse-look asks.
 * Returns 0, -EINVAL for a bad handle, -ENODEV when nothing is attached.
 */
int32_t input_set_relative(int32_t handle, int32_t on);

/*
 * `input_state(i32 handle, i32 ptr, i32 cap) -> i32`  — verb_id 4,
 * flags TENSION_IMPORT_REENTRANT_READONLY.
 *
 * Writes one `input_state` record (see below) to `ptr` and returns its size.
 * `cap <= 0` probes: the size is returned and nothing is written. `0 < cap <
 * size` is -ENOSPC. -ENODEV when nothing is attached, -EINVAL for a bad
 * handle or a refused destination.
 *
 * This is the third rule's edge: the motion delta in the record is the
 * accumulation since the previous snapshot, and taking a snapshot consumes it.
 */
int32_t input_state(int32_t handle, int32_t ptr, int32_t cap);

/*
 * `input_pad(i32 handle, i32 slot, i32 ptr, i32 cap) -> i32`  — verb_id 5,
 * flags TENSION_IMPORT_REENTRANT_READONLY.
 *
 * Writes one `input_pad` record for a gamepad slot. `cap <= 0` probes; a slot
 * with no pad is -ENOENT — which is what every slot answers while zero pads
 * are attached, a normal state and not a failure (INPUT.md §3 Q2). -ENODEV
 * when nothing is attached, -EINVAL for a bad handle or slot, -ENOSPC for a
 * short buffer.
 *
 * Gamepad edges need a class the session does not have; this verb is the
 * gamepad's state half only (INPUT.md §3 Q5).
 */
int32_t input_pad(int32_t handle, int32_t slot, int32_t ptr, int32_t cap);

/*
 * `input_close(i32 handle) -> i32`  — verb_id 6, flags 0.
 *
 * Detaches (destroying input's own window, if it made one), releases the
 * handle, and leaves the SDL subsystem up for a later `input_open`. 0, or
 * -EINVAL for a bad handle.
 */
int32_t input_close(int32_t handle);

/* ── the two records ─────────────────────────────────────────────────── */

/*
 * `input_state`, 96 bytes, 4-byte alignment. Offsets are the wire; a field
 * that drifted would be read as another field's bytes.
 *
 *   off  size  field
 *   ---  ----  -----------------------------------------------------------
 *    0     4   version (1)
 *    4     4   flags — see TENSION_INPUT_STATE_* below
 *    8     4   pads_present (bit i = slot i has a pad)
 *   12     4   mouse_buttons (bit n = SDL button n+1)
 *   16    32   keys_held[8] (u32 words; bit `scancode & 31` of word
 *              `scancode >> 5`)
 *   48     4   mouse_dx   i32 — the truncation of mouse_dxf, remainder carried
 *   52     4   mouse_dy   i32
 *   56     4   mouse_dxf  f32 — the delta SDL produced; authoritative
 *   60     4   mouse_dyf  f32
 *   64     4   mouse_x    i32 — window pixel; meaningful only when
 *              TENSION_INPUT_STATE_RELATIVE is clear
 *   68     4   mouse_y    i32
 *   72     4   wheel_x    f32 — accumulated since the previous snapshot
 *   76     4   wheel_y    f32
 *   80     8   seq        u64 — the highest event sequence this snapshot
 *              reflects (0 when none); events are ordered by it
 *   88     8   reserved   (zero)
 */
#define TENSION_INPUT_STATE_SIZE 96u
#define TENSION_INPUT_STATE_VERSION 1u

/** `flags` bits of the state record. */
#define TENSION_INPUT_STATE_ATTACHED (1u << 0)
#define TENSION_INPUT_STATE_RELATIVE (1u << 1)
#define TENSION_INPUT_STATE_FOCUSED (1u << 2)
#define TENSION_INPUT_STATE_POINTER_OVER (1u << 3)

/*
 * `input_pad`, 48 bytes, 4-byte alignment.
 *
 *   off  size  field
 *   ---  ----  -----------------------------------------------------------
 *    0     4   version (1)
 *    4     4   flags — TENSION_INPUT_PAD_ATTACHED while a pad is there
 *    8     4   buttons (SDL_GameController button mask)
 *   12     4   reserved
 *   16    24   axes[6] f32: left x/y, right x/y in [-1, 1]; triggers [0, 1]
 *   40     8   reserved (zero)
 */
#define TENSION_INPUT_PAD_SIZE 48u
#define TENSION_INPUT_PAD_VERSION 1u
#define TENSION_INPUT_PAD_ATTACHED (1u << 0)

/** How many gamepad slots this chunk serves. */
#define TENSION_INPUT_PAD_SLOTS 8u

/* ── the event records ───────────────────────────────────────────────── */

/*
 * The two classes this capability posts on, from the session's frozen
 * catalogue (tension-core/src/session/arena.rs): INPUT_KEY is 6, INPUT_MOUSE
 * is 7, both BATCHED. The `EventRecord` is 32 bytes — {seq u64, class u32,
 * flags u32, a u32, b u32, f0 f32, f1 f32} — and has no room for a device id,
 * so a record identifies its own shape in `flags` (INPUT.md §3 Q5):
 *
 *   CLASS_INPUT_KEY    flags bit0 DOWN, bit1 REPEAT, bit2 SYNTHETIC
 *                      a = SDL keycode, b = SDL scancode
 *   CLASS_INPUT_MOUSE  flags bits0-1 = SHAPE (0 motion, 1 button, 2 wheel)
 *                      motion: a = dx i32, b = dy i32, f0/f1 = float delta
 *                      button: a = button (SDL numbering), b = mask after;
 *                              flags bit2 = DOWN
 *                      wheel:  f0 = x, f1 = y
 *
 * Motion is *not* posted per device sample: it coalesces into the state
 * record, one delta per snapshot (measured 989 events in one second against
 * a 64-slot ring — INPUT.md §3 Q3). Keys, buttons and wheel are edges and are
 * posted.
 */
#define TENSION_INPUT_CLASS_INPUT_KEY 6u
#define TENSION_INPUT_CLASS_INPUT_MOUSE 7u

#define TENSION_INPUT_KEY_DOWN (1u << 0)
#define TENSION_INPUT_KEY_REPEAT (1u << 1)
#define TENSION_INPUT_KEY_SYNTHETIC (1u << 2)

#define TENSION_INPUT_MOUSE_SHAPE_MASK 0x3u
#define TENSION_INPUT_MOUSE_SHAPE_MOTION 0u
#define TENSION_INPUT_MOUSE_SHAPE_BUTTON 1u
#define TENSION_INPUT_MOUSE_SHAPE_WHEEL 2u
#define TENSION_INPUT_MOUSE_BUTTON_DOWN (1u << 2)

/* ── refusals ────────────────────────────────────────────────────────── */

/*
 * The vocabulary is tension_adapter.h's, with the same one recorded
 * exception the renderer carries: -ENODEV is not in the boundary's closed
 * list, and it is what "no display, no window, nothing attached yet" answers
 * with, because none of the listed codes names that state. The amendment
 * tension-core owes is one line in that list; until it lands, this header and
 * tension_ogre.h are where the deviation is recorded.
 *
 *   -EINVAL  a bad handle, a kind above 4, a slot outside 0..7, a non-zero
 *            `flags`, or a refused guest destination
 *   -ENODEV  no display, no window, or nothing attached
 *   -ENOENT  no such window token, or an empty gamepad slot
 *   -ENOSYS  a token kind this build does not serve
 *   -EBUSY   the capacity is taken, or already attached
 *   -ENOSPC  a short buffer (`0 < cap < size`)
 *   -EIO     SDL refused, or an attach that did not verify
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_INPUT_H */
