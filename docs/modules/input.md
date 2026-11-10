# tension-input — the input capability

`tension-input` is the capability DSO behind the wasm import module
`tension::input`. It is a **subscriber on the host's event bus**, not the owner
of a window, a keyboard or SDL: the host initialises the video subsystem, owns
the window and pumps the queue, and this module is handed a batch of translated
events once per pump and keeps a *mirror* of what they said.

**It is a DSO, and it stays one.** Unlike `tension-2d`, which became an in-core
module, input is optional: a build that has no input loads no input code, and the
capability pays for itself only when it is asked for. It owns no regions,
publishes nothing into the arena, and keeps no state the guest cannot reconstruct
from the verbs.

The design statement is [`INPUT.md`](../../INPUT.md); this page is the code. It
is derived from `tension-input/src/`, `scripts/build-input.mjs` and the suites
that exercise them. Every claim carries a `file:line`; a bare filename means a
file under `tension-input/src/`.

## 1. What this module is

An adapter implementing `tension_adapter_v1` (`adapter.cpp:437-449`): six
imports registered during `link` (`adapter.cpp:342-396`), one event layer
registered during `init` (`adapter.cpp:304-340`), `publish` and `apply` NULL. The
state is a `Mirror` (`input.h:96-160`) — held keys, mouse buttons, the motion
accumulator, the wheel, the focus bits — and every verb reads or writes it.

What it is **not**:

- **Not a window owner.** There is no window here and no handle for one
  (`INPUT.md` §3). `attach` answers only "is there a host window to join".
- **Not an SDL user.** No SDL header, no `SDL_` symbol, no `DT_NEEDED` on SDL —
  the build prints the list and fails if `SDL` appears in it
  (`scripts/build-input.mjs`).
- **Not a thread owner.** Before v7 it was; the layer replaced it
  (`INPUT.md` §1).

## 2. The six verbs

Module `tension::input`, every parameter and return `i32`, every registration
`TENSION_VT_I32`. Signatures and guest wrappers are in `docs/abi/guest.md` and
`tension-framework/assembly/input.ts`; this table is what each does and how it
refuses.

| # | verb | signature | what it does | refuses |
|---|---|---|---|---|
| 1 | `open` | `(flags) -> handle` | handle bookkeeping only; no device is opened | `-EINVAL` non-zero flags, `-EBUSY` already open |
| 2 | `attach` | `(handle, kind, lo, hi) -> i32` | joins the host's window; **`kind`/`lo`/`hi` ignored** | `-EINVAL` handle/kind, `-ENODEV` no host window, `-EBUSY` already attached |
| 3 | `set_relative` | `(handle, on) -> i32` | queues `TENSION_CTRL_RELATIVE_MOUSE` on the host's control queue | `-EINVAL` handle, `-ENODEV` not attached, `-ENOSYS` no control queue, `-EBUSY` queue full |
| 4 | `state` | `(handle, ptr, cap) -> bytes` | fills a 96-byte snapshot; `cap <= 0` probes the size | `-EINVAL` handle/write, `-ENODEV` not attached, `-ENOSPC` short buffer |
| 5 | `pad` | `(handle, slot, ptr, cap) -> bytes` | one 48-byte pad slot from the host's mirror | as `state`, plus `-ENOENT` for an empty slot |
| 6 | `close` | `(handle) -> i32` | detach and release the handle | `-EINVAL` unknown handle |

`state` and `pad` are the two `TENSION_IMPORT_REENTRANT_READONLY` verbs
(`adapter.cpp:360-373`): they take a snapshot and write guest memory, and never
pump or block. Nothing here is `DEFERRABLE`, so `apply` is NULL.

**The `ret` hazard.** The session puts the shim's `ret` into the wasm result slot
and only logs the shim's own return value. A refusal that only did
`return -ENOENT;` answers the guest **0** — measured by this capability's own
fixture, which saw `pad(0)` succeed while the session logged `adapter status -2`.
Every refusal therefore writes both, through one function (`refuse()`,
`adapter.cpp:72-76`).

## 3. The event flow

```
SDL queue
  └─ HostWindow::pump          platform.rs:1667   drain, translate, cap at 256
      └─ HostShared::dispatch  platform.rs:1078   EventBus: snapshot the layers
          └─ dispatch(layer_user, events, count)  adapter.cpp:147-150
              └─ Mirror::ingest                   input.cpp:84-178
                  ├─ edges  → post_event  CLASS_INPUT_KEY (6), CLASS_INPUT_MOUSE (7)
                  └─ motion → accumulator  (never posted)
                      └─ state()/pad() read the mirror on the guest's next call
```

**The translation is the host's**, not this module's: `pump` turns an
`SDL_EVENT_KEY_DOWN` into a `tension_event` with the family, flags and packing
the wire declares (`platform.rs:1728-1790` and on). This module therefore never
sees a keycode's SDL type, a scan code's `Option`, or a driver's name — only the
translated record.

**Edges are posted, motion is accumulated.** Key, button and wheel events are
edges: they go through `post_event` on classes 6 and 7, and posting is skipped
when `class_info` reports no subscriber (`input.cpp:221-227`). Motion is not an
event at the consumer's timescale — a 1 kHz device against a 64-slot ring is a
statistic — so it accumulates in the mirror and one `(int, float)` delta is
published per snapshot (`input.cpp:189-219`).

**The batch is bounded and the excess is counted.** `EVENT_BATCH_CAPACITY` is 256
(`platform.rs:481`); a burst larger than that is delivered up to the cap, the
remainder is counted and logged by `pump_host_window` (`main.rs:2689-2700`), and
a layer is expected to coalesce what it needs rather than assume one batch is the
whole drain.

**The sub-ring reclaim.** A guest that subscribes `BATCHED` used to advance its
class sub-ring's `tail` only through `rt.deliver`, which a host-loop guest
reaches but a self-driven guest does not. Measured here: exactly 256 `INPUT_KEY`
edges arrived and then no key ever arrived again for the rest of the session —
the ring was full and nothing reclaimed it. The host now writes the same tail
when a batch callback returns (`session::subring::reclaim_through`,
`tension-core/src/session/epoch.rs:335`). The bug predated v7 and would have hit
the old DSO identically; nothing had ever put 256 key edges through a session
before.

**Three pump sites, one dispatcher.** The host loop (`main.rs:2808`), the start of
a blocking `session::wait`/`drain` (`epoch.rs:106`), and the 2D renderer's present,
which already holds the window. The second is the one that matters for a
renderer-less guest: without it a text game pumps nothing at all.

## 4. The threading model

Everything is the **main thread**: the thread that created the window runs the
pump, and the same call dispatches (`platform.rs`'s `HostShared`; rule 13 in
`tension_adapter.h:380-387`). The guest calls the verbs on the interpreter
thread, which is that same thread. So the `Mirror`'s mutex (`input.h:96-105`)
is never contended in practice; it exists because "same thread today" is not a
property the type can check.

**`dispatch` is synchronous and cannot be skipped.** The event bus copies its
layer table under the lock and releases it before calling; a layer that is slow
delays the next pump, but it cannot miss a frame's events by being late, and a
guest cannot cause a dispatch from inside its own code.

**One request crosses the boundary.** `set_relative` does not touch a window: it
queues `TENSION_CTRL_RELATIVE_MOUSE` with `TENSION_CTRL_CORE_ONLY` and returns
once the message is *queued* (`adapter.cpp:116-136`). The host's executor is the
only caller of `SDL_SetWindowRelativeMouseMode`, and it drains the queue in the
same two places the pump runs.

## 5. The measured rules, in the code

Four rules, and each one is a measurement rather than a preference:

1. **`which == 0` is not a device.** Motion whose device id is 0 is the pointer's
   position changing because a window moved under it; it is dropped before the
   accumulator (`input.cpp:108-112`).
2. **The attach settles.** The first 500 ms of motion after a successful attach
   is discarded (`input.h:41`, `kAttachSettleMs`): measured at 137 ms (347 px,
   absolute mode) and 343 ms (112 px, relative mode) of motion with the pointer
   provably stationary before and after.
3. **Motion is not an event.** It accumulates; the float fields are authoritative
   and the integers are their truncation, with the remainder carried into the
   next snapshot (`input.cpp:189-219`).
4. **Every sample the host hands over is accumulated before anything reads it**,
   so a guest's total depends on the device's displacement and not on its frame
   rate.

The numbers behind rule 4, from `scripts/test-input-edge.mjs` on an X11 rig
(SDL 3.4.18). The same binary, run against a nested `Xephyr` server on the
Wayland rig, reproduced them exactly — 400 px at 2, 16 and 33 ms:

| pump cadence | 400 px injected over 200 ms, observed |
|---|---|
| 2 ms | 400 px |
| 16 ms | 400 px |
| 33 ms | 400 px |

Latency of a key edge, same clock on both sides (600 edges per cadence). Two
sessions, because the transport dominates: X11 over `xrdp`, and a nested
`Xephyr` server on the same machine (SDL 3.4.18 both times).

| pump | xrdp median | xrdp p99 | xrdp max | Xephyr median | Xephyr p99 | Xephyr max |
|---|---|---|---|---|---|---|
| 2 ms | 6.6 ms | 12.8 ms | 15.1 ms | 1.4 ms | 2.9 ms | 3.1 ms |
| 16 ms | 17.4 ms | 32.2 ms | 34.8 ms | 8.8 ms | 16.9 ms | 17.0 ms |
| 33 ms | 40.4 ms | 77.7 ms | 78.4 ms | 27.5 ms | 67.0 ms | 69.3 ms |

The medians track the cadence plus the epoch's own cost, which is the shape the
second column makes obvious: a key waits at most one pump, and the median is
about half of it. What the first column adds is the remote display's latency,
not the dispatcher's.

Host cost: a pump of 10.5 µs and a six-event dispatch of 1.2 µs — 0.07 % of a
60 Hz frame, 0.28 % of a 240 Hz one. Overflow: a 300-event burst against a 33 ms
cadence delivered 256 and reported 44 as not fitting, which is the batch
capacity and the excess.

**These are point-in-time measurements, not a gate on every machine.** The
fidelity gate re-runs them; §7 says which display it needs and what the two ways
it can go wrong look like.

## 6. Refusals and the normal states

- **Zero gamepads is normal.** `pad(slot)` answers `-ENOENT` for every slot while
  nothing is attached: the state, not an error. The host's `pad_state` slot
  reports `-ENODEV` per empty slot and this verb maps it (`adapter.cpp:266-290`).
- **No window is a state, not a failure.** `attach` answers `-ENODEV` before the
  guest has created one and `open` never answers it at all, which is what makes
  `create_window → open → attach` work in that order (`adapter.cpp:174-215`).
- **A driver that cannot deliver events still creates a window.** Measured with
  `SDL_VIDEODRIVER=dummy`/`offscreen`: SDL comes up, and the state record even
  says FOCUSED and POINTER_OVER for a window that can never receive an event.
  This is a measurement rather than a policy; nothing in the capability can tell
  the difference.
- **A second attach is `-EBUSY`,** not a silent re-point: one layer per process,
  because a second registration would double every edge (`adapter.cpp:304-340`).

## 7. Tests and coverage

**`scripts/test-input.mjs`** — the capability's own gate. It builds the DSO,
compiles `tests/guest-input.ts` with the framework's generated flags, and runs
four cases against a real host:

- `with-display` — the guest creates a 320×200 window, opens, attaches, reads a
  state record and walks all eight pad slots, requests relative mode twice, closes;
- `no-window` — attach with no window → `-ENODEV`;
- `no-driver` — a video driver that does not exist → no window → the headless answer;
- `no-env` — no `DISPLAY`, no `WAYLAND_DISPLAY` → one of the two legal answers.

**`scripts/test-input-edge.mjs`** — the measurement, and the only *fidelity*
gate: 400 injected pixels at 2, 16 and 33 ms cadences must sum to 400 ± 1. It
needs real server events (XTEST) and `xdotool` to locate the guest's window, so
it is Linux/X11-only and says so. Run it as `node scripts/test-input.mjs --edge`
or directly; both invoke the same `run()`.

**`scripts/test-ogre.mjs`** — the windowed half of that suite's opt-in block now
runs `examples/ogre/input-camera` bounded to 30 frames
(`TENSION_OGRE_WINDOW_TEST=1`). It is the only case in the tree with two
capabilities loaded, and it asserts the end-to-end attach path: a real host
window, `input.attach` finding it through `host_window_info`, `input.state`
answering every frame, and a clean exit with a frame summary. It does not inject
input, so it proves the plumbing and not a keystroke.

**What is not covered:** a Windows runtime (the DSO compiles there, nothing runs
the suite there — `docs/known-limitations.md`), and gamepad hardware (no pad has
been plugged into the rig; `-ENODEV` for every slot is what is verified).

**Where the measurement must run.** XTEST injects into whichever display
`DISPLAY` names, so the suite needs one it controls. Against a live desktop
session it is not wrong, it is *contaminated*: the operator's own pointer is
also moving, and the accumulator cannot tell the two apart — measured on this
rig against the running XWayland display, one cadence read 349 px of a 400 px
injection while another read −80 px, which is the operator's mouse, not the
probe. Against a private X server the same binary reproduces the injection
exactly, at every cadence, with the numbers in the table above:

```sh
Xephyr :7 -screen 1280x800 -ac +extension XTEST +extension GLX &
DISPLAY=:7 SDL_VIDEODRIVER=x11 node scripts/test-input-edge.mjs
```

Two consequences for reading a failure. `0 px` at every cadence is a display
that took no events — no XTEST on it, or no `xdotool` in `PATH`; the suite names
both before it starts. A *negative* or wildly large delta is real input from a
person or another client on that display, not a dispatcher defect. The gate has
no tolerance for either, which is why it must be given a display nobody else is
using.

## 8. Non-goals

- **Input is not a rendering concern.** It works with no renderer loaded; the
  window it joins is the host's, not Ogre's.
- **Input is not `io`.** `io` is stdin/stdout and the argument vector, a
  process-scoped byte stream, fatal when broken. Input is a device surface with a
  rate, lossy by construction, caller-scoped, and it shares no namespace with
  `io`.
- **Gamepad goes through the host's `pad_state`,** which reads SDL's controller
  database. No custom HID, no evdev, no per-platform backend, no remapping table
  of our own.
- **No text/IME input in v0.** Composition is its own problem (IME, dead keys,
  per-locale state) and does not ride `INPUT_KEY`.

## 9. Source index

| File | What it settles |
|---|---|
| `include/tension_input.h` | the boundary: six verbs, two records with their offsets, the refusal vocabulary |
| `src/input.h` | the records as C++ sees them, and `Mirror` |
| `src/input.cpp` | `tension_event` → state and edges; no SDL, no thread, no window |
| `src/adapter.cpp` | the vtable, the layer subscription, the six shims |
| `../../scripts/build-input.mjs` | the build, and the `DT_NEEDED` check |
| `tests/guest-input.ts` | the fixture the suite compiles |
| `../../scripts/test-input.mjs` | the four cases |
| `../../scripts/test-input-edge.mjs` | fidelity, latency, overflow |
