# INPUT.md — the input capability

What an input capability is allowed to assume, what it owes the rest of the
engine, and the shape it should take.

**This is a design statement, not a description of the code.** Nothing here is
implemented: there is no `tension-input/`, no `libtension_input.so`, no adapter
registering a `tension::input` module. Where the design leans on something that
*is* implemented it cites file and line; where it leans on measurement it cites
round 20's feasibility probe (raw output in `/tmp/sdl-probe/`); where it leans on
judgment it says so.

**The measured base**, because the rest of the doc leans on it:

- SDL3 3.4.16 attaches to OGRE-Next 3.0's GL3Plus window on this machine, first
  try, given the X11 window id `getCustomAttribute("WINDOW")` returns (18874370,
  `0x1200002` — the same window XQueryTree finds). The exchange is not
  hypothetical; only the *channel* is (§2).
- OGRE-Next 3.0's render system is GL3Plus/X11-only on Linux: its DSO links
  `libX11` and `libGLX`, neither `libwayland` nor `libEGL`. On a Wayland session
  the window is an X11 window under XWayland, and everything platform-shaped
  below follows from that.
- `SDL_CreateWindowFrom` **does not exist in SDL3**; the replacement is
  `SDL_CreateWindowWithProperties` with
  `SDL_PROP_WINDOW_CREATE_X11_WINDOW_NUMBER`. A DSO written against the SDL2
  spelling does not compile.
- A wrong video driver returns a *live window that is not the target* with no
  error (`SDL_VIDEO_DRIVER=wayland` with an X11 window number returned a 1×1
  empty window). The DSO must force the driver **and** verify the attach.
- Relative mouse motion delivered 1780 events in 6.05 s, every `xrel`/`yrel` an
  exact integer (`±1…±9` on x, `±1…±5` on y), modal inter-event gap 1 ms. The
  source is a mouse; the touchpad measurement that would show whether subpixel
  deltas survive is still pending, and Q3 designs for both answers.
- No synthetic input path works on this box: XTEST is a no-op, and uinput devices
  are created and tagged but never taken by the compositor. The probe's only real
  input was the operator's own hardware.

## 1. What input is

Input is the capability that owns a **device surface**: the keyboard and pointer
attached to a window, and the gamepads attached to the machine, delivered as
edges in time and as state a frame reads.

It is not `io`, and the difference is not size. `io` is the process's terminal —
stdin, stdout, argv — a byte stream and a command line, process-scoped, fatal
when broken, one per process (`SESSION.md` §3, §10); its verbs are `print`,
`read_line`, `arg_count`, `arg` under `tension::io`
(`tension-core/src/main.rs:547-668`), and its statefulness is the parked line
`HostState.pending_line` (`main.rs:100-104`). Input arrives whether or not
anyone asks, has a *rate* (the probe measured ~1 kHz pointer motion), and is
lossy by construction — the session's per-class sub-ring has a capacity and
counts what it drops (`tension-ogre/DESIGN.md` §3.4). Nothing about that is a
byte stream, and nothing about it is the process's: ten windows could each have
their own. The two capabilities share no namespace, no aspect and no vocabulary;
§6 keeps it that way.

## 2. The ABI constraint

**There is no adapter→adapter channel in ABI v1.** That is the probe's finding
and the fact this whole design turns on, so state it precisely:

- **Rule 10**, verbatim: *"An adapter must not assume another adapter is loaded,
  must not read or interpret another capability's records or ids, and must not
  assume it is the only event source."* (`tension-core/include/tension_adapter.h:63-65`.)
  The "never" list repeats it: *"Never interpret another capability's records."*
  (`tension_adapter.h:354`.)
- The arena's twelve region kinds are frozen with a fixed writer each — six
  session-written, five guest-written, one both (`tension_adapter.h:361-412`;
  `arena.rs:387-400`). None is a shared-value slot. The header's own sentence
  about adding one: *"Adding a region requires either a schema bump (a shape
  change: the layout hash and the schema version both move, and every capability
  recompiles) or a dynamic allocation mechanism this chunk does not have. A
  capability adapter cannot add, move or resize one."* (`tension_adapter.h:386-388`.)
- `post_event` carries a record **to the guest**, not to a peer: the session
  drains class queues into sub-rings and invokes the *guest's* callbacks
  (`tension-ogre/DESIGN.md` §3.3; `tension-core/src/session/epoch.rs:14-21`).
- The core API an adapter is handed is a fixed list — `guest_read`,
  `guest_write`, `guest_size`, `resolve_callback`, `call_callback`,
  `release_callback`, `log`, `register_import`, `register_source`, `post_event`,
  `class_info`, `region_lookup` (`tension_adapter.h:140-259`) — and none of them
  reads a value another adapter wrote.

So the window handle **exists** and **cannot move**: `getCustomAttribute("WINDOW")`
hands the renderer's own adapter the XID (probe, measured), and no mechanism
carries it to a peer capability. The only channels that do not cross this line
today are the two the ABI was built out of: the guest, which may hold values
from any capability it calls, and a new session-owned mechanism, which does not
exist.

## 3. The five questions

### Q1 — what is a window, architecturally?

Three readings, evaluated against the philosophy (`SESSION.md` §1: nothing is
baked in, every capability an option, the host knows the shape and never the
meaning) and against the ABI as it exists.

**(a) The window is the renderer's private resource.** What the code does today:
the window is created inside the OGRE adapter's `init`
(`tension-ogre/src/backend_ogre.cpp:227-228`), lives and dies with the renderer's
session aspect, and its handle is published nowhere. It fits the ABI exactly —
zero extension — and mis-assigns ownership of a platform object. `SESSION.md` §8
made this move once already, for the sound card: *"The OS owns the card; the
capability acquires it."* (`SESSION.md:217`.) The compositor owns the window; the
renderer holds a lease on its GL surface. Two consequences, both disqualifying:
input inside the renderer makes a text game load a renderer (§6 forbids it), and
it couples failure modes the failure contract exists to separate — a renderer
that dies would take the keyboard with it.

**(b) The window is a host-level resource.** Read as *the host creates and owns
the window*, this contradicts `SESSION.md` §6: the host would have to name a
window system, and a window system is a meaning. Read as *the host mediates the
value without owning the surface*, it is the interesting reading — an opaque
token is shape, not meaning. That reading is implementable, but only by building
something, because the mediation mechanism does not exist (§2); (b) is not an
alternative to an extension, it is a description of one.

**(c) The window is a shared platform resource, with a session-owned mechanism
for shared values.** (b) stated precisely, and the reading that generalizes: the
surface is the OS's, each capability holds its own lease on it (the renderer a GL
surface, input an event stream), and *no capability needs to read another's
records* to attach — it needs a platform fact the OS handed to someone else. The
**smallest extension that works** is *not* a region: a region lives in the
guest's memory, changes the arena's shape and moves `layout_hash`
(`arena.rs:1006`, `1020-1025`) — and the reader of a window handle is a
*capability*, not the guest, so the guest's memory is the wrong home for it. The
smallest extension is a session-owned **value channel**: two entries appended to
`tension_core_api` (publish, read), stored host-side, invisible to the arena.
Rule 11 permits exactly this shape — *"append-only within an ABI version"*
(`tension_adapter.h:66-67`) — and nothing about it moves `layout_hash`.

**Recommended: (c) as the concept, with (b)'s mediation and *no* host extension
for v0 — because the guest is already the mediator and always will be.** Every
capability is reached through the guest's verbs; the guest is the only party
that knows both capabilities exist; and the agreement between them ("this token
is a window, attach to it") is exactly the kind of knowledge `SESSION.md` §1
keeps out of the host. So the window is a shared platform resource, and the
exchange is: the renderer learns the token from the OS and hands it to the guest
(one new `ogre` verb); the guest hands it to input (one argument on
`input_attach`). No ABI change, no key agreement between peers, no new
mechanism. The value channel of (c) is the *fallback* for the day a consumer
exists with no guest in the loop; §5 keeps it as migration item M1, and names
what it would cost.

### Q2 — DSO or built-in?

Three shapes, argued against the philosophy and the ABI.

**(a) Built-in, like `io`.** The precedent exists and is honest about its price:
*"The built-in capabilities are the honest exception... they are compiled into
the host, so the host names them (`HostState.audio`, `.ai`, `.solver`, `.res`)
and their verbs are `func_wrap` calls in `main.rs`"* (`SESSION.md` §6; the io
registrations are `main.rs:547-668`). Input fails that test on both halves: it is
not process-scoped in the way a terminal is — one process can have several
windows — and linking SDL3 into `tension-core` makes every build carry a window
system, an audio backend and a hidapi backend for a capability the build may not
want. "Nothing is baked in by design" (`SESSION.md` §1) is the philosophy input
would be violating first.

**(b) A DSO, like `ogre`.** This is the shape the ABI was designed for: the
adapter returns a vtable (`tension_adapter.h:268-319`, entry point at `:322`; the concrete table at `tension-ogre/src/adapter.cpp:1276-1290`),
registers its imports during `link` (`adapter.cpp:1020-1031`), and the host never
learns what SDL is. SDL3 becomes a real dependency of an *optional* capability:
pay for it only if you load it. The capability's process-global parts —
`SDL_Init`'s subsystem state, SDL's one event queue — are not a problem for this
shape; they are an *aspect* to declare (see the aspect table below), and the
design already has a precedent for a process-scoped aspect inside a sessioned
capability: llama.cpp's process init inside AI (`SESSION.md` §3).

**(c) Inside the OGRE adapter.** This is (a)'s disqualifier plus a second one:
the `ogre` namespace would grow verbs that are not about rendering, so a
capability stops meaning one thing. It also forces the input pump onto the
renderer's thread (§3 Q4), which is rejected there for a reason independent of
this one.

**The aspect table for input**, in `SESSION.md` §3's form. `SESSION.md` §2 says
the unit of analysis is the aspect, not the capability, and input has two:

| Capability | Aspect | Identity | Failure | Kind | Note |
| --- | --- | --- | --- | --- | --- |
| Input | the SDL subsystem: one `SDL_Init`, one event queue, one video driver per process | process | fatal | singleton | new — the shape SDL itself imposes, not a Tension limit |
| Input | the attached surface: one window, its device set, its held state | caller | recoverable | session | the `input_open` handle; capacity 1 in v0 |

**Zero gamepads is a normal state, not a failure.** Round 21's probe measured
`SDL_GetGamepads` returning 0 with `SDL_WasInit(SDL_INIT_GAMEPAD)` set — the
subsystem is ready and no device is attached. `input_open` and `input_attach`
must succeed in that state (a game with no pad is still a game), and `input_pad`
returns `-ENOENT` for every slot, per the slot record in Q5.

**Recommended: (b), a DSO**, namespace `tension::input`, with the two aspects
above. **Smallest viable first version**: `libtension_input.so` registering five
verbs (§3 Q5), keyboard and mouse edges on the two classes the session already
reserves (`CLASS_INPUT_KEY` 6, `CLASS_INPUT_MOUSE` 7 — `arena.rs:210-211`), state
through a verb rather than a region, capacity 1, **no gamepad** (edges need a
class that does not exist — §5 M3 — and no custom abstraction is permitted, §6).
A headless build is the *same binary* refusing at attach with `-ENODEV`, the
mirror of the ogre capability's no-display case
(`tension-ogre/tests/run.sh:125-135`).

### Q3 — events or polled state?

The ABI answered this before the question was asked. `post_event`'s own doc:

> Posting is a hint about what happened, not a status update: the authoritative
> state is what the adapter writes into its own regions during `publish`.
> (`tension_adapter.h:229-231`.)

and the vtable's `publish` doc: *"Write this adapter's host -> guest regions from
its own mirror"* (`tension_adapter.h:285`). That is a **mixed model stated as a
division of labour**: edges go through the ring, state goes through the mirror,
and where the two disagree the state is right. Input is the clearest possible
case for it:

- **Edges are events.** A key press is an instant, and losing one is a different
  failure from losing a frame's worth of motion. They ride `INPUT_KEY` and
  `INPUT_MOUSE` — classes the session already has, with modes and capacities
  already declared (`INPUT_KEY` BATCHED/256, `INPUT_MOUSE` BATCHED/64 —
  `arena.rs:241-242`, `250-260`).
- **Continuous state is state.** Held keys, buttons, axes, and the delta since
  the last time anyone looked. A delta is not an event: it is an accumulation,
  and its correct value is a function of *when you ask*, which is what a region
  (or a verb's snapshot) is for.

**The rate argument, measured.** The probe's mouse produced 1780 motion events
in 6.05 s — ~294 Hz average, modal gap 1 ms — against `INPUT_MOUSE`'s ring
capacity of **64** (`arena.rs:241-242`). One event per device sample would drop
almost everything and make the ring a statistic. A frame at 60 Hz wants ~16 ms of
accumulated motion — a few hundred counts, one record. So **motion is coalesced
per delivery epoch**: the input side accumulates, and posts one motion record
per epoch when the accumulated delta is non-zero. Coalescing is the producer's
job, which is exactly why `class_info` exists: *"so a producer can skip
generating events nobody subscribed to"* (`tension_adapter.h:238-240`; the
constant is `CLASS_FLAG_SUBSCRIBED`, `arena.rs:271`) — an input DSO that only
posts while someone is subscribed is using the mechanism as designed.

**Where state lives**, three candidates, and the honest comparison:

1. **A new arena region.** What the `publish` doc assumes an adapter has. It
   needs a thirteenth region kind: `layout_hash` moves (`arena.rs:1020-1025`
   hashes the whole `REGIONS` table, `1006` hashes `REGION_COUNT`), `session.json`
   pins the new hash, `layout.ts` regenerates, and every capability recompiles
   (`tension_adapter.h:386-388`; the cross-check is
   `tension-core/tests/framework_layout.rs`). It buys the guest a state read
   with no call and no copy, readable from inside a callback.
2. **A verb that copies the adapter's mirror into a caller-provided buffer.**
   The solver's precedent, exactly: `solver_state(id, t_ptr, y_ptr, y_cap)`
   validates both destination ranges *before* writing either, so a failure hands
   back an untouched buffer (`tension-core/src/solver/mod.rs:515-542`). No arena
   change, no hash move; costs one call and one copy per frame, which is nothing
   against a frame's work.
3. **All events.** Rejected: it makes every consumer reconstruct state from a
   lossy ring, and the ring is deliberately lossy (`tension-ogre/DESIGN.md`
   §3.4 counts drops as a first-class number).

**Recommended: the mixed model, with state through the verb (2) in v0 and the
region (1) named as the v1 move** — the moment a consumer needs state from
inside a callback, or the verb's copy shows up in a profile, which are the only
two things (1) buys. Note what this does *not* need: `RING` mode is *"reserved
and stubbed in chunk 1"* (`tension-ogre/DESIGN.md` §3.2), so no design may
depend on it; and a class with no registered callback is still published into the
ring (`epoch.rs:18-21`), so a guest that wants to poll rather than be called may
subscribe with `POLLED` — the delivery mode is policy and is deliberately not
hashed (`arena.rs:246-249`).

### Q4 — the threading model

The constraints, all citable:

- **Rule 4**: the session calls `init`, `link`, `publish`, `apply`, `shutdown`
  and `destroy` on the interpreter thread, and `publish`/`apply` only while the
  guest is inside a `session::*` call (`tension_adapter.h:45-47`).
- **Rule 7**: `post_event` is the only function in the ABI callable from a non-guest
  thread; it never touches guest memory and never blocks (`tension_adapter.h:56-57`).
  The code is built for it: the posting side is interior-mutability based and
  *"can be called from a render thread without any of the session's machinery"*
  (`tension-core/src/session/posting.rs:5-11`), and the session's own test calls
  it *"exactly as an adapter's render thread would"* (`session/mod.rs:2915`).
- **SDL**: the video/event pump belongs to the thread that ran `SDL_Init`. The
  probe exercised this on one thread only; the cross-thread case is an owed
  verification (§4, "unverified").
- **OGRE already has a render thread** (`tension-ogre/src/adapter.cpp:283`,
  joined in `shutdown`), and the vtable's `shutdown` contract is written for
  exactly this: *"Stop background threads and release their resources;
  idempotent"* (`tension_adapter.h:308`).

Three candidates:

**(i) The interpreter thread, pumping inside `publish`.** Legal by rule 4 and by
SDL (init and pump on one thread), and the cheapest: no thread to own, no
lifetime to get right, and `publish` is already where an adapter touches its
mirror (`tension_adapter.h:283-290`). It fails one way, and the design has
already written the failure down: *"A capability whose work completes only in
`publish` cannot be relied upon with an unbounded `session_wait`"*
(`tension-ogre/DESIGN.md:200`) — a guest blocked in `wait(-1)` for a keypress
would be waiting for the pump that only the blocked verb could have run. Games
poll with a timeout anyway, but "your input only works if you poll" makes the
obvious text-adventure loop impossible.

**(ii) OGRE's render thread.** Rejected on rule 10's first clause: an input
capability may not assume a renderer is loaded, and this makes the input pump's
existence depend on a peer's thread. SDL's init would also have to happen on a
thread input does not own.

**(iii) A dedicated input thread.** `init` (which may block bounded —
`tension_adapter.h:274-275`) creates the thread, and the thread's first act is
`SDL_Init`; from then on the thread owns SDL — attach, pump, coalesce — and
posts edges with `post_event` (rule 7). State lives in the thread's mirror,
which `publish` copies on the interpreter thread (v1) or which a verb snapshots
(v0). This is the same shape the loader and render threads already have, for the
same reason: asynchronous work that finishes off-thread, *"post_events, and the
post wakes a blocked wait"* (`tension-ogre/DESIGN.md:202-206`).

**Recommended: (iii), with (i) named as the fallback only if v0 must not own a
thread.** One consequence the design must state rather than discover:
`SDL_CreateWindowWithProperties` must run on the SDL thread, but `input_attach`
is called from the interpreter thread — so **attach is a request to the input
thread plus a bounded wait for its answer**, and `init`'s "may block bounded"
licence covers the same pattern elsewhere. The second consequence is the reason
attach is a *verb* and not part of `init` at all: the window may not exist yet,
and rule 10 forbids assuming the capability that makes it is loaded.

**Keyboard delivery, measured (round 21).** Key events arrive on the attached
window, on the input thread, while the window holds X focus: the probe captured
`SDL_EVENT_KEY_DOWN`/`KEY_UP` pairs for two Down-arrow presses with the window
focused and no focus transitions in either direction. The `INPUT_KEY` path is
real, not hypothetical. The precondition is the compositor's, not the DSO's —
the window must hold X focus for the keys to arrive, and that is the window
manager's decision; the capability can only make its window focusable and ask.

### Q5 — the wire and the record shapes

**Verbs.** Namespace `tension::input`; every parameter and return is `i32`. That
is not a stylistic choice: every import the tree registers through
`register_import` today is `TENSION_VT_I32` (`tension-ogre/src/adapter.cpp:1020`),
so a 64-bit window token crosses as two halves and the guest-side wrapper
reassembles it. (The value set does have `I64`/`F32`/`F64` —
`tension_adapter.h:93-99` — but nothing exercises them on the adapter path,
and a wire that is the first user of a shape is a wire that has not been tested.)

| verb | signature | answer |
| --- | --- | --- |
| `input_open` | `(flags: i32) -> i32` | handle ≥ 1; `-ENODEV` when the SDL subsystem cannot start (no display, no driver); `-EBUSY` when the declared capacity (1) is taken; `-EINVAL` for unknown flags |
| `input_attach` | `(handle: i32, kind: i32, lo: i32, hi: i32) -> i32` | 0; `-EINVAL` handle/kind, `-ENODEV` no display or no device, `-ENOENT` no such window, `-ENOSYS` kind unsupported here, `-EBUSY` already attached, `-EIO` SDL refused |
| `input_set_relative` | `(handle: i32, on: i32) -> i32` | 0; `-EINVAL`, `-ENODEV` |
| `input_state` | `(handle: i32, ptr: i32, cap: i32) -> i32` | bytes written (== the record size); `cap <= 0` is a **probe** that returns the required size and writes nothing; `-ENOSPC` when `0 < cap < size`; `-ENODEV` not attached; `-EINVAL` |
| `input_pad` (v1) | `(handle: i32, slot: i32, ptr: i32, cap: i32) -> i32` | as `input_state`, plus `-ENOENT` for an empty slot |
| `input_close` | `(handle: i32) -> i32` | 0; `-EINVAL` |

`kind` names what the token is: `0` = give me your own surface, `1` = X11 XID
(in `lo`), `2` = Wayland `wl_surface` (lo/hi), `3` = Win32 `HWND`, `4` = Cocoa
`NSView`. Kind `0` is how the §6 non-goal works: an input-only window that input
creates and owns, so a text game needs no renderer. The probe's measurements fix
kinds 1 and 2's behaviour: with a token, the DSO forces the matching SDL driver
and **verifies the result** (size and title against what the token's window
reports), because the probe measured a wrong driver returning a live window that
is not the target with no error.

The probe's other wire-relevant measurement is the event timestamp: on the X11
path, `SDL_MouseMotionEvent.timestamp` tracked `CLOCK_MONOTONIC` *milliseconds*
across all 1780 events, while window events carried nanoseconds-since-`SDL_Init`
in the same process. **The DSO must not forward SDL's timestamp as if it had one
unit**; the record below carries `seq` (the session's own, globally ordered —
`posting.rs:232-235`) and leaves wall-clock time to the capability, not the wire.

**Events.** No new verbs: the guest subscribes to classes 6 and 7 with
`session::subscribe` (`tension-framework/assembly/runtime/session.ts:28-33`), or
does not, and reads the ring. The 32-byte `EventRecord` is
`{seq u64, class u32, flags u32, a u32, b u32, f0 f32, f1 f32}`
(`arena.rs:138-150`), and **has no room for a source id** — *"it belongs to the
host's bookkeeping rather than to the guest's view"* (`posting.rs:30-34`). So a
device that must be identified identifies itself in `flags`; this is the
capability's own vocabulary, and the session neither knows nor checks it.

| class | `flags` | `a` | `b` | `f0`/`f1` |
| --- | --- | --- | --- | --- |
| 6 `INPUT_KEY` | bit0 `DOWN`, bit1 `REPEAT`, bit2 `SYNTHETIC` | SDL keycode | SDL scancode | 0 |
| 7 `INPUT_MOUSE`, shape bit0–1 = 0 MOTION | bit2 `RELATIVE` | `dx` (i32 bits) | `dy` (i32 bits) | `dxf`, `dyf` |
| 7 `INPUT_MOUSE`, shape = 1 BUTTON | bit2 `DOWN` | button (SDL numbering, 1-based) | buttons-after mask | 0 |
| 7 `INPUT_MOUSE`, shape = 2 WHEEL | — | 0 | 0 | x, y (SDL3's wheel is float) |

Modifier state is deliberately not on the wire: it is derivable from the held
keys in the state record, and duplicating it would create two answers to one
question.

**`which` is a device id, and zero is not a device.** Round 21's probe measured
SDL attributing raw device motion to an XInput device id (7, which is
`xwayland-relative-pointer:11` on this machine) and position-derived motion —
the window moving under a stationary pointer — to `which == 0`. Events with
`which == 0` are not device motion and must never enter the delta accumulator;
the DSO drops them at the pump, before the mirror.

**State** (`input_state`'s payload, `INPUT_STATE_SIZE = 96`, 4-byte alignment):

| offset | size | field |
| --- | --- | --- |
| 0 | 4 | `version` (1) |
| 4 | 4 | `flags`: bit0 `ATTACHED`, bit1 `RELATIVE_MOUSE`, bit2 `FOCUSED`, bit3 `POINTER_OVER` |
| 8 | 4 | `pads_present` (bit *i* = slot *i* has a gamepad) |
| 12 | 4 | `mouse_buttons` (bit *n* = SDL button *n+1*) |
| 16 | 32 | `keys_held[8]` — 256 scancodes; bit `scancode & 31` of word `scancode >> 5` |
| 48 | 16 | mouse delta since the previous snapshot: `dx` i32, `dy` i32, `dxf` f32, `dyf` f32 |
| 64 | 8 | `mouse_x`, `mouse_y` (i32, window pixels; meaningful only when `RELATIVE_MOUSE` is clear) |
| 72 | 8 | `wheel_x`, `wheel_y` (f32, accumulated since the previous snapshot) |
| 80 | 8 | `seq` (u64) — the session `seq` of the last epoch this snapshot includes |
| 88 | 8 | `reserved` (zero) |

Two rules make the delta outlive the pending measurement. **The float fields are
authoritative and the integers are their truncation** — the probe measured
integers because the source was a mouse, and the layout must not need editing if
a touchpad produces `0.4`. **The truncation carries its remainder**: the adapter
accumulates floats, publishes `(int, float)`, and keeps the remainder for the
next epoch, so a slow subpixel drag degrades in resolution but never disappears —
the same reason the X server keeps a fixed-point sprite.

**A third rule, measured in round 21: the first accumulation window after
`input_attach` is discarded.** The probe recorded 347 px over 137 ms (absolute
mode) and 112 px over 343 ms (relative mode) of motion in the sub-second window
right after attach, with the pointer provably stationary before and after — the
window being placed under the pointer, and the pointer-confinement warp settling.
It is not input. The DSO zeroes its accumulator after the attach settles and
before the first snapshot it publishes, so a game never sees a phantom jump on
its first frame.

**Gamepads** (v1, specified now, built later) are state first: one 48-byte slot
record per attached pad, read with `input_pad` — `version` u32, `flags` u32 (bit0
`ATTACHED`), `buttons` u32 (the SDL_GameController mask), `reserved` u32, then
`axes[6]` f32 (left x/y and right x/y in `[-1, 1]`, triggers in `[0, 1]`), then
`reserved` u64. Edges — connect, disconnect, button — have no class to ride
(`CLASSES` is `arena.rs:218-231`; there is no `INPUT_GAMEPAD`), and adding one is
a schema bump (§5 M3), so v0 ships without gamepad and says so rather than
smuggling it into `INPUT_KEY`.

**Error surface.** Rule 1: every entry point is panic-free and every failure is
a negative errno (`tension_adapter.h:38-39`). The list is the table above; the
detail behind `-EIO`-class failures is a line through `core->log`
(`tension_adapter.h:202`) carrying `SDL_GetError()`, never a silent refusal.

**What moves `layout_hash`.** This is the part a reader will otherwise get
wrong, so it is a table:

| change | `layout_hash` | consequence |
| --- | --- | --- |
| use classes 6 and 7 as they are | no | nothing recompiles |
| re-mode a class (BATCHED ⇄ POLLED) | **no** — `DEFAULT_CLASS_MODES` is deliberately excluded (`arena.rs:246-249`) | nothing |
| resize a class ring (`INPUT_MOUSE` 64 → 1024) | **yes** — `DEFAULT_RING_CAPACITIES` is hashed (`arena.rs:1071-1073`) | schema bump: looks like tuning, is not |
| add an `INPUT_GAMEPAD` class | **yes** — `CLASS_COUNT` is hashed (`arena.rs:1056`) | schema bump; every capability recompiles |
| add an `INPUT` region | **yes** — `REGIONS` and `REGION_COUNT` are hashed (`arena.rs:1006,1020-1025`) | schema bump (`tension_adapter.h:386-388`) |
| pin the input records in the manifest `TYPES` | **yes** — *"adding an entry is a schema change"* (`arena.rs:412-413`) | so do not: the records live in this document and the DSO, like OGRE's catalogue |
| append a `tension_core_api` entry (value channel) | **no** | rule 11 permits it (`tension_adapter.h:66-67`); §5 M1 |

### Q6 — the cross-platform story (asked as "ALSO")

The device side of this capability is a platform surface, and the platforms
disagree about what one *is*. What changes:

| platform | token (kind) | SDL property | raw motion | gamepad |
| --- | --- | --- | --- | --- |
| Linux/X11, incl. XWayland (measured) | XID, 32-bit (1) | `SDL_PROP_WINDOW_CREATE_X11_WINDOW_NUMBER` | XI2 raw motion from XWayland's relative-pointer device (the probe's `which` was device 7, `xwayland-relative-pointer:11`); integers measured, subpixel pending | evdev via SDL_GameController |
| Wayland native (the day a renderer has a backend — OGRE-Next 3.0 does not) | `wl_surface*` (2) | `SDL_PROP_WINDOW_CREATE_WAYLAND_WL_SURFACE_POINTER` | compositor relative pointer, `wl_fixed` (1/256) — subpixel expected, and the same "verify the attach" rule applies | evdev via SDL_GameController |
| Windows | `HWND` (3) | `SDL_PROP_WINDOW_CREATE_WIN32_HWND_POINTER` | `WM_INPUT` raw input through SDL | XInput via SDL_GameController |
| macOS | `NSView*`/`NSWindow*` (4) | `SDL_PROP_WINDOW_CREATE_COCOA_VIEW_POINTER` / `..._COCOA_WINDOW_POINTER` | `NSEvent` deltas (fractional possible) | SDL_GameController (MFi/IOKit) |

**One wire, platform-neutral; the platform lives in the DSO.** The guest sees a
kind tag and two opaque halves, never a pointer, an XID or an HWND. That is the
philosophy applied to the device side: "the host owns the machine, the guest owns
the world" (`README.md:14`) — and the guest owning the world does not mean the
guest owning `WM_INPUT`. SDL is already the abstraction layer for everything
below the token; the DSO's attach is the only code that reads the kind, and a
platform it cannot serve is `-ENOSYS` at attach, not a different wire. The
alternative — per-platform shapes crossing the ABI — would put a platform in the
guest's source, which is precisely what the DSO shape exists to avoid, and would
make the four rows above four versions of the API instead of one.

## 4. The recommended design

A DSO, `libtension_input.so`, implementing `tension_adapter_v1` and registering
the `tension::input` namespace.

**Aspects.** Two, per Q2's table: the SDL subsystem is a process singleton; the
attached surface is a capability session keyed by the `input_open` handle —
recoverable, capacity 1 in v0, declared as such (`SESSION.md` §7). The handle
exists in the first version because that is AI's shape and what `SESSION.md` §11
A4 asks the others to adopt.

**Threading.** One input thread, created in `init`, owning SDL from `SDL_Init`
onward: it pumps, coalesces, keeps the mirror, and posts edges with `post_event`.
`input_attach` hands the thread a request and waits bounded for its answer,
because the SDL window call must run there. `shutdown` stops and joins it and
destroys the SDL window on it. `publish` is `NULL` in v0 — no regions
(`tension_adapter.h:296`) — and becomes the mirror's copy point in v1.

**Events.** `INPUT_KEY` and `INPUT_MOUSE` exactly as specified in Q5, motion
coalesced per epoch, posting skipped when `class_info` reports no subscriber.

**The capability's lifetime is owned by `input_close`.** The host never calls
the vtable's `shutdown` or `destroy` (`SESSION.md` §11 M3 is open), so a
capability that owns background threads must tear down through a verb.
`input_close` detaches, stops the thread, and re-arms for a later
`input_open` — the DSO's destructor cannot do it: measured, `SDL_Quit` from a
static destructor during `dlclose` never returns.

**State.** `input_state` copies the mirror into the caller's buffer, validating
the range first (the solver's pattern). Floats are authoritative; the integers
are their truncation with the remainder carried.

**The window handle.** The guest relays it. That needs one new verb on the
renderer's side — `ogre.window_handle() -> (lo, hi)`, an exempt read-only
accessor in the shape of `job_state` (`adapter.cpp:1002-1003`), reading the value
`getCustomAttribute("WINDOW")` already produces — and one argument on input's
side. The framework may wrap it (`input.attachTo(ogre)` in the guest SDK), but
nothing in the host or the session is involved, and neither capability learns the
other exists.

**Failure contract.** The SDL subsystem's death is fatal to the capability
aspect, not to the process: `input_open` refuses with `-ENODEV` when there is no
display or no device, exactly as `audio_init` returns `-1` with no card
(`SESSION.md` §8), and a later `input_open` may try again. A failed attach is
recoverable: close, open, attach again.

**The v0 gate.** A keyboard-and-mouse example under `examples/ogre/` (a camera
moved by WASD, turned by the mouse) plus a headless case that asserts the
no-display refusal, mirroring `tension-ogre/tests/run.sh:125-135`. The full-stack
target this feeds is already written down: *"a small controllable game with
input, a light and a shadow"* (`tension-ogre/DESIGN.md:2719`).

**Unverified, and what would falsify the design.**

- SDL pumping on a thread that is not the renderer's, while the renderer pumps
  its own X connection. The attach is a different connection by measurement
  (OGRE's `XDISPLAY` was not the probe's own `XOpenDisplay`), so independence is
  expected — but the probe ran both pumps on one thread and never tested the
  split. If SDL's X11 backend demands more than "same thread as `SDL_Init`",
  Q4's recommendation needs re-reading.
- The touchpad measurement. It decides whether `f0`/`f1` earn their place or are
  decoration. The layout already carries both, which is the design's answer to
  not knowing.
- Whether SDL's queue survives a 60 Hz pump at 1 kHz input — a question about
  ring capacities, not about SDL, since the input thread drains SDL continuously.
- Whether a second window consumer ever appears: the only thing that would make
  the value channel (§3 Q1) more than a fallback.

## 5. Migration if the ABI must be extended

Ordered by cost, cheapest first. **M0 is the design above and needs no ABI
change at all** — it is listed only to make that explicit.

**M0 — the guest relay (this design).** One new `ogre` verb and one argument on
`input_attach`. Nothing in `tension-core`, the session, the arena or the ABI
moves. Cost: the game author writes one line, or the guest SDK does.

**M1 — a session-owned value channel.** Two entries appended to
`tension_core_api` (publish, read), stored host-side, invisible to the arena.
Rule 11 permits the append (`tension_adapter.h:66-67`); `layout_hash` does not
move; no capability recompiles. Why it is second rather than first: two
capabilities must agree on a key and a payload meaning, a wire agreement *between
peers* — the thing rule 10 exists to keep out of a capability's assumptions. If
it is built, the keys must be session-namespaced, the payload typed (a token plus
a kind), and the publisher recorded. It buys a consumer with no guest in the
loop, and a second consumer of the same window.

**M2 — an `INPUT` state region.** The arena path for state: a thirteenth region
kind with the adapter as writer, and therefore a **schema bump** (`REGIONS` and
`REGION_COUNT` are hashed — `arena.rs:1006,1020-1025`): `layout_hash` moves,
`session.json`'s pinned hash changes, `layout.ts` regenerates, every capability
recompiles (`tension_adapter.h:386-388`), and
`tension-core/tests/framework_layout.rs` enforces that it did. It buys a state
read with no call and no copy, readable from inside a callback — the `job_state`
shape.

**M3 — an `INPUT_GAMEPAD` class.** Needed before gamepad *edges* exist. Also a
schema bump: `CLASS_COUNT` is hashed (`arena.rs:1056`) and `DEFAULT_RING_CAPACITIES`
with it (`arena.rs:1071-1073`). What it buys: connect/disconnect and button
edges that are not state.

**M4 — a larger `INPUT_MOUSE` ring.** Do not do this by itself: the capacities
are hashed, so it is the same bump as M2/M3 at a fraction of the benefit. Fold it
into whichever of them lands first, if the drops are real.

**M5 — a mode change.** Free, and the only kind of tuning available without a
bump (`arena.rs:246-249`). If input ever wants `POLLED` delivery by default,
this is where it happens.

**What the order protects.** M0 delivers a working capability with the ABI
frozen. M1 is the smallest host extension and moves no arena shape. M2–M4 are
schema bumps and should be batched into one, because each of them alone spends
"every capability recompiles" for one field's worth of value.

## 6. Non-goals

- **Input is not a rendering concern.** It must be usable without a window —
  without *OGRE's* window, and without OGRE loaded at all: kind `0` of
  `input_attach` gives input its own surface, and the §6 non-goal is why the
  renderer's private-resource reading (Q1a) and the inside-the-adapter shape
  (Q2c) are rejected rather than merely disfavoured.
- **Input is not `io`.** `io` is stdin/stdout and the argument vector, a
  process-scoped byte stream, fatal when broken; input is a device surface with a
  rate, lossy by construction, caller-scoped. They do not share a namespace, an
  aspect, or a verb, and `read_line`'s parked-line statefulness has no analogue
  here.
- **Gamepad goes through `SDL_GameController`.** No custom gamepad abstraction:
  no raw HID, no evdev, no per-platform pad backend, no axis remapping table of
  our own. SDL's controller database is the abstraction, and the wire's axes are
  normalized to `[-1, 1]` / `[0, 1]` so SDL's raw `Sint16` range never reaches
  the guest.
- **The input DSO does not create the renderer's window, read another
  capability's records, or assume a renderer is loaded** (rule 10). Its token is
  an argument, not a discovery.
- **The session does not learn what a window is.** No region kind, class name or
  core-API signature in this design names X11, Wayland, Windows or Cocoa; the
  kind tag is a number the input capability defines in its own catalogue.
- **Input is not a world feature.** A world is what the engine simulates, and
  `tension-world/schema.yaml:254` excludes "rendering, audio, input, or any other
  non-simulation feature" from that format. Input is behavior and presentation,
  and it lives in the guest's hands and this capability.
- **No text/IME input in v0.** `SDL_EVENT_TEXT_INPUT` composition is its own
  problem (IME, dead keys, per-locale composition) and does not ride
  `INPUT_KEY`; if it is ever wanted it is a class or a state field with its own
  round, not a flag bolted onto a keycode.
