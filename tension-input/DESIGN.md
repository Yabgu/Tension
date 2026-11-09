# DESIGN.md — the input capability

What this DSO does, what was measured while making it do it, and what is still
open. `INPUT.md` is the design document; **it still describes the pre-v7
thread model and is scheduled for a rewrite in V7c** — until then, this file is
the accurate one and `INPUT.md` is the one to distrust.

## 1. What this is

`libtension_input.so`: a capability adapter (`tension_adapter_v1`) that
registers the `tension::input` namespace. **It owns no SDL, no thread and no
window.** From v7 the host initialises the video subsystem, owns the window, and
pumps the event queue on the thread that did so; this capability registers an
**event layer** and is handed a batch once per pump (`tension_adapter.h`, thread
rule 13).

That was not always true. Until v7 the DSO ran its own thread whose first act
was `SDL_Init`, polled the queue every 2 ms, and created or attached a window of
its own. Three measured facts made that untenable:

1. SDL requires the video subsystem to be used from the thread that initialised
   it; a second `SDL_Init` elsewhere is illegal and fatal on macOS.
2. Two pollers on one queue split it nondeterministically — 4000 pushed events
   came out 2452/1548 on one run, 1796/2204 on the next.
3. A second `SDL_Quit` on that thread tears the subsystem down under the host's
   own window, which then reports 0×0 and fails every later call.

## 2. Layout

- `include/tension_input.h` — the boundary: six imports, two records with their
  offsets, the event shapes, the refusal vocabulary. No SDL header, and no SDL
  dependency behind it.
- `src/input.h` — the records as C++ sees them (with `static_assert`s against
  the header's sizes) and `Mirror`, the state the layer keeps.
- `src/input.cpp` — the translation from `tension_event` batches to state and
  edges. No SDL call, no thread, no window.
- `src/adapter.cpp` — the vtable, the layer subscription, and the six shims.
- `scripts/build-input.mjs` — the build. It prints the DSO's `DT_NEEDED` and
  fails if `SDL` appears there.

## 3. The layer, and what a frame looks like

`init` calls `register_event_layer` with the mask
`KEY | TEXT | MOUSE_MOTION | MOUSE_BUTTON | MOUSE_WHEEL | WINDOW | PAD` — every
family but QUIT, which the host handles and a layer cannot act on. `shutdown`
calls `unregister_event_layer` before anything else, because the host tears its
layers down *after* the adapters (`main.rs`'s ordering) and a layer left
registered would be a call into code the loader is about to unmap.

`dispatch(layer_user, events, count)` runs on the window's thread, synchronously
after a pump, and returns 0 (consumed) always: ingesting an event cannot fail —
an unknown family is skipped, an out-of-range scancode is dropped. It updates
the mirror under one mutex and posts the edges.

The pump sites are the host's, not this capability's:

- the host loop's own iteration (0.7.0a guests, and anything with a renderer);
- the start of a blocking `session::wait` / `session::drain`, which is the only
  place a guest that drives its own loop yields to the host.

**The second site is load-bearing and was found the hard way.** Before it, a
renderer-less guest — a text game, which is the case this capability exists for
— pumped nothing at all. The same gap existed for the control executor:
`input.set_relative(true)` queued `TENSION_CTRL_RELATIVE_MOUSE`, the request sat
in the queue forever, and the pointer was never grabbed. Both now run on the
blocking path, in that order: pump, then execute controls, then the epoch.

## 4. The four measured rules, in the code

Three came across from the thread model unchanged, because they are about SDL's
*data*, not about who polls it:

1. **`which == 0` is not a device.** Motion whose device id is 0 is the pointer's
   position changing because a window moved under it; it is dropped before the
   accumulator.
2. **The attach settles.** The first 500 ms of motion after a successful attach
   is discarded (`kAttachSettleMs`): measured at 137 ms (347 px, absolute mode)
   and 343 ms (112 px, relative mode). Attaching is immediately followed by a
   relative-mode request, and the warp that produces is one enormous delta.
3. **Motion is not an event.** It accumulates in the mirror; one `(int, float)`
   delta is published per snapshot, with the float's remainder carried into the
   next one.

The fourth is new, and is the reason the thread could go:

4. **Every sample the host hands over is accumulated before anything reads it.**
   A guest's total therefore depends on the device's displacement and not on its
   frame rate — measured at 2, 16 and 33 ms pump cadences against a 400 px
   injected flick: 400 px each time (`scripts/test-input-edge.mjs`).

Keys, mouse buttons and wheel are edges and are posted on `INPUT_KEY` (6) and
`INPUT_MOUSE` (7); posting is skipped when `class_info` says the class has no
subscriber. The sequence number the session returns is kept as `state.seq` — the
last *edge*'s, exactly as before, since motion never posts.

The state record's `pads_present` is asked of the host's `pad_state` slot once
per snapshot rather than tracked from PAD events: the host owns the slot map, and
a layer that registered after a pad was already connected never saw an ADDED.

## 5. Verbs, and what changed about them

- `open(flags)` — handle bookkeeping only. Nothing device-shaped happens, so
  nothing device-shaped can fail; in particular it no longer answers `-ENODEV`.
- `attach(handle, kind, lo, hi)` — **`kind`/`lo`/`hi` are ignored.** There is one
  surface in a v7 host and a capability joins it by subscribing. The four-word
  wire is kept so a v6-compiled guest still links and its `kind` stops meaning
  anything rather than becoming a different failure. `-ENODEV` when the host owns
  no window yet, `-EBUSY` on a second attach.
- `set_relative(handle, on)` — posts `TENSION_CTRL_RELATIVE_MOUSE`. The host's
  executor is the only caller of `SDL_SetWindowRelativeMouseMode`. The RELATIVE
  bit reports the request the host accepted into its queue.
- `state`, `pad` — unchanged read shapes; `pad` now forwards to `pad_state`
  (mapping the host's `-ENODEV` to this verb's documented `-ENOENT`).
- `close(handle)` — detach, release. Nothing to destroy.

## 6. Verified

- The DSO's `DT_NEEDED` is `libstdc++`, `libm`, `libgcc_s`, `libc`. The build
  gate fails if SDL appears.
- `scripts/test-input.mjs`, four cases: `with-display` (guest creates a 320×200
  window, opens, attaches, reads state, walks all eight pad slots, requests
  relative mode twice, closes), `no-window` (attach → `-ENODEV`), `no-driver`
  (a driver that does not exist → no window → the headless answer), `no-env`.
- `scripts/test-input-edge.mjs`, the measurement: fidelity (the hard gate),
  latency, and the batch-overflow contract. Numbers in §7.

## 7. Measured on this rig (X11 via xrdp, SDL 3.4.18)

- **Fidelity.** 400 injected px over 200 ms, guest accumulating `state()` once
  per frame: 400 px at 2 ms, 16 ms and 33 ms pump cadences. No loss.
- **Latency** (600 key edges per cadence, same CLOCK_MONOTONIC on both sides):

  | pump | median | p99 | max |
  | --- | --- | --- | --- |
  | 2 ms | 6.6 ms | 12.8 ms | 15.1 ms |
  | 16 ms | 17.4 ms | 32.2 ms | 34.8 ms |
  | 33 ms | 40.4 ms | 77.7 ms | 78.4 ms |

  The medians track the cadence plus the epoch's own cost; a p99 near two
  cadences is a frame that ran long, not a lost event.
- **Host cost** (`platform_events`'s `pump_cost`): pump 10.5 µs, dispatch of a
  six-event batch 1.2 µs — 0.07 % of a 60 Hz frame, 0.28 % of a 240 Hz one.
- **Overflow.** A 300-event burst against a 33 ms cadence delivered 256 and
  reported 44 as not fitting, which is the batch capacity and the excess, i.e.
  the contract in rule 13 holding exactly.

## 8. Unverified, and one bug this pass found

- **The ring reclaim.** A guest that subscribes with a `BATCHED` callback never
  advanced its sub-ring's `tail`; only `rt.deliver` did, and only for host-loop
  guests. Measured here: exactly 256 `INPUT_KEY` edges arrived and then no key
  ever arrived again for the rest of the session. The host now makes the same
  write on the guest's behalf when a batch callback returns
  (`session::subring::reclaim_through`). This was pre-existing and would have
  hit the old DSO identically; nothing had ever put 256 key edges through a
  session before.
- **Gamepad hardware.** `pad_state` is implemented and sampled, but no pad has
  been plugged into this rig, so what the host's mirror reports for a real
  controller is unmeasured. `-ENODEV` for every slot is verified.
- **Windows.** The source is portable as of v7b (no SDL, no `libX11`, no thread),
  but `scripts/build-input.mjs` still refuses Windows until V7c lands the docs
  that explain the change, and nothing has been built there.
- **A driver that cannot deliver events still creates a window.** Measured
  before v7 with `SDL_VIDEODRIVER=dummy`/`offscreen`: SDL comes up, the window
  exists, and the state record even says FOCUSED and POINTER_OVER for a window
  that can never receive an event. Unchanged by v7, and still a measurement
  rather than a policy.
- **`ret` is the guest's return value, not the shim's.** A refusal that only did
  `return -ENOENT;` makes the session log `adapter status -2` and answers the
  guest **0**. Every refusal in `adapter.cpp` writes both; `refuse()` is the one
  place that does.
