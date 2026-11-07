# Known limitations

**Stub.** Pass 5 owns this file. It is started here because deleting
`tension-ogre/DESIGN.md` would otherwise lose three constraints that exist
nowhere else in the tree. Nothing below is a bug report; each is a limit a
reader should know before relying on the arena or the session.

## The canary lattice detects, it does not prevent

The reserved gap between the arena's layout end and `memoryBase` is guarded by a
16-byte canary every 4 KiB, carrying `(offset ^ magic)` and its complement. A
mismatch is detected at the next check and reported as `FAULT_GUEST_OVERLAP`
with `-EIO`. A write that misses every block between two checks is not detected
until it lands on one. The two other mechanisms are not substitutes: the
control-block triple (`magic`, `layoutHash`, `regionCount`) catches a guest that
overwrites the arena's metadata at any entry, and the pre-`start` zero sweep is
complete for the startup case only. Canaries make the common `memoryBase` drift
loud; they do not make overlap impossible.

The structural fix — a second wasm memory for the arena, so isolation is a
property of the module rather than of a sampler — is not available today: the
build emits one imported memory (`scripts/gen-session.mjs:207`,
`importMemory: true`), and nothing in the guest ABI names a second
(`docs/abi/guest.md`, "Memory").
Source: `tension-ogre/DESIGN.md` §5.4, `tension-core/src/session/arena.rs:404-427`
(the table they guard), `docs/architecture.md:272-278` (the one-line summary).

## The region layout is fixed; a capability cannot add one

`region_lookup` answers `-ENOENT` for any kind outside the twelve. A capability
that needs its own region requires either a schema bump — `layoutHash` and
`schemaVersion` both move, every capability recompiles — or a dynamic allocation
verb with a directory, which forfeits the `kind == index` O(1) lookup and the
compile-time offsets `link` depends on. Neither exists. `RESOURCE_REQ` is the
one region in the table with no live consumer (`tension-core/src/session/arena.rs:423`;
the only reader outside the layout is
`tension-core/tests/support/ogre_stub_adapter.c:457`).
Source: `tension-ogre/DESIGN.md` §5.2.

## `RING` delivery is accepted but behaves like `POLLED`

`MODE_RING` is a valid subscription value (`tension-core/src/session/arena.rs:128`)
and is not refused (`tension-core/src/session/mod.rs:1432`), but the epoch
special-cases only `BATCHED` and `DIRECT`; every other mode, `RING` included,
publishes into the class sub-ring with no callback and waits for the guest to
drain it (`tension-core/src/session/epoch.rs:292-318`). A guest that subscribes
`RING` gets `POLLED` behaviour and no diagnostic says so.
Source: `tension-ogre/DESIGN.md` §3.2 ("reserved and stubbed in chunk 1").

## `tension-2d` owns its own window

With `TENSION_2D_OPEN_WINDOWED`, the 2d capability creates and claims its own
`SDL_Window` (`tension-2d/src/render.cpp:504-521`). The host owns a window too
(`tension-core/src/platform.rs:352`), so a run with `--window` and
the 2d capability has two windows and the guest's frame is not drawn into the
host's. This contradicts the ownership model in `docs/architecture.md` §2 and is
unfixed: SDL_GPU has no external-surface handoff, so the fix is a new capability
path rather than a parameter. `docs/modules/2d.md` §3; contradiction 24.

## The 2d windowed path is untested

Every 2d scenario runs `SDL_VIDEODRIVER=offscreen`, so `SDL_CreateWindow`,
`SDL_ClaimWindowForGPUDevice` and the swapchain blit in `present` are compiled and
never executed by a test. This is why the two-window problem above has never been
observed in a run rather than merely unrecorded.

## `SDL_VIDEODRIVER=dummy` is refused with `-ENODEV` and a named driver

`dummy` comes up as a video driver with no GPU backend. `open` refuses it before
the device is attempted, naming both the driver and the one that works
(`tension-2d/src/render.cpp:491-505`); the errno is the `-ENODEV` the
device-creation failure would have produced. Contradiction 25, closed.

## The 2D render scenarios do not run on this rig

`scripts/test-2d.mjs` fixes a real harness defect this pass — its stub core never
set `abi_version`, so every run failed at `init` since ABI v6 (contradiction 27).
With that fixed, the scenarios reach `present` and die from SIGSEGV inside
`libnvidia-glcore` under `SDL_VIDEODRIVER=offscreen`. The driver-guard case runs
before any device exists and passes here; the pixel scenarios need a conformant
Vulkan ICD, which is what the CI image's lavapipe provides.
