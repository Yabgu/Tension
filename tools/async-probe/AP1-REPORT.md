# AP1 — what the async backends can actually do, measured

Round AP1. Brief `~/work/_cw/roundAP1.brief.txt`, 2026-11-22.
Host: Linux x86-64, `wasmtime 50.0.2` (pinned), engine
`tension-core/target/release/tension-core` 33,545,888 B @ 2026-11-21T22:14.
Every claim below is a file-and-line citation or a command's output; anything
*inferred* is labelled.

Reproduce all four measurements with

    sh tools/async-probe/run.sh > transcript.txt

Sources: `tools/async-probe/programs/`. Captured output:
`tools/async-probe/transcript-linux.txt`.

---

## 0. Phase 0 — preflight

```
Tension          integration/dwarf-debug  708c155   clean
TensionScript-a2 fix/dwarf-prologue      c8fd330b   clean
installed compiler  d297c3a196bec2963c275aa0038cadf4dcd4e5cb855396b918471167e35b3e72
```

Matches the brief exactly.

**One pre-existing discrepancy found while building**, reported and not fixed:
`Tension/package.json:32` declares
`file:.packs/yabgu_gm-tensionscript-0.14.1-g41b8721bc4f0.tar`, and that tarball
is **not on this machine** (`.packs/` holds `g03e0507`, `g150a6e97`, `g9697d13`,
`gc1df751`, `gd96ac60`; `manifest.json` still names `g150a6e97`). The pin was
moved to `41b8721b` by `f83380b` ("build(windows): find the packages that were
already installed") without re-vendoring. Consequence: every
`scripts/tensionscript.mjs` invocation fails the provenance assertion, so
`node scripts/build-test-programs.mjs` and thus `cargo test --test threads` fail
before running a guest:

    the compiler that would run is NOT the vendored pin:
      package.json declares file:.packs/yabgu_gm-tensionscript-0.14.1-g41b8721bc4f0.tar,
      the manifest says file:.packs/yabgu_gm-tensionscript-0.14.1-g150a6e974698.tar

The probes here use the documented escape hatch instead — `$TENSIONSCRIPT` set to
the installed `bin/tensionscript.js`, which prints `using $TENSIONSCRIPT=… — NOT
the vendored pin` on every build. That is why `tools/async-probe/run.sh` sets it
explicitly, and it is why every number below names the compiler as "installed
dist `d297c3a1`" rather than "the vendored pin".

---

## A — how the backend is chosen today

### 1. The function

`tension_core::async_backend::build` — `tension-core/src/async_backend.rs:60`.

```rust
pub fn build(base: &Config) -> anyhow::Result<(Engine, AsyncBackend)> {
    let mut with = base.clone();
    with.wasm_stack_switching(true);                       // :62
    match Engine::new(&with) {
        Ok(engine) => Ok((engine, AsyncBackend::Continuations)),   // :64
        Err(refusal) => {
            if !format!("{refusal}").contains("wasm_stack_switching") {  // :69
                return Err(anyhow::Error::from(refusal));
            }
            let engine = Engine::new(base)?;               // :72
            Ok((engine, AsyncBackend::Promise))            // :73
        }
    }
}
```

### 2. Its inputs — a **runtime capability probe**, not a cfg and not a config value

The only input that decides is **whether `Engine::new` accepts a `Config` with
`wasm_stack_switching(true)`**. There is no `cfg!(windows)` in
`tension-core/src/` (`grep -rn 'cfg!(windows)' tension-core/src/` → nothing for
this decision), no env var, no CLI flag, and no feature flag on the dependency:
`wasmtime = "=50.0.2"` with default features, and `stack-switching` **is** in
wasmtime's default set (`wasmtime-50.0.2/Cargo.toml:98-127`). The crate feature
is compiled in everywhere; what differs by target is wasmtime's own gate.

That gate, in the vendored crate:

- `wasmtime-50.0.2/src/config.rs:2458` `fn compiler_panicking_wasm_features()`,
  whose x86-64 Cranelift arm (`:2497-2513`) marks `STACK_SWITCHING` unsupported
  on **every** target except `x86_64` × (`Linux | MacOSX | Darwin`):

```rust
Triple { architecture: Architecture::X86_64 | Architecture::X86_64h,
         operating_system: OperatingSystem::Linux | MacOSX(_) | Darwin(_), .. } => {
    // Stack switching supported on (non-Pulley) Cranelift.
}
_ => { unsupported |= WasmFeatures::STACK_SWITCHING; }
```

- `wasmtime-50.0.2/src/config.rs:2686-2697`, `Config::validate()`, refuses:

```rust
let unsupported = features & self.compiler_panicking_wasm_features();
if !unsupported.is_empty() { … bail!("the wasm_{} feature is not supported on this compiler configuration") }
```

- `wasmtime-50.0.2/src/engine.rs:125-127`: `Engine::new` calls
  `config.validate()?` first, so the refusal arrives before any module is seen.

The `enabled_features` from `wasm_stack_switching(true)` are OR-ed in **after**
the mask (`config.rs:2649-2651`), so no amount of `Config` fiddling gets past it;
`validate()` re-tests the final set.

### 3. The full set of backends, and the condition for each

`tension-core/src/async_backend.rs:22-27` — exactly two:

| variant | condition |
|---|---|
| `AsyncBackend::Continuations` | `Engine::new` accepted `wasm_stack_switching(true)` — i.e. x86-64 Linux / macOS / Darwin under Cranelift |
| `AsyncBackend::Promise` | `Engine::new` refused with a message containing `wasm_stack_switching`; the engine is rebuilt **without** the feature and the host records the downgrade |

Anything else is fatal: a refusal that is not the stack-switching one is
returned as an error rather than silently downgraded (`async_backend.rs:69-71`).

### 4. What Windows gets, and where that is decided

`Promise`. Decided at `async_backend.rs:63-73` on Windows for exactly the reason
above: `Engine::new` refuses. The label is
`"promise (no stack switching on this target)"` (`:46`), printed once at startup
(`main.rs:1245`) and in `--help` (`main.rs:837`).

### 5. Per-process, per-guest, or per-task

**Per-process.** `async_backend::build` is called once, in `main`
(`main.rs:1231`), and its two results are stored together in `HostConfig`:
`engine` and `async_backend`
(`host/config.rs:37-48`), documented there as "Immutable, `Clone`, and identical
for every guest the process runs — so it is configuration, not per-guest state".
The `Engine` owns the compiled-code cache, and one engine per guest would compile
a shared module twice. No task ever sees a different backend: the second caller
of `build` anywhere in the tree is `#[cfg(test)]`
(`thread.rs:623`, `sandbox.rs:808` are test helpers).

**Consequence for the design question:** adding a third backend is a new arm of
`build`'s `match` plus a new `AsyncBackend` variant — but the probe's *input*
(`Engine::new`) cannot distinguish "no stack switching on this target" from
"some other third backend is possible", so a parking backend would need its own
decidable condition, not a reuse of this one.

---

## B — is the continuation refusal ours or wasmtime's?

### 1. Which of the four it is

**Wasmtime's, at the target gate — not a `cfg` in our code, not a dependency
feature flag, and not the guest failing to validate.**

- The message the brief quotes is **ours**, in
  `tension-core/src/host/guest.rs:129-139`: when the backend is `Promise` and
  the module-cache error text contains `"stack switching"`, we rewrite the error
  to name the platform and the recompile hint. That is a *diagnostic*, not the
  refusal.
- The refusal itself is wasmtime's, in two layers:
  1. `Engine::new` → `Config::validate()` →
     `"the wasm_stack_switching feature is not supported on this compiler
     configuration"` (`config.rs:2686-2697`), before any guest exists. This is
     why `async_backend::build` had to *not* pass the feature in the first place;
  2. with the feature off, a module carrying continuation types is refused at
     compile time with `"cannot define continuation types when stack switching
     is disabled"` — also wasmtime's (`wasmtime-50.0.2/src/compile.rs` /
     validator), and the string our `guest.rs` matches on.
- Not the guest failing to validate in any way we control: the identical
  `.wasm` byte stream runs on Linux (measured in D and in DL3–DL6).

### 2. Citation

- ours (the message): `tension-core/src/host/guest.rs:129-139`
- wasmtime (the gate): `wasmtime-50.0.2/src/config.rs:2458` (`compiler_panicking_wasm_features`),
  `:2497-2513` (the target match), `:2686-2697` (`validate()` bails)
- wasmtime (the call path): `wasmtime-50.0.2/src/engine.rs:125-127`

### 3. What `12092c2` ("continuations per-target") actually changed

`git log -1 12092c2` — one commit, five concrete changes:

1. `tension_core::async_backend::{build, current}` — the try-and-fall-back engine
   builder, returning `AsyncBackend::{Continuations, Promise}` instead of letting
   `Engine::new` take the process down.
2. `main` prints one startup line naming the backend, and `--help` prints it too.
3. A continuation guest on a target without the feature is refused **by name**
   with the platform in the message (this is the `guest.rs` block above).
4. `gallery_async`, `threads`, `async_on_main`, `continuation_module` assert that
   refusal instead of failing with a mystery, keeping their test counts.
5. `AGENTS.md` records the toolchain prerequisites and the wasmtime limit.
   Plus an unrelated one-line fix to `rt-guards.ts`'s import depth.

"Per-target" therefore means **the backend is negotiated at runtime against the
target wasmtime was built for, and the host degrades to a Promise seam rather
than refusing to start.** Nothing was made conditional on Windows in our source;
the same code returns `Continuations` on Linux and `Promise` on Windows because
`Engine::new` answers differently.

### 4. Is it reversible by us? — **No, not by configuration. Yes, by patching wasmtime.**

- **Not by a flag, a cfg, or a feature.** wasmtime's own doc comment in our file
  records it (`async_backend.rs:6-10`: "there is no configuration switch that
  overrides it"), and the code agrees: `enabled_features` is applied after the
  unsupported mask but `validate()` re-tests the final set.
- **Not by upgrading.** `wasmtime-51.0.0-rc.1` is in the local registry and its
  `compiler_panicking_wasm_features` is **identical** at the same place
  (`51.0.0-rc.1/src/config.rs:2486-2541`, same `Linux | MacOSX | Darwin` arm,
  same `_ => unsupported |= STACK_SWITCHING`). The next release does not change
  this.
- **But Cranelift has a Windows stack-switch model that the gate never lets you
  reach.** `wasmtime-50.0.2/src/config.rs:3130-3143` and `engine.rs:499` both
  expect `stack_switch_model = "update_windows_tib"` on Windows when
  `STACK_SWITCHING` is set, and `cranelift-codegen-meta-0.137.2/src/shared/settings.rs:131-141`
  documents it: *"If set to `update_windows_tib`, we additionally update
  information about the active stack in Windows' Thread Information Block."* So
  the code generator can emit Windows stack switching today; only wasmtime's
  feature gate refuses to enable the feature.
- **Untested, and this is the part that decides months vs indefinite:** whether
  continuations *run* on Windows once the gate is lifted. Nothing in the
  repository or the vendored crate tests it; `wasmtime-50.0.2/src/runtime/vm/stack_switching.rs`
  contains no `cfg(windows)` refusal, which is suggestive but is not a
  measurement. Lifting the gate is a one-arm vendored patch; proving it works is
  a Windows bring-up with its own round.

**Answer in the brief's terms:** wasmtime genuinely cannot run continuations on
Windows *today*, but "genuinely cannot" is a policy decision inside wasmtime
rather than a property of Cranelift on that target. It is reversible by a
vendored one-condition patch plus a bring-up, not by anything we can set.

---

## C — does this platform do threads?

Yes, on Linux, measured. **Windows not measured** — no Windows host is reachable
from this machine (`~/.ssh/config` absent; `scripts/ssh-run.mjs` exists but has
no configured host). Left to the Windows brief as the brief allows.

### The probe

`tools/async-probe/programs/shared-probe.wat` — 46 lines of WAT, written by hand
so the question asked is about the **host**, not about a compiler. It imports the
host's shared memory and the two thread imports, does two atomic RMW adds, asks
for the executor count, spawns one worker, and has the worker do its own atomic
RMW on the same memory:

```wat
(import "env" "memory" (memory 1 64 shared))
(import "env" "__executorCount" (func $count (result i32)))
(import "env" "__startThread" (func $start (param i32) (result i32)))
(export "memory" (memory 0))
…
(func (export "__workerMain") (param $id i32) (result i32)
  (i32.atomic.rmw.add (i32.const 4) (i32.const 1)) …)
(func (export "_start_game")
  (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 7)))
  (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 35)))
  (if (i32.eq (i32.atomic.load (i32.const 0)) (i32.const 42)) … "ok" …)
  (if (i32.eq (call $count) (i32.const 3)) … "ok" …)   ;; --executors 2 ⇒ 3
  (drop (call $start (i32.const 1))))
```

### The command and the output

```
$ ./tension-core/target/release/tension-core --executors 2 tools/async-probe/programs/shared-probe.wat
2026-11-22T00:28:07.971Z INFO  core: async backend: continuations (wasmtime stack switching)
main: atomic 0+7+35 = 42 ok|main: executorCount = 3 ok|worker: atomic rmw.add over shared memory ok|
```

Loads. Runs. Two atomic RMWs in main give 42. An atomic RMW **in the worker**
gives the expected 0→1 on the same memory. `__executorCount()` answers 3 for
`--executors 2`, which is the documented contract (`--help`: "Main is always one
executor, so the guest's `__executorCount()` answers N + 1"; `main.rs:630`).

Control, no pool (`--executors 0`, the default):

```
main: atomic 0+7+35 = 42 ok|main: executorCount WRONG|
```

Same guest, atomics still work, no worker exists — the "WRONG" is the probe's own
assertion (`count == 3`) reporting the expected absence.

### What backs it in the host

- `main.rs:1311` attaches `cli.executors`; `main.rs:1564` runs `thread_boot`
  (`:524`) only when a pool exists, in the documented order
  `__threadInit` → `__arenaInit` → `__start`.
- `thread.rs:114` `ExecutorPool::new`, `:160` `std::thread::Builder::new` — the
  worker is a real OS thread over one `SharedMemory`, not a coroutine.
- The engine enables what a shared build needs: `main.rs:1227-1228`
  `engine_config.wasm_threads(true); engine_config.shared_memory(true);`
- `wasmtime-50.0.2/src/config.rs`: Cranelift marks `THREADS` unsupported only
  for Pulley (`:2491-2493`) and for Aarch64-under-Winch (`:2525`). x86-64 Windows
  is in neither set, and our tree has no `cfg(windows)` around threads
  (`grep -rn 'cfg!(windows)' tension-core/src/` → nothing for this path).
  **Inferred:** threads should work on Windows; that is a prediction, not a
  measurement.

### Also measured (cheap, and it was already there)

`cargo test --lib thread::tests::a_pool_spawns_a_real_thread_over_the_shared_memory`
— **1 passed** in 0.02 s. That test compiles the in-repo `WORKER` fixture, spawns
a real thread over a `SharedMemory`, and reads the worker's word back with
`AtomicI32` (`thread.rs:628-726`).

---

## D — why the Promise build does not run `main`

### 1. Does the same Promise build run correctly on Linux? **No. It fails identically.**

```
$ ./tension-core/target/release/tension-core /tmp/ap1/game-promise.wasm
2026-11-22T00:28:07.xxx INFO  core: async backend: continuations (wasmtime stack switching)
2026-11-22T00:28:07.xxx INFO  core: res: writing under /home/acakar/work/Tension
exit=0
```

No transcript. Exit 0. Exactly W3's Windows observation, on the platform where
the engine *does* support continuations. **The platform is not a variable in this
defect.**

### 2. It does not differ by platform; it differs by build

| build of `examples/async-on-main/game.ts` | exports | `main` call sites | output |
|---|---|---|---|
| stackful (`--enable stack-switching`) | `__asyncStatus __asyncPump $starts __start …` | **1** (`$~asyncMainStart`) | full transcript |
| Promise (no `--enable stack-switching`) | `main _start_game memory __start` | **0** | nothing, exit 0 |

`main` has **zero call sites in the Promise build**. Nothing in the module can
start it.

### 3. Where the entry call is made

Host side, `tension-core/src/main.rs`:

- `:1580` — `__start` is called as `() -> ()` when the guest exports that
  signature; this runs the module's boot body (`~lib/rt` init) and, when a shell
  was emitted, the shell.
- `:1713` — `_start_game` is called next, else `:1715` `_start`.
- `:1719-1728` — if the guest exports neither, and `__start` ran, the host logs
  "the module booted through `__start` and exports no `_start_game`/`_start`;
  nothing left to run" and returns `Ok`.

In the owner's example `_start_game` exists but is **`nop`** — it is `(func (;184;) (type 4) nop)`
in the Promise build, and the program says so:

```ts
// examples/async-on-main/game.ts:100-107
/// The host's entry export.
/// **It is empty, and that is the point of the showcase.** With `--exportStart
/// __start` the compiler puts the boot body and the core loop in `__start` …
export function _start_game(): void {}
```

So the host does exactly what it is told: run `__start` (boot body only), then
call the program's empty `_start_game`. Exit 0.

Compiler side — the mechanism:

- `TensionScript-a2/src/transforms.ts:220` sets `program.hasAwait = true` for an
  `Await` node **anywhere in the program's sources**. `latchAsyncUsage`
  (`transforms.ts:93-98`) walks `program.sources`, which includes library modules
  the program imports; **reachability is not consulted**, and the comment says so
  (`transforms.ts:76-90`).
- `TensionScript-a2/src/compiler.ts:897-902` `shouldEmitAsyncShell()`:

```ts
if (program.hasAwait) {
  return this.asyncShellSuspends && this.mainFunction != null;   // :898
}
if (!program.hasAsync) return false;
return this.mainFunction != null;                                 // :901  (A1)
```

- `compiler.ts:1497`: `asyncShellSuspends = program.hasAwait && options.hasFeature(Feature.StackSwitching)`.

So for a **Promise** build of any program whose source set contains an `await`:
`hasAwait` true → `asyncShellSuspends` false (no `--enable stack-switching`) →
`shouldEmitAsyncShell()` false → **no shell at all** → `__start` is the boot body
only → `main` is never called. The A1 shell (the branch at `:901`, which *does*
run an async `main` that never suspends) is unreachable for such a program.

The backend choice itself is `transforms.ts:351-357`: `hasAwait &&
StackSwitching` → `StackfulAsyncTransform`, else `AsyncLowerTransform`.

### 3b. The isolation, on one variable

Two programs that differ only in the import path of `print`:

| probe | import resolves to | Promise build runs `main`? |
|---|---|---|
| `promise-main-framework.ts` | `tension-framework` (index) | **no** — silent |
| `promise-main-io-only.ts` | `tension-framework/assembly/io` | **yes** — prints `io only: main ran` |

The index re-exports `./2d` (`tension-framework/assembly/index.ts:14`), whose
`scene.ts:1036` contains `await rt.frame();`. `io.ts` contains no `await`
(`grep -c "await " io.ts` → 0). So **one `await` in an imported library file,
in code that is never called, is enough** to switch this program off in a Promise
build. The same framework-importing probe built with `--enable stack-switching`
prints (`main-framework-stackful` in the transcript).

### 4. The emitted module, explicitly

- Is `main` exported? **Yes** — `(export "main" (func 301))`.
- Is `__start` present? **Yes** — `(export "__start" (func 245))`, and its body
  is the boot guard plus one call (`global.get; if; return; end; i32.const 1;
  global.set; call 72`, where 72 → 71 is the runtime initializer). It does not
  reach `main`.
- What does the Promise backend do with an `async main`? It lowers `main` into
  the task-graph form (`AsyncLowerTransform`) and leaves it **unrooted**: there
  is no `$~asyncMainStart` wrapper (that is emitted only by
  `prepareAsyncStackShell`, `compiler.ts:1201`), so no code refers to `main`, and
  the module has no root task to run.

`async_backend.rs:30-35` already records this as a known gap in prose: "a
Promise-compiled `async function main` does not run end to end yet — that gap is
a TensionScript round, not this host's." The measurement here says the same
thing more sharply: it is not "does not run end to end", it is **does not start**.

### 5. Is it a small fix?

Not diagnosed to that level here, and out of scope (no compiler changes this
round). But the shape is now precise: for a Promise build with `hasAwait` and an
exported `main`, the compiler emits neither shell, so nothing calls `main`. The
narrow question a fix round must answer is **which shell a Promise build with
`main` should get** — the A1 shell's root-task path (`emitAsyncShellStart`) is
already written and already runs an awaitless async `main`; whether it can also
run a `main` that awaits is the design question (the A1 comment says "A1 is the
shell without suspension; a program with an `await` belongs to Backend A").

---

## What I did not verify

- **Windows, anywhere.** No host reachable. B's "does it actually run once the
  gate is lifted", C's thread probe, and D's Windows reproduction are all
  untested here. D's Linux result makes D platform-independent, so that one is
  covered by inference from a measurement.
- **The compiler used is the installed dist (`d297c3a1`), built from
  `main @ 41b8721b` + the DWARF patch**, not the checkout's declared pin
  (`g41b8721b`) — which is not vendored on this machine (§0). The compiler
  source lines cited are from `fix/dwarf-prologue @ c8fd330b`, whose
  `src/compiler.ts` and `src/transforms.ts` are unmodified relative to `main`.
- **The `hasAwait`-from-library-code claim** is: measured as a behavioural
  difference between two import graphs (table in §3b), *inferred* to be
  `transforms.ts:220` from reading. No instrumentation was added to confirm which
  node sets it.
- **The A1 vs Backend-A boundary** for a `main` that awaits is read from the
  comments and the code, not from a run of a Promise build with a suspending
  `await` that also has a shell. No such build exists to run.
- **Whether Cranelift's `update_windows_tib` actually runs** a continuation on
  Windows. The setting exists and is documented; nothing exercises it.
- `cargo test --test threads` was **not** run successfully: it fails at
  `build-test-programs` for the pin reason in §0, not for a thread reason. The
  thread measurements here are the hand-written probe plus the in-crate pool
  unit test.
- Assumed: `$TENSIONSCRIPT` overriding to the installed dist is acceptable for
  probes (the toolchain documents it as the escape hatch and prints a warning);
  no repository source was changed to make any probe build.
