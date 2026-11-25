# DL42 — one completion contract, one dual-park program, and a build record a bare build cannot stale

| | |
|---|---|
| `~/work/Tension` | branch `feat/dl42-completion-contract` off `80ee99a` |
| `~/work/TensionScript-a2` | branch `feat/dl42-completion-contract` off `e1addaca` |
| bundle | **`6edd95979ae4` unchanged** — the std change does not move `dist/assemblyscript.js` (finding I102) |
| installed compiler | `6edd95979ae4` = tree dist; std `diff -r` silent |
| binaryen | `e84dfd8e` unmoved |
| `--check` | **9/9 PASS** at Phase 0 and at the end, from bare cargo builds |
| threads | 11 → **12** (`k = 1`, declared when the test was written; measured 12) |
| CI | see §7 |

Three phases done, one refused. **Phase A closed I98. Phase C closed I100. Phase B is a
refusal with evidence**, because no single source parks on both backends: each backend
honours exactly one of the two awaits, and they are disjoint (§3).

---

## 1. Phase 0 — the trees

```
TensionScript-a2  feat/dl41-suspend-serve @ e1addaca   clean  (0 modified)
Tension           feat/dl41-suspend-serve @ 80ee99a    clean  (0 modified)
installed compiler     6edd95979ae4  (= tree dist; std 81 files identical)
third_party/binaryen   e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a
```

`--check` read **9/9 PASS**, exit 0 — the seat's rebuild held:

```
compiler: src → dist/assemblyscript.js   159 inputs → ff6841982b2e   PASS
compiler: dist → installed               6edd95979ae4 (tree)        PASS
compiler: std → installed std            81 files identical         PASS
runtime: src → release                   84 inputs → fc12b322c10a   PASS
runtime: src → debug                     84 inputs → fc12b322c10a   PASS
fixtures: committed .wasm                14 present, all current    PASS
guests: build/*.wasm                     35 current                 PASS
guests: built by the installed compiler  70 of 70 current           PASS
docs: docs/abi/*.md                      current                    PASS
```

---

## 2. Phase A — one completion contract (I98)

### The two call chains, as they stood

**Continuation** (`--enable stack-switching`):

```
host  thread.rs::service_wakes            (this store's own thread)
  → writes the task id into the wake cell (the spawn record's dead entry/arg words,
    sig+16/+20 = rec+stride-8, 8 bytes)
  → wake.call((cell, 1))
guest ~lib/task-rt::__taskWake(idsPtr, count)
  → slot = slots[ load<u64>(idsPtr) as i32 ]        ← low word only; high word read and dropped
  → slot.state = null; slot.record = null
  → state.resume(state)                             ← **the record is never written**
```

Payload carried: **no**. `__taskResume(idsPtr, classesPtr, payloadsPtr, count)` does carry
one (`task-rt.ts:288`, it writes `record.payload/status/done`), and nothing exports it:
it is dead code in every compiled guest (`--list` of the artifact's exports: `__taskWake`,
nothing else). The docs name it as the adopting guest's export
(`docs/getting-started.md:76`); our guests re-export only `__taskWake`.

**Fiber**:

```
guest ~lib/task-stack::__parkAwait        (policy.await → __suspendParked)
  → __parkHost(record) → hostPark(id, class, key)      scheduler::park   (import)
host  thread.rs  (link_worker / run_on_fiber)
  → fiber::suspend_current(park)                     the fiber stops here
  → (producer) take_delivery / claim_early → delivery.payload
  → fiber::run resumes with that word
guest __parkHost continues:
  → record.payload = hostCompletion(id)              scheduler::completion (import)
  → record.status = 0; record.done = 1
  → __settleFromRecord → Task<T>.value
```

Payload carried: **yes**.

### The change

**Host** (`tension-core/src/thread.rs::service_wakes`): the 8-byte wake cell is now
`{id: u32, payload: u32}` instead of a `u64` id whose high half the guest discarded. Same
eight bytes, same record, no layout change, no new import.

**Guest** (`std/assembly/task-rt.ts::__taskWake`): reads the id as `i32` (identical value —
store-local slot indices never reach the high half), reads the payload word, and settles
the record before resuming:

```ts
const record = slot.record;
slot.state = null;
slot.record = null;
if (record != null) {
  record.payload = payload;
  record.status = 0;
  record.done = 1;
}
state.resume(state);
```

`class_` is deliberately **not** written: the fiber path does not write it either, and the
contract the brief states is the value. The two backends now end a park in the same
observable state.

### Before / after, one program, both backends

`wake-on-worker` is the shape that parks on the continuation backend (bare `await` on a
stamped handle → `parkState` → `scheduler::park` → host match → `__taskWake`).
`--post-completion 4,7,500`, same source, same binary, same flag:

| | artifact | `inner: AFTER the await` |
|---|---|---|
| **before** (HEAD, both trees stashed) | `5c0fe21d495f98db` | `value=0` |
| **after** (this round) | `2ae3b389fcea55a8` | `value=500` |

Control, the same artifact with `--post-completion 4,7` (a completion that carries no
payload): **`value=0`, exit 0** — the value tracks the producer's word, not a constant.

The fiber half is measured on `suspend-serve-fiber` with the same flags: `value=500`,
exit 0, **before and after this round** — the change does not touch that backend.

### The delta, stated

Of 70 built artifacts (35 release + 35 debug), **59 are byte-identical** to the
`6edd9597` baseline and **11 moved** — every guest that carries `__taskWake`:

```
release: suspend-serve.wasm  suspend-serve-fiber.wasm  two-waiters-late.wasm  wake-on-worker.wasm
debug:   the same four, plus async-main-promise.wasm  promise-fallback.wasm  rt-guards.wasm
```

No other artifact moved, and nothing else changed byte-wise. The four committed fixtures
whose bytes are among them were regenerated
(`fixtures/thread/{wake-on-worker,suspend-serve,two-waiters-late}.wasm`,
`fixtures/fiber/suspend-serve-fiber.wasm`): CI has no compiler, so the committed bytes are
what it measures.

**Which programs' transcripts change**: any continuation run that posts a payload. Nothing
committed changes value — the suites post `4,7` (no payload) everywhere except the fiber
test and the new one — so this is a defect closing, not a regression: a program that
asked for the producer's word used to read `0`.

---

## 3. Phase B — one program that parks on both backends: **REFUSED**, with evidence

**No single source can park and be completed on both backends today.** The two awaits each
work on exactly one.

| shape | continuation | fiber |
|---|---|---|
| bare `await` on a stamped handle | **parks**, is resumed, reads the value (§2) | **no park site**: the lowering is `if (!t.settled) t.drive(); t.value`, and a producer handle is a plain `Task<T>` whose `drive()` is `{}`. Artifact imports no `scheduler::park` (DL41, re-checked) |
| `policy.await(handle)` | **hangs**: `__suspendParked` → `module.suspend(tag,[-2])` with **no host call**, so no park is recorded and the sticky delivery is never matched — measured exit **124**, log ends at `worker: BEFORE the await`, no park, no match | **parks** keyed through `scheduler::park`, resumed with `scheduler::completion` |

The exact point of divergence, in the lowering:

- `__suspendAwait(slot)` — what a bare await becomes — compiles to
  `module.suspend(ASYNC_AWAIT_TAG, [slot])` and is resumed **in the store** by
  `__resumeTask`/`__taskWake`. On fiber the same builtin becomes `__parkYield()` →
  `scheduler::park(id, 0, 0)`, a **keyless** park no producer can answer.
- `__suspendParked(task)` — what `policy.await` becomes — compiles to
  `module.suspend(ASYNC_AWAIT_TAG, [-2])`, which registers **nothing** with the host. On
  fiber it becomes `__parkAwait(task)` → the keyed `scheduler::park`.

So the continuation backend knows how to resume a task by *store-local id* and the fiber
backend knows how to resume one by *(class, key)*, and the two park builtins each supply
only one of the two facts.

**What a policy layer would have to abstract**: one park that both registers a
`(class, key)` with the host *and* names the store-local thing the store can resume. That
is already `scheduler::park`'s signature — `(task_id, class, key)` — and a continuation
guest already imports it. What is missing is `task_id`: on the continuation backend it must
be `TaskState.slot` (`~lib/task-rt`'s table id, which `__taskWake` resumes), and only the
**lowering** has that value in hand — it is a local in the generated `drive()`, while
`policy.await` is an ordinary library call.

**The cheapest option, not taken here**: have the transform emit the same
`__taskPark(state, record)` it already emits for a bare await at the `policy.await` call
site, or publish `slot → TaskState` at `drive()` entry so `__currentSlot()` can reach it
and `__suspendParked`'s continuation branch can post `hostPark(state.slot, class, key)`
before its `-2` suspension. Both are lowering changes in `drive()`'s emission — which is
§5's policy/scheduler territory and touches every continuation artifact — so this round
reports instead of taking it. **No new import is needed for it**, which is why it is worth
doing: `scheduler::park` is already in the continuation guest's import list.

Consequences for the gate, stated rather than papered over:

- **Gate 1's "the same program on both backends" cannot be met this round.** Phase A's
  contract is met (`value=0` → `value=500` on continuation, `500` on fiber) and the
  delivery contract is now *identical* on both; what is missing is a program that reaches
  it on both.
- **I99 stays open**, and is narrower than DL41 left it: it is not "two shapes" but "the
  continuation policy park registers nothing with the host".
- `schedule-order` is still the one DIFF and still out of scope (DL43).

---

## 4. Phase C — the build record cannot go stale (I100)

**The writer is now the build**: `tension-core/build.rs` writes
`<profile>/tension-core.build.json` on every run, for whichever profile cargo is building.
`scripts/build-native.mjs`'s release writer and `rebuild.mjs`'s dev writer are **deleted**;
`build-native.mjs` now *verifies* the record after its cargo step and fails if it is not
current. One writer, and it is the step that cannot be skipped.

**One definition of the digest — and the shape changed to make that true.** The canonical
*form* used to be defined once in JavaScript, which meant writer and checker were the same
language. Moving the writer to Rust would have duplicated the rule, so the record now
carries **one sha256 per input file** (`format: 2`) and `--check` verifies those directly.
A per-file digest is one algorithm — `sha256 of these bytes` — with no canonical form for
two languages to disagree about; the aggregate is still written for the row's label and
nothing depends on it. The Rust sha256 is a dependency-free implementation (a Cargo
dependency for one function would be a manifest change); it was **checked against Python's
`hashlib` on all 84 inputs — 84/84 identical**.

`--check`'s behaviour is unchanged in kind and stronger in detail: it names the file that
moved rather than only reporting two different aggregates. The guest and compiler rows are
untouched.

### The three red cases, each with the check's own rows

**1. `cargo build --release` alone** (and `cargo build` for debug), then `--check`:

```
runtime: src → release   84 inputs → 1d9b48bf73c3   recorded 1d9b48bf73c3   PASS
runtime: src → debug     84 inputs → 1d9b48bf73c3   recorded 1d9b48bf73c3   PASS
rebuild: 9/9 links PASS
```

**2. edit `tension-core/src/fiber.rs`, rebuild that profile** → PASS with the new digest;
the profile that was not rebuilt stays STALE, which is the point of one record per profile:

```
runtime: src → release   84 inputs → 8b4d348b1cb3   recorded 8b4d348b1cb3   PASS
runtime: src → debug     84 inputs → 8b4d348b1cb3   built before tension-core/src…   STALE
```

**3. edit it and do not rebuild** → exit 1, both profiles, by name:

```
runtime: src → release   84 inputs → 8b4d348b1cb3   built before tension-core/src…   STALE
runtime: src → debug     84 inputs → 8b4d348b1cb3   built before tension-core/src…   STALE
rebuild: 7/9 links PASS, 2 STALE/UNKNOWN
```

(The full reason line is `built before tension-core/src/fiber.rs changed`; the table
truncates it. Reverted, rebuilt, and the digest returned to `1d9b48bf73c3`.)

**A layout bug the first run caught, worth keeping**: `profile_dir()` counted ancestors
(`OUT_DIR` → `.ancestors().nth(3)`) and put the record in `target/<profile>/build/`. It is
found by name now — the nearest ancestor called `build`, whose parent is the artifact
directory — because the depth is not a promise.

---

## 5. Phase D — the gate lands in CI

The new test is in **`--test threads`** (the suite the wake path already lives in) and its
name is added to the `Wake path guard` step, which selects by name because the other
thread tests need a compiler this job cannot install:

```
a_woken_task_reads_the_producers_word_on_the_continuation_backend
```

It asserts **one artifact, two flags**: `4,7,500` must print `value=500` on both `AFTER`
lines, and `4,7` — the same bytes — must print `value=0`. A test that ran only the first
would pass on a build that hard-coded 500.

**Red case, on the CI path** (compiler hidden, pre-fix artifact in the fixture slot):

```
test result: FAILED. 0 passed; 2 failed
  `inner: AFTER the await, value=500` is missing — the resumed task did not read the
  payload the host delivered:  …  inner: AFTER the await, value=0
```

Restored fixture, compiler still hidden (exactly what CI does): **2 passed** — the commit
fixture path proves the fix.

### The parity table, nine rows

| # | program | continuation | fiber | verdict |
|---|---|---|---|---|
| 1 | `async-on-main` | pass | pass | **PASS** |
| 2 | `spawn-join` | pass | pass | **PASS** |
| 3 | `two-workers` | pass | pass | **PASS** |
| 4 | `spawn-entry-async` | pass | pass | **PASS** |
| 5 | `count` | — | — | **excluded**: never parks (no `scheduler::park`, no `__suspendAwait`) |
| 6 | `spawn-refusals` | — | — | **excluded**: never parks |
| 7 | `schedule-order` | pass | DIFF | **DIFF** — same values, different order, `steps 0` vs `steps 15`: no core loop on fiber, no scheduling policy (DL43) |
| 8 | `suspend-serve` | **124** | pass (`value=500`) | not a pair: continuation never registers the park (§3) |
| 9 | `wake-on-worker` | pass (`value=500` with a payload — *new this round*) | **refused** | not a pair: `ERROR AS100: Not implemented: the stackful backend requires an exported main (there is no root continuation to resume)`, measured by invoking the compiler with the wake flags plus `--stackful-backend=fiber` |

---

## 6. Gates, each from its own line

| gate | result | command |
|---|---|---|
| threads | **12 passed** (11 → 12, k = 1) | `cargo test --no-default-features --features audio --test threads` |
| fiber | **6 passed** | `… --test fiber` |
| fiber-executor | **7 passed** | `… --test fiber-executor` |
| async_on_main | **2 passed** | `… --test async_on_main` |
| fiber-runner | **5 passed** | `… --test fiber-runner` |
| debugger | **5 passed** | `… --test debugger` |
| async_main_promise | **2 passed** | `… --test async_main_promise` |
| `--bin`, default features | **307 passed** | `cargo test --bin tension-core` |
| `--bin`, audio-only | **298 passed** | `cargo test --no-default-features --features audio --bin tension-core` |
| census | **71/82 pass, 0 skipped, 11 no-source**; engine not stale (no warning; `engine tension-core/target/release/tension-core [continuations]`) | `node tools/debug-conformance/runner.js --workers 8`, run alone |
| `--check` | **9/9 PASS**, exit 0, from bare `cargo build` + `cargo build --release` | `node scripts/rebuild.mjs --check` |
| runtime digests | release and debug both `1d9b48bf73c3` | quoted above |
| artifacts | 59 of 70 byte-identical to the `6edd9597` baseline, 11 moved and listed | like-for-like rebuild, both trees stashed |

---

## 7. CI

**`45596235984` success** (`aadf269`), job **`E2E debug`**, step **`Wake path guard`**:

```
running 7 tests
test a_woken_task_reads_the_producers_word_on_the_continuation_backend ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 6.79s
```

That is the gate the brief asks for: the new assertion executed **in CI**, on the branch,
in the step that runs the wake path — and it ran on the **committed-fixture path**, since
this job installs no compiler. The refreshed `fixtures/thread/wake-on-worker.wasm` is what
it measured, which is why the fixture had to be regenerated rather than left to a
developer's build.

`~/work/TensionScript-a2` branch **`feat/dl42-completion-contract`** @ `c93ecdf` — its Test
workflow ran on the push and passed (**`45596224092` success**), so the std change is
proven on the compiler's own suite as well as through Tension's guests.

Report commit `25c95ae` — CI **`45599201320` success**, the same step on the branch tip.

---

## 8. Findings

- **I98 CLOSED.** The continuation wake carries the producer's word and settles the record
  before `state.resume(state)`; one program, two flags, `0` and `500` from the same bytes.
- **I99 NARROWED, NOT CLOSED.** Not "two shapes" but one missing registration: on the
  continuation backend `policy.await` posts nothing to the host. The option that closes it
  is named in §3 and needs no new import.
- **I100 CLOSED.** `build.rs` writes the record for whichever profile cargo builds; a bare
  cargo build can no longer leave a current binary beside a stale record. Three red cases.
- **I101 STILL OPEN.** `suspend-serve`'s `main: spawn=0` is printed after `__spawnThread`
  returns, so its position races the worker's first line. DL41's assertion pins its value
  and count and not its position, with the reason stated. Phase B asked for the program to
  be made deterministic; there is no dual-park program to make deterministic yet, and
  editing this one would churn a passing expectation for no assertion (§5 forbids editing
  expectations). Reported, not touched.
- **I102 (proposal, new): the compiler identity cannot see `std/`.** `compilerIdentity()`
  hashes `dist/assemblyscript.js`; the std that actually compiles a guest is embedded in
  the bundle that runs, `dist/asc.js` — so a `std/`-only change moves *neither* the
  identity *nor* the guests' skip decision. Measured two ways:
  1. appending `export function __dl42ProbeSyntax( {}` to
     `node_modules/@yabgu_gm/tensionscript/std/assembly/task-rt.ts` and rebuilding a guest
     **succeeded** — the installed `std/` directory is not read at all;
  2. after editing `std/assembly/task-rt.ts`, the chain printed
     `compiler: src → dist/assemblyscript.js 159 inputs → 116cfe2bc3cc` (the *input* digest
     moved) beside `compiler: dist → installed 6edd95979ae4` (the *identity* did not), and
     the builder reported `35 built, 0 up to date`… `guests: … 35 current` — every guest
     was skipped while its std had changed.

  The workaround used this round is the documented one (run the chain, then
  `build-test-programs.mjs --force`), and that is a trap for the next round: **a std edit
  without `--force` silently leaves stale guests.** The fix would be to include the
  embedded library in the identity (`dist/asc.js`, or a digest of `std/`) — a record-format
  change the brief puts out of scope ("the guests' and the compiler's rows keep their
  current behaviour"), so it is proposed rather than made.

---

## 9. What was not verified

Windows (WIN22), scheduling policy (I95, DL43), migration, I76, I78, I87, `f32`/64-bit
payloads, and `npm ci` (still gated on an absent `node_modules`). The Phase A contract is
i32 payloads only, as `Task<T>.__settleFromRecord` already was.
