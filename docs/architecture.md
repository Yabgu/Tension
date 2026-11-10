# Architecture

Tension is a host process and a WebAssembly guest. This document is the
contract between them, and the order in which each side makes and unmakes the
resources it owns.

It is derived from code. Every claim carries a `file:line`; anything that is
design intent rather than current behaviour is marked **not yet proven** in
place. If you change the code and this document disagrees, the code is right and
this file is a bug.

A bare filename in a citation means the file under `tension-core/src/`
(`main.rs`, `platform.rs`, `adapter/mod.rs`, `ffi.rs`, `session/*.rs`). Anything
outside that tree carries its path.

## 1. The north star

**The host owns the machine; the guest owns the world.** `tension-core` owns the
process — the window, the Vulkan instance and surface, the event queue, the audio
device, the main loop — and the guest is a WebAssembly module that must never
learn that SDL3 or Vulkan exist. Between them is one narrow ABI of plain
integers: a guest reaches the host through registered imports, a capability (a
renderer, an input layer) reaches it through a versioned vtable, and
communication is batched where it is per-frame and asynchronous where it is I/O
or latency-bound.

Time is world, not machine. The host wakes the guest; it does not tell the guest
what time it is. Guest simulation is deterministic by construction because the
host contributes no clock.

The separation is structural, not documentary. The adapter header includes only
`<stddef.h>` and `<stdint.h>` (`tension-core/include/tension_adapter.h:35-36`),
so a capability cannot name an SDL or Vulkan type even if it wants to; the
handles it is given cross the boundary as `u64`
(`tension-core/src/platform.rs:238-244`).

## 2. Who owns what

| Resource | Owner | Created | Destroyed |
|---|---|---|---|
| `SDL_Window` | host | `platform::create_window`, on the guest's `tension::platform.create_window` call (or a 2D renderer's first windowed `open`) | `platform::close_window`, or `main`'s teardown |
| SDL video + event pump | host | `platform.rs:353-362` | field order, `platform.rs:336-340` |
| `VkInstance` | host | `platform.rs:452` | `platform.rs:664` |
| `VkSurfaceKHR` | host | `platform.rs:457` | `platform.rs:663` |
| `VkDevice` | renderer (Ogre-Next — current, not settled) | inside `root_->init`, from the host's instance | `OgreVulkanDevice.cpp:525` |
| Ogre swapchain | renderer (Ogre-Next — current, not settled) | `OgreVulkanWindow` | `destroyRenderWindow`, `backend_ogre.cpp:738` |
| GPU device + swapchain | renderer (2D, in core) | `render2d/device.rs`, first windowed `open` | `Render2dState::close`, or the store's drop |
| Which renderer owns the swapchain | core | `Render2dState::claim_swapchain` | released by the holder |
| The guest's window *request* | the guest | `tension::platform.create_window` (`tension_window_config`) | one-shot: the host keeps the window, not the request |
| Render thread | renderer | `tension-ogre/src/adapter.cpp:616` | joined `adapter.cpp:1624` |
| SDL event queue | host, `HostWindow::pump` | with the window | with the window |
| Event layers (ABI v7) | the capability that registers one; the host owns the dispatcher | `register_event_layer`, from `link` | `unregister_event_layer`, or the host's `clear()` at teardown |
| Guest input attach | the `tension-input` DSO, as an event *layer* | `input_attach` (the words are kept; `kind` is ignored) | `input_close` |
| Audio device (cpal) | host, `tension-core/src/audio/mod.rs:55` | `audio_init` | `audio_shutdown`, `audio/mod.rs:146` |
| Filesystem | host, mediated by `tension::res`, `main.rs:1114` | startup | process exit |
| Time | **the guest, deliberately.** The host provides no clock import, no dt on the frame wake, and no tick callback. The guest derives time from frame identity (§4) — a determinism requirement, not an omission. | no import matching `clock`, `time`, `elapsed` or `now` exists among the 48 `Linker::func_wrap` registrations in `tension-core/src` `[verified]` | not applicable — the host creates no clock to destroy |
| Main loop | host, `main.rs:1927` | after guest entry returns | loop exit |
| Session (epoch, arena) | host, `main.rs:204` | guest asks | guest closes, or the host closes for it |
| Guest `Store<HostState>` | host, `main.rs:895` | before instantiation | end of `main` |
| Capability code (DSO) | the adapter itself | `adapter/mod.rs:1029` | `adapter/mod.rs:1020` |

The rows that are not obvious:

**The window is created by the guest, and there is no flag that creates one.**
`tension-core` takes no window option: a run with no `create_window` call has no
window, and `tension::platform.window_info` reports `width == 0` rather than an
error. The guest asks; the host creates. A renderer never creates one — the
Ogre backend has no own-window path at all — so "the window the frame goes to"
and "the window the host owns" are the same object by construction.

**The guest can change the window after creating it.** Three imports —
`set_fullscreen`, `set_window_size`, `set_window_title` — are synchronous, like
`create_window`: they run on the interpreter thread, which is where SDL's window
API lives, and each records the request before returning, so `window_info`
answers with what the guest asked for rather than with whatever the compositor
has got round to. A renderer learns about a mode change the same way it learns
about a resize — by polling `host_window_info` once per frame — so an Ogre
swapchain on the host's surface rebuilds at the new extent without the guest
telling it.

**The surface is created, and published, inside that call.** `HostWindow::new`
sets `SDL_WINDOW_VULKAN` only for `target: Vulkan` (`platform.rs`, `HostWindow::new`),
and `create_window` calls `surface()` and publishes the handles into the cell that
`host_surface` serves from. So the ordering rule in the guest contract is
**`createWindow` and then `ogre::init`**: a renderer that inits first gets
`-ENOSYS` from `host_surface`, which the adapter reports as `-ENODEV`. Published
mid-run rather than at load — that inversion is what the programmatic API cost,
and it is one shared `Arc<Mutex<…>>` rather than a second mechanism.

The three targets are the contract, not a hint:

| target | flags at creation | who can use the window |
|---|---|---|
| `PLAIN` | `RESIZABLE`, `HIGH_DPI` | anything; no graphics API promised |
| `GPU` | `RESIZABLE`, `HIGH_DPI` | `SDL_GPU` — it builds its own surface on Linux and uses D3D12/Metal elsewhere, so no `VULKAN` flag |
| `VULKAN` | the above plus `VULKAN` | `SDL_Vulkan_CreateSurface`, which *requires* the flag; what `host_surface` hands a renderer |

`GPU` exists because asking for a Vulkan window on Windows makes SDL want a
Vulkan loader that a D3D12-only machine need not have. `VULKAN` exists because
`SDL_Vulkan_CreateSurface` refuses a window without the flag — and the flag
cannot be added after creation on every driver.

**The instance is created from SDL's list, not a guessed one.**
`vulkan_instance_extensions()` (`platform.rs:422`) is what SDL asks for on the
current driver — `VK_KHR_wayland_surface`, `VK_KHR_xlib_surface`, or
`VK_EXT_headless_surface` — and those exact names go to `vkCreateInstance`
(`platform.rs:452`). The same list is later served to a renderer through
`host_surface_extension` so Ogre can build a `VulkanExternalInstance` from the
truth (`platform.rs:519`, `main.rs:1498-1499`).

**Ogre does not create the instance and does not own it.** It creates the
`VkDevice` from the host's `VkInstance` and builds its swapchain on the host's
`VkSurfaceKHR`. The handles are borrowed: the adapter must not destroy either
of them (`platform.rs:246-251`).

Where the frame goes is the renderer's declaration, not the host's guess: the
config's `target` key names `auto`, `swapchain` or `offscreen`, and `swapchain`
is a requirement — with no published surface `init` refuses `-ENODEV` rather
than opening a window of its own (`tension-ogre/src/adapter.cpp:590-602`). The
three values are the contract a replacement 3D backend implements; the Ogre
implementation is current, not settled.

**2D does not create a window and does not consume the host `VkSurfaceKHR`
either.** `SDL_GPU` has no external-surface handoff, so a 2D renderer presents by
claiming the host's `SDL_Window` for its own device
(`render2d/device.rs`, `SDL_ClaimWindowForGPUDevice`) rather than by borrowing a
surface. One window, one owner, two different handoffs — the difference is
SDL_GPU's, not the architecture's. See §8 for what that costs, and
[`modules/2d.md`](modules/2d.md) §3 for the mechanism.

## 3. Lifetime and teardown order

Two exit paths, one order. A guest that traps and a guest that returns both pass
through the same three steps, and the order is load-bearing in every one.

```
trap path                              clean path
────────────────────────────────────────────────────────────────────
guest traps (main.rs:1738)             guest returns (main.rs:1750)
  │                                      │
  ├─ teardown_adapters (main.rs:1743)    ├─ session closed if the guest left it
  ├─ drop_host_window  (main.rs:1747)    │    ready (main.rs:1794-1810)
  │                                      ├─ teardown_adapters (main.rs:1815)
  │                                      ├─ drop_host_window  (main.rs:1819)
```

**Step 1 — `teardown_adapters`.** Reverse link order, `shutdown` then `destroy`,
at most once (`adapter/mod.rs:1020`, `:987-1015`). `shutdown` stops and joins
background threads; `destroy` frees the adapter's own storage. Nothing is still
inside the adapter when `destroy` runs (`adapter/mod.rs:974-983`).

For the Ogre adapter, `shutdown` sets `shutting_down`, then
`stop_render_thread()` (`tension-ogre/src/adapter.cpp:1559-1572`), which
signals the thread and joins it (`adapter.cpp:1600-1627`, `:1624`). The backend's
`stop()` runs *on the render thread* — the thread that created every Ogre object
— and unmakes things in this order (`tension-ogre/src/backend_ogre.cpp:721-762`):

1. scene, then resources (an `Item` holds its mesh's vertex buffers),
2. `native_window_ = 0` before the window is destroyed, so a concurrent
   `window_handle` sees "no window" rather than a dying handle,
3. `destroyRenderWindow` (`:711`),
4. `root_->shutdown()` (`:721`) — this is where `vkDestroyDevice` runs
   (`third_party/ogre-next/RenderSystems/Vulkan/src/OgreVulkanDevice.cpp:525`),
5. `external_instance_.reset()` (`:726`) — **after** the root, because the
   plugin holds that pointer while shutting down.

**Step 2 — `drop_host_window`.** `HostWindow::drop` destroys the
`VkSurfaceKHR` and then the `VkInstance` (`platform.rs:650-666`), and only then
does the `SDL_Window` field drop — a `VkSurfaceKHR` must not outlive its window,
and the `Sdl` handle is the last field so `SDL_Quit` runs after everything
(`platform.rs:336-340`).

**What reversal costs.** This is the part that was learned by crashing:

- *Adapters torn down after the window* — the adapter holds a `VkSurfaceKHR`
  into an instance that has been destroyed. The comment at `platform.rs:653-655`
  says exactly this, and `main.rs:1743-1747` repeats it for the trap path, which
  is the path that would otherwise forget.
- *`external_instance_` freed before `root_->shutdown()`* — the render system
  reads the struct it was handed during shutdown, so the reset has to come after
  (`backend_ogre.cpp:750-753`).
- *Backend freed while the render thread is drawing* — SIGSEGV windowed, SIGABRT
  headless; this is why `AdapterState::~AdapterState` calls
  `stop_render_thread()` on the trap path (`adapter.cpp:1648-1660`).

**Status of the `VkDevice`-before-`VkInstance` claim.** *Inferred*, not directly
asserted. The device is destroyed inside `root_->shutdown()`
(`OgreVulkanDevice.cpp:525`), the instance inside `HostWindow::drop`
(`platform.rs:664`), and the second runs after the first because
`teardown_adapters` precedes `drop_host_window` on both paths
(`main.rs:1743/1747`, `:1815/1819`). No test asserts the ordering of the Vulkan
objects themselves; `ogre_host_surface` asserts a clean exit, and a validation
run produced no use-after-destroy. That is corroboration, not a proof.

## 4. The host loop

`HOST_LOOP_SLICE_MS` is **16** (`main.rs:2240`). It bounds exactly one thing:
how long the loop may block before it pumps SDL again.

One iteration (`main.rs:1927-2211`), in order:

1. **Exit test.** The guest's `game_running` say-so first, then whether anything
   is still parked, then whether a wake batch is pending (`main.rs:1934-1941`).
   Nothing is lost by testing in that order: a completion that arrives while the
   guest is stopping still gets drained.
2. **Pump.** `HostWindow::pump` drains SDL, updates the published size atomics,
   translates what it drained onto the event wire, publishes the window record,
   **and dispatches the batch to every registered layer** (§4.1). It reports
   `resized` / `close_requested` to the loop, and `translated` / `overflow` for
   diagnostics. The pump is reached from two places — this loop and the 2D
   renderer's present — which is why the dispatch lives inside it rather than
   beside it: whichever of the two drains an event is the one that dispatches
   it, and no event can be drained without being offered.
3. **Close.** `close_requested` sets `window_closed` (`main.rs:1978`) and the
   loop breaks (`main.rs:1982`). Not an error, and not a teardown here — the
   adapters still need `shutdown` on their own threads, which `main` arranges.
4. **Control executor.** One `drain` (`platform.rs:220`), then
   `apply_control` per message (`platform.rs:610`) on this thread, because
   `HostWindow` is not `Sync` and SDL requires the creating thread.
5. **Wait.** `wait_for_events(HOST_LOOP_SLICE_MS)` (`main.rs:2047` →
   `posting.rs:320`). It returns on a pending class event, on a fault or
   shutdown, or on the deadline; a negative timeout would block indefinitely and
   is still safe for the same three reasons (`posting.rs:315-352`).
6. **Epoch.** `run_epoch_with_store` (`main.rs:2070` →
   `session/epoch.rs:107`) publishes, matches and hands the wake batch to
   `__taskWake`.

### 4.1 The dispatcher

Input events reach a capability through a **layer**, not through SDL. The host
initialises the video subsystem, owns the window, and pumps on the thread that
did so; a capability subscribes a `tension_event_layer` with a family mask and
receives a batch once per pump (ABI v7, `tension_adapter.h`). The ordering is
mechanical rather than conventional: `pump` translates, then dispatches, in the
same call.

Why it is the host's job (measured, not asserted): SDL requires the video
subsystem to be used from the thread that initialised it, and a second
`SDL_Init` on another thread is what the old `tension-input` DSO did. Two
pollers on one queue split it nondeterministically — 4000 pushed events came out
2452/1548 on one run and 1796/2204 on the next, none lost, none duplicated — and
a second `SDL_Quit` on that thread tears the subsystem down under the host's own
window (the host's window then reports 0x0 and every later call fails).

Four properties the implementation is built to hold:

- **One thread.** `dispatch` runs on the window's thread, outside any adapter
  callback (a `publish` hook or a deferred `apply`) and never nested inside
  another dispatch (rule 13). It may call `post_event` and `post_control`; it
  must not touch guest memory, must not block, and must not register or
  unregister a layer. The pump itself has two sites: the host loop's own
  iteration, and the start of a blocking `session::wait` / `session::drain` —
  the second is what serves a guest that drives its own loop, which is the only
  way a renderer-less guest ever yields to the host.
- **The mask is the host's filter.** A layer receives only the families it
  named; it cannot ask for one it did not subscribe to.
- **No lock across adapter code.** `begin_dispatch` copies the layer table out
  and releases the bus mutex; `end_dispatch` reacquires it. That is what makes a
  re-entrant `register` a `-EBUSY` refusal instead of a deadlock on the same
  thread (`platform_events` asserts the lock is free from inside a dispatch).
  The bus is cleared at teardown *before* the window drops, so a layer is never
  called into after its adapter has been unloaded.
- **Bounded.** Eight layers, 256 events per pump; the excess is counted in
  `PlatformEvents::overflow` rather than truncating silently.

**The frame wake carries no time.** `rt.frame()` resolves to a task whose payload
is the literal `0` (`tension-framework/assembly/runtime/rt.ts:256-257`;
`main.rs:2094-2099` pushes `payload: 0`). No dt, no timestamp, no frame number —
the guest counts its own wakes. Note that `FrameState.frameIndex` is the
*session's epoch counter*, explicitly not the renderer's frame number
(`tension-framework/assembly/runtime/wire.ts:301-302`); using it as a frame
counter is a misreading the comment anticipates. A guest that wants a frame
identity increments one of its own, once per resolved `rt.frame()`.

**Resize latency.** A compositor resize becomes visible to a renderer at the
next iteration's pump, so the bound is one slice plus the duration of one epoch
— not a hard 16 ms. The comment at `main.rs:1947-1956` states the intent ("one
frame at 60 Hz"); there is no measurement in code backing the epoch term.
*Inferred.*

**Close latency.** The same bound: the close request is seen at the next pump.

**A guest that never yields freezes the window.** The epoch runs guest code
synchronously on the loop thread (`main.rs:2070`); a callback that does not
return means the loop never reaches its next `pump`, so the window stops
responding — including to close. There is no preemption and no watchdog.
*Risk, not a bug in the current model:* a guest is expected to park and yield,
and the 0.7.0a scheduler is what makes that possible. Recommendation: address it
in the scheduler pass, not here.

## 5. The two channels to a layer

A capability gets exactly two things from the host, one read and one write.

**Read — `host_surface`** (`tension_adapter.h:628`). Fills a
`tension_host_surface` (instance, surface, native handle, width, height) from the
published state (`ffi.rs:1517` → `adapter/mod.rs:449`), which `main` sets before
any adapter loads (`main.rs:1499`). Any thread (rule 7), no guest memory, no side
effects — the render thread calls it every frame. Answers `-ENOSYS` when the host
owns no window, which a layer must treat as "make your own window", not as an
error.

The record carries **two currencies for one window**: the Vulkan pair
(`instance`, `surface`) and the window system's own handle (`native_handle` —
X11 XID / Win32 HWND, 0 on Wayland and macOS). A render system that cannot adopt
a `VkSurfaceKHR` adopts the native handle instead, so no renderer ever opens a
second window behind the host's back. `native_handle` was appended after ABI v7;
the host writes only as many bytes as the caller's `struct_size` names, so an
adapter built before it still reads the old 32-byte shape.

**Read — `host_surface_extension`** (`tension_adapter.h:660`). Enumerates the
names the host passed to `vkCreateInstance`, one index at a time; `-ENOENT` past
the last (`adapter/mod.rs:463`). This exists because a `VkInstance` handle alone
is not enough for a renderer that validates its own extension list: Ogre's
external-instance path requires the caller to supply the list it enabled.

**Read — `host_window_info`** (ABI v7). The host's window record
(`tension_window_info`) as of the last pump, or a zeroed one when there is no
window — the same `width == 0` convention the guest's `window_info` uses, so a
capability has one test for "headless" rather than two. This is what a
capability that no longer owns a window handle uses to answer "is there a
window, and how big".

**Read — `pad_state`** (ABI v7). One gamepad slot's `tension_pad_record`, or
`-ENODEV` for a slot with no pad. The host opens the pads (from `pump`, on the
thread that initialised SDL) and samples every live slot at the end of each pump,
so this is a mirror read and honestly any-thread — SDL's gamepad getters are not
thread-safe, and a direct read from an arbitrary thread would be the same class
of mistake the two-poller design was. A caller that wants every button or axis
sample rather than the state subscribes to `TENSION_EVENT_PAD`.

**Write — `post_control`** (`tension_adapter.h:606`). Copies a
`tension_ctrl_msg` onto the control bus and returns. The answer is "queued",
never "applied" (`tension_adapter.h:585-586`); a caller that needs the result
polls `host_surface`. Any thread. Errno: `-EINVAL` for a null message, an
unknown `kind`, or non-zero `reserved`; `-ENOSPC` when the caller's share is
full — synchronously, because a silently dropped window command is
undetectable.

Capacity is 16 messages, 4 of them reserved for the core
(`platform.rs:77,81,83`), so a guest spamming `control()` cannot starve the
host's own traffic. A core message that finds the queue genuinely full is
returned as `ApplyNow` instead of being dropped (`platform.rs:106-118`, `:210`).
`source` is stamped by the bus, not trusted from the caller
(`platform.rs:197-212`).

**Subscribe — `register_event_layer`** (ABI v7). Registers a
`tension_event_layer`: a family mask, a `dispatch`, and an optional `shutdown`.
Returns a host-assigned token (1-based, never reused) which is the `layer_user`
both callbacks receive and the only name `unregister_event_layer` accepts. Eight
layers are served; `-ENOSPC` past that, `-EBUSY` from inside a dispatch, and
`-EINVAL` for a malformed layer. `shutdown` is called once, when the host clears
the dispatcher at teardown — not on unregister, which is a capability leaving of
its own accord.

**Guest side — three imports.** `tension::platform.control`,
`tension::platform.surface_width`, `tension::platform.surface_height`
(`main.rs:1322`, `:1345`, `:1350`; typed wrappers in
`tension-framework/assembly/platform.ts:38-47`). They are core services, not
capabilities: a guest with no renderer still has a surface size to ask about.

## 6. The adapter boundary

A capability is a shared object that exports `tension_adapter_v1` and returns a
pointer to a static vtable (`adapter/mod.rs:1029-1060`). The host checks the
**ABI version** before it touches any slot beyond the first
(`adapter/mod.rs:1045-1055`), then the **layout hash**
(`adapter/mod.rs:1070-1071`) — the version answers "is this the right shape",
the hash answers "is this the right build of it".

The ABI is alpha and at version 7 today (`tension_adapter.h`): it may break
between releases. Within a version it is append-only — `post_control` at offset
160, `host_surface` at 168, `host_surface_extension` at 176, and the four
dispatcher slots at 184/192/200/208 (`ffi.rs`, pinned by the header's
`_Static_assert` block and by `TensionCoreApi`'s size, 216 bytes) — and changing
the meaning of an existing field requires a new entry-point symbol
(`tension_adapter.h:17-22`).
Append-only is the discipline in force while alpha lasts, not a compatibility
promise.

Thread rules: `init`, `link` and the publish phase run on the interpreter
thread; `shutdown`/`destroy` are called on the interpreter thread at teardown
and `shutdown` must not touch guest memory (`adapter/mod.rs:974-983`). A
renderer owns its own thread and creates its objects there.

The slot-by-slot table is not duplicated here. The source of truth is the
header; [`docs/abi/adapter.md`](abi/adapter.md) is generated from it by
`npm run docs:abi` and checked by `npm test`, which also compiles a probe that
confirms every documented offset against the C compiler's `offsetof`.

## 7. The session boundary

One session per process today: `session: Option<Session>` (`main.rs:204`). Its
state machine is `Uninit`/`Ready`/`Closed` (`session/mod.rs:113-121`); the guest
opens it, and the host closes what the guest left open so the process never
exits with a session that looks live (`main.rs:1794-1810`).

The arena is the guest's memory; the host reaches it through the session, which
is taken out of the store for the duration of a verb — which is why the arena
handle is also kept separately (`main.rs:130-136`). The layout is pinned twice:
an adapter built against a moved region is refused at load, before `init`
(`adapter/mod.rs:1070-1071`), and the session verifies the guest's own arena —
its band and its canary lattice — between instantiation and `_start_game`
(`session/mod.rs:589-597`).

The epoch is the unit of work: publish, match, wake (`session/epoch.rs:107`),
once per loop iteration. It runs *inside* the guest's own turn; the host never
calls into guest code from another thread.

`SESSION.md` argues that the API should be plural — more than one session in a
process. The code is not plural, and this document describes the code. Treat
plurality as design intent, not as a property of the system today. *Risk /
unproven.*

One correction to `SESSION.md:78`, which lists "Root, SceneManager, **window**,
workspace, render thread" as Ogre's: the window is the host's
(`platform.rs:352`). Ogre owns the rest.

## 8. Risks and open contracts

- **A non-yielding guest freezes the window** (§4). No preemption, no watchdog.
- **A window is claimed, not shared.** Since the 2D merge the renderer runs in
  core and claims the host's `SDL_Window` for its own `SDL_GPUDevice`
  (`render2d/device.rs`), so there is one window and no second one. What is not
  fixed is the *combination*: a 2D renderer and Ogre in one run would be two GPU
  devices presenting to one window — legal, incoherent, and refused in advance by
  `Render2dState::claim_swapchain` (`-EBUSY`, naming the holder). Wiring Ogre's
  own claim through the same guard is Pass D.
- **Two validation findings remain open, both upstream.** Ogre's
  `destroySwapchain` calls `vkDestroySwapchainKHR` without stalling the device
  (`OgreVulkanWindow.cpp:562-575`), so `VUID-vkDestroySwapchainKHR-swapchain-01282`
  fires at teardown; and a rebuild that follows a readback rebuild can leave an
  image in `UNDEFINED` where the descriptor expects `PRESENT_SRC_KHR`
  (`VUID-vkCmdDraw-None-09600`). Both reproduce on the native path with no host
  surface, so neither is caused by the host-owned window. The host's own resize
  path stalls first and is clean.
- **No validation layers are enabled at instance creation**
  (`platform.rs:451-452`), so a validation run must force the layer through the
  loader environment. If it is ever enabled in-process, the adapter needs a
  symmetric layer-list slot; that is a deliberate new append, not an oversight.
- **Plurality is not implemented** (§7).

## 9. Non-goals

This document deliberately does not cover:

- **Record and region layout** (what a material record's bytes mean, the
  region catalogue, the sleep window) — [`docs/modules/ogre.md`](modules/ogre.md)
  §4, which reconciles the schema, the guest SDK and the (now deleted) design
  note against the code.
- **Per-adapter guest ABI details** — every import a guest can call.
  [`docs/abi/guest.md`](abi/guest.md), generated from the registration sites.
- **The ABI slot table** — [`docs/abi/adapter.md`](abi/adapter.md), generated
  from the header.
- **Build and CI** — `docs/build.md`.
- **Input** — [`INPUT.md`](../INPUT.md) is the design statement and
  [`docs/modules/input.md`](modules/input.md) is the module page: six verbs, the
  event flow, the threading model and the suites. The capability is an event
  layer as of v7: it owns no SDL, no thread and no window, and the pump runs in
  the epoch.
- **`tension-res`, `tension-solver`, `tension-world`** — their schemas and
  headers are the contract; no prose doc is planned.

## 10. Source files

**Citations are point-in-time.** They go stale when a cited file changes
above them, and no drift gate exists for this page — only the generated
`docs/abi/*.md` are drift-checked. Re-verify a citation before acting on
it. The real fix (generated citations, or slot names without line
numbers) is a future project.

| File | What it settles |
|---|---|
| `tension-core/src/main.rs` | init order, host loop, import registration, both teardown paths |
| `tension-core/src/platform.rs` | `HostWindow`, `HostSurface`, `ControlBus`, the pump |
| `tension-core/src/adapter/mod.rs` | `AdapterHost`, `PublishedSurface`, load and teardown |
| `tension-core/src/adapter/ffi.rs` | the Rust mirror of the C vtable |
| `tension-core/src/session/mod.rs` | session state, arena, open/close |
| `tension-core/src/session/posting.rs` | class queues, `wait_for_events` |
| `tension-core/src/session/epoch.rs` | publish / match / wake |
| `tension-core/src/audio/mod.rs` | the cpal device and its verbs |
| `tension-core/include/tension_adapter.h` | the C vtable, append-only rule, thread rules |
| `tension-ogre/src/adapter.cpp` | the render thread's life |
| `tension-ogre/src/backend_ogre.cpp` | Ogre object order, the per-frame size check |
| `tension-core/src/render2d/device.rs` | the 2D renderer: device, window claim, present |
| `tension-core/src/render2d/pipeline.rs` | the graph compiler, called in-process |
| `tension-2d/reference/` | the pre-port C++, unbuilt (Pass C deletes it) |
