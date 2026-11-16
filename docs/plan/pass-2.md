# Pass 2 — the nested guest

**Status:** durable plan reference. The plan itself was deleted with the planning
corpus (`2c74bbe`); this page is the numbering and the decisions that survived
only in commit bodies, written down where a fresh clone can find them. It is a
record of what was decided, not a proposal.

## The five passes

- **Pass 1 — the host library.** `main()` registered every capability inline;
  each was lifted into a module with the guest-kind as a parameter. Three
  slices, closed.
- **Pass 2 — the nested guest.** A guest that runs another guest, renders into
  records, and hands them back. Slices below. 1–4 closed, the remainder open.
- **Pass 3 — the compiler daemon.** Not started. No file in this tree specifies
  it; the shape appears only in Pass 2 commit prose.
- **Pass 4 — the editor demo, final.** Not started.
- **Pass 5 — cleanup, and optionally F1** (press F1 in the editor, docs opens).
  Not started.

## Pass 2's five slices

1. **Capture mode** (`022b2b2`). `Render2dState::Mode::Capture`: records are
   staged and not cleared. Inert until slice 4, by design.
2. **The sandboxed second guest** (`e8e3dce`, with `5aede1d`). A second wasm
   store, its bounds, and the finding that `GuestState` is `!Send`.
3. **`tension::dev`** (`7697ec2`). `run` / `stop` / `out`, a run registry, and
   the depth rule.
4. **`dev.frame` and `dev.read`** (`2582de5`, `11699b7`, fixed by `5c3caf8`).
   The run declares its kind; a frame completes at `present`, not at the first
   return from guest code; `read` probes then fills and refuses a partial frame.
   **4b** is the second half of this slice: making a real guest actually run
   sandboxed and produce records.
5. **The nested guest in the editor.** Open. 4b-5 and 4b-6 below, then 4c is
   deferred rather than part of this slice.

## 4b's six sub-slices

Only two carry their number in a commit body, and two more are identifiable by
position. The arrows are what the commits say; where the number is inferred, it
is marked so it is not quoted as evidence.

- **4b-1 — per-call deadline.** `5c3caf8` (inferred number). `Sandbox::open`
  armed the epoch once; wasmtime's deadline is absolute, so the bound capped the
  guest's lifetime. Measured: trapped on frame 9, 178 ms in.
- **4b-2 — the session, for a nested guest.** `6ad9e75` (inferred number).
  `GuestHost::build` built the session and left it uninstalled, because `main`
  normally installs it; a nested guest has no `main`.
- **4b-3 — the platform namespace.** `2d407f6` (numbered in `2cf7fae`). One
  registration for both guest kinds; the window verbs answer `-ENOTSUP`, the
  viewport answers honestly.
- **4b-4 — capture mode for the real verbs.** `2cf7fae` (numbered in its own
  body). `set_preset`, `set_pipeline_blob`, `texture_load`, `set_texture`
  reserve ids and record their arguments instead of building GPU objects.
- **4b-5 — replay onto the outer device.** **Done.** Allocate the recorded
  pipelines, textures and bindings on the device that actually draws, and offset
  a record's `tex` by the page base the nested guest was given.
  `Render2dState::replay_deferred(&Deferred, page_base)` builds pipelines in
  ascending id, loads each recorded IWI through the presenter's own
  `texture_load`, and binds every recorded page at `page_base + slot`;
  `forward_into` applies the same base to the records as they leave the sandbox.
  `NESTED_PAGE_BASE = 1` (the outer keeps page 0), `nested_page` is the checked
  bound (`-EINVAL`, never a clamp), and the implicit page-0 binding is reapplied
  at the base while the *outer's* implicit page 0 is written down first. Five
  tests: the three declared plus `the_replay_keeps_the_outer_implicit_page_zero`
  and `the_page_base_is_checked_at_the_boundary`, with `nested_records_land_in_
  bucket_zero` extended to assert the page the outer guest actually receives. A
  warm gate is 26/26 with cargo **620** passed / 0 failed (declared 615 → 618; the
  two extra are the boundary check and the outer-implicit-page-0 guard), warnings
  85 in 18 distinct rows.
- **4b-6 — the editor.** **Done.** Play runs a nested guest, frames drive it, its
  records land in the editor's frame, Stop and Esc return. The SDK wrapper is new
  (`tension-framework/assembly/dev.ts`: `Dev.run` → `DevRun.{frame, readFrame,
  frameBytes, out, pipe, stop}`, `OutBuffer`, no `Bytes` import, no `adopt`);
  `RecordBuffer.place(x, y, w, h)` moves a forwarded frame onto the viewport and
  drops what does not fit; `examples/2d/isometric` adopted the frame contract
  (exports `__taskWake` + `_game_running`, the blocking `while` loop replaced by
  one `present` per hook, the two facing passes and the offscreen path unchanged);
  `apps/editor` calls `dev.run(RUN_RENDERING, viewport)` in Play and submits the
  frame into bucket 0 under `run.pipe(1)`.
  **A nested guest's pipeline is a second object**, not the one of the same id:
  a pipeline owns one texture array and the two guests' arrays differ in size
  (measured — the editor's UI pages are 640×500, the isometric scene's 128×128,
  and a shared preset 1 refused every nested page with `-EINVAL`). So the replay
  builds it fresh, and the id is a translation asked for by `dev.pipe`. Three new
  tests in `device.rs` pin it: `a_capture_repaint_keeps_the_frame`,
  `a_preset_the_outer_already_draws_gets_a_second_pipeline`,
  `a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline`.
  The demo's measured acceptance is in the section below.

## 4b's acceptance, measured

The demo is `apps/editor` at 1600x900 headless with `--game=<isometric>` and
`--play=N` (a harness path that calls the same `runAct(Act.Play)` the Run button
does). Measured on the development Linux box:

- **Textured, and provably the guest's frame.** The editor publishes the viewport
  rectangle its nested frame occupied and the demo harness compares it pixel for
  pixel against the standalone guest's own `front` frame: **29,120 px compared,
  0 differ**, on the first run and again after a restart. The clip is exercised:
  46 records submitted, 46 kept (the scene fits the 1600x822 viewport).
- **Records/frame: 46**, against a cap of 3,064 — headroom 3,018. This is the
  isometric scene's own count (6x6 ground, 46 records), which is what the guest
  reports and what `dev.read` returns; the "~2,410" figure would be a 60x40 grid,
  a different scene. Page usage: the nested guest uses **3 of the 15** pages it is
  given (pages 1–3 of the array), the outer keeps page 0 for its own atlas.
  **The demo proves the pipeline, not the budget**: 46 records is 1.5% of the
  cap, and the 2,000-record case is not exercised by the editor yet. The budget
  itself was measured by the 4b-4 probe (2,410 records, 654 spare) through the
  sandbox, not through this composite.
- **Frame cost: 17.3 ms/frame (about 58 fps)** for the whole editor frame, measured as
  the slope between a 1-frame and a 240-frame run (median of five). A bare editor
  frame with no nested guest measures 17.4 ms, so **the nested guest's own cost is
  below the measurement's noise on this rig** — the sandbox is synchronous, and the
  cost is there, but the 320x180 guest is far cheaper than a 1600x900 composite.
  **The synchronous model is not stressed at this size.** The figure says "a
  320x180 guest costs less than the frame around it", not "the model holds for a
  heavy guest"; a guest whose own frame is 10 ms would add 10 ms to the editor's,
  and nothing here measures that.
- **Restart** is a fresh `Store` from the cached `Module`: run 2 reports the same
  46 records, the same 3 pages, a new pipeline id (1001 against 1000), and the
  same pixel-identical frame.
- **Stop / Esc** return to edit mode and restore the chrome; the run reports its
  frame count, its last error (0), and the canvas is closed in order.

**Resize while playing is out of scope** and is a known limit, not a bug: the
nested scene keeps the dimensions it was started with, because the run's viewport
is fixed at `dev.run` and a canvas is fixed for its handle's life. Handling it
means stopping and restarting the run on a resize (or the buffer-rendering path in
4c, where the inner guest owns a render target); it is **4b-7** by preference.


## The compile gap, stated plainly

4b-6 proves the **run** half of "click Run and the example appears in the
viewport". It does not prove the **compile** half, and the difference is worth
naming because the goal named compile:

- The wasm the demo runs is `examples/2d/isometric/build/game.wasm`, produced
  before the editor started by `npm run build` in that example
  (`build-2d-guest.mjs` -> `tensionscript`). `build/` is gitignored, so it is a
  build product, not a bundled asset.
- Nothing inside the editor compiles anything. `apps/editor` imports no compiler,
  the guest SDK has no compile verb, and `dev.run` takes a **path** — resolved
  from an absolute name or under the process's write root — so what it starts is
  a module that already existed on disk.
- The editor's `--game=<wasm>` argument is that path. A user cannot yet choose an
  example from inside Play; the harness names one file.

So the demo today is: *a pre-built guest runs inside the editor, driven frame by
frame, and its pixels are the guest's own.* The compile half is **Pass 3** (the
compiler daemon), which the plan's opening section already lists as not started
and unspecified in this tree. Until it exists, "the demo works" means the run
path works end to end — not that the editor compiles a project.


## The threading branch

`ui-threading` opened from the merge of `ui-nested-guest` into `main`
(`4da7cd7`). It exists because the synchronous model has a stated cost limit
(`docs/backlog/threading.md` §1) and the fix needs an engine that can suspend a
guest. Pass 3 waits behind it.

**The upgrade.** wasmtime `24.0.13` -> `50.0.1` (`003f1a7`); Rust `1.90.0` ->
`1.100.0`, because 50.x requires 1.97.0. Seven compile errors, all of them one
shape: since wasmtime 50 `wasmtime::Error` is its own type rather than a
re-export of `anyhow::Error`, so every boundary between the two now says which it
means. Two counters widened (`ResourceLimiter::table_growing` takes `usize`,
`Table::get` takes `u64`). The predicted `epoch_deadline_callback` break
(wasmtime#14386) **does not apply**: this tree never registers a deadline
callback, it arms `set_epoch_deadline` and relies on the default trap.
`cargo test` measured **623 passed / 0 failed before and after** — identical
counts over 40 `test result:` lines, which is the strongest statement a
26-release jump allows.

**`resume_throw` is proven, not assumed** (`1f74656`). Five tests in
`tests/stack_switching.rs`: a continuation parks and is resumed again; a thrown
cancellation reaches a `try_table` handler inside the guest with its payload
intact; an uncaught one escapes to the host boundary as `thrown Wasm exception`;
a host call inside a continuation (wasmtime#13322's shape, including re-entering
the guest) does not corrupt the store; and a consumed continuation traps with
`continuation already consumed`, which is the mechanism behind "cancel is
throw-and-discard, never cancel-and-resume". Mutation-checked: with the flag off,
all five fail.

**Platform: `x86_64-unknown-linux-gnu` only.** Stack switching is x86_64-only in
wasmtime 50, and the test **fails rather than skips** on any other target, naming
arch and OS in the failure. A skip would let "the foundation is proven" become
true on a machine the contract never runs on.

**wasmtime#13322 does not apply, and not in the window the brief assumed.**
Measured: opened 2026-05-07, closed **2026-09-28** by wasmtime#14439 ("Two
regression tests"), which attributes the fix to wasmtime#11717 ("Continuation
trapping semantics", merged 2026-07-28). Both precede 50.0.0 (2026-10-20), so
50.0.1 carries them; the repro's shape is one of the five passing tests.

**The surface exists as stubs.** `tension::threads` is registered for every guest
(`host/threads.rs`) with six verbs — `self`, `context_of`, `spawn`, `join`,
`post`, `await_task` — and every one answers `-ENOTSUP`. `-ENOSYS` is reserved
for the parallel half and returned by nothing, because no verb in this surface
can ask for a parallel context and a code no path returns would lie about being
reachable. `tests/threads_stub.rs` is a guest that imports all six and traps
unless each answers `-95`; mutation-checked by moving the constant to `-96`.

**Gate, measured** (`node scripts/test.mjs --jobs 1`, declared before the run):
26/26 PASSED, cargo **629 passed / 0 failed over 42 result lines** (was 623 over
40: five stack-switching tests, one stub test), abi-docs regenerated to 97
imports across 14 modules, bundle 82 pages / 3,755 blocks, docs green. Warnings
measured **86 in 19 distinct rows**, one more than the warm baseline of 85/18, and
the extra row is named rather than waved at: Rust 1.100 brought cargo's
`unused_dependencies` lint, which fires on `arc-swap` because the gate's prepare
step builds with `--no-default-features` and `arc-swap` is used only by
`audio::real` (`cfg(feature = "audio")`). That is **gate finding 6** — finding 1's
shape one layer down, and recorded rather than silenced.

The run table is still `HashMap<i32, GuestRun>`. The target shape is
`HashMap<CtxHandle, GuestContext>`; the key type and the value type are left
alone until the mechanism exists, because a rename with no behaviour change hides
the stub in review and `GuestContext` is a design decision the backlog withholds
(`docs/backlog/threading.md` §5).

**The round trip, proven** (`tests/cooperative_round_trip.rs`, one test). A
context is created, suspends, is resumed, and completes, across **three separate
host calls into one living store**: after `spawn` the body has not run; the first
`step` runs it to `suspend` and control returns to the host; the second `step`
runs it past that point and returns; a third `step` answers `-1` because a
finished context leaves the table. Mutation-checked three ways — `threads::
enable()` off, no slot clear on completion, no store-back of the parked handle —
and each one fails at the assertion that names it ("continuation already
consumed", twice, for the two table mutations).

**The continuation lives in a wasm table, and that is forced.** wasmtime 50.1
cannot hand a continuation to the host: `ContRef` is `pub struct ContRef;`, an
empty stub ("A placeholder until continuation objects are fully integrated with
the GC system", #10248), `Val::ref_()` answers `None` for it, and no `WasmTy`
implementation exists, so a host function cannot even declare a continuation
parameter. The host's whole view of a context is an `i32`. The test pins this as
a tripwire: when #10248 lands the assertion fails, and that is the day a
host-side context table becomes possible and this decision should be revisited
rather than inherited.

What that round did **not** do: no scheduler loop, no dispatcher, no
cancellation policy, no `join`, no run-table rename, and `threads::enable()` was
still not called by the process engine.

### The first scheduler

`threads::queue::ThreadQueue` owns **order** — a `Vec<CtxHandle>` in insertion
order, a frame counter, and a trace — and nothing else. A step is a closure,
because *how* a context advances is guest-side (the previous section's
constraint). The host is what can be deterministic about order; the guest owns
the interleaving. That split is the contract's, arrived at by measurement.

One drain = one frame: every live context stepped once, in insertion order, and
a context that completes or traps leaves the queue. No priority, no starvation
rule, no budget. A guest cannot push during a drain — `drain` holds the queue for
the whole call, so the step closure has no handle to spawn through, which makes
"the frame's membership is fixed when the frame begins" a type-level guarantee
rather than a convention.

`tests/cooperative_scheduler.rs` (five tests) drives two contexts in one store
through a guest with four slots and four bodies, and asserts **two** traces: the
queue's (`f<frame> <ctx> alive|complete|trapped`) and the guest's own byte log,
written by the bodies as they run. Both are byte-identical across two independent
runs; the guest log reads `ABABCA` — alternating, not one body run to exhaustion.
A trapped context is removed and the context after it is still stepped in the
same frame. Mutation-checked: reversing the drain to LIFO fails three tests;
letting a completed context stay in the queue fails four and now fails *fast*
(the drain loop in the scenario is bounded, because that mutation originally hung
the test past 60 s — a scheduler whose queue never empties must fail a test, not
the gate).

**A slot index is not a handle.** The guest hands out table slots, and a freed
slot comes back with the same number — asserted, not assumed. `CtxHandle`
therefore cannot be a table index; the rename slice needs a monotonic handle and
a separate slot map.

### One engine, not two — **decided: two**

*Decision, 2026-11-16: option (a), two engines. Implemented in
`tension-core/src/engines.rs` and measured; see "The decision taken" below.*

`threads::enable()` was **not** called anywhere in the binary when this was
written, and the round before found out why "on the sandbox engine only" was not
expressible then: the process built **one** engine and shared it with every guest
(`HostConfig::engine`), and that doc names the cost of doing otherwise — "an
engine owns the compiled-code cache; one engine per guest would compile a shared
module twice, which is precisely the cost `tension::dev.compile` exists to
avoid". A `Module` is engine-bound, so a second engine is also a second module
cache, and every nested guest recompiles.

So the choice was the user's, and it is a real one:

* **two engines** — a sandbox engine with the three flags, its own code cache,
  and a module compiled twice per nested guest. Enables the mechanism exactly
  where it is wanted and nowhere else;
* **one engine, flags on** — cheapest, and turns the proposals on for the
  process's own guest too, which the previous round rejected for a good reason
  (a sketch is not a reason to enable a proposal for every guest);
* **defer** — leave both stub-answered until the scheduler's shape forces it.

Nothing in this branch depends on the answer: the queue and the round trip are
proven on a test engine, which is what `enable()` takes.

`step`, the seventh verb, is registered and answers `-ENOTSUP` for two reasons: a
step resumes a continuation, which needs a guest-side hook (a later slice), on an
engine that has the flags (**now built** — see below). Its contract — `1` alive,
`0` complete, `-errno` trapped — is in the ABI doc now, so the Dispatcher slice
can be written against it.

### The decision taken — option (a), two worlds

**Two engines, one per capability world, chosen by nesting depth.** The unit is
the **capability world**, not the guest: an engine is a frozen `Config` plus a
compiled-code cache, so the count is the number of distinct configurations, and
one engine per guest is the anti-pattern above.

| | process world | sandbox world |
| --- | --- | --- |
| exceptions | default | on |
| function references | default | on |
| stack switching | **off** | **on** (`threads::enable`) |
| epoch interruption | on, armed `NEVER_TRAPS` | on, armed `TICKS_BEFORE_TRAP` per call |
| built | at startup | on the first `dev.run` |

Five things worth keeping, all measured:

1. **The boundary is a compile-time refusal, not a policy.** A module with
   continuation types fails at `Module::new` on the process world:
   `cannot define continuation types when stack switching is disabled (at offset
   0xe)`. The same bytes compile, instantiate and run on the sandbox world.
   `tests/engine_worlds.rs` asserts both directions.
2. **A module cannot cross worlds**: `cross-`Engine` instantiation is not
   currently supported`. So the module cache is keyed `(world, path)`: one cache
   object, one compile per file **per world**, and the second world's compile is
   the stated cost of (a) — paid once per file, not per run.
3. **The watchdog was a real defect, not a detail.** One ticker per `Sandbox::open`
   advanced the **shared** epoch, so two live sandboxes halved every guest's
   budget. Measured on the pre-fix tree: 161 ms alone, **81 ms with a second
   sandbox merely open**. The ticker now belongs to the world and is
   reference-counted, so there is one per epoch counter; measured after, 160 ms
   with a second sandbox live.
4. **The sandbox world gets the sandbox engine.** `dev.rs` used to clone
   `state.engine` — the *outer* guest's engine — into the nested config, which is
   how a nested guest ended up in the process's capability world. It now asks the
   worlds holder for the sandbox world, and `Sandbox::open` refuses a config from
   any other world.
5. **Epoch interruption stays on in both.** A store's deadline is armed against
   it, `GuestHost::new` relies on it (`NEVER_TRAPS`), and turning it off on the
   process world would change the compiled shape of every shipped guest to save
   an unmeasured number of instructions.

What this deliberately does **not** do: call `threads::enable()` anywhere but the
sandbox world, wire `step`, or give the dispatcher a shape. The scheduler's
remaining blocker is the guest-side step hook, not the engine.

## The F1 constraint

F1 is "press F1 in the editor and the docs open as a second guest". It has
exactly two shapes and the choice is a cost, not a detail:
`docs/modules/2d.md:464-483`. It is not scoped into any pass yet, and it is the
reason the texture path in 4c matters beyond the editor's own viewport.

## Deferred

- **The threading mechanism itself** (a scheduler, a dispatcher, the
  cooperative-vs-parallel fork): the surface is stubbed, the mechanism is not
  started, and the fork is the user's decision (`docs/backlog/threading.md` §5).
- **4c — arbitrary guest-authored textures and buffer rendering.** A guest
  handing raw pixels to the device, and an inner guest rendering into a host
  surface. Two shapes, both recorded in `docs/backlog/buffer-rendering.md`:
  **texture rendering** (inner draws into a host render target on the shared
  device — the only viable path for 3D, no CPU copy) and **surface rendering**
  (offscreen render, read back, hand the pixels over — stills only; 5.76 MB per
  1600x900 frame). Status there: backlog, scheduled nowhere.
- **Pass 3 (the compiler daemon and the docs playground)** — deferred behind
  the threading branch, and specified nowhere in this tree yet. The split
  proposal is written up in this session's report; no code has been written.
- **Passes 4 and 5**, above.

**4c is not "the demo's textures".** The demo's atlas loads, page ids and their
replay onto the outer device are 4b-5 and 4b-6. The v1 record path (the inner
guest emits sprite records, the host copies them into the outer frame) stays and
is an optimisation for 2D — it is what 4b-5/4b-6 use. 4c begins where a guest
wants a texture it authored, or a render target it owns.

## Durable rules this pass earned

### The IWI container has one authority: ImageViewer

`third_party/ImageViewer/src/format/IwiFile.h` defines the on-disk header and
`IwiFile.cpp` implements the grammar behind a C ABI. The host
(`tension-core/src/render2d/iwi.rs`) and the C++ bisect adapter
(`tension-2d/reference/texture.cpp`) call that API; neither carries a parser.
A guest writing a texture at run time uses `writeIwiHeader`
(`tension-framework/assembly/2d/iwi.ts`), and the Node asset tools use
`tools/lib/iwi.mjs`; both mirror the C header because wasm and Node cannot call
it, so the container layout is stated in exactly those two mirrors and nowhere
else. A change to the format goes upstream first (`IwiFile.h`), then the
submodule pin here moves, then the two mirrors follow.

A new consumer calls `decode_iwi`, `iwi_parse_structural` / `iwi_decode`,
`writeIwiHeader`, or `readIwiHeader`. It never spells `36`, `6 * n`, `IWI1`, or
a field offset. Test fixtures that build a header are the one exception, and they
live beside the decoder so they move with it.

### The deadline: absolute, not relative

wasmtime's epoch deadline is `now + delta`, not a countdown. Arming once bounds
the guest's **lifetime**; arming before each call bounds the **call**. Pass 2
paid for this once (`5c3caf8`). `Sandbox::arm()` is the one door, and every new
entry into a sandboxed guest must pass through it — a missing arm is silent,
because the guest inherits whatever was left of the previous bound. The root
guest is the deliberate exception: its store is armed `NEVER_TRAPS` once, because
the process's own guest owns its loop.

### The gate must run the shipped configuration

Four findings in this pass were one shape: **the gate tested a configuration
other than the one that ships, and measured it in a way that was not
reproducible.**

1. The `core` suite ran `cargo test --no-default-features --features audio`,
   which also dropped `render2d-core`, so the gated tests exercised only the DSO
   escape hatch (`11699b7`).
2. `cargo build` with **default** features did not compile at all — `ai::stub`
   was gated to `not(feature = "ai")` while `HostState::build` named it
   unconditionally. Every gate invocation passes `--no-default-features`, so the
   shipped configuration was compiled by nothing.
3. The `cli` suite ran `node --test <dir>`, which stopped resolving on Node 24,
   so the gate was red or green depending on the interpreter's version.
4. The projected warning count moved between two runs of one unchanged tree,
   because two warnings come from the OGRE stbi probe and appear only when it
   recompiles (85/18 warm, 87/20 cold).

Tracked as `docs/backlog/gate-configuration-audit.md`, because the rule is the
fix and the four fixes are the instances.

## Related

- `docs/spikes/records-budget.md` — the 4096-record budget, and why a nested
  guest's scene fits.
- `docs/backlog/buffer-rendering.md` — 4c's two paths.
- `docs/backlog/guest-rejectable-close.md` — explicitly out of Pass 2 and 3.
- `docs/modules/2d.md:464-483` — the F1 constraint.
