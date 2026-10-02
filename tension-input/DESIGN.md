# DESIGN.md — the input capability

The implementation of `INPUT.md`. **That document owns the design** — the five
architectural questions, the wire, the thread model, the migration — and this
one records what the code does, what was measured while writing it, and what is
still unverified. Where the two disagree, `INPUT.md` is the argument and this
is the bug.

## 1. What this is

`libtension_input.so`: a capability adapter (`tension_adapter_v1`) that
registers the `tension::input` namespace and owns SDL3 for a process. It is the
DSO from `INPUT.md` §3 Q2 (b), with the two aspects of that section's table:

| Aspect | Identity | Failure | Kind | Where it lives |
| --- | --- | --- | --- | --- |
| the SDL subsystem (one `SDL_Init`, one event queue, one video driver) | process | fatal | singleton | `src/input.cpp`, the thread's first act |
| the attached surface (one window, its device set, its held state) | caller | recoverable | session | the `input_open` handle, capacity 1 |

The host never names SDL. The renderer never learns that input exists. The
guest is the mediator (`INPUT.md` §3 Q1): it takes a token from
`ogre::window_handle`, hands it to `input_attach`, and neither capability
learns the other's name.

## 2. Layout

- `include/tension_input.h` — the boundary: the six imports, the two records
  with their offsets, the event shapes, and the refusal vocabulary. No SDL
  header leaks through it.
- `src/input.h` — the records as C++ sees them (with `static_assert`s against
  the header's sizes) and `InputThread`.
- `src/input.cpp` — the only file that includes SDL. The thread, the pump, the
  pad table, the mirror.
- `src/adapter.cpp` — the vtable and the six shims. No SDL here either.
- `build.sh` — `pkg-config sdl3`, `-shared -fPIC`, and it prints the DSO's
  `DT_NEEDED` so a reviewer can see `libSDL3.so.0` without asking.

## 3. The thread model

`INPUT.md` §3 Q4's recommendation, implemented exactly:

- `init` creates the thread; its first act is `SDL_Init(SDL_INIT_VIDEO |
  SDL_INIT_GAMEPAD)`. `start()` waits for that result (a condition variable,
  5 s bound) so `init` returns knowing what happened — it returns **0** either
  way, because the refusal point for "no display" is `input_open`/`input_attach`
  (which retry the subsystem), not load. A thread that cannot be created is
  `-EIO`.
- Every other call into the thread is a request with an answer: the caller
  parks a request, wakes the thread, and waits bounded (5 s). That is why
  `input_attach` can live on the interpreter thread while
  `SDL_CreateWindowWithProperties` runs on the SDL thread.
- `shutdown` asks the thread to stop, joins it, and `SDL_Quit` runs on the
  thread that ran `SDL_Init` (the vtable's `shutdown` contract, and the reason
  the teardown is on that thread at all).

Round 21's probe measured this architecture as viable before it was written:
SDL on a dedicated thread, OGRE pumping its own X connection on another, no
serialisation between them, 11,829 motion events delivered while OGRE rendered
83,858 frames.

## 4. The three measured rules, in the code

All three are round 21's corrections to `INPUT.md`, and each has a line in
`pump_events`:

1. **`which == 0` is not a device.** Motion with `which == 0` is the pointer's
   position changing because a window moved under it; it is dropped before the
   accumulator.
2. **The attach settles.** The first 500 ms of motion after a successful attach
   is discarded (`kAttachSettleMs`): measured at 137 ms (347 px, absolute mode)
   and 343 ms (112 px, relative mode) of settling, not input.
3. **Motion is not an event.** It accumulates in the thread's mirror; one
   `(int, float)` delta is published per `input_state` snapshot, with the
   float's remainder carried into the next one. A 1 kHz device against the
   session's 64-slot `INPUT_MOUSE` ring is a statistic, not a stream.

Keys, mouse buttons and wheel are edges and are posted on `INPUT_KEY` (6) and
`INPUT_MOUSE` (7); posting is skipped when `class_info` says the class has no
subscriber, which is what that flag is for. The sequence number the session
returns from `post_event` is kept as the state record's `seq`.

## 5. What v0 is and is not

- **No regions.** The vtable's `publish` is `NULL` — the adapter owns none — so
  the state crosses through `input_state` into a caller-provided buffer. The
  region is `INPUT.md` §5's M2, for the day a consumer needs state from inside
  a callback.
- **No gamepad edges.** They need a class the session does not have (`INPUT.md`
  §5 M3). `input_pad` is the state half, and with zero pads every slot answers
  `-ENOENT` — a normal state, not a failure (`INPUT.md` §3 Q2).
- **Two token kinds of four.** Kind 0 (input's own surface) and kind 1 (an X11
  window id) are served; kinds 2–4 answer `-ENOSYS` until a platform that makes
  them meaningful exists.
- **Capacity one**, declared, with the handle in the first version anyway
  (`INPUT.md` §3 Q2).

## 6. Verified

- `build.sh` exits 0 with zero warnings; the DSO's `DT_NEEDED` is
  `libSDL3.so.0`, `libstdc++`, `libm`, `libgcc_s`, `libc` — SDL is the only
  capability dependency, and the host is not one.
- The six imports register with the right verb ids and flags (the two readers
  carry `TENSION_IMPORT_REENTRANT_READONLY`).
- Driven by a stub core in `/tmp/input-dso-test` (dlopen, `tension_adapter_v1`,
  `init`, `link`, then the verbs): `open` → handle 1; `state` before `open` →
  `-EINVAL`; `state`/`pad` unattached → `-ENODEV`; `attach(0)` → 0 and a window
  of its own; `state` probe → 96; `state` → a 96-byte record with
  `version=1 flags=0x1`; `set_relative(1)` → 0; `pad(0)` → `-ENOENT`; `close` →
  0; `shutdown` → 0, thread joined.
- **The driver-forcing path, for real.** The same test creates an X11 window
  with Xlib and attaches it as kind 1 on a Wayland session: the log shows
  `kind 1 needs 'x11', forcing it (was 'wayland')`, SDL comes back up on x11,
  and the attach verifies at `400x300` — the size of the window that was
  created. `INPUT.md`'s "force the driver and verify the attach" is not
  theoretical; without the forcing, round 20 measured a live 1×1 window that
  was not the target.

## 7. Unverified, and the two hazards found while writing this

- **A real guest through the host.** The DSO has only been driven by the stub
  core; nothing has loaded it through `tension-core --capability` and called it
  from wasm. The fixture in `tests/` is the first step, not the proof.
- **Keys and edges end to end.** The pump's post path is exercised only by
  inspection: no test has moved a mouse or pressed a key through the DSO yet.
- **An invalid token is dangerous on X11, and the DSO cannot make it safe.**
  Measured: attaching a bogus XID (`0xdeadbeef`) raises `BadWindow` inside
  SDL's `XGetWindowAttributes` call, and **Xlib's default error handler exits
  the process** before the verb can answer — the design's `-ENOENT` never gets
  to happen. With a quiet `XSetErrorHandler` installed in the test, SDL returns
  a window whose geometry is uninitialized garbage (`-871452896x30600`), and
  the attach's verify check is what refuses it (`-EIO`). Two consequences are
  recorded rather than papered over: the verify check is the only thing
  standing between a bad token and a garbage attachment, and a positive garbage
  size would pass it. The owed follow-up is a Linux-side pre-check (a
  `dlopen`'d `libX11` `XGetWindowAttributes` with a quiet handler) before the
  token reaches SDL; it is not in v0 because it is platform code the skeleton
  does not need yet, and because the realistic producer of the token is
  `ogre::window_handle`, which hands out a real XID.
- **`-ENODEV` is outside the boundary's closed errno list.** Same deviation as
  `tension_ogre.h`'s, recorded in `include/tension_input.h`'s refusal section:
  none of `tension_adapter.h`'s codes names "no window or device yet". The
  amendment is one line in that list; until then both capability headers say so.
