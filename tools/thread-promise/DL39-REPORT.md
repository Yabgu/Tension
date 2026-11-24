# DL39 — the I90 gate runs in CI, and parity does not hold

**Round:** DL39, 2026-11-24. Phase A installs the gate. **Phase B fails, and that
is the round's main finding** — reported, not smoothed over, per §5 of the brief.

| | |
|---|---|
| Tension | `feat/dl39-parity` @ **`6465009`**, off `482bf46` |
| TensionScript-a2 | `feat/dl39-parity` @ **`2d210696`** — **no commit this round** |
| binaryen | `e84dfd8e…`, not moved |
| installed compiler | `bf1ebc2770b8` (unchanged) |
| census | **71/82**, `stale: false`, run alone |

---

## 1. Phase 0, as measured

```
TensionScript-a2  feat/dl38-fiber-await @ 2d210696    clean
Tension           feat/dl38-fiber-await @ 482bf46     clean
installed compiler     bf1ebc2770b8   (= tree dist/assemblyscript.js)
third_party/binaryen  e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a
```

Branches `feat/dl39-parity` created in both. `TENSIONSCRIPT_DIR` was
`/home/acakar/work/TensionScript-a2` for every build.

Baselines (`test result:` lines):

```
--test async_on_main    test result: ok. 1 passed; …
--test fiber-runner     test result: ok. 5 passed; …
```

---

## 2. Phase A — the gate becomes real (I93)

### 2.1 The fixture pair

Both artifacts are committed, one directory per backend:

```
tension-core/tests/programs/fixtures/fiber/async-on-main-fiber.wasm    9 554 B
  c0c78f8b24c885a4bdd8ea4a09e80ca83290a78e045af6a20366ccef80453f16
tension-core/tests/programs/fixtures/contract/async-on-main.wasm      17 566 B
  ff108b95e3ec7bafd608b447245ca4fbe11c47ad6a08a2ec1c1990d84d6a5ec3
```

each with its `.build.json` sidecar and a README naming the rebuild recipe. The
brief asked for the fiber artifact; **the continuation one had to come too**, and
that is not gold-plating — see §2.3.

### 2.2 The alias, without forking the helper

`tension-core/tests/support/programs.rs`:

```rust
pub fn guest_fiber_fixture(name: &str) -> PathBuf {
    guest_or_fixture(name, fiber_fixtures_dir())
}
pub fn guest_contract_fixture(name: &str) -> PathBuf {
    guest_or_fixture(name, contract_fixtures_dir())
}

fn guest_or_fixture(name: &str, dir: PathBuf) -> PathBuf {
    if compiler_installed() { return guest(name); }
    let fixture = dir.join(format!("{name}.wasm"));
    if !fixture.is_file() { support_ci::skip_or_fail(…); }
    fixture
}
```

**One rule, two callers.** The accessors differ only in a directory, so they cannot
drift in how they fall back — which is what the brief's "one-line alias, do not
fork the helper" is protecting.

### 2.3 Why the continuation artifact is committed

Adding `--test async_on_main` to CI is only a gate if **both** tests can run there,
and this is the measurement that showed the second one could not:

```
$ mv node_modules/@yabgu_gm/tensionscript /tmp/…        # CI's configuration
$ cargo test … --test async_on_main
test the_fiber_backend_prints_the_same_contract_transcript ... ok      ← fixture
test the_shared_program_prints_the_contract_transcript ... FAILED      ← built on demand
panicked at tests/support/programs.rs:101:
  test programs: `node …/build-test-programs.mjs` failed (exit status: 1)
```

So the pair is committed, and both tests now pass with no compiler installed:

```
$ cargo test … --test async_on_main      # no compiler present
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.24s
```

### 2.4 The red case (required)

With the compiler absent, the **fiber** fixture removed:

```
test the_fiber_backend_prints_the_same_contract_transcript ... FAILED
test the_shared_program_prints_the_contract_transcript ... ok
thread '…' panicked at tests/support/programs.rs:195:9:
  test programs: …/fixtures/fiber/async-on-main-fiber.wasm is not committed and the
  vendored compiler is not installed at node_modules/@yabgu_gm/tensionscript; run
  `npm install`, then `node scripts/build-test-programs.mjs`
  A missing fixture fails the test by default, in every environment.
test result: FAILED. 1 passed; 1 failed; …
```

**It failed; it did not skip** — `skip_or_fail` panics by default and CI sets no
`TENSION_TEST_ALLOW_SKIP`. Then the control removed as well:

```
test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Restored:

```
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.40s
```

The harness was not changed: the default already fails, which is why this was a
`git mv` rather than a code edit.

### 2.5 The CI diff

```diff
       - name: Stackful proofs
         run: |
           cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
-            --test fiber --test fiber-executor --test fiber-runner
+            --test fiber --test fiber-executor --test fiber-runner --test async_on_main
```

with a comment saying what `async_on_main` is the only test of, and why it could
not run there before. The exact command, locally, in CI's configuration (no
compiler): **2 + 6 + 7 + 5 = 20 tests**, every `test result: ok`.

### 2.6 The CI run

**Run `45488946322`**, job **`E2E debug`**, step **`Stackful proofs`**, conclusion
**success**. From its log:

```
Stackful proofs  21:29:02.604  running 2 tests
Stackful proofs  21:29:02.909  test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.30s
Stackful proofs  21:29:02.912  running 6 tests
Stackful proofs  21:29:02.934  test result: ok. 6 passed; …
Stackful proofs  21:29:02.937  running 7 tests
Stackful proofs  21:29:02.964  test result: ok. 7 passed; …
Stackful proofs  21:29:02.967  running 5 tests
Stackful proofs  21:29:03.902  test result: ok. 5 passed; …
```

`async_on_main` is the **2 tests** line. That is the gate the round exists to
install, and it is now executing on every push.

---

## 3. Phase B — parity, and it does not hold

### 3.1 The enumeration (before any change)

Programs under `tension-core/tests/programs/**/*.ts` that a suite **reads and whose
output it checks**, with the flags they are built under:

| program | asserted by | flags | stack switching? |
|---|---|---|---|
| `async/async-on-main` | `async_on_main.rs` (transcript vs `async-on-main.expected.txt`) | `ASYNC_ON_MAIN_FLAGS` | **yes** |
| `thread/count` | `threads.rs::run("count", …)` | `THREAD_FLAGS` | **yes** |
| `thread/spawn-join` | `threads.rs::run("spawn-join", …)` | `THREAD_FLAGS` | **yes** |
| `thread/two-workers` | `threads.rs::run("two-workers", …)` | `THREAD_FLAGS` | **yes** |
| `thread/spawn-refusals` | `threads.rs::run("spawn-refusals", …)` | `THREAD_FLAGS` | **yes** |
| `thread/spawn-entry-async` | `threads.rs::an_async_worker_entry_is_served_as_its_spawn_entry` | `THREAD_FLAGS` | **yes** |
| `async/schedule-order` | `gallery_optimized.rs::the_schedule_survives_optimization` (-O0 vs -O2) | folder default (`ASYNC_ON_MAIN_FLAGS`) | **yes** |
| `thread/wake-on-worker` | `threads.rs` | `WAKE_FLAGS` | no — the Promise shell resumes it on purpose |
| `thread/two-waiters-late` | `threads.rs` | `WAKE_FLAGS` | no, same reason |
| `async/async-main-promise` | `async_main_promise.rs` | `PLAIN_FLAGS` | no — Promise backend |
| `async/promise-fallback` | (built for the same family) | `PLAIN_FLAGS` | no |
| `async/rt-guards` | `framework_guards.rs` | `PLAIN_FLAGS` | no |
| `async/main-policy` | `debugger.rs` — **a breakpoint binding**, not a transcript | `ASYNC_ON_MAIN_FLAGS` + debug | yes, but no output assertion |
| `fiber/i70-fiber` | `fiber-runner.rs` | `FIBER_FLAGS` | fiber only, already |

**Twins built for measurement, not committed:** `count`, `spawn-join`,
`two-workers`, `spawn-refusals`, `spawn-entry-async`, `schedule-order` — each the
same source with `--stackful-backend=fiber` and **without** `--enable
stack-switching`, built into `/tmp`. They are not in the tree because §3.2 says
four of them do not pass, and a twin committed without an assertion is dead
weight, while one asserted against today's behaviour would enshrine a defect.

### 3.2 The parity table

| program | continuation | fiber | verdict |
|---|---|---|---|
| `async-on-main` | `suspensions: 7 · total: 33 · final: 1150 · status: 1150`, exit 0 | **identical**, exit 0 | **PASS** (DL38's gate; asserted in both tests) |
| `count` | `executors=3 · executorTotal=3 · ringCapacity=1024 · controlStride=16432` | **identical**, exit 0 | identical — but **excluded**: it never parks (no `scheduler::park` import, no `__suspendAwait`), so a twin proves only that the artifact loads |
| `spawn-refusals` | `spawnMain=-1 · spawnPastEnd=-1 · spawnFirst=0 · spawnAgain=-2 · join=0` | **identical**, exit 0 | identical — **excluded**, same reason |
| `spawn-join` | `spawn=0 · pumpRounds=101452 · answer=242`, exit 0 | worker **traps**, run **hangs** (exit 124) | **DIFF** |
| `two-workers` | `observed=12 · valueSum=66 · workerSum=30`, exit 0 | worker **traps**; `spawn1=0 spawn2=0` then the stub, exit **0** with no totals | **DIFF** |
| `spawn-entry-async` | `spawnIndexOf=3 · spawn=0 · worker: entered (async entry) · worker: AFTER the await, value=0 · main: done`, exit 0 | `spawnIndexOf=1 · spawn=0`, worker **traps**, run **hangs** (exit 124) | **DIFF** |
| `schedule-order` | 15 lines: `enter high · enter mid · … · resume high 9 · … · steps 15` | 15 lines, **different order** and **`steps 0`** | **DIFF** |

### 3.3 The two DIFFs, and what causes them

**A. The guest-side worker executor is `unreachable` in a fiber build.** All three
trapping programs fail the same way:

```
ERROR thread: executor 1 could not run: the worker's `__workerMain(1)` failed:
  error while executing at wasm backtrace:
    0: 0x1912 - <unknown>!<wasm function 100>
    1: 0x3c85 - <unknown>!<wasm function 237>
    2: 0x403c - <unknown>!<wasm function 243>
    3: 0x5e7d - <unknown>!<wasm function 288>
```

and function 100 is, verbatim from the artifact:

```
(func (;100;) (type 1) (param i32) (result i32)
  unreachable
)
```

That is one of the three intrinsics DL37 left as `unreachable()` in fiber mode —
`__resumeTask`, `__serveCont`, `__resumeMain`, all `(i32) -> i32` — reached from
`__workerMain` (func 237, `(i32,i32,i32,i32,i32) -> i32`), which is what the host
calls for a worker thread. So: **a fiber build can start a worker thread but the
worker cannot serve a task**, because serving is a continuation operation and
DL37 removed continuations from the fiber shell.

`count` and `spawn-refusals` do not import `scheduler::park` and never suspend, so
they never reach the path — which is exactly why they are excluded rather than
counted as passes.

**B. There is no core loop, so policy and loop-observability differ.**
`schedule-order` prints the same set of *values* on both backends
(`resume eager 7`, `value low 1 / mid 5 / high 9 / eager 7`) but in a different
**order**, and its `steps` count is `0` instead of `15`:

```
continuation              fiber
main: enter               main: enter
enter eager               enter eager
resume eager 7            resume eager 7
enter high                enter low          ← call order, not priority order
enter mid                 resume low 1
enter low                 enter mid
resume high 9             resume mid 5
resume low 1              enter high
resume mid 5              resume high 9
…                         …
steps 15                  steps 0            ← no core loop to count
```

That is not a bug in the sense of a wrong answer: it is the *semantics* of the
fiber backend. `drive()` runs the callee immediately, so a task's admission order
is its call order, and nothing steps a loop. **Scheduling policy — including the
priority order this program measures — is not implemented on the fiber backend at
all**, which is the policy layer the brief schedules for the round after this one.

### 3.4 What I did about it

Per §5 ("If a parity row fails, that is a finding — report it and stop; the fix is
its own round"):

- **No twin committed** for the four DIFF rows, no expectation edited, nothing
  skipped or `#[ignore]`d.
- **No change to the lowering**, the artifact record, the park ABI or
  `scheduler::completion`.
- The limitation is written into `docs/task-model.md` (§4 below) so the tree says
  it, not only this report.

**So Phase B's gate is not met: 1 stackful program is parity-clean, 2 are excluded
as not stackful, 3 trap in the worker path, and 1 differs semantically.** The
honest summary is that **the fiber backend is not a drop-in for the continuation
backend for any program that uses an async worker or observes the core loop**, and
the round that fixes it is the one that builds the policy layer.

---

## 4. Phase C — the record

`docs/task-model.md`, new §"The two backends, and what they agree on" (verbatim,
less the code spans):

> A stackful suspension has two expressions, chosen by `--stackful-backend` and
> recorded in the artifact as `tension.stackful-backend`: `continuation` (wasm
> `suspend`, resumed out of the executor's table) and `fiber` (a call to
> `scheduler::park` that the host turns into an OS-thread fiber switch). On the
> fiber backend an awaited callee's body runs **on the caller's stack**: `drive()`
> calls it, it settles, and the caller's `await` reads the value one frame deeper
> — no park and no resume for that path. A suspension *inside* that body (a
> `policy.await` on a producer's pair, an external completion) still parks the
> fiber, and the resume continues exactly where it stopped because the whole stack
> is preserved. Both backends are asserted against the **same** contract
> transcript, including its suspension count: `async_on_main.rs` runs
> `the_shared_program_prints_the_contract_transcript` and
> `the_fiber_backend_prints_the_same_contract_transcript` against one expected
> file, from committed artifacts so the assertion also runs where no compiler is
> installed.
>
> What they do **not** yet share: the fiber backend has no guest-side core loop, so
> a program that observes the loop (a pump-step count, ready-queue order) or that
> uses the guest-side worker executor (`__workerMain` → `__serveOne`) does not run
> on it — the intrinsics that path calls are `unreachable` in a fiber build. That
> is a known limitation, not a passing case.

**Census note** (`tools/debug-conformance/README.md`, behaviour unchanged):

> **Run it alone.** … lldb is spawned per case, and when other work is competing
> for the cores its attach or its breakpoint binding fails — which the runner
> records as `unresolved` … but the *number* still moves. Measured twice: **62/82
> with 14 `unresolved`** while eight `cargo test` suites were running on the same
> box, **71/82** on the same tree with nothing else going (DL38; I23 named the same
> effect earlier).

---

## 5. Gates

| # | gate | measured |
|---|---|---|
| 1 | `--test async_on_main` 2 passed | `test result: ok. 2 passed; 0 failed; 0 ignored; … finished in 0.41s` |
| 2 | fixture committed (`git ls-files`), red case shown | `git ls-files` lists both `.wasm` + both `.build.json`; §2.4 = FAILED 1/2, then 0/2, then ok 2/2 |
| 3 | a CI run executed `async_on_main` | **run `45488946322`**, job `E2E debug`, step `Stackful proofs`, `ok. 2 passed` |
| 4 | parity table, every row passes | **NOT MET — §3.2**: 1 pass, 2 excluded, 4 DIFF. Reported, not smoothed |
| 5 | compiler suite 367 unchanged | **367**, `[ SUCCESS ]` |
| 6 | `--check` 9/9; guests 30 → 30 + twins (0) | **`rebuild: 9/9 links PASS`**, `60 of 60 current`, 30 guests |
| 7 | continuation artifacts byte-identical to `bf1ebc27` baseline | **all 60 byte-identical** (`cmp` of the sorted hash+name multisets → equal) |
| 8 | suite totals | threads **9** · fiber **6** · fiber-executor **7** · async_main_promise **2** · debugger **5** · `--bin` **307** · fiber-runner **5** · async_on_main **2**, each from its own `test result:` |
| 9 | census 71/82 alone, `stale: false` | `71/82 pass, 0 skipped, 11 fail [no-source 11, pass 71]`, run with nothing else going |
| 10 | commits, branches, clean trees, `main` untouched | §7 |

---

## 6. A measurement error of mine, declared

While measuring the fiber twins I read exit codes **through a pipe**:

```sh
$BIN … /tmp/dl39-spawn-join-fiber.wasm 2>&1 | grep … | head -6; echo "exit=$?"
```

`$?` there is `head`'s status, so I first recorded `exit=0` for a run that in fact
**hangs**. Re-measured with the output redirected to a file and no pipeline:

```
spawn-join fiber        exit=124   (timeout 60)
two-workers fiber       exit=0     (wrong output, worker trapped)
spawn-entry-async fiber exit=124   (timeout 60)
all three continuation  exit=0
```

The §3.2 table uses the re-measured values. The error mattered: it turned two
hangs into apparent passes, which is the same species of mistake as the green
line that runs nothing.

---

## 7. Commits

**Tension**, `feat/dl39-parity`:

- **`ff36462`** — `test(core): the I90 gate runs in CI, on committed artifacts
  (I93)`. `.github/workflows/e2e-debug.yml`, `.gitignore`,
  `tension-core/tests/async_on_main.rs`, `tension-core/tests/support/programs.rs`,
  `tension-core/tests/programs/fixtures/{contract,fiber}/*` (4 new files + 2 READMEs).
- **`6465009`** — `docs: what the two backends agree on, and how to read a census`.
  `docs/task-model.md`, `tools/debug-conformance/README.md`.

**TensionScript-a2**: **no commit.** The parity work was measurement; nothing in
the compiler or std needed to change, and §5 forbids changing the lowering.

Both trees clean; `main` untouched in both; no `third_party/` change; no npm
publish.

---

## 8. What I did not verify

- **Windows** — WIN21 owns it.
- **The policy layer** — not implemented on either backend for guest tasks, which
  is what §3.3 B shows.
- **`f32` / 64-bit payloads**, **migration**, **I76**, **I78**, **I87**.
- **Whether a fiber build could serve a worker task at all** — I established that it
  traps today; whether the right fix is to re-enable `__serveCont` for fiber
  builds, or to give the fiber backend its own worker shape, is the next round's
  question and I did not attempt it.
- **`main-policy` in fiber mode** — it is asserted by a breakpoint binding rather
  than by a transcript, so it is outside this round's parity definition; I did not
  build it.
