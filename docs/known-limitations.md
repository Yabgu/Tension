# Known limitations

What does not work today, why, and what would unlock it. Not a bug list —
defects with reproductions live in [`known-issues.md`](known-issues.md). Not a
wish list — things that are deliberately not being built are
[`vision.md`](vision.md) §6, and deliberate deferrals with unlock conditions are
§5 of the same file.

A row with no blocker and no unlock condition does not belong here. If it is the
current design, it belongs in `vision.md`; if it is a wish, it belongs nowhere
yet.

| Limitation | Since | Blocker | Unlock | Owner |
| --- | --- | --- | --- | --- |
| The canary lattice detects guest overlap, it does not prevent it | arena layout | one wasm memory | a second memory in the guest ABI | — |
| The region layout is fixed at twelve kinds | arena layout | `kind == index` and `layout_hash` | schema bump, or a dynamic allocation verb | — |
| `RING` delivery behaves like `POLLED` | epoch v1 | only `BATCHED` and `DIRECT` are special-cased | a ring delivery path | — |
| `tension-2d` owns and creates its own window | the module | SDL_GPU has no external-surface handoff | upstream support, or a Vulkan renderer | vision §5.2 |
| The 2d windowed path is never exercised | the module | every scenario uses `SDL_VIDEODRIVER=offscreen` | a windowed fixture that can run headless | — |
| The 2D pixel scenarios do not run on this rig | pre-dates `272309e` | NVIDIA ICD SIGSEGV in `present` | a conformant ICD (CI's lavapipe) | CI |
| No offscreen GPU render path | `f1c57af` | the adapter has no offscreen target | an offscreen `VkImage` path | — |
| Swapchain destroyed with the queue still holding its images (#17) | Ogre pin `475f783` | upstream `destroySwapchain` does not stall | a patch hunk, at a per-rebuild cost | — |
| Draw against a rebuild's previous image layout (#18) | Ogre pin `475f783` | upstream rebinds no Hlms descriptors | the same patch area | — |
| Six example lockfiles name a deleted package (#26) | package removal | needs the network to regenerate | `npm install` in each example | pass 7d |
| Two input sources still assert the old teardown rule (#28) | `9d3af39` | the file belongs to the v7 pass | v7 input pass | v7 |
| Source comments cite design notes that no longer exist (#29) | `2c74bbe` | none — mechanical | a sweep of ~166 sites | pass 7d |
| HDR output | — | Ogre-Next has no output-HDR path | the colour-management API | vision §5.1 |
| Win32 is cross-compiled, never run | — | needs a Windows machine and a Win32 host-surface variant | both exist | vision §5.3 |
| One window per process | ABI v6 | one `HostSurface` in the ABI | a surface set | vision §5.4 |
| Input dispatcher still in the DSO | — | scheduled as its own pass | that pass opens | vision §5.5 |
| Win32 header path is a checked-in overlay | `ci/linsys2.md` | Ogre's tree has no `WIN32` platform define for the Vulkan window | upstream, or the overlay grows | — |
| The isometric suites fail on this rig | — | NVIDIA GL driver crash | the same ICD | CI |

## The canary lattice detects, it does not prevent

The reserved gap between the arena's layout end and `memoryBase` is guarded by a
16-byte canary every 4 KiB, carrying `(offset ^ magic)` and its complement
(`tension-core/src/session/arena.rs:471-476`, `:954`). A mismatch is detected at the next
check and reported as `FAULT_GUEST_OVERLAP` with `-EIO`. A write that misses
every block between two checks is not detected until it lands on one. The two
other mechanisms are not substitutes: the control-block triple (`magic`,
`layoutHash`, `regionCount`) catches a guest that overwrites the arena's metadata
at any entry, and the pre-`start` zero sweep is complete for the startup case
only. Canaries make the common `memoryBase` drift loud; they do not make overlap
impossible.

The structural fix — a second wasm memory for the arena, so isolation is a
property of the module rather than of a sampler — is not available today: the
build emits one imported memory (`scripts/gen-session.mjs`, `importMemory: true`),
and nothing in the guest ABI names a second (`docs/abi/guest.md`, "Memory").

## The region layout is fixed; a capability cannot add one

`region_lookup` answers `-ENOENT` for any kind outside the twelve. A capability
that needs its own region requires either a schema bump — `layoutHash` and
`schemaVersion` both move, every capability recompiles — or a dynamic allocation
verb with a directory, which forfeits the `kind == index` O(1) lookup and the
compile-time offsets `link` depends on. Neither exists. `RESOURCE_REQ` is the
one region in the table with no live consumer (`tension-core/src/session/arena.rs:430`;
the only reader outside the layout is
`tension-core/tests/support/ogre_stub_adapter.c:457`).

## `RING` delivery is accepted but behaves like `POLLED`

`MODE_RING` is a valid subscription value (`tension-core/src/session/arena.rs:130`)
and is not refused (`tension-core/src/session/mod.rs:1432`), but the epoch
special-cases only `BATCHED` and `DIRECT`; every other mode, `RING` included,
publishes into the class sub-ring with no callback and waits for the guest to
drain it (`tension-core/src/session/epoch.rs:292-318`). A guest that subscribes
`RING` gets `POLLED` behaviour and no diagnostic says so.

## `tension-2d` owns its own window

With `TENSION_2D_OPEN_WINDOWED`, the 2d capability creates and claims its own
`SDL_Window` (`tension-2d/src/render.cpp:522-539`). The host owns a window too
(`tension-core/src/platform.rs:352`), so a run with `--window` and the 2d
capability has two windows and the guest's frame is not drawn into the host's.
This contradicts the ownership model in [`architecture.md`](architecture.md) §2
and is unfixed: SDL_GPU has no external-surface handoff, so the fix is a new
capability path rather than a parameter. [`modules/2d.md`](modules/2d.md) §3;
contradiction 24; deferral recorded in [`vision.md`](vision.md) §5.2.

**Every 2d scenario runs `SDL_VIDEODRIVER=offscreen`**, so `SDL_CreateWindow`,
`SDL_ClaimWindowForGPUDevice` and the swapchain blit in `present` are compiled and
never executed by a test. That is why the two-window problem has never been
observed in a run rather than merely unrecorded.

## The 2D pixel scenarios do not run on this rig

`scripts/test-2d.mjs` fixes a real harness defect — its stub core never set
`abi_version`, so every run failed at `init` since ABI v6 (contradiction 27).
With that fixed, the scenarios reach `present` and die from SIGSEGV inside
`libnvidia-glcore` under `SDL_VIDEODRIVER=offscreen`. The driver-guard case runs
before any device exists and passes here; the pixel scenarios need a conformant
Vulkan ICD, which is what the CI image's lavapipe provides. The `isometric` and
`isometric-framework` suites fail the same way.

## No offscreen GPU render path

`headless` is honoured (`tension-ogre/src/config.cpp:234-250`): with no
`renderer` key it resolves to the null renderer, and with an explicit GPU
renderer it is refused with `-EINVAL`, because this build has no offscreen
target to render into. Headless means "no window", not "render without one".

## Upstream Vulkan validation at teardown and rebuild

Two VUIDs fire and are deliberately not patched around:

- **`VUID-vkDestroySwapchainKHR-swapchain-01282`** — `destroySwapchain`
  (`RenderSystems/Vulkan/src/OgreVulkanWindow.cpp:562`) destroys the swapchain
  with the queue still holding its images. Reproduced identically on the native
  path, so it is upstream's. Our external-surface patch stalls before
  `destroySwapchain` on resize; upstream's other rebuild paths do not.
- **`VUID-vkCmdDraw-None-09600`** — after a readback rebuilds the swapchain,
  the next rebuild draws against an image in `UNDEFINED` layout because nothing
  rebinds the Hlms descriptors (`OgreVulkanWindow.cpp:722-733`).

Both are validation-layer only on this rig: frames present and read back
correctly. Fixing either is a patch hunk with a cost on every rebuild.

## Six example lockfiles name a deleted package

`examples/ogre/{animated-character,bouncing-ball,bouncing-bodies,hello-mesh,hello-triangle,input-camera}/package-lock.json`
still resolve `@yabgu_gm/tension-freeimage`, which is not in the tree, so a clean
`npm install` there fails. The remedy is six `npm install` runs and a regenerated
lockfile; that needs the network and a registry state that matches, so it is not
done here. Contradiction 26; [`build.md`](build.md) §5.

## Two input sources assert the old teardown rule

The host calls the vtable's `shutdown` then `destroy` on both exit paths
(`tension-core/src/adapter/mod.rs:987-1011`); `tension-input/DESIGN.md:60` and
`tension-input/src/adapter.cpp:226` still say it never does. Both belong to the
v7 input pass. Contradiction 28.

## Source comments cite deleted design notes

`tension-ogre/DESIGN.md` and `tension-2d/DESIGN.md` were deleted in `2c74bbe`.
Measured at `0672e1e`: 166 references remain in 71 tracked files — mostly
`file:line` comments in `tension-core/src/session/` (34), `main.rs` (8),
`world/eval.rs` (6) and the per-module design notes that still exist. The pages
in `docs/` already mark their `DESIGN.md:` citations as historical provenance.
The source comments need a sweep: retarget to the new page, or drop the pointer
and keep the claim. Contradiction 29.

## Win32: cross-compiled, never run; headers by overlay

The Win32 side of the Vulkan window is compiled and statically checked, not
executed (`ci/linsys2.md`). Ogre's tree has no `WIN32` platform define for the
Vulkan window configuration, so a checked-in overlay supplies it
(`third_party/patches/win32-headers/`), and `scripts/check-win32-headers.mjs`
fails if the overlay drifts from the pinned submodule. Runtime testing is
[`vision.md`](vision.md) §5.3.
