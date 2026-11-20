# The task model: two words, two mechanisms

**Promise = state machine, Task = stack.**

That sentence is the owner's, and it is the definition — not a summary of one.
Everything below follows from it, and the two halves are not interchangeable: a
Promise is lowered, a Task is *not* lowered at all.

The language, the compiler and the lowering live in
[`third_party/TensionScript`](../third_party/TensionScript); this page says which
of the two mechanisms a program actually gets, where each one's machinery lives,
and what a suspension costs in each. It links to the upstream prose rather than
restating it — the upstream documents are the source of truth for the guest side.

## 1. What each is

**A Promise is a state machine.** The compiler rewrites each may-suspend
function into a resumable *step* over a record: a resume point, the locals that
cross a suspension, and a table the runtime indexes. Calling the function
allocates the record and returns; each `await` stores the resume point and
returns to the caller. Resuming is a function call that dispatches on that point.
There is no stack to capture, so nothing about the guest's frames is special —
and every suspension round-trips through resident state the compiler has to name.

**A Task is a stack.** The function is compiled as it is written. A `await`
suspends the *wasm stack* (`suspend` in the stack-switching proposal) with the
continuation as the payload, and a resume pushes that continuation back with
`resume`. Locals stay exactly where the function put them, because the frame
is still there: a lifted local is a local, not a record field. Nothing about the
body is rewritten, so an `async function` with no `await` compiles to the same
code a plain function does.

## 2. What a suspension costs

| | Promise = state machine | Task = stack |
|---|---|---|
| what a suspension stores | the record's resume point + the lifted locals | a continuation (the wasm stack itself) |
| what a resume is | a call that dispatches on the point | `resume` of a continuation |
| code the compiler rewrites | every may-suspend body | none; the shell is emitted once, into `__start` |
| locals across an await | copied into the record — a field per local | untouched; the frame never left |
| cost of an `async` body with no `await` | still a rewritten body and a record | nothing: no continuation, no record |
| where the state lives | guest memory, one record per task | the guest's own stack |
| who resumes it | the host (`scheduler::park` → a wake) or an executor step | the module's own core loop, or an executor step |
| what can be cancelled | the record's point | the whole continuation |

The cost difference that matters in practice is the last two rows of the first
column: a state machine's suspension is *visible state* the program can inspect,
and a stack's suspension is not. A stack can therefore suspend inside a loop, in
a callee three frames deep, or in a `try` block without the compiler having to
model any of it — which is exactly what
[`examples/async-on-main`](../examples/async-on-main/game.ts) shows.

## 3. Which code is which

| mechanism | TensionScript | meaning |
|---|---|---|
| Promise = state machine | `TaskRecord`, `std/assembly/task-rt.ts`, `src/async/lower.ts` | the record, its fields and offsets, the table the host parks in, and the transform that rewrites bodies into steps |
| Task = stack | `TaskBase`, `std/assembly/task-stack.ts`, `src/async/stack.ts` | the task object, the continuation table and the park/resume protocol, and the transform that builds the continuation entries |
| the shell (Task only) | `std/assembly/async.ts` (`__coreloopAwait`), `src/compiler.ts` (`emitAsyncStackShellStart`) | the loop that resumes continuations, emitted into `__start` |

Both mechanisms share the *task object* (`Task`/`TaskBase`): the `await`
expression, the completion path and the scheduler's vocabulary are the same in
both. What differs is what a task's suspension *is*.

## 4. The shipped path is the Task

A program compiled with `--enable stack-switching` and a may-suspend `main` gets
the stackful backend: the compiler emits the core loop into `__start`, and the
program's `main` runs as slot 0 of main's executor. No host call is involved in
a suspension, and none in a resume — on one store the executor *is* the resumer,
which is the point of the showcase and the reason it needs no capability, no
window and no thread.

Without that flag, the same program is lowered as a state machine and parks
through the host (`scheduler::park`), which is the path `docs/showcase.md` §5
describes. **That section is being rewritten upstream**; until it is, it
documents the Promise path. It is still accurate for a build without
stack switching, and it is not what `examples/async-on-main` runs.

### Evidence in this repository

- `examples/async-on-main/` — a three-deep chain plus a loop, six suspensions on
  one store, no capability. Its transcript is the proof (ordering, a lifted
  local, the loop's running total).
- `tension-core/tests/async_on_main.rs` — asserts that transcript.
- `tension-core/tests/async_await.rs` — the other side: an await on a real
  cross-thread completion, which needs a producer (OGRE's loader) and therefore a
  capability.

## 5. Where to read more

Upstream, in the pinned submodule:

- `docs/async-core-loop.md` — the shell: the three tags, the three parking
  rules, and the control shape (`main`, the core loop, the host).
- `docs/scheduler-contract.md` — `await` as the program sees it, and the
  settled-await rule both mechanisms keep.
- `docs/showcase.md` §5 — the Promise path's description (§4 above says why it
  is not the shipped one).
- `docs/thread-abi.md` — the same Task mechanism spread over several stores, and
  the two host imports that makes necessary: [`threads.md`](threads.md).
