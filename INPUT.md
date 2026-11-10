# INPUT.md — the input capability

What input is in a v7 host, what it owes the rest of the engine, and why its
shape is a subscriber rather than an owner.

**This page is the design statement.** The module page — verbs, event flow,
threading, tests — is [`docs/modules/input.md`](docs/modules/input.md), and the
wire is [`tension-input/include/tension_input.h`](tension-input/include/tension_input.h).
Where this page and the header disagree about a record, the header is what a
guest links against; where this page and the module page disagree about the
code, the module page is right.

## 1. The host owns SDL; input is a subscriber

There is one SDL in the process, initialised by the host on the thread that
creates the window, and `SDL_Quit` runs when the host's own `Sdl` drops
(`tension-core/src/platform.rs:1409-1440`). Input owns none of it: at `init` the
capability registers an *event layer* with `register_event_layer` and a mask of
every family but QUIT, and from then on the host pumps, translates, and calls
`dispatch` synchronously once per pump on the window's thread — thread rule 13,
`tension-core/include/tension_adapter.h:380-387`. That is the whole change: the
capability keeps its six verbs, its two records and its two edge classes, and
loses a thread, an `SDL_Init`, a poll loop and a window. The three measured
reasons it could not keep them are recorded in `tension_adapter.h:365-379` and
are worth reading before proposing a second pump: SDL's video subsystem belongs
to the thread that initialised it (illegal elsewhere, fatal on macOS); two
pollers split one queue nondeterministically (4000 pushed events came out
2452/1548 one run and 1796/2204 the next, nothing lost or duplicated); and a
second `SDL_Quit` tears the subsystem down under the host's window, which then
reports 0×0 and fails every later call.

## 2. The import module is unchanged

The capability still registers `tension::input`: six verbs, ids 1–6, every
parameter and every return `i32`, all registered during `link`
(`tension-input/src/adapter.cpp:342-396`). Nothing moved into the host, no verb
was added or renamed, and `state`/`pad` still carry
`TENSION_IMPORT_REENTRANT_READONLY` because they take a snapshot and write guest
memory without pumping or blocking. A guest compiled against v6 links and runs
unchanged; what changed is the *meaning* of one argument (§3) and the fact that
the edges it subscribes to are now posted from a layer instead of from a thread
this capability started. The wire is `tension-input/include/tension_input.h`;
`tension-framework/assembly/input.ts` is the guest SDK over it, and it too keeps
its shape.

## 3. `attach` — kept for compatibility, `kind` and the token ignored

`input_attach(handle, kind, lo, hi) -> i32` (verb 2,
`tension-input/src/adapter.cpp:193-216`). The four arguments are the v6 wire and
stay, because a guest that was compiled against v6 must keep linking; what v7
changed is that `kind`, `lo` and `hi` are **ignored**. There is one surface in a
v7 host — the window the host owns — and a capability joins it by subscribing,
so a token that names an X11 window or an HWND has nothing left to attach to.
`kind` is still range-checked (`0…4`, `-EINVAL` outside it) so a caller that
passes nonsense is told so, and the honest spelling of "no token" is
`Kind.OwnSurface` with zeros. The refusals that remain are about *state*, not
identity: `-ENODEV` when the host owns no window yet, and `-EBUSY` on a second
attach. That makes the ordering explicit — `platform.create_window`, then
`input.open`, then `input.attach` — and makes `-ENODEV` a retry rather than a
verdict: the window is created synchronously by `platform.createWindow`, but the
host's own record of it is what the verb checks, so a guest may see `-ENODEV`
for a frame or two after a window it just made.

## 4. `state`, `pad`, `set_relative`

`state(handle, ptr, cap)` (verb 4, `adapter.cpp:234-265`) writes the 96-byte
state record — held keys as 256 scancode bits, mouse buttons, the motion delta
since the previous snapshot, wheel, and the session `seq` of the last epoch the
snapshot includes. `cap <= 0` is a probe that returns the size and writes
nothing; a short buffer is `-ENOSPC`; a read with no attach is `-ENODEV`. **The
read consumes the delta**: floats are authoritative and the integers are their
truncation with the remainder carried into the next snapshot, so a slow subpixel
drag degrades in resolution but never disappears. The first 500 ms of motion
after a successful attach is discarded (`kAttachSettleMs`,
`tension-input/src/input.h:41`): it is the window settling under the pointer and
the confinement warp, measured at 137 ms and 343 ms. `pad(handle, slot, ptr,
cap)` (verb 5, `adapter.cpp:266-291`) writes one 48-byte slot from the host's
mirror, and answers `-ENOENT` for an empty slot — zero gamepads is a normal
state, not a failure. `set_relative(handle, on)` (verb 3, `adapter.cpp:217-233`)
routes through `post_control` with `TENSION_CTRL_RELATIVE_MOUSE` and returns once
the request is *queued*, not once it is applied: the host's executor runs in the
host loop and is the only caller of `SDL_SetWindowRelativeMouseMode`. The
`RELATIVE` bit in `state()` therefore reports the request the host accepted, and
the host logs any refusal at the moment it tries.

## 5. Teardown guarantees

The host calls the vtable's `shutdown` then `destroy`, once each, reverse of link
order, on both exit paths (`tension-core/src/adapter/mod.rs:1021-1049`, reached
from `tension-core/src/main.rs:1943` on a trap and `:2015` on a clean return),
and `dlclose`s the library afterwards. So `adapter_shutdown`
(`adapter.cpp:411-426`) is the capability's one teardown hook, and it
unregisters the layer *first* — before anything else, because the host tears
layers down after the adapters and a layer left registered would be a call into
code the loader is about to unmap. The layer struct's own `shutdown` is a
deliberate no-op: the host has already stopped dispatching by then
(`adapter.cpp:153-155`). The window and the event bus go last and in that order:
`drop_host_window` clears the dispatcher's layers, then closes the 2D canvas,
then drops the window (`main.rs:2029-2064`), which is what makes "no pump can
dispatch into a destroyed adapter" true. **No adapter calls `SDL_Quit`** — the
host's `Sdl` owns the subsystem and quits it once, on the thread that
initialised it. `input_close` (verb 6, `adapter.cpp:292-302`) still exists and
still matters for a guest that wants to re-open within one session; it detaches
and releases the handle, and a handle left open is released by `shutdown`
anyway.

## 6. Portability

The capability builds wherever the host builds, because nothing in it names a
platform: no SDL header, no `libX11`, no `dlopen` probe, no thread. The build
recipe is `scripts/build-input.mjs`, it has no platform gate, and it prints the
DSO's `DT_NEEDED` so a reader can check the claim: `libstdc++`, `libm`,
`libgcc_s`, `libc`, and the recipe fails if `SDL` appears there. Keys, buttons,
wheel and motion all arrive already translated by the host, so the platform
differences that used to live here — which token a window has, which driver
delivers raw motion — are the host's business now. Windows compiles as of v7;
it has not been run there, and `docs/known-limitations.md` says so ("`tension-input`
on Windows") rather than implying a tested platform. The one platform-shaped thing left in the tree is
the *measurement*, not the capability: `scripts/test-input-edge.mjs` injects
real server events through XTEST, so it is a Linux/X11 probe and says so when it
skips.

## 7. Where the rest lives

- Verbs, event flow, threading and tests: [`docs/modules/input.md`](docs/modules/input.md).
- The records and their offsets: [`tension-input/include/tension_input.h`](tension-input/include/tension_input.h).
- The host's ownership of SDL, the window and the surface: [`docs/architecture.md`](docs/architecture.md) §2–3.
- The event wire and thread rule 13: `tension-core/include/tension_adapter.h`.
