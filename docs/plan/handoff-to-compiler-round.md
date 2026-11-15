# Handoff to the compiler round

**Written:** 2026-11-16, at `ui-threading` `2811299` in the Tension repo.
**For:** a fresh agent session with no memory of the conversation that built this.
**Status:** the runtime foundation is done and gated. The next project is a
**compiler** project in `~/work/TensionScript`, and it needs a design decision
from the user before code.

Read this document in full before touching either repository. It names what is
verified, what is not, and — where the brief this was written from was wrong —
it says so, with the measurement.

---

## 1. What is done

### The nested-guest arc — merged to `main`

`origin/main` = **`4da7cd7`**, a merge commit (parents `e2d2517` + `2ad9f35`)
that kept the arc's 32 commits of slice structure rather than squashing them.
34 including the branch behind it.

A guest runs inside the editor: `dev.run` starts a second Store from a wasm
module, frames it, and replays what it asked for (pipelines, atlas pages,
records) onto the outer device. Acceptance, measured: **29,120 pixels of the
editor's viewport against the standalone guest's own frame, 0 differ**, on the
first run and after restart. 46 records/frame of a 3,064 cap; 3 of 15 nested
pages.

**The compile half of that goal does not exist.** The wasm the demo runs is
pre-built by the example's own `npm run build`; the editor compiles nothing, and
`dev.run` takes a *path*. That is Pass 3, deferred, and it is specified only as a
proposal (`docs/plan/pass-2.md`, "The compile gap, stated plainly").

### The threading runtime foundation — `ui-threading` at `2811299`

Seven commits on top of the merge:

| hash | what |
| --- | --- |
| `003f1a7` | wasmtime `24.0.13` -> `50.0.1` |
| `1f74656` | `resume_throw` proven (5 tests) |
| `5839017` | `tension::threads` surface, every verb `-ENOTSUP` |
| `fc8655a` | the record in docs |
| `9b49bb2` | the round trip: spawn -> suspend -> complete |
| `53af7e5` | gate finding 7: diff cargo results by content, not index |
| `2811299` | the first scheduler: a FIFO run queue |

**wasmtime 50.0.1, Rust 1.100.0** (50.x's MSRV is 1.97.0; the dev machine was
on 1.90.0 and had to move). Cargo test counts are **identical before and after**
the 26-release jump — 623/0 over 40 result lines on the gate's feature set —
which is the strongest statement a jump that large allows.

**`resume_throw` is proven, not assumed** (`tests/stack_switching.rs`, five
tests): a continuation parks and is resumed; a thrown cancellation reaches a
`try_table` handler *inside* the guest with its payload intact; an uncaught one
escapes to the host boundary as `thrown Wasm exception`; a host call inside a
continuation (wasmtime#13322's shape) does not corrupt the store; and a consumed
continuation traps with `continuation already consumed`. Mutation-checked: with
the flag off, all five fail. **Platform: x86_64-Linux only** — the test fails
rather than skips elsewhere, naming arch and OS, because a skip would let "the
foundation is proven" become true on a machine the contract never runs on.

**The scheduler is real, not sketched** (`threads::queue::ThreadQueue` plus
`tests/cooperative_scheduler.rs`, five tests, and seven unit tests in the
module): a run queue in insertion order, one step per live context per frame,
completion and traps removing a context. Two contexts alternate FIFO and produce
**byte-identical traces on two independent runs** — both the queue's trace
(`f<frame> <ctx> alive|complete|trapped`) and the guest's *own* byte log, written
by the bodies as they run (`ABABCA`). Mutation-checked: reversing the drain to
LIFO fails three tests; letting a completed context stay fails four.

**`tension::threads` has seven verbs, all `-ENOTSUP`** (`host/threads.rs`):
`self`, `context_of`, `spawn`, `join`, `post`, `await_task`, and `step`.
`step(ctx) -> 1 alive | 0 complete | -errno trapped` is the primitive; `join`
becomes a framework loop over it, because a `join` whose meaning depends on the
kind of its argument is the failure mode earlier rounds kept warning about.
`-ENOSYS` is **reserved and returned by nothing**: no verb can ask for a parallel
context, so a code no path returns would claim a reachability it does not have.

---

## 2. What is not done on `ui-threading`

### The WAT Dispatcher test — partly done, and the remainder is blocked

The brief this handoff was written from calls this "the last runtime artifact …
Proves `__thread_step` end-to-end via hand-written wasm. One round." **Half of
that is already true and should not be rebuilt.**

`tests/cooperative_scheduler.rs` contains a hand-written WAT guest (the `GUEST`
constant) with four context slots, four bodies, and `spawn(kind)` /
`__thread_step(idx)` / `log_len` / `done_a` / `done_b` exports. Five tests drive
it through `ThreadQueue` end to end, including the guest writing its own log so
the host's trace can be checked against the guest's account. That is a WAT
scheduler test, at the Rust level.

What is **not** done, and why each is blocked:

1. **The `step` verb wired to a real guest hook.** `step` resumes a
   continuation, and only the guest can: wasmtime 50.1 hands the host no
   continuation (`ContRef` is `pub struct ContRef;` — an empty stub, #10248;
   `Val::ref_()` answers `None` for it; and no `WasmTy` impl exists, so a host
   function cannot even *declare* a continuation parameter). The verb must call
   an export the guest defines — the `__thread_step(idx)` shape the test drives
   directly — which means an adoption contract like `_game_running`.
2. **That needs an engine that compiles stack switching**, which is §2's engine
   decision below.

So the remaining runtime round is not "write a WAT test"; it is "decide the
engine shape, then wire `step` to the hook the test already exercises".

### `threads::enable()` — the engine shape decision (the user's)

**`threads::enable()` is not called anywhere in the binary.** This round found
out why "on the sandbox engine only" is not expressible today: the process
builds **one** engine and shares it with every guest (`HostConfig::engine`), and
that type's own doc names the cost of otherwise — *"an engine owns the
compiled-code cache; one engine per guest would compile a shared module twice,
which is precisely the cost `tension::dev.compile` exists to avoid."* A `Module`
is engine-bound, so a second engine is also a second module cache and a
recompile per nested guest.

Three options, each with its cost, in `docs/plan/pass-2.md` ("One engine, not
two"):

- **(a) two engines** — a sandbox engine with the three flags and its own code
  cache; a module compiled twice per nested guest. Enables the mechanism exactly
  where it is wanted.
- **(b) one engine, flags on** — cheapest, and turns the proposals on for the
  process's own guest too, which an earlier round rejected for a good reason.
- **(c) defer** — both answers stay stubs until the shape forces it.

**This is the user's decision.** Not the agent's, and not to be picked by
momentum.

### Other open items on this branch

- **Run table rename.** Still `HashMap<i32, GuestRun>` + `next_run_id`; the
  target is `HashMap<CtxHandle, GuestContext>`. Waits for the mechanism to
  become a writer. `threads::CtxHandle` exists as the wire vocabulary.
  Constraint found this round: **a handle cannot be a table slot index** — a
  freed slot comes back with the same number, asserted in
  `a_freed_slot_is_reused_so_a_slot_index_is_not_a_stable_handle`. The rename
  needs a monotonic handle plus a separate slot map.
- **Full scheduler policy** — priority, starvation, per-context budgets,
  cancellation beyond throw-and-discard. Deliberately absent.
- **`Dispatcher` in assembly** — blocked on the compiler, §3.

---

## 3. The next project: the compiler repo

This is the substantive work. It is **design before code**, and it lives in
`~/work/TensionScript`, a sibling repository with its own release cadence
(`AGENTS.md` rule 2 in the Tension repo: Tension consumes the compiler as the
published `@yabgu_gm/tensionscript` package; the language is not editable from
Tension).

### 3.1 Backend B emission for `async`/`await`

The language's own normative contract (`docs/scheduler-contract.md`) names two
conforming backends:

- **Backend A** — a state machine with a resume function. **This is what the
  compiler emits today.**
- **Backend B** — WasmFX `cont.new` / `suspend` / `resume`, where a park *is* a
  `suspend` of the current continuation. Named as conforming in §1.7 and §7.
  **Not emitted.**

Measured:

- `src/async/lower.ts` synthesizes a state struct and a `$resume` function
  (`RESUME_SUFFIX` at `:165`, the resume function at `:1153`). Backend A only.
- `src/module.ts:220` declares `StackSwitching = 65536
  /* _BinaryenFeatureStackSwitching */`. A grep for that constant returns **its
  own declaration and nothing else** — it is dead. Stack switching is never
  enabled in codegen.
- Consequence: **no TensionScript program can be a continuation body today.**
  Nothing the `ui-threading` scheduler steps can be written in TensionScript.

The contract's own words are the reason this is a backend swap and not a
rewrite (§7): *"Backend B changes when and how the guest's stack is captured,
not what the host guarantees. That is the test of whether this contract is a
contract."*

### 3.2 The `spawn` contract — parallel execution

This is a **different** primitive from everything above, and the distinction has
to survive the naming.

- `async`/`await` is **cooperative** execution: one thread, tasks that park and
  are resumed. Backend B would implement that on WasmFX.
- `spawn()` would be **parallel** execution: real concurrency, a different
  backend, a different contract. It changes the determinism philosophy —
  *deterministic with barriers, not without.*

Constraints already measured or known, to be verified in the compiler round:

- **wasm has no `thread.spawn`.** WASI-threads is the legacy generation and is
  not the target; shared-everything-threads has not landed.
- The host side is `tension::threads.spawn(entry, arg)` — registered,
  `-ENOTSUP`, meaning *start a nested guest*, not *start a thread*.
- There is a **naming collision** to resolve, and it is semantic, not cosmetic:
  `spawn` is currently a **syntactic marker**, not a function. Measured in the
  compiler: `SPAWN_MARKER = "spawn"` (`src/lazy/lower.ts:123`), matched by
  `isSpawnCall` (`:818`) and unwrapped by `spawnTarget` (`:833`) — `spawn(f(a))`
  emits `f(a)` and adds no runtime. `docs/showcase.md:412` states it plainly:
  *"`spawn` is a marker, not a function. A call to an `async` function **is** the
  launch, so `spawn` adds no runtime; it exists to escape `@lazy`'s deferral and
  to give the unawaited-task warning a subject."*

  So redefining `spawn` to mean *parallel* is a **semantic change** to a
  ratified form. The contract must take a position: does the marker stay, is it
  redefined, or do both exist under different spellings?

### 3.3 The contract discipline

**TensionScript owns the contract; `tension-core` implements it. Neither depends
on the other.** The seam is `docs/scheduler-contract.md` in the language repo:
two calls, `park` and `wake`, and — normatively — **no continuation parameter**,
because *"no single ABI type carries every mechanism's continuation"* (§2.1). A
`spawn` contract needs the same shape of document: what it returns, the
shared-state model (atomics), the backends it admits, and where the determinism
boundary lies.

**Read `docs/backlog/threading.md` §5 before proposing anything.** It is a
governance rule, not advice: when the cooperative-vs-parallel fork is reached,
the agent **stops and puts the decision to the user** — no momentum, no "this is
the natural fit" — and specifically, *whether the contract implementation lives
in TensionScript or stays framework-only is the user's decision, not the agent's
architectural recommendation.* The same applies to where the `spawn` contract
lives.

---

## 4. The contract discussion already established

Recorded so the next agent does not re-litigate it:

- **`async`/`await` is normal cooperative execution** — one thread, park/resume,
  the shipped `Task<T>` contract. Backend B is a second conforming
  *implementation* of it, not a new feature.
- **`spawn()` would be parallel execution** — a different backend, a different
  contract, and a different determinism story ("with barriers deterministic,
  without not").
- **The naming problem is real and measured** (§3.2): `spawn` is a syntactic
  no-op marker today. Redefining it is a breaking semantic change to a ratified
  form, and the contract must say which of marker / redefined / both it chooses.

One measured fact worth carrying in: **`let t = work(4)` does not compile.**
A local that crosses an `await` needs a declared type —
`AS100: Not implemented: a local without a declared type that crosses an await`.
`let t: Task<i32> = work(4)` compiles, on **both** 0.13.2 and 0.14.1. So the
"launch now, await later" shape exists today, but only in the declared-type
form; a `spawn` that returns an inferred handle would collide with that rule.

---

## 5. Gate state

`node scripts/test.mjs --jobs 1` at `2811299`:

```
26/26 suites PASSED, exit 0
cargo 642 passed / 0 failed over 44 `test result:` lines
warnings 86 in 19 distinct rows (warm)
bundle 82 pages / 3,776 blocks
abi-docs 98 imports across 14 modules
```

Projection artefacts: `.tmp/gate-sched.proj` and `.tmp/gate-sched.log` — **not
committed** (`.tmp/` is scratch). Re-run the gate rather than trusting a number
from this document if a decision depends on it.

- **Gate finding 7** — `project-gate --diff` compared cargo result lines by
  index, so one added test read as 28 hard differences — is **fixed** at
  `53af7e5`. `compare()` now routes the cargo section through `diffLines`, the
  multiset difference the warning section already used. Verified: the real
  commit went 28 -> 1; a synthetic added test reads as one `+` line; a removed
  test as a `-`/`+` pair; a FAILED verdict still exits 1; and re-projecting a
  saved log is byte-identical (the fix changes comparison, not projection).
- `docs/backlog/gate-configuration-audit.md` holds **seven findings**, none
  blocking. Finding 6 (a feature-gated dependency looks unused under
  `--no-default-features`: `arc-swap`, newly flagged by Rust 1.100's
  `unused_dependencies`) has two named fixes, neither taken.
- **Unverified: the `ai` feature.** No libclang on the dev machine, so `bindgen`
  panics and `cargo build` with default features cannot be compiled there at
  all. Pre-existing and untouched by the wasmtime bump, but it means the
  *shipped* default configuration is not compiled by any gate.
- **Unverified: Windows and aarch64.** Nothing in this branch has been built or
  run on either. Stack switching is x86_64-only in wasmtime 50, so the branch
  cannot be green there — by design, failing rather than skipping.

---

## 6. Read these first, in this order

**Tension repo:**

1. `docs/plan/pass-2.md` — the arc structure; "The threading branch" section is
   the whole runtime story, including "One engine, not two".
2. `docs/backlog/threading.md` — the contract sketch, the `step`-not-`join`
   rationale, and **§5's governance rule** (it forbids the agent from defaulting
   on contract location).
3. `docs/backlog/gate-configuration-audit.md` — findings 1-7, and what a green
   gate does and does not mean.
4. `docs/plan/handoff-to-compiler-round.md` — this file.

**TensionScript repo:**

5. `docs/scheduler-contract.md` — **the** normative document. §1.1-§1.7
   (`Task`, continuation, backend-agnostic), §2 (`park`/`wake`, and why the
   continuation is not a parameter), §7 (Backend B), §5 (what a class declares).
6. `src/async/lower.ts` — Backend A emission: the state struct, the `$resume`
   function, the resume-point discriminator.
7. `src/module.ts:220` — `_BinaryenFeatureStackSwitching`, declared and unused.
   That single dead constant is the gap this project closes.
8. `docs/showcase.md` §7 — the `spawn` marker's ratified semantics, measured.
9. `docs/concurrent-await-scope.md` — the `@lazy` / `spawn` design measurements,
   including the 38-line syntax surface and the ratified target syntax.

---

## 7. Clone and branch state

Expected layout for a fresh session, both clones under `~/work`:

```
~/work/Tension          branch ui-threading, HEAD 2811299 (pushed)
~/work/TensionScript    branch main, but see below
```

**Tension** — remote `origin` has exactly three branches: `main`
(`4da7cd7`), `ui-nested-guest` (`2ad9f35`, the arc before the merge), and
`ui-threading` (`2811299`). Everything the next round needs is on `ui-threading`.
There are **28 stale local-only branches** on the dev machine, all superseded,
all with deleted upstreams — see §8.

**TensionScript** — **the local checkout on the dev machine is stale.** It is at
`5dad4d39` / version **0.10.0**; `origin/main` is at **`f941a1f0`** / version
**0.14.1**, with a `v0.14.0` tag and a `feat/debug-harness` branch. That is **82
commits behind**. A fresh clone gets `origin/main` and is therefore current; a
copy of the dev machine's working tree is **not**. `git pull` before reading any
source, or `docs/scheduler-contract.md` and `src/async/lower.ts` will be read at
a version that predates most of what this handoff describes.

Version pins inside Tension, for reference: `tension-framework` pins
`@yabgu_gm/tensionscript` **0.13.2**; every example and both apps pin
**0.14.1** (`docs/debugging.md` §2 records that the same flag set compiles
differently between those two versions).

---

## 8. Branch hygiene — what exists and what does not

**Pushed and needed:** `main`, `ui-threading` (both above).

**Local-only on the dev machine, deliberately not pushed:** 28 branches —
`Refine`, `ai`, `backup/pre-push-main`, `debug`, `feat/arrow-this`,
`feat/resource-management`, `feat/runtime-migration`,
`feat/solver-coprocessor`, `feat/v7c-input`, `feature/2d`, `feature/ogre-next`,
`feature/solver`, `milestone1`, `next`, `polish/hlms-skin`,
`polish/input-design`, `polish/input-dso`, `polish/session-design`, `refactor`,
`verify/runtime-migration-windows`, `win32`, `polish/anim-evaluator`,
`polish/anim-parser`, `polish/animated-character-texture`,
`polish/loader-sibling-quiet`, `polish/mesh-v2`,
`polish/ogre-skin-registration`, `polish/ogre-submodule`. All are dated
2026-09/11, all behind `main`, all with deleted upstreams. Spot-checks confirm
their content landed in `main` by other routes (`feat/v7c-input`'s work is in
main as `b6e6c7b`, and the `input-camera` example exists there). None is needed
by the next round. **They exist only on that one machine** — if it is replaced,
they are gone. That was a deliberate standing decision ("do not prune; the user
decides"), not an oversight.

**There is no IWI branch on either remote.** The Tension remote has three
branches, none matching `iwi`/`image`/`viewer`; TensionScript has none either.
So if another agent is working on the IWI format, its branch has not been pushed
under a recognisable name yet. **Ask the user which branch it is before pushing
anything to TensionScript**, and do not assume a name.

`.git/modules/third_party/assemblyscript/` is **inert git metadata** — a leftover
from a submodule that was removed in `b771bfd`; `.gitmodules` lists only
`ogre-next` and `ImageViewer`, and `git submodule status` reports only those two.
It is internal git bookkeeping, not a working-tree concern, and `git status` is
clean.

---

## 9. What to do first

1. Read §6's list, in that order. Do not skip `docs/scheduler-contract.md` §1.7
   and §7 — they are what makes this a backend swap rather than a redesign.
2. `git -C ~/work/TensionScript pull` and confirm `docs/scheduler-contract.md`
   and `src/async/lower.ts` match what §3 describes. If `_BinaryenFeatureStack
   Switching` is no longer dead, the gap has closed and this handoff is stale —
   say so rather than proceeding.
3. Re-run the Tension gate before relying on §5's numbers.
4. **Put the decisions in §2 (`threads::enable()` shape) and §3.2 (`spawn`'s
   naming and semantics) to the user before writing code.** Both are theirs by
   the governance rule in `docs/backlog/threading.md` §5.

Then, and only then, propose a slice breakdown.
