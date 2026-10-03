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
- **`input_close` is the teardown that actually runs.** The host on `main`
  never calls the vtable's `shutdown` or `destroy` (`SESSION.md` §11 M3: the
  fix lives on `polish/loader-sibling-quiet`), so a capability that keeps a
  thread must release it through a verb or the DSO's own destructor has to. It
  tried the destructor and lost (below); `input_close` now detaches, stops the
  thread, and quits SDL, and a later `input_open` starts it again — the device
  precedent from `SESSION.md` §8, where a re-acquirable subsystem is exactly
  what a handle is for.

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

**Driver selection** is `TENSION_INPUT_DRIVER`. Unset or `auto`: no driver is
forced at `SDL_Init`, and the per-kind rule decides at attach — kind 1 (an X11
window id) forces x11, kind 0 (input's own surface) takes the platform's
choice. Any other value (`x11`, `wayland`, …) forces that SDL driver up front
with `OVERRIDE` priority, so the shell's `SDL_VIDEO_DRIVER` cannot change it;
an init failure retries once with no hint and logs the fallback. Measured on
this Wayland session: kind 0 under `auto` comes up on `wayland` and the
compositor grants no input focus without a click (round 21's finding,
unchanged); kind 0 under `TENSION_INPUT_DRIVER=x11` gets the X11 window whose
focus arrives unprompted; the example's kind-1 attach logs
`kind 1 needs 'x11', forcing it (was 'wayland')` and proceeds.

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
  (`INPUT.md` §3 Q2). The handle is also the lifetime: `input_close` releases
  the window, SDL, and the thread.

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
- **The DSO through the real host.** `tests/run.sh` loads
  `libtension_input.so` with `tension-core --capability` and drives it from a
  wasm guest — the whole path: the host's loader, `init`/`link`, the six
  imports, the session, and the guest SDK.
- `tests/run.sh` — three cases, all green: `with-display` (open, attach kind 0,
  a 96-byte state record, eight `-ENOENT` pad slots, close), `no-driver`
  (`SDL_VIDEODRIVER=` a name that cannot exist: `input_open` refuses `-ENODEV`
  and the guest prints `OK headless -ENODEV`), and `no-env` (no `DISPLAY`, no
  `WAYLAND_DISPLAY`).
- **The driver-forcing path, for real.** The same test creates an X11 window
  with Xlib and attaches it as kind 1 on a Wayland session: the log shows
  `kind 1 needs 'x11', forcing it (was 'wayland')`, SDL comes back up on x11,
  and the attach verifies at `400x300` — the size of the window that was
  created. `INPUT.md`'s "force the driver and verify the attach" is not
  theoretical; without the forcing, round 20 measured a live 1×1 window that
  was not the target.

## 7. Unverified, and the two hazards found while writing this

- **Keys and edges end to end.** The pump's post path is exercised only by
  inspection: no test has moved a mouse or pressed a key through the DSO yet,
  so `INPUT_KEY`/`INPUT_MOUSE` posts, the coalescing, and the `class_info`
  subscription check have no measurement behind them. The three rules have
  unit-level coverage (the isolation test's state reads) but not end-to-end.
- **An invalid token no longer reaches SDL, because it used to be fatal.**
  Measured three ways, with the isolation test's bogus XID (`0xdeadbeef`):
  1. against SDL alone, `BadWindow` inside its `XGetWindowAttributes` call
     reached **Xlib's default error handler, which exits the process** from
     SDL's thread — the verb never answered, and the DSO's destructor then
     self-joined and aborted;
  2. with a quiet `XSetErrorHandler` in the test, SDL *returned a window* built
     from an uninitialized `XWindowAttributes`, and the attach's size check
     refused it once (`-871452896x30600`) and accepted it once (the garbage was
     a positive size) — so the verify is not a guard for this case at all;
  3. either way the design's `-ENOENT` never happened.

  `attach` now resolves a kind-1 token itself, before SDL sees it: a
  `dlopen`'d `libX11` connection, a quiet handler for the probe and the
  previous handler restored after it (SDL installs one at `SDL_Init`; putting
  the default back would take its place), `XGetGeometry` plus `XSync` because
  X errors are asynchronous. The measured result is now deterministic: the real
  XID attaches at its true size, and the bogus one answers `-ENOENT` with the
  process alive. `-ENOSYS` (no libX11, no X display) leaves SDL's own answer in
  place, which is what a non-X platform gets.
- **The teardown hang, and why `input_close` owns the lifetime.** Measured: if
  the SDL thread is still alive when the process unloads the DSO, the host's
  `dlclose` runs the DSO's static destructor, which joined the thread and the
  thread called `SDL_Quit` — and `SDL_Quit` never returned (both threads ended
  in `futex_do_wait`; the process hung until killed). The destructor now stops
  the thread *without* SDL_Quit (the process is ending; SDL's own threads die
  with it), and the verb path does the real teardown. This is the one place the
  DSO's lifetime and the host's differ, and it is why `input_close` is more
  than a detach.
- **A driver that cannot deliver events still attaches.** Measured with
  `SDL_VIDEODRIVER=dummy` and `offscreen`: SDL comes up, the attach verifies at
  320x200, and the state record even says `flags=0xd` — ATTACHED, FOCUSED and
  POINTER_OVER, for a window that can never receive an event. The verify rule
  catches a wrong *window*, not a fake *platform*. Two policies are named and
  neither is chosen here: refuse those two driver names in `attach`, or give
  the state a bit that says "this subsystem cannot deliver input". A test host
  may legitimately want the first behaviour, which is why v0 records the
  measurement instead of picking for it.
- **`ret` is the guest's return value, not the shim's.** Measured by this
  capability's own fixture: a refusal that only did `return -ENOENT;` made the
  session log `adapter status -2` and answer the guest **0**
  (`tension-core/src/adapter/ffi.rs` puts `ret` in the wasm result slot and
  logs the status). Every shim here writes `ret` through `refuse()`. The same
  shape in `tension-ogre`'s `job_state`/`job_release` — `return found; // -ENOENT`
  — is invisible to guests today; that is a repair for the round that owns those
  verbs, not this one.
- **`-ENODEV` is outside the boundary's closed errno list.** Same deviation as
  `tension_ogre.h`'s, recorded in `include/tension_input.h`'s refusal section:
  none of `tension_adapter.h`'s codes names "no window or device yet". The
  amendment is one line in that list; until then both capability headers say so.
