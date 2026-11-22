# AS2 — async `main` runs on the Promise backend

Round AS2. Brief `~/work/_cw/roundAS2.brief.txt`, 2026-11-22.
Compiler `~/work/TensionScript-a2` branch `fix/dwarf-prologue`; harness
`~/work/Tension` branch `integration/dwarf-debug`.
No behaviour change on the stackful path, and the conformance matrix is
unchanged at **71 pass / 11 no-source**, per case identical.

## 0. Preflight

```
TensionScript-a2  fix/dwarf-prologue      c8fd330b  clean      (+ AS2 changes, below)
Tension           integration/dwarf-debug 2e2dd75  clean      (+ AS2 changes, below)
installed compiler  d297c3a1…  before; 45b3535e… after
```

**One difference from the brief's expectation:** `Tension` sits at `2e2dd75`,
not `708c155`. `2e2dd75` is `708c155` plus round AP1's single commit
(`git merge-base --is-ancestor 708c155 HEAD` succeeds), and the trees are clean.

**I19, the pin trap, unchanged and not papered over.** `package.json:32` declares
tarball `…-g41b8721bc4f0.tar`; `.packs/` does not contain it
(`manifest.json` still says `150a6e97`). Every provenance-checked build therefore
dies on the check. Nothing was edited to hide it; every build in this round used
the documented `$TENSIONSCRIPT` override pointing at the installed
`node_modules/@yabgu_gm/tensionscript`, which prints
`using $TENSIONSCRIPT=… — NOT the vendored pin` on every invocation. Two
consequences worth naming: `node scripts/build-test-programs.mjs` was always
invoked with that variable set, and so was `cargo test` for the new Rust test (the
test calls the builder, which inherits the environment). CI, where the pin is
vendored, needs neither.

## 1. Phase A — reproduction

**Promise build of the owner's example** (no `--enable stack-switching`):

```
$ cd examples/async-on-main
$ TENSIONSCRIPT=…/node_modules/@yabgu_gm/tensionscript/bin/tensionscript.js \
  node ../../scripts/tensionscript.mjs game.ts -o /tmp/as2/game-promise.wasm \
       --runtime incremental --target release --exportStart __start
$ tension-core /tmp/as2/game-promise.wasm
2026-11-22T00:59:05Z INFO core: async backend: continuations (wasmtime stack switching)
2026-11-22T00:59:05Z INFO core: res: writing under …
EXIT=0                       # and nothing on stdout
```

Exports and call sites, before the fix:

| build | exports | `main` call sites | stdout |
|---|---|---|---|
| `game.ts` Promise | `main _start_game memory __start` | **0** | empty, exit 0 |
| `game.ts` stackful | `__asyncStatus main _start_game __asyncPump memory $starts __start` | 1 (`$~asyncMainStart`) | full transcript |
| AP1 probe `promise-main-framework.ts` | `main __start` | 0 | empty, exit 0 |
| AP1 probe `promise-main-io-only.ts` | `main __start` (+`__asyncPump`, `__asyncStatus`) | 1 | `io only: main ran` |

Neither build has `~asyncMainStart` (that symbol exists only on the stackful
path, and only as the unnamed `() -> i32` wrapper at WAT index 123 in the
stackful control). The `__start` bodies say the rest in one line each: the
Promise build's is `global.get; if; return; end; i32.const 1; global.set;
call <runtime-init>` and stops — the stackful one continues into
`ref.func <main-start>; cont.new; table.set`.

Reproduced exactly as AP1 left it; the compiler that built them is
`d297c3a1…` (`dist/assemblyscript.js`; `dist/asc.js` is `cc8f13ff…` and is
*identical* on the patched and unpatched compilers, so it proves nothing — the
hash that counts is `assemblyscript.js`).

## 2. Phase B — the mechanism, confirmed (both i and ii)

The brief asked for one of three answers. It is **(i) and (ii) together**, and
the second is what makes the first bite from unreachable code.

1. **Where the decision is made.** `compiler.ts:893-903`
   `shouldEmitAsyncShell()`, called once at `compiler.ts:1585`. Its inputs are
   `program.hasAwait`, `program.hasAsync`, `this.asyncShellSuspends` and
   `this.mainFunction`.

2. **What the stackful shell does — read, not inferred.**
   `prepareAsyncStackShell` (`compiler.ts:1176`) builds `~asyncMainStart`
   (`() -> i32 { main() }`, WAT index 123 in the control build),
   `module.addTable(ASYNC_CONT_TABLE, …)`, `cont.new`, and
   `emitAsyncStackShellStart` (`compiler.ts:1288`) resumes `~lib/async/__coreloopAwait`
   from `__start`. The *pump* is guest code: `std/assembly/async.ts:70-100`
   `__coreloopAwait()` pushes slot 0 onto `mainExecutor().ready` and loops
   `e.step(e)` until the queues are empty, ending in `__suspendDone(status)`.

3. **On the Promise path there was no code that could run an async `main`.**
   The two shell implementations that existed are **both continuation-based**:
   A1 (`prepareAsyncShell`, `compiler.ts:944`) sets
   `FeatureFlags.StackSwitching` and emits `cont.new`/`resume_with_handlers` —
   measured, the A1-built `promise-main-io-only.wasm` carried **6** continuation
   references and two `(cont …)` types. A2 is the stackful shell. Backend A's
   own runtime (`std/assembly/task-rt.ts`) has the machinery — `__taskResume`,
   `__taskWake`, the slot table, and a private `drainReady()` — but **nothing in a
   plain guest calls it**: the session guest drains it from its frame loop, the
   host-driven guest from `__taskResume`, and a `--exportStart __start` guest from
   neither. So the fix was "write it", not "wire it up".

4. **`hasAwait` is reachability-blind, and that is what suppressed the shell.**
   `transforms.ts:220` sets `program.hasAwait = true` on any `Await` node the
   scan meets, and `latchAsyncUsage` walks *every parsed source*
   (`transforms.ts:93`), so an `await` in an imported library file counts even if
   the function containing it is unreachable. The old gate was
   `hasAwait → asyncShellSuspends && mainFunction != null`, and
   `asyncShellSuspends = hasAwait && StackSwitching` (`compiler.ts:1497`), so on
   the Promise backend the expression was `false && …` and **no shell was
   emitted at all**.

**Cause: (i) — the only shell that could start `main` was gated on stack
switching and no Promise equivalent existed — made reachable by (ii), because
`hasAwait` is program-wide and reachability-blind, so one unreachable `await` in
an imported library was enough to move a program into the branch that emitted
nothing.**

## 3. Phase C — the fix

Five files, +170/−10. In the compiler:

- **`src/program.ts`** — a new `hasAsyncMain` latch: whether a *top-level
  exported* `async function main` exists.
- **`src/transforms.ts`** — `latchAsyncEntry` fills it in its own pass before
  `latchAsyncUsage`'s early-exit scan (that scan stops as soon as it has seen an
  async declaration and an `await`, which can be before it reaches `main`).
  Exported-ness is part of the test because `mainFunction` is set from the export
  table (`compiler.ts:2247`), so a nested `async function main` cannot make a
  *sync* `main` look startable.
- **`src/compiler.ts`** — `shouldEmitAsyncShell()` now reads: no `main` → none;
  `hasAwait` → *only for an async entry* (true ⇒ A2 if `asyncShellSuspends`, else
  the Promise shell); otherwise unchanged (A1's rule). `prepareAsyncShell()`
  routes `hasAwait && !asyncShellSuspends` to the new `preparePromiseShell()`,
  and the `__start` rewrite block calls `emitPromiseShellStart()`.
- **`std/assembly/task-rt.ts`** — three lines: a private `__taskDrainReady()`
  that calls the existing `drainReady()`, **appended at the end of the file** so
  no existing line number moves (see §5).
- **`src/builtins.ts`** — its internal name.

What the shell emits, in full: `__start` gains `drop(call main)` and
`call ~lib/task-rt/__taskDrainReady`. No continuation type, no tag, no table, no
status global — which is why `promiseShellPrepared` is a separate flag from
`asyncShellPrepared`: the latter means "a continuation shell exists" and is read
by the shared-memory thread entries, `emitStartEntry`'s status word and the A1/A2
rewrite.

Why no loop over "is the handle settled": a guest `await` either falls through
(the callee settled in its own entry) or parks on a completion only a host can
post. `drainReady()` already loops to quiescence over the first kind; the second
has no producer in a plain guest, and stopping is the honest outcome.

**The design choice the brief did not settle, reported rather than picked.**
The gate is `hasAwait`, so an `async main` with **no** `await` in the whole
source set still takes **A1** — the continuation shell — and therefore still
carries continuation types and still cannot load on a Promise engine. Measured:
`promise-main-io-only.wasm` after the fix has **6** continuation references,
while `game.ts`, the framework probe and the new test program each have **0**.
Closing that would mean routing the awaitless case through the Promise driver
too, which removes the `__asyncStatus`/`__asyncPump` exports those programs get
today — a semantic decision, so it is left to the user. One line in
`shouldEmitAsyncShell` switches it, and the A1 tests are the check.

## 4. Phase D — nothing else moved

1. **The two probe programs print.** `promise-main-framework` →
   `framework index: main ran`, exit 0. `promise-main-io-only` → `io only: main
   ran`, exit 0.
2. **`examples/async-on-main` on the stackful build is byte-identical** to the
   pre-change build of the same source (`cmp` clean; `2d98eed1…` both times) and
   prints the same 30-line transcript.
3. **`examples/io`** builds and runs (`=== TensionCore demo game ===`, …, exit 0).
4. **`examples/async-io`** builds and runs unchanged — `pipeline() completed with
   83`, `no task left to resume: true`. Its stack-switching build is **refused by
   a pre-existing guard** (`AS100: the stackful backend requires an exported
   main`); async-io exports `_start_game`/`_game_running` and no `main`, that
   guard is `compiler.ts:1655` which this round does not touch, and it fired the
   same way for the pre-change compiler. So async-io runs on the backend it is
   built for, and the "other backend" is not a build it can have.
5. **Conformance: 71 pass / 11 no-source / 0 wrong-line / 0 skipped**, per case
   identical to DL6 (`as2-conformance-2026-11-22.json`). All **24 debug artifacts
   are byte-identical** to their pre-change hashes, which is why: the only
   conformance program with an `await` and no stack switching
   (`promise-fallback.ts`) has no exported `main`, so it gains no shell.
6. **`npm run check` exit 0; `npm test` exit 0, 71 checks; `test:debug:unit`
   5 + 5; `test:debug` 2 PASS.**

A **flaky-verdict finding**, recorded because it nearly became a false blocker:
the first conformance run of the round reported `69 pass / 11 no-source /
**2 unresolved**` (`schedule_order.transcript#13`, `thread_count.transcript#3`) —
with byte-identical artifacts. That run overlapped `npm test`. Re-runs: those two
cases pass 3/3 serially, and a second 82-case run **alone** (no concurrent
cargo/npm job) is 71/11 with per-case equality. The harness's `unresolved` is
therefore load-sensitive under 8 workers, not produced by this change. It is not
fixed here — the honest next step is a retry or a longer lldb timeout under
contention — but it is a hole in the same sense the arc cares about: a gate that
reports `unresolved` when the machine is busy can cry wolf.

**The regression guard**, `tension-core/tests/async_main_promise.rs` +
`tests/programs/async/async-main-promise.ts` (built with `PLAIN_FLAGS` +
`--exportStart __start`; its expected transcript is
`async-main-promise.expected.txt`). Two assertions, two different questions:

- the module **loads on an engine without stack switching** — a default
  `wasmtime::Config`, the same gate a Windows host meets, which is the property
  a working-on-Linux shell would otherwise hide;
- `main` **runs**, in order, exit 0 — with an explicit "printed nothing" failure
  message, because silence-with-exit-0 is the defect.

Proven to catch it: against the pre-fix compiler (`d297c3a1…`) the guest exits 0
printing nothing and the test fails with `async main printed nothing — main was
never called`; against this compiler both tests pass.

## 5. One measurement worth keeping

Adding three lines to `std/assembly/task-rt.ts` **mid-file** changed the bytes of
`rt-guards` and `promise-fallback` even though their code was identical: the line
table records line *numbers*, so every later row in that file shifted by the
inserted length (measured: one `DW_LNS_advance_line` from 601 to 621). Appending
the function at EOF restores both to their original hashes. A shell change is not
the only thing that moves an artifact — a std edit's *position* does too.

## 6. Phase E — what this unblocks

**Unblocked.** The user's stated goal — *"async await without threads, just on
main"* — now works on the Promise backend: `game.ts`'s full 30-line transcript,
in order, exit 0, from a guest with **zero** continuation types. On Windows that
is not a claim about a capable engine; it is a guest the Promise engine can load,
because the load-time refusal is exactly "a module declaring a continuation type".

**Newly measurable on Windows.** For the first time an async program can be run
there at all, so the previously meaningless questions become answerable: does the
Backend A state machine resume correctly under the Windows engine; does the
promise-seam park/post path behave; do the framework's session rings work on that
target. Before this, every Windows measurement of an async example measured a
program that never started.

**Still impossible on Windows.** Continuations: `wasmtime 50.0.2`'s
`compiler_panicking_wasm_features` marks `STACK_SWITCHING` unsupported on
everything but x86-64 Linux/macOS/Darwin (`config.rs:2497-2513`; identical in
51.0.0-rc.1), and the `update_windows_tib` arm that Cranelift defines is
therefore unreachable — AP1's finding stands. Concretely, on Windows: async is
the state-machine backend only, a suspension must be driven by the host's
completion stream, and the frame shape after a suspension is not main's original
stack. The one gap this round leaves inside that boundary is the *awaitless*
`async main`, which still gets the continuation-based A1 shell (§3) — the
smallest remaining piece of "async main runs everywhere", and a decision rather
than a defect.

## 7. Files

Compiler (`~/work/TensionScript-a2`, `fix/dwarf-prologue`):
- `src/compiler.ts` — `shouldEmitAsyncShell` gate, `preparePromiseShell`, `emitPromiseShellStart`
- `src/program.ts` — `hasAsyncMain`
- `src/transforms.ts` — `latchAsyncEntry`
- `src/builtins.ts` — `taskDrainReady` internal name
- `std/assembly/task-rt.ts` — `__taskDrainReady` (appended)

Harness (`~/work/Tension`, `integration/dwarf-debug`):
- `tension-core/tests/async_main_promise.rs` — the guard (new)
- `tension-core/tests/programs/async/async-main-promise.ts` — the guest (new)
- `tension-core/tests/programs/async-main-promise.expected.txt` — its transcript (new)
- `scripts/build-test-programs.mjs` — `async-main-promise` → `PLAIN_FLAGS + --exportStart __start`
- `tools/debug-conformance/as2-conformance-2026-11-22.json` — the 82-case capture
- `tools/async-probe/AS2-REPORT.md` — this file

## 8. What I did not verify

- **No Promise *engine* exists on this machine.** `AsyncBackend::Promise` is what
  wasmtime returns where it refuses stack switching, which on Linux it does not.
  "Runs on the Promise backend" is therefore measured as: the guest contains no
  continuation type (so an engine without the feature must accept it — asserted
  by the new test against a default `Config`), plus the transcript on the capable
  engine. The Windows run itself is untested here.
- **The awaitless `async main` gap** (§3) — measured, not fixed; closing it is a
  decision.
- **`hasAsyncMain` is latched from the AST**, not from the compiled export table.
  A `main` exported by a re-export or a namespace (`export { main } from …`) is
  not matched; `mainFunction`'s own rule (`prefix.length == 0 && name == "main"`)
  is narrower in the same direction, so the two agree, but this is read from the
  code, not exhaustively tested.
- **`examples/async-io` on a stack-switching build** was not run: the compiler
  refuses it for want of an exported `main`, before and after this change. I did
  not re-run that refusal against the pre-change compiler; the code path is
  untouched (`git diff` on `compiler.ts:1655` is empty).
- **The conformance flake** under load (§4) is characterised, not fixed.
- **`npm test`'s two `async-closure*` fixtures** drove the `hasAsyncMain` gate:
  without it, a program with a *sync* `main` and an `await` elsewhere gained a
  shell it never had. Verified by the fixture suite going green, not by reasoning
  alone.
- The comparison of "which compiler built what" is by `dist/assemblyscript.js`
  sha256 at each step (`d297c3a1…` before, `45b3535e…` after; intermediate
  builds `a72c937f…` and `ff9bce0b…` are recorded in the log above), plus
  `cmp` of the stackful artifact and the 24 debug artifacts.
