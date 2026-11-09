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
 * **There is no platform here any more (v7).** Before v7 the DSO owned SDL — its
 * own thread, its own `SDL_Init`, its own window and poll loop — and the kinds
 * below named which surface it should attach to. The host owns the window, the
 * video subsystem and the event queue now; this capability subscribes a layer
 * (thread rule 13, tension_adapter.h) and joins whatever window the host has.
 * The four-argument `attach` wire is unchanged so a guest compiled against v6
 * still links; `kind`, `lo` and `hi` are ignored.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_INPUT_H
#define TENSION_INPUT_H

#include <stdint.h>

/* `tension_pad_record` and the event wire (ABI v7) live in the boundary header:
 * the host serves both now, so a second definition here would be a second
 * meaning for one layout. The `TENSION_INPUT_PAD_*` names below stay, because
 * they are what this capability's adapter and guest SDK already spell. */
#include "tension_adapter.h"

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
 *
 * **Nothing device-shaped happens here, so nothing device-shaped can fail.** In
 * particular this does *not* answer -ENODEV: no window may exist yet, and the
 * ordering a guest follows is `platform.createWindow`, then `input.open`, then
 * `input.attach`. "No window" is `attach`'s answer.
 */
int32_t input_open(int32_t flags);

/*
 * `input_attach(i32 handle, i32 kind, i32 lo, i32 hi) -> i32`  — verb_id 2,
 * flags 0.
 *
 * Attaches the session to the host's window.
 *
 * **`kind`, `lo` and `hi` are ignored, and a guest should pass
 * `Kind.OwnSurface` (0) with zeros.** There is one surface in a v7 host — the
 * window it owns — and a capability joins it by subscribing to its events, not
 * by naming it. The parameter survives because a guest calls four words and
 * this capability still takes four words: a caller recompiled against no header
 * keeps working, and its `kind` stops meaning anything rather than becoming a
 * different kind of failure.
 *
 * Returns 0, or:
 *   -EINVAL  bad handle, or a kind above 4
 *   -ENODEV  the host owns no window yet — create one first
 *   -EBUSY   already attached
 *
 * The first ~500 ms of motion after a successful attach are discarded: they are
 * the pointer-confinement warp and the window settling, not input (INPUT.md Q5).
 */
int32_t input_attach(int32_t handle, int32_t kind, int32_t lo, int32_t hi);

/*
 * `input_set_relative(i32 handle, i32 on) -> i32`  — verb_id 3, flags 0.
 *
 * Turns the window's relative mouse mode on (grab + raw deltas) or off
 * (absolute window coordinates). Off at attach; a game that wants mouse-look
 * asks.
 *
 * **Queued, not applied.** This posts `TENSION_CTRL_RELATIVE_MOUSE` to the
 * host's executor, which runs on the window's thread inside the host loop; the
 * capability never calls `SDL_SetWindowRelativeMouseMode` and never holds a
 * window. The RELATIVE bit in `input_state` therefore reports the request the
 * host accepted into its queue, and the host logs the refusal if it cannot
 * apply it. Returns 0, -EINVAL for a bad handle, -ENODEV when nothing is
 * attached, -EBUSY when the host's control queue is full (retry next frame).
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
 * short buffer, -ENOSYS from a host that does not serve pad state.
 *
 * Reads the host's `pad_state` slot: the host opens the pads, on the thread that
 * initialised SDL, and samples them once per pump. Gamepad edges still need a
 * class the session does not have; this verb is the state half only (INPUT.md
 * §3 Q5).
 */
int32_t input_pad(int32_t handle, int32_t slot, int32_t ptr, int32_t cap);

/*
 * `input_close(i32 handle) -> i32`  — verb_id 6, flags 0.
 *
 * Detaches and releases the handle. There is no window to destroy — it was
 * never input's — and no subsystem to leave up. 0, or -EINVAL for a bad handle.
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
 * `input_pad`, 48 bytes, 4-byte alignment — `tension_pad_record` in
 * `tension_adapter.h`, which is where the layout is now stated. The names here
 * are this header's spelling of the same three constants; the assertion below
 * is what keeps the two from drifting.
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
#define TENSION_INPUT_PAD_SIZE TENSION_PAD_RECORD_SIZE
#define TENSION_INPUT_PAD_VERSION TENSION_PAD_RECORD_VERSION
#define TENSION_INPUT_PAD_ATTACHED TENSION_PAD_RECORD_ATTACHED

/* How many gamepad slots this chunk serves. */
#define TENSION_INPUT_PAD_SLOTS TENSION_PAD_SLOTS

#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
_Static_assert(sizeof(tension_pad_record) == TENSION_INPUT_PAD_SIZE,
               "tension_input's pad size and the boundary's record disagree");
#endif

/* ── the event records ───────────────────────────────────────────────── */

/*
 * The two classes this capability posts on, from the session's class
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
 * list, and it is what "no window, nothing attached yet" answers with, because
 * none of the listed codes names that state. The amendment tension-core owes is
 * one line in that list; until it lands, this header and tension_ogre.h are
 * where the deviation is recorded.
 *
 *   -EINVAL  a bad handle, a kind above 4, a slot outside 0..7, a non-zero
 *            `flags`, or a refused guest destination
 *   -ENODEV  the host owns no window, or nothing is attached
 *   -ENOENT  an empty gamepad slot
 *   -ENOSYS  a host that does not serve pad state
 *   -EBUSY   the capacity is taken, already attached, or the control queue is
 *            full (retry next frame)
 *   -ENOSPC  a short buffer (`0 < cap < size`)
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_INPUT_H */
