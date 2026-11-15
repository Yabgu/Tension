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
- **4b-6 — the editor.** Open. Play runs the nested guest, frames drive it, the
  records land in the editor's frame, Stop and Esc return. Sizing, measured:
  `assembly/dev.ts` does not exist (`dev.run`/`frame`/`read`/`out` are imports
  with no SDK wrapper); the editor's Play is chrome-only (`Mode.Play` hides
  chrome, `apps/editor/src/main.ts`); isometric has to be adopted (exports added,
  loop restructured) before it can be the demo guest.

## The F1 constraint

F1 is "press F1 in the editor and the docs open as a second guest". It has
exactly two shapes and the choice is a cost, not a detail:
`docs/modules/2d.md:464-483`. It is not scoped into any pass yet, and it is the
reason the texture path in 4c matters beyond the editor's own viewport.

## Deferred

- **4c — arbitrary guest-authored textures and buffer rendering.** A guest
  handing raw pixels to the device, and an inner guest rendering into a host
  surface. Two shapes, both recorded in `docs/backlog/buffer-rendering.md`:
  **texture rendering** (inner draws into a host render target on the shared
  device — the only viable path for 3D, no CPU copy) and **surface rendering**
  (offscreen render, read back, hand the pixels over — stills only; 5.76 MB per
  1600x900 frame). Status there: backlog, scheduled nowhere.
- **Passes 3, 4 and 5**, above.

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
