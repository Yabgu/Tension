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
| The 2D *pixels* are never checked on this rig | the module | every scenario uses `SDL_VIDEODRIVER=offscreen`, and no pipeline can be created here | a conformant ICD (CI's lavapipe) | CI |
| The 2D scenarios do not run on this rig | pre-dates `272309e` | `vkCreateGraphicsPipelines` → `VK_ERROR_OUT_OF_HOST_MEMORY` under Mesa `dzn` | a conformant ICD (CI's lavapipe) | CI |
| No offscreen GPU render path — `target=offscreen` names it, it does not supply it | `f1c57af` | the adapter has no offscreen target; the value resolves to the NULL render system, which produces no image | an offscreen `VkImage` path | — |
| Swapchain destroyed with the queue still holding its images (#17) | Ogre pin `475f783` | upstream `destroySwapchain` does not stall | a patch hunk, at a per-rebuild cost | — |
| Draw against a rebuild's previous image layout (#18) | Ogre pin `475f783` | upstream rebinds no Hlms descriptors | the same patch area | — |
| HDR output | — | Ogre-Next has no output-HDR path | the colour-management API | vision §5.1 |
| Hardware floor: a Vulkan, D3D12 or Metal GPU (~2017 or newer) | the renderer split | there is no software-rendering path; `SDL_GPU` needs one of those three, and Ogre's Vulkan backend needs Vulkan | a software backend (lavapipe covers CI, not users) | vision §5.1 |
| Win32 is cross-compiled, never run | — | needs a Windows machine and a Win32 host-surface variant | both exist | vision §5.3 |
| `tension-input` builds on Windows, has never been run there | v7 | needs a Windows machine to run the input suites | one exists | vision §5.3 |
| The GL3+ windowed suite needs an X11 display | — | Ogre-Next 3.0's GL3+ is GLX; a Wayland window has no adoptable handle | an EGL backend, or `SDL_VIDEODRIVER=x11` on XWayland | vision §5.3 |
| One window per process | ABI v6 | one `HostSurface` in the ABI | a surface set | vision §5.4 |
| Win32 header path is a checked-in overlay | `ci/linsys2.md` | Ogre's tree has no `WIN32` platform define for the Vulkan window | upstream, or the overlay grows | — |
| The isometric suites fail on this rig | — | `vkCreateGraphicsPipelines` fails under `dzn` | the same ICD | CI |

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

## `tension-2d` owns its own window — **closed**

**Closed in the 2D merge.** `tension-2d` no longer creates a window; it claims the
host's. There is no `SDL_CreateWindow` in the 2D path — the renderer lives in
`tension-core/src/render2d/device.rs` and presents by calling
`SDL_ClaimWindowForGPUDevice` on the `SDL_Window` the host already owns. The
window itself is created on demand, at the size the canvas declares, so a guest
calling `Canvas.windowed()` needs no `--window` beside it.

A second claim is refused by SDL with `"Window already claimed"`
(`SDL_gpu_vulkan.c:9940-10012` at release-3.4.18) and by core first, with the
owning renderer's name, as `-EBUSY`. The proof that the refusal path is real is
`tension-core/tests/render2d_open.rs`, which opens a windowed canvas, asserts the
claim, and asserts that a second claimant is refused without disturbing it.

What the merge did **not** fix is the pixels: every 2D test runs
`SDL_VIDEODRIVER=offscreen`, so the windowed claim is exercised but what a user
would see is not. See the next entry.

## The 2D pixel scenarios need a conformant Vulkan ICD

Every 2D scenario that draws needs a working graphics pipeline, and a machine
where `vkCreateGraphicsPipelines` fails cannot run any of them. On the
development rig (Mesa `dzn` under WSL2) it fails with
`VK_ERROR_OUT_OF_HOST_MEMORY`, which the *untouched* C++ renderer reproduces
identically — so it is the driver, not the port.

Two things follow, and the merge handled both:

- `tension-core/tests/render2d_open.rs` asserts the one frame that needs no
  pipeline: an empty `present` clears to `(0,0,0,255)` and `screenshot` reads it
  back, pixel by pixel. That pins the clear colour, the target format and the
  readback layout on a rig where nothing else can draw.
- `scripts/parity-2d.mjs` compares the two backends' shader modules byte for byte
  on any machine, and skips the same-guest comparison with the assertion it would
  have run stated. It also asserts that both backends fail at the same verb with
  the same errno, which is the only cross-backend signal this rig can give.

The `isometric` and `isometric-framework` suites fail rather than skip when no
pipeline can be created, which is the policy in `tests/support/ci.rs`. CI's
image provides lavapipe, which is what makes them run there.

## No offscreen GPU render path

`headless` is honoured (`tension-ogre/src/config.cpp:252-266`): with no
`renderer` key it resolves to the null renderer, and with an explicit GPU
renderer it is refused with `-EINVAL`, because this build has no offscreen
target to render into. Headless means "no window", not "render without one".

`target=offscreen` (`tension-ogre/src/config.cpp:268-294`) makes the same
promise under the contract's own name: no window, the NULL render system, no
image. The value exists so a backend that can render offscreen implements one
contract instead of inventing a second one — it is not a claim that this backend
can. A guest that asks for `offscreen` and an explicit GPU renderer is refused
with `-EINVAL`, exactly as `headless` over a GPU renderer is.

## The hardware floor is a 2017-or-newer GPU

Both renderers need a modern graphics API: the 2D renderer is `SDL_GPU`, which
resolves to Vulkan, D3D12 or Metal, and the 3D backend is Ogre-Next's Vulkan
render system. There is no software fallback for either, and none is planned —
CI uses lavapipe (a software Vulkan ICD) so the suites can run headless, but a
machine without one of those three APIs cannot render, and no amount of
configuration changes that. The window itself can be created on such a machine
(`target: plain`); what fails is the renderer's device, at the point it asks.

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

## The old input teardown rule — **closed**

The claim was "the host never calls the vtable's `shutdown`/`destroy`". It has
been false since `9d3af39`: the host calls both, reverse of link order, once
each, on a clean return and on a guest trap
(`tension-core/src/adapter/mod.rs:1021-1049`).

`tension-input/DESIGN.md` was rewritten in v7b and then deleted in v7c — its
contents are [`modules/input.md`](modules/input.md) now — and the
`adapter.cpp` comment the contradiction named was removed with it. The teardown
site states the true contract instead: `adapter_shutdown` unregisters the event
layer, has no thread to join, and never calls `SDL_Quit`
(`tension-input/src/adapter.cpp:397-409`, `INPUT.md` §5).

Contradiction 28 (in the workspace's own `docs-contradictions.md`, outside this
repository) is closed; `SESSION.md:332`'s instance belongs to that doc's
declared-historical section.

## Citations to the deleted design notes

`tension-ogre/DESIGN.md` and `tension-2d/DESIGN.md` were deleted in `2c74bbe`.
The sweep is done for everything outside two files: every source comment now
points at `docs/session.md`, `docs/modules/ogre.md`, `docs/modules/2d.md`,
`docs/abi/adapter.md` or `docs/architecture.md`, or states the claim without a
pointer where no page carries it. Bare `DESIGN.md` references in
`tension-res/`, `tension-solver/`, `tension-world/` and the core's
`solver/`/`world/` modules name the note that still exists.

What remains, deliberately:

- **`INPUT.md`** — **done in v7c.** The page was rewritten around the layer
  model and no longer quotes a deleted note; the seven citations went with the
  thread model they described.
- **`SESSION.md`** — four citations inside its own argument, declared
  historical in the header. Rewriting the argument is not a citation fix.
- **`docs/`** — the pages that preserve a deleted note's claims cite it as
  provenance, and each says so at the top of the section or the page.

## Win32: cross-compiled, never run; headers by overlay

The Win32 side of the Vulkan window is compiled and statically checked, not
executed (`ci/linsys2.md`). Ogre's tree has no `WIN32` platform define for the
Vulkan window configuration, so a checked-in overlay supplies it
(`third_party/patches/win32-headers/`), and `scripts/check-win32-headers.mjs`
fails if the overlay drifts from the pinned submodule. Runtime testing is
[`vision.md`](vision.md) §5.3.

## GL3+ needs an X11 display on a Wayland session

`TENSION_OGRE_WINDOW_TEST=1 node scripts/test-ogre.mjs` opens a real window for
every opt-in case, and the GL3+ ones fail on a native Wayland session with
`DEVICE_LOST` at the first frame. It is not a renderer bug: Ogre-Next 3.0's GL3+
render system on Linux is GLX, so it needs an X11 display and a window with an
adoptable native handle. A Wayland window has neither (`HostWindow::native_handle`
documents 0 for it), and the adapter refuses rather than opening a window of its
own.

On a Wayland host with XWayland available — the common case — run the windowed
suite with the driver pinned:

```sh
TENSION_OGRE_WINDOW_TEST=1 SDL_VIDEODRIVER=x11 node scripts/test-ogre.mjs
```

The Vulkan path does not need this: `input-camera` runs under the native Wayland
driver (`create_window … target=Vulkan on 'wayland'`), which is what the
surfaces above are for. The same pin makes `hello-sprites`' windowed run work.
The default suite (`npm test`) sets no driver and passes on either session.

## `tension-input` on Windows: builds, not run

**`tension-input` builds on Windows as of v7.** The capability has no X11 and no
SDL dependency left — no `libX11`, no `SDL_Init`, no thread — so
`scripts/build-input.mjs` has no platform gate and produces
`libtension_input.dll` with the same recipe it uses for `.so` (`CXX`,
`-std=c++17 -O2 -fPIC -Wall -Wextra -shared`). On Linux the DSO's `DT_NEEDED`
is `libstdc++`, `libm`, `libgcc_s`, `libc`, and the build fails if `SDL`
appears; the Windows import list is the same runtime minus nothing platform
shaped, because nothing in `src/` names one.

**It has not been run there.** Compiling is the whole claim: the input suites
start a real host and create a real window, and none of that has been executed
on Windows. `scripts/test-input.mjs` no longer skips Windows, so the claim will
be tested the first time someone runs it there; until then, "builds" is the
limit of what this repository knows, and [`vision.md`](vision.md) §5.3 is the
condition that changes it.
