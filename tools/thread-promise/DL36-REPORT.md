# DL36 — the fiber executor lands, and the artifact says what built it

**Round:** DL36, 2026-11-24. Three phases: A (build identity, I82), B (the section
asserted in CI, I84), C (the executor, I83).

| | |
|---|---|
| Tension | branch **`feat/dl36-fiber-executor`** @ **`14848b0`**, off `9f4605a` |
| TensionScript-a2 | branch **`feat/dl36-artifact-identity`** @ **`8d495b06`**, off `526f5227` |
| binaryen | `e84dfd8e…` — **not moved** |
| installed compiler | **`a1ccac356de5`** (was `9cbd3684f71f` — §9.1) |
| census | **71/82** before and after, identical |
| CI | Tension run **`45412410830` — success** on `14848b0` |

**CI coverage, stated plainly.** Tension's workflow ran green on the code commit.
The new `fiber-runner` suite is **not** one of its steps: the workflow names
`--test threads`, `--test fiber`/`fiber-executor` and the two debug targets
explicitly, so wiring it in is a one-line addition to that list and was not part of
this brief's scope. On the compiler side, `stackful-fiber-section` is inside
`npm run test:compiler` — the suite a2's `test.yml` runs at line 133 — but that
workflow triggers on **`main` only**, so the test will first execute in CI on the
push that lands this branch; it was run green locally (**366**).

---

## 1. Phase 0, as measured

```
Tension          integration/dwarf-debug @ 9f4605a        clean, nothing unpushed
TensionScript-a2 feat/dl35-fiber-lowering @ 526f5227      clean, on origin
third_party/binaryen  e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a
installed compiler   9cbd3684f71f   (= tree dist/assemblyscript.js)
census               71/82 pass, 0 skipped, 11 no-source
```

All five matched the brief. Branches created: `feat/dl36-artifact-identity` at
`41a972e1`'s successor `526f5227` (a2) and `feat/dl36-fiber-executor` at `9f4605a`
(Tension). `main` untouched in both.

---

## 2. Phase A — build identity for guests (I82)

### 2.1 The skip condition, before and after

```js
// before: the whole question was the mtime
if (!force && existsSync(wasm) && statSync(wasm).mtimeMs >= statSync(ts).mtimeMs) { ++skipped; continue; }

// after: a record, and all three facts
const upToDate =
  !force &&
  existsSync(wasm) &&
  statSync(wasm).mtimeMs >= statSync(ts).mtimeMs &&
  identity.hash !== null &&
  record !== null &&
  record.compiler === identity.hash &&
  sameFlags(record.flags, usedFlags);
```

**The flags are the third condition and the brief did not ask for it.** A flag edit
was invisible to an mtime test in exactly the way a compiler edit was — same
defect, same fix, one line. Declared as an addition, not smuggled in.

`identity.hash !== null` is load-bearing: with no identifiable compiler every
comparison would be `null === null` and the builder would skip every artifact
having no idea what built them.

### 2.2 The sidecar

`<artifact>.wasm.build.json`, beside each artifact:

```json
{
  "compiler": "a1ccac356de5ddb5eb9a0fbc29af40f0cfe2f61f443e8cbe6e1164c3ab0c50d5",
  "compilerPath": "node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js",
  "source": "fiber/i70-fiber.ts",
  "flags": ["--runtime", "incremental", "…", "--stackful-backend", "fiber"]
}
```

**`dist/assemblyscript.js`'s sha256**, not the bin entry's: that bundle *is* the
compiler, and it is the same file `rebuild.mjs`'s `dist → installed` link already
compares — one identity, two callers, so a record and the check that reads it
cannot disagree. The path is repo-relative when it is inside the repo, because a
committed record must not carry one machine's home directory.

`compilerIdentity()`, `buildRecordPath()`, `readBuildRecord()` and
`writeBuildRecord()` live in `scripts/lib/toolchain.mjs`; the builder and the
check both call them, so the schema has one definition.

### 2.3 The ninth link, and its red case

```
guests: built by the installed compiler       58 recorded by a1ccac356de5   58 of 58 current   PASS
```

Three states, transcribed:

```
=== (a) one record pointed at a hash that never existed ===
guests: built by the installed compiler       58 recorded by a1ccac356de5   1 built by another compiler   STALE
rebuild: 8/9 links PASS, 1 STALE/UNKNOWN                                     EXIT=1

=== (b) one record deleted ===
guests: built by the installed compiler       58 recorded by a1ccac356de5   1 with no build record        STALE
rebuild: 8/9 links PASS, 1 STALE/UNKNOWN                                     EXIT=1

=== (c) restored ===
guests: built by the installed compiler       58 recorded by a1ccac356de5   58 of 58 current              PASS
rebuild: 9/9 links PASS                                                      EXIT=0
```

The row names **only the reasons that fired** — an earlier draft printed
`0 no build record, 1 built by another compiler`, which makes a reader go and
check a zero.

The link covers the release **and** debug sets (58 = 29 + 29), because an artifact
built by an older compiler misleads a breakpoint test exactly as much as a run
test. Only sets that exist are counted, so a tree that has never built debug
artifacts is not failed for their absence.

**The builder's own red case** — the same tampered record:

```
build-test-programs: thread/count.ts
build-test-programs: 1 built, 27 up to date, 28 total (1 for a new compiler)
build-test-programs: 0 built, 28 up to date, 28 total          ← second run, record rewritten
```

One artifact rebuilt, the record rewritten, the next run a no-op, and the rebuilt
bytes identical to the ones it replaced (`c79dd696823d` before and after).

### 2.4 The 56 guest artifacts, before and after

Compared as `(name, sha256)` multisets against the pre-round baseline captured
before any edit:

```
baseline (name,hash) pairs: 56   distinct: 56
now:                        58   distinct: 58
only in baseline: []
only in now:      [('i70-fiber.wasm', '2578436723fd…'),   ← debug
                   ('i70-fiber.wasm', '70981859b8d8…')]   ← release
```

**Every one of the 56 pre-existing artifacts is byte-identical. Two new, both
`i70-fiber` (the guest Phase C requires).** Nothing else moved.

### 2.5 The seat's five guests — measured, and where my DL35 control went wrong

The five named guests (`async-main-promise`, `promise-fallback`, `rt-guards`,
`two-waiters-late`, `wake-on-worker`) carry the post-DL35 line constant:

```
rt-guards 309:0 337:1 · async-main-promise 309:0 337:2 · promise-fallback 309:0 337:1
two-waiters-late 309:0 337:2 · wake-on-worker 309:0 337:2
```

`337 = d1 02`, `309 = b5 02` in LEB128 — **one byte**, which is exactly the
`0xD1 → 0xB5` the seat measured. And DL35's own committed fixture diff shows the
movement: `- i32.const 309` / `+ i32.const 337` (the source line of `class Task<T>`,
shifted by the members DL35 added to `TaskBase`).

Why my DL35 "0 bytes moved" control was worthless, in one sentence: **the builder
runs the *installed* compiler**, so stashing the sources and rebuilding produced
the same artifacts — the control could not have seen the change it was controlling
for. That *is* I82, and it is why Phase A exists.

**In this round nothing moved** (§2.4), because this tree's baseline was already
post-DL35. The five-guest movement is `41a972e1 → 526f5227`, not `526f5227 → now`.

---

## 3. Phase B — the section asserted on bytes (I84)

**Test:** `tests/compiler/stackful-fiber-section` — suite **365 → 366**
(`npm run test:compiler -- --parallel` → `366` / `[ SUCCESS ]`).

**What it asserts**, on a temporary `.wasm` the compiler writes:

```
tension.stackful-backend  exists exactly once
payload                   66 69 62 65 72   (= "fiber", compared as bytes)
default build             the section is ABSENT
```

The control is in the same test and is not decoration: without it the test passes
just as well if **every** build carried the section, which would make "absent means
continuation" a claim the suite never checks.

**Two harness pieces, both additive:**

1. `skipFixture` — a fixture may *assert* instead of *compare*. The compile still
   has to succeed and the test is not skipped; only the golden comparison is
   dropped, against a `.wat` that cannot carry the claim (the text format has no
   custom-section syntax). **No golden invented**, no `.wat` committed for it.
2. The glue runs at **import time**. The harness imports a fixture's `.js` before
   it decides whether to instantiate — which matters because a fiber artifact
   declares continuation types (§8) and cannot be instantiated on a Node without
   wasmfx. `postInstantiate` would never have run.

**Verified red**, then reverted (`grep -c MUTATION` → 0):

```
Error: tension.stackful-backend says 6669626572 ("fiber"), expected 66616b6500 ("fake\u0000")
EXIT=1
```

---

## 4. Phase C — the executor (I83)

### 4.1 The module

`tension-core/src/fiber.rs` (clap-free, no new dependency beyond the fiber crate
moving from `[dev-dependencies]` to `[dependencies]`):

| item | what it is |
|---|---|
| `Backend` | `Continuation` / `Fiber`, with `name()` (the artifact's word) and `label()` (the startup line) |
| `Backend::of(bytes)` | **reads `tension.stackful-backend`**; absence → `Continuation` |
| `Mismatch` | `{ guest, executor }`, one sentence, both names |
| `Park` | `{ task: u64, class: u32, key: u32 }` — what a park was |
| `Stranded` | the park plus "and no completion arrived" |
| `Outcome` | `Done(i32)` / `Stranded(Stranded)` |
| `suspend_current(park)` | the park import's last line; `false` when no fiber is running |
| `completion_value()` | what `scheduler::completion` answers |
| `run(store, instance, call, producer)` | the fiber, the handle, and the loop |

`Backend::of` parses the section list by hand: wasmtime 50's `Module` exposes no
`custom_sections()`, and the bytes are in hand at load time. Twelve lines, no
dependency.

`Fiber::new`'s closure takes `impl FnOnce(…) + 'a` — **no `Send` bound**, because
the fiber runs on the calling thread. So `store` is *borrowed* for the run rather
than moved, and nothing crosses a thread.

### 4.2 The selection path

```
main(): read the guest's bytes → Backend::of(bytes) → guest_backend
        executor = cli.executor.unwrap_or(guest_backend)     // flag is test-only
        executor != guest_backend → eprintln!("{}", Mismatch{..}) ; exit(2)
        log "executor: fiber (scheduler::park suspends an OS thread's stack)"
        — before GuestHost::new, before instantiation —
```

The default path never reads `--executor`: the executor **is** the artifact's
answer. The refusal is at **exit 2** (the code the other load-time refusals use:
the command line and the artifact disagree, nothing about the guest was wrong).

`thread_boot` keeps the carve/arena/verify sequence unchanged and branches only on
the `__start` call: `Continuation` → `start.call(store, ())`, `Fiber` →
`fiber::run(...)` with the same closure.

### 4.3 The refusal, both directions, from the release binary

```
$ tension-core --executors 1 --executor=fiber …/fixtures/thread/wake-on-worker.wasm
tension-core: this guest was built for the `continuation` backend and this executor is the
`fiber` backend — refusing by name, nothing was run
EXIT=2

$ tension-core --executors 1 --executor=continuation …/fixtures/fiber/i70-fiber.wasm
tension-core: this guest was built for the `fiber` backend and this executor is the
`continuation` backend — refusing by name, nothing was run
EXIT=2
```

Same sentence, two names swapped, no instantiation, no guest output.

### 4.4 The producer, and where the ordering comes from

The producer is a closure the caller passes to `fiber::run`; it is asked **once per
park, after the guest has parked**:

```rust
|park| staged.iter().position(…).map(|i| staged.remove(i).2)
```

`None` → `Outcome::Stranded`. So "park, then wake" is the *shape of the loop*, not
something a test has to arrange — which is why I70's ordering is asserted cheaply
in §5 instead of being slept for. A staged completion is consumed when used: one
flag, one resume.

`scheduler::completion(task_id) -> i32` is the second half: `park`'s signature is
the contract's `void(i64,i32,i32)` and has nowhere to return a value, so the resumed
task asks for the payload it was woken with. Registered for every guest like
`park`; a module that does not import it never resolves it. The ABI doc regrew
(`docs/abi/guest.md`: 94 → 95 imports) and names it.

### 4.5 Resume or refuse at shutdown — **refuse, and leak**

A suspended fiber **cannot be dropped** (`debug_assert!(self.done.get())` in the
crate). At a strand the executor `mem::forget`s it and returns
`Outcome::Stranded`; `main` turns that into `anyhow::bail!` → exit 1. The choice is
**refuse-and-leak**, and the leak is one 512 KiB stack at the end of a run by
definition. The alternative — resume with a fabricated completion, or drop and
abort — is the failure mode `Stranded` exists to name.

---

## 5. The five tests, and what each asserts

`tension-core/tests/fiber-runner.rs` — **5 passed**:

```
cargo test --manifest-path tension-core/Cargo.toml --test fiber-runner
test result: ok. 5 passed; 0 failed; 0 ignored
```

1. **`a_fiber_guest_parks_and_resumes_with_the_producers_word`** — exit 0;
   stdout `before=1` and `value=500`; **parks == 1** and **completions == 1** counted
   from the host log; **ordering asserted** by line index (park line < completion
   line); `executor: fiber` in the log, i.e. the artifact chose it with no flag.
2. **`a_continuation_guest_is_refused_by_a_fiber_executor`** — exit **2**; both
   names; no `executor:` line (so the refusal precedes the choice); empty stdout.
3. **`a_fiber_guest_is_refused_by_a_continuation_executor`** — the same, swapped.
4. **`a_never_woken_park_is_refused_at_shutdown`** — exit **non-zero** (no hang:
   `Command::output` returns); `parked on class 4 key 7 and no completion arrived`;
   `before=1` printed and no `value=` at all.
5. **`two_parked_tasks_on_two_threads_both_complete`** — two OS threads, each with
   its own engine/store/linker and its own fiber; **both threads park before either
   is resumed** (a `Barrier`, not a sleep); each reads its own producer's word:
   `values == [500, 700]`.

**Compulsory controls, applied-run-reverted** (`grep -c MUTATION` → 0 each time):

| mutation | effect |
|---|---|
| M1 strand returns `Done(0)` | **test 4 FAILS**, the other four pass |
| M2 the producer's word never reaches the guest (`COMPLETION := 0`) | **tests 1 and 5 FAIL** |
| M3 the mismatch check accepts anything (`if false && …`) | **tests 2 and 3 FAIL** |

### 6. I70 under the real executor

```
$ tension-core --executors 1 --post-completion 4,7,500 …/fixtures/fiber/i70-fiber.wasm
INFO  core: executor: fiber (scheduler::park suspends an OS thread's stack)
warm=0
before=1
INFO  fiber: task 0 parked on class 4 key 7
INFO  fiber: completing class 4 key 7 with 500 → resume
value=500
start_game=1
EXIT=0
```

**parks = 1, wakes = 1, value = 500, order: park → complete → resume.** The two
log lines are deliberately separate: one line naming both facts would make a
transcript unable to say which came first, and "the wake came after the park" is
the whole claim.

And the strand, with no completion staged:

```
INFO  core: executor: fiber (…)
warm=0
before=1
Error: fiber executor: task 0 parked on class 4 key 7 and no completion arrived
EXIT=1
```

---

## 7. Every suite, with its command

| suite | command | count |
|---|---|---|
| compiler | `npm run test:compiler -- --parallel` (a2) | **366**, `[ SUCCESS ]` |
| fiber-runner | `cargo test --manifest-path tension-core/Cargo.toml --test fiber-runner` | **5** |
| threads | `… --test threads` | **9** |
| fiber | `… --test fiber` | **6** |
| fiber-executor | `… --test fiber-executor` | **7** |
| async_main_promise | `… --test async_main_promise` | **2** |
| debugger | `… --test debugger` | **5** |
| `--bin` | `… --bin tension-core` (default features) | **307** |
| `rebuild --check` | `node scripts/rebuild.mjs --check` | **9/9 PASS**, exit 0 |
| census | `node tools/debug-conformance/runner.js --workers 8` | **71/82** before **and** after |

`--bin` caught a real regression on the way: `host_option_table_tests` feeds every
option a literal `"value"`, and `--executor value` is **refused by design** (a typo
must not fall back to the default). Fixed the test the way the test already works —
a per-option sample value, `HostOptionKind::Executor => "fiber"` — not by weakening
the parser.

---

## 8. Found, not fixed: I85 — a fiber artifact still declares continuation types

The engine refuses to **parse** the fiber guest with stack switching off:

```
cannot define continuation types when stack switching is disabled (at offset 0x27)
```

The artifact carries no `suspend` (verified: 0), but it still declares the shell's

```
(type (;6;) (cont 3))   (type (;8;) (cont 5))   (tag (;0;)) (tag (;1;)) (tag (;2;))
```

So the *mechanism* is fiber-only and the *type section* is not. Two consequences,
both stated rather than glossed:

- **I16 (Windows) is not delivered by the lowering.** A stackful fiber guest still
  cannot load where `wasm_stack_switching` is unavailable.
- **DL35's report claims otherwise** ("lets the artifact load on an engine without
  stack switching"). That claim is **false**, and `src/fiber.rs`'s header now says
  so in the place a reader will meet it. Dropping the unused types/tags is a
  lowering change this round did not make — it would move every artifact, and gate
  3 forbids movement.

`tests/fiber-runner.rs` enables stack switching in its own engine and says exactly
why in the comment, so the test does not quietly pretend the property holds.

---

## 9. Findings about the prior round

### 9.1 The committed compiler source was never built (`a1ccac35` vs `9cbd3684`)

Phase 0 read `9cbd3684f71f` for both the tree's `dist` and the installed copy — as
the brief expected. But the **committed source** (`526f5227`) builds
**`a1ccac356de5`**, deterministically (two builds, identical), and the two bundles
differ in exactly one place:

```
old: `--stackful-backend=${a} (expected \``+nm+"` or `"+kl+"`)"
new: `--stackful-backend=${a} (expected `+nm+" or "+kl+")"
reconstructing old from new gives the installed bytes: True   (5 bytes shorter)
```

That is DL35's **last** edit — removing two backslashes for eslint — made *after*
the last build and install. So: the fix was never compiled, never installed, and
never exercised by any test that ran. Rebuilt and installed here (`a1ccac35`), and
the 56 guests it produced are byte-identical to the `9cbd3684` set (§2.4), which is
what one expects from a diagnostic string nobody hit.

Nothing was broken by it; the report's claim of "PASS" was true at the moment it was
measured. But a round that ends with an unbuilt source is a round whose gate did not
cover its own last edit, and the honest fix is the one this round ships: **the
artifact now records which compiler built it, and the check asks.**

### 9.2 The five-guest baseline

See §2.5. The claim is confirmed; my DL35 control could not have shown it.

---

## 10. Commits

**TensionScript-a2**, branch `feat/dl36-artifact-identity` (pushed):

- **`8d495b06`** — `test(compiler): assert the fiber backend's artifact record on its
  bytes (I84)`. `tests/compiler.js` (`skipFixture`), and
  `tests/compiler/stackful-fiber-section.{ts,js,json}`.

**Tension**, branch `feat/dl36-fiber-executor` (pushed):

- **`5ae9abd`** — `build(guests): an artifact records which compiler built it (I82)`.
  `scripts/lib/toolchain.mjs`, `scripts/build-test-programs.mjs`, `scripts/rebuild.mjs`.
- **`14848b0`** — `feat(core): a fiber executor, chosen by the artifact (I83)`.
  `tension-core/src/fiber.rs` (new), `Cargo.toml` (fiber crate to `[dependencies]`),
  `src/lib.rs`, `src/main.rs`, `src/scheduler.rs`, `src/host/config.rs`,
  `tests/fiber-runner.rs` (new), `tests/programs/fiber/i70-fiber.ts` (new),
  `tests/programs/fixtures/fiber/{i70-fiber.wasm, i70-fiber.wasm.build.json,
  README.md}` (new), `.gitignore` (the fixture's exemption), `docs/abi/guest.md`
  (regenerated: 94 → 95 imports).

Both trees clean at the end; `main` untouched in both; no `third_party/` change; no
npm publish; no PR.

---

## 11. What I did not verify

- **Windows.** No run (WIN18 follows). And on the evidence of §8, this round does
  **not** unblock it: a fiber guest still needs stack switching to parse.
- **Migration, cross-thread fiber hand-off.** Not attempted; `Suspend` is `!Send`
  and DL24 measured the cross-thread resume aborting.
- **`f32` / 64-bit payloads.** The delivery path carries one `i32` word, which is
  what `scheduler::completion` returns. Nothing in this round delivers anything
  else; a 64-bit completion would need the `f0`/`f1` rule `rt.classify` implements.
- **A fiber stack overflow.** Guard pages are **off** (the `nostd` stack has none,
  DL25 §"guard pages"), so a guest that overruns its 512 KiB stack runs into
  whatever follows. Untested, and a real hazard for a shipping pool.
- **I76** (`tests/fiber.rs` Windows cfg), **I78** (provenance bytes), **I79/I80**.
- **The policy layer** — no `TaskPolicy`, no per-call dispatch, no queue policy.
- **More than one parked task per thread.** Test 5 puts them on separate threads
  because one thread cannot hold two (DL24's trap-handler assertion). Nothing here
  tries to.
- **The cost** of the fiber path. Not measured; DL27's instrument is where that
  belongs.
