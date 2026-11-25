# DL44 — the abort has a line number, and it was ours

| | |
|---|---|
| `~/work/Tension` | branch `feat/dl44-ci-green` off `develop` (`4e5d84e`) — tip **`7d4e771`** |
| `~/work/TensionScript-a2` | branch `feat/dl44-ci-green` off `develop` (`4a0b46ef`) — tip **`f045fc5a`** |
| CI (Tension) | **`45694108177` success** — `E2E debug`; `Wake path guard`: `10 passed; 0 failed; … 5 filtered out` |
| CI (TensionScript) | **`45693396996` success** — **all 16 jobs**, `Gate 4 (threads)` included |
| vendor identity | `61b8322587a5` → **`96c7d1c0825a`** |
| `--check` | **9/9 PASS**; runtime digests `dc2cf96275ae` (release and debug) |
| threads / fiber | **15** / **6** on Linux; threads unchanged in meaning |
| `main` | untouched in both repos |

**I106 is closed, and the brief's §0 was right: it was our emission, not V8.**

---

## 1. Phase 0 — reproduce, then locate

Reproduced with the job's own recipe — `npm run test:gate4`, i.e.
`node scripts/run-wasmfx.js tests/rt/gate4.js` under `--experimental-wasm-wasmfx`:

```
  ok  the worker is spawned and the caller posted to main
Error: abort 880 1008 362 3
```

**Mapping `1008/362/3`.** `abort` on the worker path is `(message, file, line, col)` where
the two strings are AssemblyScript `String` objects, not char pointers: a first attempt
that read bytes gave `U` / `~`, which is the object header. Decoding `rtSize` at `+12`
and UTF-16LE chars at `+16` gave:

```
ABORTMSG=Unexpected 'null' (not assigned a value)
FILE=~lib/task.ts   LINE=362   COL=3
```

`std/assembly/task.ts:362` was, at that HEAD:

```ts
export class Task<T> extends TaskBase {
  /** Backend A's record for this task. Unused by the stackful backend. */
  _record!: TaskRecord;
```

**What the check at that line asserts, in one sentence:** a field declared
definitely-assigned (`!:`) with a non-nullable reference type gets a generated null
check in its getter (`src/compiler.ts:4366`, `CommonFlags.DefinitelyAssigned &&
valueType.isReference && !valueType.isNullableReference`), and the getter *aborts* when
the field holds zero.

**The call chain, from the built module** (`probe.wat`, kept from the fixture build):

```
(func $~lib/task/Task<i32>#get:_record …)
  i32.load offset=44          ;; the field
  local.tee $1
  local.get $1
  if (result i32) local.get $1
  else
    i32.const 880   i32.const 1008   i32.const 362   i32.const 3
    call $~lib/builtins/abort     ;; ← the abort, with the strings' data offsets
```

and its caller, one level up each time:
`__lib/task/Task<i32>#__parkRecord` → `~lib/task/TaskBase#__parkRecord@override` →
**`~lib/task-stack/__parkRemote`** — the function DL43 added so that the continuation
`policy.await` registers its park. A stackful task never creates a record (the class's
own doc says so), so it holds zero, and asking for it trapped.

---

## 2. Phase A — the probe that decides (a) vs (b)

Hand-written module, **no compiler and no std** — `/tmp/dl44/probe.wat`, assembled with
`wasm-tools parse`, run under the same Node flag as the job:

```wat
(import "env" "host" (func $host (param i32) (result i32)))
(type $ft (func (result i32)))  (type $ct (cont $ft))
(func $body (result i32)
  i32.const 42   call $host      ;; 142
  i32.const 1000 call $host      ;; 1100
  i32.add)
(elem declare func $body)
(func (export "run") (result i32) ref.func $body  cont.new $ct  resume $ct))
```

```
run() = 1242 (expected 1242 = 142 + 1100), host calls = 2 (expected 2)
```

**Verdict (a), the defect is ours.** V8's wasmfx delivers an imported host function's
return value from inside a resumable frame exactly as it does outside one; the guest's
abort is not downstream of a corrupted return, it is a check in *our* std firing on a
state *our* emission created. In three sentences: the engine was never the limit; a
field we declared non-null is legitimately null on the stackful backend; and DL43 made
the continuation park the first reader that could reach it.

---

## 3. Phase A — the fix, and the two designs that were wrong

**Landed** (`std/assembly/task.ts`): the non-null contract stays where every existing
reader has it, and the store behind it is nullable.

```ts
recordValue: TaskRecord | null = null;      // offsetof-visible; Backend A's store
get _record(): TaskRecord { return this.recordValue!; }
set _record(value: TaskRecord) { this.recordValue = value; }
__parkRecord(): TaskRecord | null { return this.recordValue; }   // no assertion
```

Every caller is unchanged: Backend A still writes `handle._record = __taskRegister(state)`,
guest programs still read `handle._record.class_`, one word, `value`'s offset unmoved.
The park path asks a question instead of dereferencing.

**Rejected, with the measurement that rejected it:**

1. **`_record: TaskRecord | null = null`.** AS refuses a non-nullable field with neither
   `!` nor an initialiser (`TS2564`); the obvious initialiser,
   `changetype<TaskRecord>(0)`, does not validate under `--wasmGc` — it lowers to
   `call set:_record(i32.const 0)` against a `(ref null …)` setter. That took Coverage
   and `Compiler (ubuntu)` red on run `45687131442`.
2. **`handle._record!` in the lowering** (the read at the await site). It compiles, and it
   broke debug information: `promise_backend_before_await` — a conformance case that
   breakpoints `promise-fallback.ts:14` — stopped reporting a file at all. A/B measured,
   twice, on the same artifact:
   ```
   built by 4a0b46ef (before):  debug-conformance: 1/1 pass   [pass 1]
   built by the `!` version:    debug-conformance: 0/1 pass   [no-source 1]
   ```
   The census went **71/82 → 70/82**. That is a finding, which is why it was reverted
   rather than accepted.

Two more things surfaced while running the suites CI runs, both from the first attempt
and both fixed in the compiler repo: `map!`/`empty!` (my `--wasmGc` narrowing fix)
report `TS210 Expression is never 'null'`, which the async-method probes assert against —
they are `changetype<Map<…>>` now, which is what the GC error actually needed; and
`tests/rt/stress.js` could not load a shared stackful module at all (§6).

**Gate 4: `[ SUCCESS ] 134 checks`** — the same 134 it ran before, nothing filtered, no
name removed. The one thing that changed in the harness is that its `scheduler` stub
*represents* the host instead of refusing the call: a keyless park is recorded and
returns (that is what the real linker does, and the store's own `settle` resumes it),
while a keyed park — which no Gate 4 fixture has a producer for — still fails loudly.

---

## 4. Phase B — I107: the fiber suite on Windows

`tests/fiber.rs` failed to compile on Windows for one reason: `Q4` hands a `Fiber` to
`std::thread::spawn`, and `wasmtime_internal_fiber::windows::Fiber` owns a raw
`CreateFiber` handle, so it is `!Send` there. Two changes, both `cfg`, no test removed:

- The compile-time `require_send(&None::<Fiber<…>>)` assertion is `#[cfg(unix)]`, with a
  Windows twin `_fiber_is_not_send` that documents the platform fact and names I107.
- **`q4_thread_affinity` keeps its name on both platforms.** On unix it is unchanged —
  the parked fiber crosses to a second thread and the outcome is recorded. On Windows it
  measures what holds there: the fiber suspends, the parked handle stays on the thread
  that created it, and that same thread resumes it — which is why the executor's
  one-thread-per-parked-fiber rule is a *requirement* on Windows and a design decision
  elsewhere.

**Linux: `6 passed; 0 failed; 0 ignored`.** **Windows: not run, not compiled.** This host
has no Windows Rust target (`rustup` absent, no mingw), and Tension's CI is
Ubuntu-only (`E2E debug`), so no `test result:` line was produced on Windows. The
Windows half is written and reasoned from the type constraint; it is not verified by
execution, and this report does not claim otherwise.

---

## 5. Phase C — the three continuation tests declare their platform

Where the target has no stack switching, a continuation-backed test now asserts the
host's refusal instead of panicking on a guest that cannot load. One helper, used by
three tests, and it asserts **both** branches:

```rust
fn refused_for_want_of_continuations(label: &str, run: &Run) -> bool {
    // true  -> exit 1, empty stdout, and the sentence with the OS in it
    // false -> not Windows (Windows must refuse; a run that did not is a failure)
}
```

The three names, and none of them disappeared:

- `a_served_body_that_parks_is_resumed_by_the_producers_word_on_continuation`
- `a_served_body_that_parks_is_resumed_by_a_late_completion_on_continuation`
- `the_cross_store_programs_print_the_same_values_on_the_fiber_backend` — where the
  continuation twin is refused, the test still asserts that the **fiber** twin runs and
  prints, which is the property DL37's type-section removal bought.

**Linux: `15 passed`** — unchanged assertions, unchanged transcripts.

---

## 6. Two latent DL43 breakages, found and fixed

Both are the same shape: a shared stackful build imports `scheduler::park` whether or not
it parks, because `__parkRemote` is an exported std entry and therefore a DCE root —
what `thread.rs`'s `link_worker` already documents for `parkState`. DL43 introduced that
import and left three hosts without the namespace; the job's *first* step failing meant
the rest never ran, so nobody saw it.

- `examples/host.mjs` + `examples/worker.mjs` — `npm run test:examples`:
  `TypeError: WebAssembly.Instance(): Import #4 "scheduler"`. Now `[ SUCCESS ] 31 checks`.
- `tests/rt/stress.js` — `Import #3 "scheduler" is not an object`. Now `[ SUCCESS ] 111
  checks`.

Both got the same stub Gate 4 has: keyless parks recorded and returned, a keyed park
refused by name. Proposed as **I110** (a host that instantiates a shared module must
provide the namespace — worth a guard, not just three patches).

---

## 7. Gates, each from its own line

| gate | result |
|---|---|
| threads | **15 passed, 0 failed** |
| fiber | **6 passed** (Linux) |
| fiber-executor | **7 passed** |
| async_on_main | **2 passed** |
| fiber-runner | **5 passed** |
| debugger | **5 passed** |
| async_main_promise | **2 passed** |
| `--bin` default | **307 passed** |
| `--bin` audio-only | **298 passed** |
| census (alone) | **71/82 pass, 0 skipped, 11 no-source**, no stale-engine warning |
| `--check` | **9/9 PASS**; runtime `dc2cf96275ae` both profiles; identity `96c7d1c0825a` |
| guests / artifacts | **35 / 70** — no new programs |
| TensionScript suites | compiler `[ SUCCESS ]`; `async/*` 11 green (lower 220, returnvalues 98, runtime 78, await 41, coreloop 24, resolver 32, regressions 10, threads 23, optimize 4, policy 13, harness n/a); `rt/*` green (gate4 **134**, stress 111, arena 76, atomics 71, order 21, examples 31) |

**CI, every job:**

- Tension `45694108177` — `E2E debug: success`; `Wake path guard → running 10 tests,
  10 passed; 0 failed; … 5 filtered out`.
- TensionScript `45693396996` — `Check`, `Binaryen`, `Bootstrap (debug)`,
  `Bootstrap (release)`, `Loader`, `Runtimes`, `Coverage`, `Features`,
  `Async core loop`, **`Gate 4 (threads)`**, `Compiler (ubuntu|macos|windows ×
  current|lts/*)` — **all success**.

---

## 8. Commits

```
TensionScript-a2  b32d73a9  std: the task's record is read through a nullable contract…   (superseded)
TensionScript-a2  284cfe0e  std: the record field tells the truth…                        (superseded)
TensionScript-a2  40146e7c  std: the record is an accessor pair, so asking cannot trap
TensionScript-a2  f045fc5a  std, tests: no false diagnostics, and every shared host stub
                            provides scheduler
Tension           8b8f212   DL44: Gate 4's abort was ours, and the fiber suite declares its platform
Tension           9d38832   DL44: the vendored compiler carries the fix; fixtures rebuilt against it
Tension           4348c87   DL44: re-vendor the accessor design, and rebuild every artifact
Tension           dec08ff   tests: regenerate the rt-guards debug fixture for the reverted source
Tension           7d4e771   DL44: re-vendor at the compiler that reports no false diagnostics
```

Both branches pushed; both trees clean; `main` untouched in both (`56ddabb`, `3f59ec08`).

Fixtures refreshed: `fixtures/thread/{suspend-serve,two-waiters-late,wake-on-worker}.wasm`,
`fixtures/fiber/{i70-fiber,suspend-serve-fiber}.wasm`, `fixtures/debug/rt-guards.wasm`,
each with its `.build.json`. **Artifact count unchanged (35/70)**; the 70 build records
were rewritten by the vendoring.

---

## 9. Findings

- **I106 CLOSED**, with the abort mapped to a line, a probe that rules the engine out, and
  a CI run where Gate 4 is green at 134 checks.
- **I107 code-only.** The suite compiles by construction on Windows now (mutually
  exclusive `cfg`, same test names, no removal) and runs 6 on Linux; **no Windows run
  exists** — see §4.
- **I110 (proposed): a host that instantiates a shared module must provide the
  `scheduler` namespace.** Three hosts did not, and each failed only when the step
  before it stopped failing.
- **A negative result worth keeping:** reading `_record!` in the lowering is a *worse*
  fix than it looks — it silently strips file attribution from the await's line, which
  only a breakpoint test notices. The census caught it; a green suite would not have.
- **I105 stands** — the park's registry entry still costs every shared stackful build an
  import and a little code (measured at DL43: +341 B on `count.wasm`).

---

## 10. What I did not verify

- **The Windows `test result:` line for `tests/fiber.rs` and for `--test threads`** — not
  produced. No Windows Rust toolchain here and Tension's CI is Ubuntu-only. The Windows
  halves of both files are written and unexecuted.
- The conformance census on Windows (it is Linux/lldb).
- `npm ci` (still gated on an absent `node_modules`), publishing, `main`.
