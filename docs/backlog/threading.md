# Backlog: threading — the synchronous model's limit, and the fork ahead

**Status:** backlog, not a plan. Written at the close of Pass 2's slice 4 because
the demo measured a cost model nobody had stated, and because the decision it
leads to is one this file exists to *put to the reader* rather than answer.
Nothing here is scheduled. Threads are needed for "a heavy guest does not jank
the editor", which is a real user need and **not** a milestone requirement. The
contract surface is described now so that stubs can land later without a
redesign; the mechanism waits.

## 1. The synchronous model's limit

A nested guest runs **on the thread that called `dev.frame`**, inside that call
(`tension-core/src/sandbox.rs`, `Sandbox::frame`). The editor's frame is therefore
chrome + the guest's frame, serialized in one thread:

```
editor frame  =  chrome records + nested guest's whole frame  +  present
```

Measured in 4b-6: 17.3 ms/frame for the whole editor with the isometric guest
running, against 17.4 ms for the editor alone — the 320x180 guest's own cost is
below that rig's noise. That is a real and useful figure, and it says exactly one
thing: **this guest is cheaper than the frame around it.**

It is not a general claim. The cost model is additive, so:

| guest frame | editor frame |
| --- | --- |
| under 1 ms (measured) | 17.4 ms (measured) |
| 10 ms | about 27 ms |
| 30 ms | about 47 ms |
| 100 ms | about 117 ms |

Only the first row is measured. The rest is the arithmetic of a serialized cost
model, and it is the reason the model does not hold for a heavy guest: a game
that needs 30 ms of CPU makes the editor's *chrome* — its pointer, its menus —
30 ms slower too, and a 100 ms guest makes the editor visibly unusable while that
guest is on screen.

**What the guest cannot do about it today.** A guest that yields — `RuntimeSession.
wait`, a parked task, an AI completion — yields to *the sandbox*, not to the
editor. `Sandbox::frame` loops until the guest has presented a frame, so a
guest's cooperative yield is spent inside the same `dev.frame` call. The
suspension mechanism exists and works (`~lib/task-rt`, `__taskWake`/`__taskResume`,
the compiler's async transform); what it does not do is give the editor a frame
back in between. That distinction is the whole of this file.

## 2. Why it cannot simply be moved to another thread

`HostState` is `!Send`, and so is everything that wraps it. The compiler names
six independent causes; `sandbox.rs:270-312` records them beside the type, and
they are, in brief:

- `Box<dyn AudioAdapter>` — the trait carries no `Send` bound, so the *type* is
  `!Send` even when the value is `silent::Silent`;
- `Box<dyn AiAdapter>` — same;
- `Render2dState` through `sdl3`'s own no-`Send` marker (`PhantomData<*mut ()>`,
  `sdl3-0.22.0/src/sdl3/sdl.rs:180`) reached by its `VideoSubsystem` field, and
  through `*mut SDL_GPUTexture`;
- `HostWindow` through `*mut c_void` over `SDL_Window`;
- `Render2dState` again, through `AdapterCall`'s `*const TensionAdapter`.

A **capture** renderer holds no device, but the *type* is `!Send` regardless of
the value — which is the part that matters here, because the obvious reading
("the nested guest has no GPU object, so send it anywhere") is wrong.

There is no `unsafe impl Send` on that path. The tree has five — `ResourceSet`,
`NativeComparator`, `FrozenApi`, `AdapterCtx`, `HostHandle` — and each covers a
narrower type than `HostState`.

Two shapes would make a background guest possible, and both are shape changes
rather than annotations:

- **`HostState` split.** A device/singleton half that stays on the main thread
  (audio, AI, the window, the renderer) and a data half that can move (arena,
  scheduler, resources, the run registry). The boundary is drawn by what the
  nested guest's own verbs actually touch.
- **A nested-only state type** that never holds `Render2dState` at all, with the
  capture records — which are plain bytes — in a `Send` buffer beside it. Smaller
  and more honest about what a sandbox needs; it duplicates the parts of
  `HostState` a nested guest really uses, and that duplication is the cost.

Reserved for Pass 5 or later. Neither is started.

## 3. The two ways to get concurrency, and the fork between them

**Cooperative — guest-scheduled, deterministic.** The guest yields at points it
chooses; the scheduler runs another task; "same spawn order, same interleaving,
same output" holds by construction. Two implementations exist on paper:

- *Within one `Store`, which is what the tree already has.* The task runtime is a
  cooperative scheduler over the compiler's async transform. It buys structured
  concurrency inside a guest and nothing at all for the editor, because every
  yield is spent inside `dev.frame` (§1).
- *Across stores, via stack switching (WasmFX continuations).* **Not available
  on this pin.** `tension-core/Cargo.toml` pins `wasmtime = "=24.0.13"`, and that
  release's `Config` has no stack-switching or continuation surface at all —
  measured: `continuation` and `stack switch` do not appear in
  `wasmtime-24.0.13/src/config.rs`, and there is no `wasm_stack_switching` setter
  beside `wasm_tail_call` and `wasm_threads`. So "buildable now" is true of the
  *contract* and false of the *mechanism*: a WasmFX path waits on a wasmtime
  bump, and the bump is its own project (the pin is exact, `=`).

**Parallel — shared memory, one `Store` per thread.** `SharedMemory` plus atomics
and barriers; threads genuinely run at once. Not deterministic by construction —
that is the trade, and it is a real one for a game that wants to skin meshes in
parallel. Blocked on shared-everything-threads landing in wasmtime. The pin's
`wasm_threads` switch (`WasmFeatures::THREADS`, the WASI-threads generation) is
legacy and is **not** the target: it is close to enabling a proposal, not building
this.

**One variant now, one reserved.** The reserved one is not chosen here. See §5.

## 4. The contract surface (a sketch, not a commitment)

If this lands, it lands as a capability module like every other one — registered
in every store's linker the way `tension::dev` and `tension::io` are, present
whether or not anything uses it, so a guest's imports resolve at instantiation.

Verbs, each a stub until its mechanism exists. The two errno classes are the
honest part of the sketch: a guest can tell "not yet" from "never".

| verb | signature | returns |
| --- | --- | --- |
| `self` | `() -> i32` | this context's id |
| `context_of` | `(handle) -> i32` | the context a resource belongs to |
| `spawn` | `(entry, arg) -> i32` | a new context, or `-ENOTSUP` |
| `join` | `(ctx, timeout) -> i32` | `0` joined, `-ENOTSUP` |
| `post` | `(ctx, msg) -> i32` | queued, or `-ENOTSUP` |
| `await_task` | `(task, timeout) -> i32` | the task's status, or `-ENOTSUP` |

`-ENOTSUP` for the cooperative half while it is unbuilt, `-ENOSYS` for the
parallel half — the same distinction the 2D adapter makes between "a preset this
build does not carry" and "no such preset", and for the same reason: a guest that
branches on the number should be able to tell which wall it hit.

Framework side, and the same rule as every other capability wrapper: a guest
calls the object, not the verb.

- `Dispatcher.invoke` / `Dispatcher.beginInvoke`, and an **`InvokeTarget` that is
  a target object, not a delegate**. This is not a style preference: the closure
  trap is measured (`2d/scene.ts`, `run`'s `FrameStep`) — a closure that captures
  a stack local traps at `call_indirect` with `uninitialized element` on this
  compiler, so a lambda-shaped `invoke(() => …)` cannot work. Virtual dispatch on
  a class the caller defines is the shape that does.
- `CtxHandle` in names from the start, so that `run_id` can eventually be spelled
  as one kind of handle rather than translated at every call site.
- Context affinity per resource — a texture or a window belongs to the context
  that created it — dispatcher queues per context, and a **FIFO drain at the
  frame boundary** so that queued work is applied at a point the guest can reason
  about rather than mid-frame.

None of this is designed past the sketch. It is here so that the stubs, if they
land, do not need the ABI redesigned around them.

## 5. The decision rule — this file stops here on purpose

When the fork is reached, an agent working in this tree **stops** and puts the
decision to the user. No momentum, no "this is the natural fit", no presupposing
an answer by writing the next slice as though one had been chosen.

Two questions are the user's, not an implementer's:

1. **Cooperative or parallel** as the first mechanism — determinism and a wasmtime
   bump, against non-determinism and a proposal that has not landed.
2. **Whether the contract implementation lives in TensionScript or stays
   framework-only.** The language is a separate repository with its own release
   cadence (`AGENTS.md` rule 2), so putting the scheduler's semantics in the
   compiler is a different commitment from putting them in the guest SDK: the
   former is a language feature consumed by every downstream project, the latter
   is a library this tree can change in a commit.

Neither has a default. A recommendation offered before the decision is made is
the thing this section exists to forbid.

## 6. When

After the demo. The demo is the priority; threads are a quality-of-life property
for a heavy guest, not a requirement of the milestone. **Pass 5 or later**, and
only after the path decision in §5 is the user's.

---

**What this file settles:** the cost model and its one measured row; the six
reasons the state cannot move to a thread today, and the two shapes that would
change that; that WasmFX is not on this pin; the contract's verbs and their two
errno classes; and that the fork is a decision for the user. **What it does not
settle:** which variant lands, when, or where the scheduler's semantics live.
