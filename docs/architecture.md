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
device, the clock, the main loop — and the guest is a WebAssembly module that
must never learn that SDL3 or Vulkan exist. Between them is one narrow ABI of
plain integers: a guest reaches the host through registered imports, a capability
(a renderer, an input layer) reaches it through a versioned vtable, and
communication is batched where it is per-frame and asynchronous where it is I/O
or latency-bound.

The separation is structural, not documentary. The adapter header includes only
`<stddef.h>` and `<stdint.h>` (`tension-core/include/tension_adapter.h:35-36`),
so a capability cannot name an SDL or Vulkan type even if it wants to; the
handles it is given cross the boundary as `u64`
(`tension-core/src/platform.rs:238-244`).

## 2. Who owns what

| Resource | Owner | Created | Destroyed |
|---|---|---|---|
| `SDL_Window` | host | `platform.rs:352` (from `main.rs:1404`) | `platform.rs:650` |
| SDL video + event pump | host | `platform.rs:353-362` | field order, `platform.rs:336-340` |
| `VkInstance` | host | `platform.rs:452` | `platform.rs:664` |
| `VkSurfaceKHR` | host | `platform.rs:457` | `platform.rs:663` |
| `VkDevice` | renderer (Ogre) | inside `root_->init`, from the host's instance | `OgreVulkanDevice.cpp:525` |
| Swapchain | renderer | `OgreVulkanWindow` | `destroyRenderWindow`, `backend_ogre.cpp:698` |
| Render thread | renderer | `tension-ogre/src/adapter.cpp:539` | joined `adapter.cpp:1532` |
| SDL event queue | host, `platform.rs:536` | with the window | with the window |
| Guest input attach | the `tension-input` DSO | `input_attach` | replaced in the v7 input pass |
| Audio device (cpal) | host, `tension-core/src/audio/mod.rs:55` | `audio_init` | `audio_shutdown`, `audio/mod.rs:146` |
| Filesystem | host, mediated by `tension::res`, `main.rs:1114` | startup | process exit |
| Clock / timing | host, `std::time` behind `posting.rs:320` | — | — |
| Main loop | host, `main.rs:1927` | after guest entry returns | loop exit |
| Session (epoch, arena) | host, `main.rs:204` | guest asks | guest closes, or the host closes for it |
| Guest `Store<HostState>` | host, `main.rs:895` | before instantiation | end of `main` |
| Capability code (DSO) | the adapter itself | `adapter/mod.rs:1029` | `adapter/mod.rs:1020` |

The rows that are not obvious:

**The window precedes the surface, and the surface is lazy.** `HostWindow::new`
creates an `SDL_WINDOW_VULKAN` window and nothing else (`platform.rs:352-375`).
The `VkInstance` is created on the first `surface()` call (`platform.rs:403`),
which only happens when an adapter was actually loaded (`main.rs:1489-1517`). A
`--window` run with no renderer opens a window and never loads Vulkan.

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

**`tension-2d` still owns a window of its own** (`tension-2d/src/render.cpp:485,504`).
It does not consume the host surface today; see §8.

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
`stop_render_thread()` (`tension-ogre/src/adapter.cpp:1467-1477`), which
signals the thread and joins it (`adapter.cpp:1538-1542`, `:1532`). The backend's
`stop()` runs *on the render thread* — the thread that created every Ogre object
— and unmakes things in this order (`tension-ogre/src/backend_ogre.cpp:681-722`):

1. scene, then resources (an `Item` holds its mesh's vertex buffers),
2. `native_window_ = 0` before the window is destroyed, so a concurrent
   `window_handle` sees "no window" rather than a dying handle,
3. `destroyRenderWindow` (`:698`),
4. `root_->shutdown()` (`:708`) — this is where `vkDestroyDevice` runs
   (`third_party/ogre-next/RenderSystems/Vulkan/src/OgreVulkanDevice.cpp:525`),
5. `external_instance_.reset()` (`:713`) — **after** the root, because the
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
  (`backend_ogre.cpp:710-713`).
- *Backend freed while the render thread is drawing* — SIGSEGV windowed, SIGABRT
  headless; this is why `AdapterState::~AdapterState` calls
  `stop_render_thread()` on the trap path (`adapter.cpp:1544-1565`).

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
2. **Pump.** `HostWindow::pump` (`platform.rs:536`) drains SDL, updates the
   published size atomics on a resize (`platform.rs:556-562`), and reports
   `resized` / `close_requested` (`main.rs:1960-1980`).
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
`tension_host_surface` (instance, surface, width, height) from the published
state (`ffi.rs:1517` → `adapter/mod.rs:449`), which `main` sets before any
adapter loads (`main.rs:1499`). Any thread (rule 7), no guest memory, no side
effects — the render thread calls it every frame. Answers `-ENOSYS` when the host
owns no surface, which a layer must treat as "make your own window", not as an
error.

**Read — `host_surface_extension`** (`tension_adapter.h:660`). Enumerates the
names the host passed to `vkCreateInstance`, one index at a time; `-ENOENT` past
the last (`adapter/mod.rs:463`). This exists because a `VkInstance` handle alone
is not enough for a renderer that validates its own extension list: Ogre's
external-instance path requires the caller to supply the list it enabled.

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

The ABI is at version 6 (`tension_adapter.h:82`) and is append-only within a
version: `post_control` at offset 160, `host_surface` at 168,
`host_surface_extension` at 176 (`ffi.rs:330-336`, pinned by the header's
`_Static_assert` block). Changing the meaning of an existing field requires a
new entry-point symbol (`tension_adapter.h:17-19`).

Thread rules: `init`, `link` and the publish phase run on the interpreter
thread; `shutdown`/`destroy` are called on the interpreter thread at teardown
and `shutdown` must not touch guest memory (`adapter/mod.rs:974-983`). A
renderer owns its own thread and creates its objects there.

The slot-by-slot table is not duplicated here. The source of truth is the
header; a generated companion (`docs/abi/adapter.md`) is planned but not yet
written.

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
- **Two SDL subsystems can exist in one process.** The core loads SDL3 for the
  host window (`platform.rs:352`); `tension-2d` loads its own and creates its
  own window (`tension-2d/src/render.cpp:485,504`). With `--window` and the 2d
  adapter, the guest's renderer is not drawing into the host's window. Not
  fixed; the 2d host-surface path is future work.
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
  region catalogue, the sleep window). Source of truth today is
  `tension-ogre/DESIGN.md` §3-6 and `tension-framework/assembly/ogre/*.ts`, and
  **they may disagree** — the next module doc has to reconcile them against the
  code rather than copy either.
- **Per-adapter guest ABI details** — every import a guest can call. To be
  generated (`docs/abi/guest.md`) from the registration sites.
- **The ABI slot table** — generated from the header (`docs/abi/adapter.md`).
- **Build and CI** — `docs/build.md`.
- **Input attach** — deferred to the v7 input pass, which deletes the
  `tension-input` DSO and moves the pump into the epoch.
- **`tension-res`, `tension-solver`, `tension-world`** — their schemas and
  headers are the contract; no prose doc is planned.

## 10. Source files

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
| `tension-2d/src/render.cpp` | the 2d adapter's own window |
