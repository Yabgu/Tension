# DL35 — the stackful lowering's host-visible suspension (I60), opt-in

**Round:** DL35, 2026-11-24. **Opt-in only**: `--stackful-backend=fiber`.
Without the flag the compiler emits what it emitted. The default stays
`continuation`.

| | |
|---|---|
| `Tension` | `integration/dwarf-debug` @ `670d4c0` → the report commit below |
| `TensionScript-a2` | branch **`feat/dl35-fiber-lowering`** off `41a972e1`, commit **`526f5227`** |
| `third_party/binaryen` | `e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a` — **not moved** |
| bundle | **`3ef8a8f4` → `9cbd3684`** (`9cbd3684f71f6bd7…`) |

---

## 1. Phase 0

```
Tension          integration/dwarf-debug @ 670d4c0        clean
TensionScript-a2 fix/dl31-spawn-entry-record @ 41a972e1   clean, on origin
third_party/binaryen  e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a
installed compiler   3ef8a8f49021
```

All four matched. `feat/dl35-fiber-lowering` created at `41a972e1`; nothing
committed to `main`. Census **before the first edit**:

```
debug-conformance: 71/82 pass, 0 skipped, 11 fail  [no-source 11, pass 71]
```

---

## 2. The flag, the section, the park ABI

**Flag** `--stackful-backend=fiber` (default `continuation`). A value that is
neither is refused **before anything is emitted**, naming both accepted values:

```
rebuild: stopped — --stackful-backend=bogus (expected continuation or fiber)
```

**Custom section** `tension.stackful-backend`, contents **`fiber`** — five bytes,
no newline, no framing:

```
custom "tension.stackful-backend"      |     0x6bb2 -     0x6bb7 |         5 bytes | 1 count
(@custom "tension.stackful-backend" (after data) "fiber")
raw bytes: 66 69 62 65 72
```

**Absence means `continuation`**, and that is a stated default rather than an
inference — it is what keeps every existing artifact byte-identical (a section
written into all of them would have moved all 28 guests to say the same thing
twice). The host reads this one section: not a flag (gone at load time), not an
import (a program may declare `scheduler::park` and never suspend), not an export.

**Park imports.** The executor's existing park is reused unchanged —
`scheduler::park(task_id: i64, class: i32, key: i32)` — and **one minimal import
was added** because the park ABI names a pair but cannot carry a value back:

```
(import "scheduler" "park"        (func (param i64 i32 i32)))
(import "scheduler" "completion"  (func (param i64) (result i32)))
```

`completion(task_id)` answers the payload the wake delivered, or 0. It is called
exactly once, immediately after the park returns, by `__parkHost`. One `i64` in,
one `i32` out, no pointers, nothing allocated.

---

## 3. What the compiler emits

`Compiler#fiberBackendActive` is the single question, asked in three places that
must agree: the suspension builtins (`src/builtins.ts`), and the artifact record
(`emitStackfulBackendSection`).

| intrinsic | continuation (default) | fiber |
|---|---|---|
| `__suspendAwait(slot)` | `suspend $await` payload slot | `__parkYield()` → `park(id, 0, 0)` |
| `__suspendParked(task)` | `suspend $await` payload `-2` | `__parkAwait(task)` |
| `__suspendDone(status)` | `suspend $done` | `nop` — the fiber returns, the host sees it |
| `__suspendIdle()` | `suspend $idle` | `nop` |

Two park shapes, because they are two different waits:

- **`__parkYield()`** — keyless, `(class, key) = (0, 0)`. The `drive` path: a task
  waiting on another **guest** task, whose waiter is queued by `settle` in this
  store.
- **`__parkHost(record)`** — keyed. A task waiting on a producer's `(class, key)`.
  On return, the same record fields the Promise path's `__taskResume` writes:
  `payload = completion(id)`, `status = 0`, `done = 1`.
- **`__parkAwait(task)`** chooses: a stamped record parks keyed and then settles
  the handle (`__settleFromRecord`); anything else parks keyless. A keyless park
  is never a silent success — it is exactly what the executor's strand refusal
  names.

**The value, and why it needed `__settleFromRecord`.** The first probe measured
`parks = 1, wakes = 1, value = 0`: the suspension worked and the value did not
arrive, because the host's word landed on the *record* and the awaited expression
reads the *handle*. `Task<T>#__settleFromRecord` copies the payload word onto
`value`; that one line is what makes `AFTER the await value=500` print 500. It is
**payload-word only** — the i32-shaped completion this round delivers. `f32` and
64-bit payloads would need the `f0`/`f1` rule `rt.classify` implements; that is
not written here, because nothing in this round delivers one and a decoder no
test exercises is how a wrong decoder ships.

---

## 4. The probe (I70) — `parks >= 1`, `wakes >= 1`, the worker's value

The harness and the guest live **outside the tree** (`/tmp/dl35probe`), not
committed, as the brief requires. The guest is the DL30 `serve-suspend.ts`
scenario reduced to what it needs: a stackful body awaits a promise-path task that
has not completed, and a worker completes it after the body has parked.

```
guest| body: entered, leaf=0
guest| body: BEFORE the await on class=4 key=7
guest: scheduler::park(task=0, class=4, key=7) → suspending
host: fiber SUSPENDED at class=4 key=7 (task 0)
worker: completes class=4 key=7 (park recorded, task suspended)
host: RESUME the fiber (wake class=4 key=7, delivered value=500)
guest: scheduler::park RETURNED for task=0 — resumed
guest: scheduler::completion(task=0) → 500
guest| body: AFTER the await value=500
host: the fiber FINISHED, guest status 0

parks = 1
wakes = 1
park[0]: class=4 key=7
```

**Order:** park → worker completes → resume → value. **Value: 500**, the worker's —
not 0. Exit 0.

`tools/thread-promise/programs/stackful-external-await.ts` in fiber mode **runs to
completion**, including the line DL23 measured as never printing:

```
guest| main: leaf=0
guest| main: BEFORE the policy await
guest: scheduler::park(task=0, class=4, key=7) → suspending
worker: completes class=4 key=7 (park recorded, task suspended)
guest: scheduler::park RETURNED for task=0 — resumed
guest: scheduler::completion(task=0) → 500
guest| main: AFTER the policy await
parks = 1 · wakes = 1
```

**Artifact inspection** (`wasm-tools`, fiber mode):

```
imports                                |       0x93 -      0x116 |       131 bytes | 7 count
  (import "scheduler" "park" (func (;2;) (type 19) (param i64 i32 i32)))
  (import "scheduler" "completion" (func (;3;) (type 20) (param i64) (result i32)))
custom "tension.stackful-backend"      |     0x6bb2 -     0x6bb7 |         5 bytes | 1 count
(@custom "tension.stackful-backend" (after data) "fiber")

suspend instructions: 0
```

---

## 5. The mismatch, both directions

```
host: custom section "tension.stackful-backend" absent → continuation (the stated default)
host: executor backend = fiber
host: guest backend    = continuation

refused: this guest was built for the `continuation` backend and this executor is
the `fiber` backend — refusing by name, nothing ran (exit 2)
```

```
host: custom section "tension.stackful-backend" = "fiber" (5 bytes, hex 6669626572)
host: executor backend = continuation
host: guest backend    = fiber

refused: this guest was built for the `fiber` backend and this executor is the
`continuation` backend — refusing by name, nothing ran (exit 2)
```

Both **exit 2**, both before the module is instantiated. No trap, no fallback.

---

## 6. Gates

| # | gate | measured |
|---|---|---|
| 1 | compiler suite 364 → **365** | **365** (`npm run test:compiler -- --parallel`, `[ SUCCESS ]`) |
| 2 | `--check` 8/8, exit 0, guests 28 | **8/8 PASS, exit 0**, `28 built after source, 28 current` |
| 3 | 28 guests, default flags, 0 bytes moved | **56 artifacts, 0 bytes moved** (see §7) |
| 4 | matrix | threads **9** · fiber **6** · fiber-executor **7** · async_main_promise **2** · debugger **5** · `--bin` **307** |
| 4 | census before/after | **71/82 · 0 skipped · 11 no-source** — both times, identical |
| 5 | artifact: import, no suspend, section | §4 — all three |
| 6 | I70: parks ≥ 1, wakes ≥ 1, worker's value | **1 park, 1 wake, 500** |
| 7 | mismatch both ways, non-zero, by name | §5 — exit 2, exit 2 |
| 8 | bundle hash changes | **`3ef8a8f4` → `9cbd3684`** |
| 9 | no commits to `main` | one commit, on `feat/dl35-fiber-lowering` |

**The one test added** (suite 364 → 365):
`tests/compiler/stackful-fiber-record` — `--stackful-backend=fiber`, asserting
**(a)** the artifact imports `scheduler::park`, **(b)** it contains no `suspend`,
and its committed `.wat` is the fixture. See §9 for what (c) is and is not.

`npm run check` (tsc + eslint) exit 0 · `npm run test:cli` exit 0 · `npm run
test:flags` exit 0.

---

## 7. Gate 3, honestly — and the stale-artifact trap

The first measurement said **every guest moved**. It was wrong, and it is worth
recording why: `tension-core/tests/programs/build/` is **gitignored**, and the 56
artifacts sitting there had been built by an **older bundle than HEAD's**. Touching
the sources and rebuilding compared "stale bytes" against "current bytes", which
moves for reasons that have nothing to do with this round.

The like-for-like measurement — build all 28 with the compiler at HEAD (`41a972e1`,
stashed and rebuilt), then with the round's compiler, same flags, both clean:

```
diff old-compiler-hashes new-compiler-hashes  →  empty
DEFAULT GUESTS: 0 bytes moved (56 artifacts, old vs new compiler)
```

**Gate 3 passes**, and the first reading was an artifact of the tree, not of the
change.

---

## 8. Declared deltas — read this before reviewing the fixture list

1. **Four existing compiler fixtures moved, by one `i32.const`.**
   `lazy-expr-spawn`, `lazy-expr-await`, `async-closures-case6`,
   `async-closure-value` (debug *and* release), each a single line:

   ```
   -   i32.const 309
   +   i32.const 337
   ```

   309/337 is the **source line of `class Task<T>`**, embedded in a debug assertion.
   `TaskBase` gained two members for the fiber path, so every line below them
   shifted by 28. I first tried to avoid it by moving the members to the end of
   each class (which fixed the *debug* half of one fixture and nothing else,
   because `Task<T>`'s declaration is after `TaskBase` either way), then accepted
   it: **a new virtual member on a std base class cannot leave the class's
   declaration line where it was.** The emitted code is unchanged — the constants
   are, and they are line numbers. The 56 guest artifacts are unaffected (§7), so
   "byte for byte" holds for everything a host loads and fails by one line number
   for four `.wat` fixtures.
2. **A new CLI convenience: kebab-case long options.** The brief's flag is
   `--stackful-backend=fiber`; the tree's option keys are camelCase. Rather than
   special-case one option, `util/options.js` rewrites a kebab-spelled long option
   to its camelCase key. Additive by construction (every key is camelCase, so no
   argument that resolves today can resolve to something else), and
   `npm run test:cli` / `test:flags` pass.
3. **`TaskBase` gained `__parkRecord()` and `__settleFromRecord()`** — two virtual
   members, needed because the policies that park take a `TaskBase` and only
   `Task<T>` carries a record. A field on the base class would have moved every
   subclass's layout; a method adds a vtable slot.

---

## 9. What was not verified, and one deliberate limit

- **Windows.** No run (WIN18 owns it). The fiber path is the one that *can* work
  there — I16's finding is that wasmtime refuses continuation guests on the
  Windows target, and a fiber guest carries no `suspend` — but that is an argument
  from `async_backend.rs`, not a measurement.
- **The policy layer** (`TaskPolicy`, per-call dispatch, queue policies) — not
  touched, not exercised.
- **Migration and cross-thread fiber hand-off** — not attempted, per DL24 Q4 and
  the brief.
- **One suspended fiber per thread** — the harness runs one; nothing here
  challenges DL24's trap-handler ceiling, and the loop has the same shape.
- **Cross-platform byte identity of guests** — not compared.
- **Cost** — not measured. No threshold was asked for, and the instrumented
  round (DL27) is where that belongs.
- **Test (c), asserted where it can be.** The compiler test asserts (a) and (b)
  from the committed `.wat`; the suite's mechanism is `.wat` comparison and a
  `.wat` carries no custom sections, so (c) is asserted by the byte-level reader
  in §4 (`wasm-tools objdump` + a raw section walk) and **not** by the test. I
  considered a `.js` glue and rejected it: a fiber artifact declares continuation
  types, so `new WebAssembly.Module` refuses it on a Node without
  `--experimental-wasm-wasmfx` — the glue would never run, and a test whose
  assertion never runs is a green tick over nothing. **This is a divergence from
  the brief and it is stated, not hidden.**
- **A harness bug worth keeping**: the fiber switch **segfaulted** with a 16-byte
  `Suspend` payload and worked at 8 bytes. The probe's `Park` struct lost its
  `task` field for that reason. Not a tree defect — a `wasmtime-internal-fiber`
  hazard for whoever writes the shipping executor with a fat park payload.

---

## 10. Commits

**`TensionScript-a2`**, branch `feat/dl35-fiber-lowering`:

- `526f5227` — `async: a fiber backend, recorded in the artifact and refused by
  name (I60)`. Files: `cli/index.js`, `cli/options.json`, `src/builtins.ts`,
  `src/compiler.ts`, `src/index-wasm.ts`, `std/assembly/async-stack.ts`,
  `std/assembly/task-stack.ts`, `std/assembly/task.ts`,
  `std/assembly/thread.ts`, `util/options.js`, four existing `.wat` fixtures, and
  the new `tests/compiler/stackful-fiber-record.{ts,json,debug.wat,release.wat}`.

**`Tension`**, `integration/dwarf-debug`: this report. Nothing else — the probe
harness and both probe guests live in `/tmp` and are not committed.

**Not pushed** (`feat/dl35-fiber-lowering` is local, like DL31's branch). Pushing
is a separate decision.

---

## 11. Final state

```
TensionScript-a2   feat/dl35-fiber-lowering @ 526f5227
Tension            integration/dwarf-debug @ <report commit>
bundle             9cbd3684  (was 3ef8a8f4)
installed std      identical
binaryen           e84dfd8e  (unmoved)
```

`I60`'s mechanism now exists and is measured end to end; what it does **not** give
is a shipping fiber executor — the runner here is a 400-line harness in `/tmp`, and
the tree has no fiber executor to load a fiber guest. That gap is the next round's
subject, not this one's.
