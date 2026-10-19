# Resource-loading async scope — `await`-friendly wrappers over `queueMeshLoad` / `queueTextureLoad`

**Status:** scoping only. No code written, no framework or example modified.
**Tree:** Tension `fad5d31`, TensionScript 0.5.0 (`3c0c385e`).
**Question:** what should `await ogre.loadMesh(name)` be, and what does the runtime
already give the wrapper to work with?

The short answer: the wrapper is a five-line composition of mechanisms that
already exist, and the two things that make it *correct* rather than
merely compiling are both defects in what ships today — `TaskRecord.status` is
never set from the failure class, and `JOB_FAILED` does not resolve a parked task
unless `rt.start()` has run. Both are measured below.

---

## 1. Measurements

### M1 — `rt.job(id)` is `Task<u32>`, and `await` yields its **payload** word

`tension-framework/assembly/runtime/rt.ts:179-187`:

```ts
static job(jobId: i32): Task<u32> {
  const record = new TaskRecord();
  record.class_ = CLASS_JOB_DONE;
  record.key = jobId;
  const handle = new Task<u32>();
  handle._record = record;
  return handle;
}
```

The handle is stamped with the **success** class (`CLASS_JOB_DONE` = 4) and the
job id as the correlation key. The family binding is what lets a *different*
class — `JOB_FAILED` = 1 — resolve the same task (§3.1).

The 4c guest awaits exactly this and assigns to `u32`
(`tension-ogre/tests/guest-async.ts:72`, `:113`):

```ts
let resource: u32 = await rt.job(job);
const h: Task<u32> = rt.job(job);
const v: u32 = await h;
```

Its own comment (`:69-71`) states what the value is: "`rt.job` stamps the record
with (JOB_DONE, jobId), which is exactly what the loader posts —
`post_event(JOB_DONE|JOB_FAILED, job_id, resource_id)`".

**So `await rt.job(id)` evaluates to `TaskRecord.payload` (`u32`, offset 8), not
to a status.**

### M2 — `JOB_DONE`'s payload word is the **resource id**

`tension-ogre/src/loader.cpp:439`:

```cpp
if (sink.post_event) sink.post_event(TENSION_OGRE_CLASS_JOB_DONE, job_id, resource_id);
```

`post_event(class, a, b)` → the dispatcher copies `key ← a`, `payload ← b`
(§3.2's table: `payload` @ 8 = "the record's `b`, verbatim"). So `b` is
`resource_id`, and the awaited value is the resource id. The same id is mirrored
into the job slot (`slot->resource_id`, `:424`) and is what `ogre.jobResult(job)`
returns (`ogre/index.ts:274-277`).

### M3 — `JOB_FAILED`'s payload is the **errno**, and `status` is **not** set

Three failure post sites, all the same shape:

```cpp
sink.post_event(TENSION_OGRE_CLASS_JOB_FAILED, job_id, static_cast<uint32_t>(-ENOSPC));   // :434
sink_.post_event(TENSION_OGRE_CLASS_JOB_FAILED, slot.job_id, static_cast<uint32_t>(error)); // :505
sink.post_event(TENSION_OGRE_CLASS_JOB_FAILED, slot.job_id, static_cast<uint32_t>(error));  // :719
```

So on failure `b` = the errno reinterpreted as `u32`, and `await rt.job(id)`
returns **that number** — not a zero, not a sentinel.

`TaskRecord.status` is the field §3.4 names as the error surface ("a rejection is
a status on the result"). It is not written from the class anywhere.
`std/assembly/task-rt.ts:283` sets it unconditionally, with the reason in the
comment above it:

```ts
// §3.4's failure classes and their errno belong to the dispatcher's binding
// (4b): std does not know the arena's class ids. Until that binding exists,
// `status` stays 0 — and nothing delivers in 4a, so nothing observes it.
record.status = 0;
```

The same is true on the buffered path (`:209`). The only non-zero status in the
whole module is the drop path's `-5` (`:342`). **The dispatcher binding §3.4
describes was never written.**

Measured, in a scratch guest that delivers `CLASS_JOB_FAILED` with `-ENOENT` and
awaits `rt.job()`:

| probe | result |
|---|---|
| payload (as `u32`) | `4294967294` (i.e. `-2` as `i32`) |
| `record.status` | **`0`** |
| `record.class_` | **`1`** (`CLASS_JOB_FAILED`) |
| `record.done` | `1` |
| contrast: `CLASS_JOB_DONE` with `4242` | payload `4242`, status `0`, done `1` |

**So the error is observable, but not where the plan says.** It is in the payload
(for a failure, an errno) and in `record.class_` (1 vs 4) — not in `status`.

**A second, unplanned finding — the family binding is load-bearing for failure
only.** With no `rt.start()` (so no `__taskBindFamily`), a `JOB_DONE` delivery
still resolves a parked `rt.job()` task (class 4 is its own family), but a
`JOB_FAILED` delivery does **not** — the task stays parked forever. Measured:

| | `record.done` after tick |
|---|---|
| `JOB_DONE`, unbound | **1** (resumed) |
| `JOB_FAILED`, unbound | **-1** (never resumed) |
| `JOB_FAILED`, after `rt.start()` | **1** (resumed) |

`rt.start()` is what binds the pairs (`rt.ts:70-76`). Only three sites call it:
`examples/async-io/game.ts:51` and `tension-ogre/tests/guest-async.ts:134`,
`:304`. **No OGRE example calls it.** A naive wrapper dropped into
`bouncing-bodies` would therefore compile, work for every successful load, and
hang forever on a missing mesh.

**A third finding: `Async.expect` does not exist.** §3.4 calls it "the documented
default in the framework's examples" (`docs/async-await-plan-v2.md:706`, `:1983`);
`grep` finds no `Async` class or `expect` function in
`tension-framework/assembly/`. The mitigation the plan promises for a forgettable
status is unimplemented.

### M4 — how the examples load today: a blocking poll, then `assert`

`examples/ogre/bouncing-bodies/game.ts:113-120`:

```ts
function settle(job: i32, what: string): i32 {
  while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
    rt.runReady();
  }
  if (ogre.jobState(job) != ogre.JOB_DONE) fail(what + " did not load");
  return ogre.jobResult(job);
}
```

Called from `loadMesh` (`:237-241`) after `queueMeshLoad(path, 0)`. Four load
sites in the example. `_start_game(): void` (`:498-502`) is **synchronous**:
construct, `run()`, `shutdown()`. Loading happens inside setup, before the frame
loop, and `fail()` is `assert(false, …)` (`:92-95`).

Two consequences for the design:

- The blocking poll and `runReady()` coexist already — `rt.runReady()` is called
  from the settle loop (`:116`, `:128`) **and** from the frame loop (`:394`).
  There are 24 `rt.runReady()` call sites across examples and tests; the
  infrastructure is in place.
- The current error behaviour is *abort*, not *recover*. A wrapper that returns a
  negative errno instead is a real improvement, and is the shape every other
  capability call already uses (`queueMeshLoad` returns `<= 0`, `ogre.init`
  returns negative, `jobError` returns negative).

### M5 — framework-side async compiles cleanly, with three constraints

A scratch file importing `tension-framework/assembly/runtime` and
`assembly/ogre`, compiled with 0.5.0:

- **The declared return type is the awaited type.** Declaring
  `async function f(): Task<u32>` and using `const t: Task<u32> = f()` fails
  `TS2322: Type 'Task<Task<u32>>' is not assignable to type 'Task<u32>'`. The
  correct form is `async function f(): u32`, and the *caller* sees `Task<u32>`.
- **Composition works**: one async wrapper awaiting another
  (`loadTwo` → `await loadMeshAsync(…)` twice) compiles and emits state machines
  (57 `$State`/`$resume` references in the wat).
- **No optional or rest parameters.** The transform refuses them
  (`src/async/lower.ts:460`, "optional or rest parameters in an async function"), so
  `priority: i32 = 0` is not available in the wrapper's signature. Both
  parameters must be required — or a second, one-argument overload must exist as
  a separate non-async entry point.

The build is unchanged: the framework already compiles with the fork
(`tension-framework/package.json` → `@yabgu_gm/tensionscript@^0.5.0`), and a
framework source file containing `async` needs no new build flag. Verified by
the scratch compile going through the same CLI the framework's `build` script
uses.

---

## 2. API shape — recommendation

**Separate functions per resource kind, async, returning `i32` where a positive
value is the resource id and a negative value is the errno.**

```ts
// tension-framework/assembly/ogre/async.ts  (new)
export async function loadMesh(name: string, priority: i32): i32;
export async function loadTexture(name: string, priority: i32): i32;
```

**Why `i32`, not `u32`.** The payload word is ambiguous by construction: on
success it is a resource id (≤ 1024, `loader.cpp:724`), on failure it is an errno
as `u32` (`-2` → `4294967294`). Returning `i32` and reinterpreting **reunifies
the two into the vocabulary the capability already speaks** — negative means
failure, and the magnitude is the errno — which is exactly what
`ogre.jobError`, `ogre.init`, `mountTns` and `queueMeshLoad` already return. No
caller has to remember a second convention.

**Why not the payload alone.** Handing back the raw payload would make a failed
load look like resource id 4,294,967,294 — a bug that only shows up on the
unhappy path. The wrapper must consult the **job slot**, which carries the truth
reliably:

```ts
export async function loadMesh(name: string, priority: i32): i32 {
  const job: i32 = ogre.queueMeshLoad(name, priority);
  if (job <= 0) return job;                       // refused at queue time
  const result: u32 = await rt.job(job);          // parks; resumes on DONE or FAILED
  const ok: bool = ogre.jobState(job) == ogre.JOB_DONE;
  const error: i32 = ogre.jobError(job);          // slot.error, the real errno
  ogre.releaseJob(job);                           // terminal slots are not freed
  return ok ? <i32>result : error;
}
```

Three points in that body are load-bearing and each is measured:

1. **`ogre.jobError(job)` rather than `record.status`** — M3: `status` is always
   0. The slot's `error` field (`ogre/index.ts:280-283`) is what the loader
   writes (`slot->error = error`, `loader.cpp:498`, `:715`).
2. **`ogre.jobState(job)` rather than `record.class_`** — both work, but the slot
   is the capability's own vocabulary and does not require the caller to know
   arena class ids.
3. **`releaseJob(job)`** — `ogre/index.ts:285-287`: "Terminal jobs are not freed
   automatically: the guest releases them, which is what keeps the table from
   filling with history." The existing `settle()` never releases, so an async
   loader that also releases is a behavioural improvement worth stating.

**Why separate functions, not `loadResource(kind, name)`.** The framework's style
is one verb per capability (`init`, `mountTns`, `submitMaterial`, `queueMeshLoad`),
and a `kind` enum would have to be mapped to a function pointer inside the
wrapper anyway. Two functions also let `loadTexture` diverge when its failure
modes differ.

**A synchronous one-argument convenience is worth having** — `loadMesh(name)`
cannot be async (no optional parameters, M5). If the ergonomics matter, add it as
a *non-async* wrapper that calls `queueMeshLoad(name, 0)`, not as a default
parameter.

---

## 3. Error handling — recommendation

**Option (c) of the three offered, refined: negative errno in the `i32` return.**

- **Not (a) companion status call.** It works — `ogre.jobError(job)` is available
  — but it forces the caller to hold the job id across the await and to remember
  a second call. Since the wrapper must read the slot anyway, returning the errno
  it already read costs nothing.
- **Not (b) a struct `{id, status}`.** Two reasons: `§3.4` records that
  reference-typed `T` does not exist in v2, and whether a *struct* value is
  accepted as an async result type is unmeasured — it would need its own compile
  test before being promised. It also invents a type for a two-word result the
  capability already encodes in one.
- **(c), refined.** `-ENOENT` from `loadMesh` is the same shape a missing mesh
  already produces through `ogre.jobError`, so callers learn one rule.

**What the 4c guest does, and why the wrapper does not copy it.** The guest reads
`handle._record.status` (`guest-async.ts:214`, `:239`, `:271`) — for the **drop**
case, where `status` is `-5` and is set by `__taskReportDrops`. That is the one
path where `status` is meaningful. For a `JOB_FAILED` completion it is 0 (M3), so
following the guest's shape for ordinary failures would silently treat a failed
load as a success.

**Should the wrapper fix `status` instead?** That is the honest long-term fix —
implement §3.4's derivation (`record.status = class_ == 0 ? 0 : payload` for
failure classes) in the dispatcher binding. It is **not** proposed here: it
changes runtime semantics (`std`/`rt`), would affect every existing awaiter, and
`__taskDeliver` deliberately keeps std free of arena class ids. Scope says
wrapper. It should be filed as its own item; until then, the wrapper's use of the
job slot is the correct defence, and the doc should say plainly that
`TaskRecord.status` is not the error surface for job failures today.

**Mandatory precondition: `rt.start()`.** Because `JOB_FAILED` does not resolve
an unbound family (M3), the wrapper's contract must state that `rt.start()` has
run, and the example that adopts it must call it before the first load. Without
that, a missing mesh hangs the guest — worse than today's `assert`. This is the
single most important line in the API doc, and a test must exist for exactly it.

---

## 4. Composition with the frame loop

- `await loadMesh(...)` parks the calling task; `rt.runReady()` resumes it. Both
  the settle loop and the frame loop already call it (M4), and `rt.start()` must
  be added for failures.
- **The entry function stays synchronous.** `_start_game(): void` is the shape
  every example uses, and `async-io` shows the composition without changing it:
  `_start_game` calls `pipeline()` (async) and receives a `Task<i32>`, then runs
  the frame loop and reads `handle._record.payload` when it settles. A loader
  that must finish before the first frame therefore has two options, and the
  scope recommends the second:
  1. make `_start_game` async — **not available, measured**: the host binds the
     entry as `get_typed_func::<(), ()>(&mut store, "_start_game")`
     (`tension-core/src/main.rs:1226`), so its signature must be `() -> ()`. An
     async function returns a `Task<T>`, which is a managed reference, not `()`.
  2. **spawn the loader task, then tick until it settles** — the existing
     `settle()` loop becomes `while (!handle._record.done) { wait; runReady(); }`,
     which is the same poll with the runtime doing the bookkeeping.

---

## 5. Which example first

**`examples/ogre/bouncing-bodies`** — one example, not all:

- It is the multi-mesh case (four load sites), so the wrapper is exercised more
  than once per run.
- It already calls `rt.runReady()` in both the settle loop and the frame loop, so
  the composition is provable without restructuring.
- It has a **real failure surface to test against**: `tests/guest-jobs.ts` already
  loads `resources/meshes/does-not-exist.mesh` and asserts `-ENOENT`
  (`guest-jobs.ts:98-102`), so the negative control has a known-good fixture.
- It currently `assert`s on failure, so the change from abort to recoverable
  errno is visible and reviewable in one diff.

`hello-triangle` is the tempting minimal case but has one load and no failure
path; it should adopt the wrapper only after `bouncing-bodies` proves it.

---

## 6. Commit plan

Four commits, each with a gate. The first two are the mechanism; the last two are
adoption and proof.

1. **`ogre: awaitable resource loaders`** — `tension-framework/assembly/ogre/async.ts`
   with `loadMesh` / `loadTexture` as specified, exporting through the ogre
   barrel. Gate: the framework builds; a scratch compile of a caller shows
   `Task<i32>` at the call site and one state machine per wrapper.
2. **`ogre: the loader requires the family binding`** — make `rt.start()`
   mandatory where the loaders are used: either the loaders call it defensively
   (idempotent — `__taskBindFamily` just overwrites a map entry) or the example
   does. **Recommendation: the loader calls `rt.start()` itself.** It is
   idempotent, it removes the hang-on-failure trap from every future caller, and
   it costs one map write per load. Gate: a fixture that delivers `JOB_FAILED`
   with no prior `rt.start()` resumes (today it does not — M3's third row).
3. **`bouncing-bodies: load meshes through the awaitable loader`** — replace
   `settle()`'s poll-and-assert with the task-plus-tick loop; report load
   failures as printed diagnostics and a nonzero exit rather than `assert`.
   Gate: the example's existing transcript is unchanged on the happy path; the
   missing-mesh run reports the errno and exits cleanly.
4. **`ogre tests: the loader's negative controls`** — the fixture described in §7.
   Gate: all three cases below pass.

---

## 7. Negative controls

Three, each targeting a defect that exists today rather than a hypothetical:

- **A failed load returns the errno and does not hang.** Queue
  `resources/meshes/does-not-exist.mesh`, await the loader, assert the result is
  `-ENOENT` (`-2`) and that the task settled. This is the case that hangs without
  the family binding; it fails today on a naive wrapper.
- **A dropped completion wakes the loader with `-EIO`.** Reuse 4e-2's drop case
  (`guest-async.ts:130-180`, ring shrunk to one slot, an unawaited completion
  fills it): the loader's task must resume with `-5`, not hang. This proves the
  wrapper inherits 4e's guarantee and does not add a poll that hides it.
- **A refused queue returns the queue's own code.** A load with an invalid name
  or a full job table returns `<= 0` from `queueMeshLoad`; the wrapper must
  return that value unchanged and **not** park (a task parked on a job id that
  was never queued would never complete).

A fourth, cheaper case belongs in the same fixture: **two concurrent loads
resolve independently** — the correlation is per job id, and a wrapper that
shared state would show up here.

---

## 8. What this does not need

- **No host change.** The job pipeline posts both classes and the slot carries
  `error` and `resource_id`; everything the wrapper needs is already in the
  guest's view. `tension-core` and `tension-ogre` stay untouched.
- **No runtime mechanism.** `rt.job`, `rt.runReady`, `rt.start` and
  `ogre.jobState/jobError/jobResult/releaseJob` are the whole vocabulary.
- **No compiler change.** M5's three constraints are all expressible in the
  wrapper's shape.

The one thing that is *not* in scope and should be filed separately:
`TaskRecord.status` is not the error surface §3.4 documents, and `Async.expect`
was never built. Fixing either changes shared runtime semantics and deserves its
own review.

---

## Amendment — the phase is blocked on a compiler gap (measured)

The implementation was written and the blocker was found before any of it was
committed. **A framework-side `async` function cannot be lowered today**, so the
wrappers cannot ship in `tension-framework/assembly/ogre/async.ts` as designed.

### What was measured

`src/async/lower.ts:256-263`:

```ts
afterParse(parser: Parser): void {
  let sources = this.program.sources;
  for (let i = 0, k = sources.length; i < k; ++i) {
    let source = sources[i];
    // Library sources are never lowered: the standard library and the runtime
    // declare no `async` function, and skipping them keeps the transform out
    // of the standard library's own compilation path entirely.
    if (source.isLibrary) continue;
```

`Source.isLibrary` is true for **every** file reached through `~lib/`
(`ast.ts:1739-1742`), and a `file:` dependency resolves there — so
`~lib/tension-framework/assembly/ogre/async.ts` is a library source and the
transform never visits it. Codegen then reports, at the wrapper's own await:

```
ERROR AS100: Not implemented: the async lowering transform did not run
     :
 105 │ return await loadResource(0, name, priority);
     └─ in ~lib/tension-framework/assembly/ogre/async.ts(105,10)
ERROR TS2322: Type 'i32' is not assignable to type '~lib/task/Task<i32>'
     :  const t: Task<i32> = ogre.loadMesh("a", 0);   // not lowered, so not Task
```

**The controlled comparison.** The identical function body, declared in *user*
source in the same example directory and compiled with the same CLI and config,
lowers and runs (`_start_game` exported, no diagnostic). Only the source kind
differs. The transform's comment states its assumption plainly — "the standard
library and the runtime declare no `async` function" — and that assumption held
until a framework wanted one. It no longer does.

**The closure transform carries the same guard** (`src/closure/lower.ts:240`,
`:251`), but it is **not** a blocker — measured, and this corrects an earlier
draft of this note. A capturing arrow added to library source and called from
user source returns the correct value (7) and emits **no** transform env class:
AS itself handles the simple capture natively, and the fork's transform adds the
broader semantics (per-iteration loop captures, `this`, escaped closures) on top.
So only the async wrapper is blocked, because `async`/`await` has no native
implementation to fall back on.

### Options, with the one recommended

1. **Narrow the compiler's skip to the standard library** (recommended).
   `isLibrary` conflates two things: the compiler's own `std/assembly/` and any
   package under `~lib/`. A user-installed package is user code and should be
   lowered. The change is a predicate — skip `~lib/std/…` and the runtime files
   the fork ships, transform everything else — and it belongs in the same class
   as `thisof` (`859e14e7`): a small compiler change with its own review,
   release and regression run. The `hasLowerable` fast path already makes the
   transform a no-op for a file with no `async`, so the cost on std is a scan.
2. **Ship the wrappers in user source.** Contradicts "framework API" and pushes
   the code into every example.
3. **Import the framework by relative path from examples.** Would make the
   framework a user source and work — but it also splits the framework into two
   module instances (one `~lib`, one relative) wherever both paths are used,
   duplicating module-level state. Rejected.

### What is in the tree now

- `tension-framework/assembly/ogre/async.ts` — the wrappers, **not exported**,
  carrying a header that states why. Inert: unreachable from the barrel, so it
  is not compiled and `loadMesh` is absent from `build/index.wasm` (checked).
- `tension-framework/assembly/ogre/index.ts` — `init` now calls `rt.start()`.
  **This part is independent of the blocker and is a real fix**: it binds the
  job families for a guest that uses only the synchronous verbs, so a guest that
  writes the 4c pattern by hand (`await rt.job(queueMeshLoad(…))`) gets its
  `JOB_FAILED` resolved instead of hanging. Framework builds; its fixtures and
  `rt-dispatch` pass; `bouncing-bodies` builds and runs unchanged.
- No example was switched; `bouncing-bodies/game.ts` is at `HEAD`.

### Corrections to this document's own text

- **"Four load sites"** in `bouncing-bodies` was wrong: there is **one**
  (`game.ts:192`, via the private `loadMesh` at `:238`). The earlier count
  grepped `loadMesh|queueMeshLoad`, which matched the declaration and the call.
- **M5 overstated what it measured.** The scratch compile that proved
  "framework-side async compiles cleanly" imported the framework by *relative
  path*, which makes it user source. It answered the type-shape question
  correctly (the declared type is the awaited type) and was silent on the
  source-kind question, which is the one that blocks.

### Gates that stay unmet until the compiler change

Commits 3 and 4 of §6 (the example's adoption, and the four negative controls)
cannot run: both need a lowered wrapper. The negative controls are written to
target exactly the defects this phase was scoped around — a failed load that
must not hang, a dropped completion that must surface `-EIO`, a refused queue
that must not park, and two concurrent loads — and they remain the right gate
for whichever commit enables the wrappers.

---

## Amendment 2 — the predicate question, answered (measurement only, no change made)

**Question:** can the compiler distinguish its own `std/assembly/` from a
user-installed package under `~lib/`, so the transform's skip can be narrowed to
a predicate?

**Answer: no complete signal exists on `Source`.** Details below; per the
dispatch this stops the phase rather than landing a marker unruled.

### What exists today

`Source.isLibrary` (`ast.ts:1739-1742`) returns true for `SourceKind.Library`
and `SourceKind.LibraryEntry`. The kind is assigned **by path shape**, in the
parser (`parser.ts:171-177`):

```ts
let source = new Source(
  isEntry
    ? SourceKind.UserEntry
    : path.startsWith(LIBRARY_PREFIX)
      ? path.indexOf(PATH_DELIMITER, LIBRARY_PREFIX.length) < 0
        ? SourceKind.LibraryEntry      // ~lib/foo.ts   — flat, one file
        : SourceKind.Library           // ~lib/foo/bar.ts — nested
      : SourceKind.User,
  ...
```

So the four kinds encode *entry vs nested*, never *whose* code it is:

| | path | kind |
|---|---|---|
| std, flat | `~lib/array.ts` | `LibraryEntry` |
| **std, subdirectory** | `~lib/rt/itcms.ts`, `~lib/shared/runtime.ts`, `~lib/util/*.ts`, `~lib/bindings/*` | **`Library`** |
| **user package** | `~lib/tension-framework/assembly/ogre/async.ts` | **`Library`** |
| user package, single flat file | `~lib/foo.ts` | `LibraryEntry` |

Measured from the embedded std (`cli/index.generated.js`, `libraryFiles`): **61
files, 35 flat, 26 under `rt/`, `shared/`, `util/` and `bindings/`**. The 26 are
indistinguishable from a user package by kind, and a single-file user package is
indistinguishable from a flat std file. `isLibrary` therefore cannot serve as
the narrowing predicate, in either direction.

### Where the provenance actually is

Only in `cli/index.js`, at parse time:

- `:503-511` parses the flat std files (`libraryFiles` keys without a `/`).
- `getFile` (`:544-565`) serves std *subdirectory* files from the same
  `libraryFiles` map — the same code path that serves user packages.
- **`:520-534` merges `--lib` custom libraries into `libraryFiles`**, so
  membership in that map is *not* a clean "is std" test after that point.

`parse()` returns `void` (`index-wasm.ts:327-338`), so recording the std sources
means either changing that signature or noting `program.sources[program.sources.length - 1]`
right after each std parse.

### Options, with tradeoffs

- **(a) A program-level `stdSources` set**, populated in `cli/index.js` at the
  two std parse sites, *before* the `--lib` merge. The transform asks
  `program.stdSources.has(source)`. Exact; no change to `Source`; every
  downstream `isLibrary` consumer keeps its current behaviour. Cost: one `Set`
  and 61 insertions at startup, plus the CLI→compiler plumbing through `Program`.
- **(b) A new `Source.isStd` flag**, set at parse time. Cleanest to read, but it
  touches a core AST type used everywhere, needs a setter or a signature change,
  and every `new Source(...)` call site (parser, native source, tests) has to say
  what it means. Largest blast radius of the three.
- **(c) An embedded `stdPaths` list** (the `libraryFiles` keys) plus a membership
  test on the source's path relative to `~lib/`. No runtime state and no CLI
  change, but the list must reach the *library* bundle: `index.generated.js` is
  bundled into `cli/`, while the transforms live in `dist/assemblyscript.js`, so
  the build script would have to emit a second generated module into `src/`.
- **(d) A path-prefix heuristic** — skip `LibraryEntry` plus `{rt, shared, util,
  bindings}`. Smallest diff, but it permanently reserves four names: a user
  package called `rt` would never be lowered, and the list silently rots if std
  grows a directory.

**Recommendation if a marker is ruled in:** (a). It is exact, it leaves
`isLibrary` alone, and it is confined to the CLI plus one field on `Program`.
(c) is the alternative if runtime state is unwanted.

### What downstream assumes about library sources

Measured, all by `isLibrary`/`isDeclaredInLibrary`, none by "was this source
lowered":

- decorator flags: `Builtin` (`program.ts:2211`, `:2659`, `:2886`), `Lazy`
  (`:2650`), `Global` (`:2659`);
- `isDeclaredInLibrary` (`program.ts:3228`) → the `__visit` generator's
  custom-visitor path (`builtins.ts:10950`);
- global registration for a `LibraryEntry`'s elements (`program.ts:3374`);
- `noUnsafe` diagnostics (`compiler.ts:6481`).

**Nothing records or depends on the transform's skip.** So (a) — adding a
marker — leaves every one of these untouched. Redefining `isLibrary` itself
would not: that is why the marker, not the predicate, is the shape to rule on.

### Fast-path cost of narrowing

`hasLowerable` (`async/lower.ts:2390-2412`) short-circuits only when a statement
list has **no** async function, **no** `ClassDeclaration` and **no**
`NamespaceDeclaration` — a class or namespace alone returns `true`. std is
class-heavy (`Array`, `Map`, `Set`, typed arrays, …), so narrowing means the
async transform walks most of the 61 std files instead of skipping them. The walk
allocates nothing for a file with no async (its structures are created only on
the lowering path), but it is not free. Measure `time` on a fixed compile before
and after; the expected cost is small, and it is the price of the marker being
path-independent.

### The test that would prove a narrowed skip

1. **The wrapper itself.** Export `ogre/async.ts` from the barrel and compile
   `bouncing-bodies`: `loadMesh` must lower and the example must run. Today that
   is exactly the file that fails (`AS100: the async lowering transform did not
   run`), so it is the direct proof that a user-installed `~lib/` package lowers.
   Revert the export if the test fails — no other change is needed to run it.
2. **std unchanged.** Compile the byte-identity corpus and compare: 10/10 against
   `ccf888c6`. A lowered std that changed any byte would show here.
3. **std's own async-free status.** Confirmed: the six `async` occurrences in the
   embedded std are all in comments, so the async transform is a no-op on std
   today even if it walks it. That is the safety margin the marker relies on —
   and the reason a *closure* transform narrowing would be a separate,
   riskier question (std has 225 `=>` occurrences; the closure transform would
   rewrite any that capture).
