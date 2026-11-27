# DL53 — `~spawnIndex` has no body

**One defect, found, fixed, and proven able to go red.** `$~spawnIndex/<fn>$spawnStart` was
emitted for any async function with an `await` and given a body only when the program's *entry*
was async. The fix keeps the promise the emitter had been making since it was written.

```
TensionScript  feat/dl53-spawn-index @ 7922bba4   CI 16/16 (45914407154)
Tension        feat/dl53-spawn-index @ e607c26    (gitlink + re-vendor; corpus unchanged)
both `main`s untouched
```

---

## 1. Phase 0 — the gap, located

### The two paths, quoted

`builtin_async_spawnIndexOf` (`src/builtins.ts:12563`) compiles a call and records the helper:

```ts
  compiler.spawnIndexTargets.set(helper, spawnName);
  return module.call(helper, [], TypeRef.I32);
```

`emitStartsTable` (`src/compiler.ts:1964`) adds that helper's body — `i32.const <index>` — once the
index is final, appending every recorded target to the `$starts` list:

```ts
    for (let _names = Map_keys(helpers), …) {
      module.addFunction(helper, TypeRef.None, TypeRef.I32, null, module.i32(index));
    }
```

### What suppressed the body

`emitStartsTable` had exactly two callers, both in `compile()`:

```
2469:          this.emitStartsTable();      // inside  if (this.asyncShellStartReady)
2491:      this.emitStartsTable();          // inside  if (!this.asyncShellSuspends && this.workerExported)
```

`asyncShellStartReady` is set only by `prepareAsyncFiberShell` / `prepareAsyncStackPrologue` — both
of which return early unless a root exists — and the shell is entered from `shouldEmitAsyncShell`:

```ts
    if (program.hasAwait) {
      return program.hasAsyncMain;      // ← only a program whose ENTRY is async
    }
```

Meanwhile the *guard* in the builtin accepted programs on a different predicate:

```ts
  if (!compiler.asyncShellSuspends && !(compiler.options.sharedMemory && !compiler.gcActive)) { error… }
```

`prepareFiberPrologue` sets `asyncShellSuspends`/`asyncShellPrepared` for **any** fiber build with an
`await`, so an async helper is compiled and its factory emits the call — but a program with a **sync**
entry never reaches line 2469, and line 2491's `workerExported` is false. Recorded, never bodied.

**Two predicates, one promise.** That is the defect's shape, not its trigger.

### The symbol's construction

`"~spawnIndex/" + target.internalName` — built and consumed in the same function
(`builtins.ts:12614` → `12657`), and the body is written from the same map, so the name is not
reconstructed at the point of use. The `$spawnStart` half is *not* reconstructed either: the entry is
resolved through `program.elementsByDeclaration` from the declaration the transform recorded
(`asyncSpawnStarts`), with a diagnostic if it cannot be resolved. This is **not** the I24 class — the
name is not a convention decoded elsewhere; the *emission* is.

### The reproduction

`tests/compiler/stackful-sync-entry-spawn-index.ts`, compiled under `fiber`:

```
[wasm-validator error in function stackful-sync-entry-spawn-index/pump] unexpected false: call target must exist, on
(call $~spawnIndex/stackful-sync-entry-spawn-index/pump$spawnStart)
FAILURE validate error
```

Three lines of program: `async function leaf()`, `async function pump()` which awaits it, and a
**sync** `_start_game` that calls `pump()`.

---

## 2. Phase A — the fix

**Emit the body, and emit it whenever something asked.** Not "emit the call only when the body is
emitted": refusing a sync entry that calls an async function would trade a false validator error for
a false diagnostic, and `promise` already builds that program. The call is legal; the table was
missing.

- `startsTableEmitted: bool` makes `emitStartsTable` idempotent, so the two callers cannot fight.
- The tail gate becomes `if (this.workerExported || Map_keys(this.spawnIndexTargets).length > 0)`.

Placed at the tail because the index is final only once every reachable body has been compiled, and
gated on "someone asked" so a program that names no index is **byte-for-byte** what it was.

The validator was not silenced.

**Byte-identity, declared before the run:** the fix only adds a function that did not exist, so the
prediction was *no artifact moves* — mine if nothing in the corpus hit the shape, and I expected
nothing to, since the corpus's async programs all have async entries. Measured:

```
artifacts whose BYTES changed: 0 of 35
fixtures re-pinned:            0
--check:                       15 current (13 bytes, 2 dwarf)  PASS
```

The corpus has four programs with a sync entry and an `await` (`async/rt-guards`,
`conformance/promise-fallback`, `thread/two-waiters-late`, `thread/wake-on-worker`); none of them
calls a parameterless async function, so none recorded a helper.

---

## 3. Phase C — the test DL52 could not write

`tests/compiler/stackful-sync-entry-spawn-index.{ts,json,js}`, asserted on the artifact:

1. the build succeeds (the regression itself);
2. `$starts` is present;
3. `backend=fiber`, `target=portable` in `tension.requires`;
4. **no `__asyncPump`** — the fix adds the table, not a shell;
5. exactly one start section.

**Red case, on the pre-fix compiler** (`2a28a3b4`, built in a worktree):

```
=== PRE-FIX compiler (must fail) ===
[wasm-validator error in function stackful-sync-entry-spawn-index/pump] unexpected false: call target must exist, on
  FAILURE validate error
```

**Green after** — `[ SUCCESS ]`, and the fixture runs inside `npm run test:compiler`
(`# compiler/stackful-sync-entry-spawn-index`), suite `[ SUCCESS ]`, CI 16/16.

### Does an async `_start_game` compile now?

**Yes.** On `2a28a3b4` the same program failed with the same validator error; on `7922bba4` it builds
(fiber, 8,991 bytes). That is the same defect, not a second one — patch one shape, both work.

**But it does not run, and that is the second finding** (§6).

---

## 4. Phase B — the corpus without declarations

Eight examples carry `--stackful-backend promise`. With **all eight removed**, on the fixed compiler:

```
build-examples: 6 of 22 example(s) failed        exit 1
  6 of 22 failed: ogre/{animated-character,bouncing-ball,bouncing-bodies,hello-mesh,hello-triangle,input-camera}
  reason, identical in all six: AS100: Not implemented: an async method (the stackful backend)
```

**16 of 22 build under `auto` (= fiber)** — `async-io` and `platform-control` advanced past the
`$spawnIndex` failure exactly as DL52 predicted. The residue is **one cause, not two**: the six
`async run(): void` methods, which is DL52's already-named, already-declared lowering gap.

### The decisions the declarations stay

The two that now build were tested for *running*, not just building, and they do not run:

```
examples/async-io, fiber, declarations removed:
  build: ok
  artifact: __asyncPump 0, asyncMainStart 0, $starts 1, NO start section
  run: printed nothing; killed at 120 s
```

A sync entry under a stackful backend gets **no starter at all**: `asyncShellSuspends` is true, so
the ordinary start body is suppressed, and `shouldEmitAsyncShell` says no shell — an empty start
section and a guest that never runs. Declaring `fiber` there would ship an example that hangs, which
is worse than one that declares a portable non-fibre backend.

So: **all eight stay, and the reason is now measured rather than assumed.** Removing two of them is
correct only after the starter gap in §6 is closed. Nothing in `examples/` changed this round.

---

## 5. Gates

| gate | result |
|---|---|
| compiler suite | `[ SUCCESS ]`, new fixture listed |
| TensionScript CI | **`45914407154` — 16/16**, no failures |
| `build:examples` | **22 of 22, exit 0** |
| `--check` | **10/10 links PASS**, every row (below) |
| second chain run | **`0 built, 35 up to date`** |
| threads · fiber · fiber-executor · fiber-runner | **15 · 6 · 7 · 5** |
| async_on_main · async_main_promise · debugger | **2 · 2 · 5** |
| `--bin` default · audio-only | **307 · 298** |
| program artifacts changed | **0 of 35** |

```
compiler: src → dist/assemblyscript.js        159 inputs → 0488a06e168c    PASS
compiler: dist → installed                    4c9ae8f1318b (tree)         PASS
compiler: std mirror (no compile reads it)    81 files identical          PASS
runtime: src → release                        84 inputs → c3c82a76c21f     PASS
runtime: src → debug                          84 inputs → c3c82a76c21f     PASS
fixtures: committed .wasm -> build            15 current (13 bytes, 2 dwarf)  PASS
guests: tests/programs/**/*.ten → build        35 current                  PASS
guests: built by the installed compiler       70 of 70 current             PASS
guests: read set vs .debug_line               35 of 35 agree              PASS
docs: docs/abi/*.md                           current                     PASS
```

**Three examples run**, and the fibre one is identified by its own declaration:

| example | `tension.requires` | output |
|---|---|---|
| `solver/world` | `backend fiber target portable features [] — met` | `match: \|err\| = 6.599878976665252e-11` |
| `io` | `backend fiber target portable features [] — met` | `=== TensionCore demo game ===` … `You said: hello from the terminal` … `--- end ---` |
| `ogre/hello-triangle` | `backend promise target portable features [] — met` | `rendered 342 frames, 42050 non-background pixels, mean rgb 229/51/51` |

---

## 6. The second finding — an async root is not a root

Asked to build the shell for a root that is itself async, the tree gives three separate answers that
disagree:

1. **`latchAsyncEntry` (`src/transforms.ts:120`) compares the name to `main`.** `hasAsyncMain` is
   never set for `export async function _start_game`, so `shouldEmitAsyncShell` says no shell.
2. **The async `_start_game` is a task factory.** It compiles and is exported, but its signature is
   not `() -> ()` — and `tension-core/src/main.rs:2753` looks it up as
   `get_typed_func::<(), ()>`, so the host refuses with `game.wasm did not export _start_game or
   _start` even though the export is right there.
3. **No `__start` boot body exists to fall back on**, because of (1).

Measured, on the fixed compiler:

```
exports: __asyncStatus, _start_game, memory, $starts
__asyncPump 0 | asyncMainStart 0 | start section False
run → Error: game.wasm did not export `_start_game` or `_start`
```

**Why the obvious fix is wrong, measured.** I tried giving *any* fiber build with an `await` the
shell (`shouldEmitAsyncShell → fiberBackendActive`). `async-io` then got `__asyncPump`,
and its run got *further and broke differently*:

```
session_open -> -16 (session_open is refused in state Ready: the guest must close first)
async-io: the session refused to open (-16)
```

The shell called the sync `_start_game` through `main$start`, and the host called it again — the
guest ran twice. So the correct shape is narrower: **the shell only when the resolved root is the
async declaration itself** (`program.asyncEntries.has(mainFunction.declaration)`), which also makes
the host's `() -> ()` lookup fail and skip the double call. I did not land that change — it needs
the host's entry rule and the shell's to be settled together, and a partial version is not a fix.

**Not in the corpus today**: no example exports an `async _start_game`; all 27 export a *sync* one
with awaits reachable underneath. So this blocks nothing shipped, and it is the gate on removing
the last eight declarations.

---

## 7. What the tree contradicted in this brief

- **"the eight `promise` declarations" were not all the same problem.** Two of them (`async-io`,
  `platform-control`) were the `$spawnIndex` defect and now build under fiber; six are the
  async-method lowering. The fix removes a *build* failure from two and a *run* failure from none.
- **The three-line reproduction was the whole defect**, but the brief's framing — "the helper body
  never appears for a non-entry async function" — is precise only with the predicate named:
  *non-entry* is not the trigger. **Sync entry** is: an async entry builds fine, because that is the
  one case where the table was emitted.
- **`--check` reads 5 UNKNOWN rows unless `TENSIONSCRIPT_DIR` names the checkout.** The default is
  `../TensionScript`, which does not exist on this host, so the compiler identity, the two installed
  rows and the DWARF comparison all degrade to UNKNOWN/STALE — and the fixture row then says
  "DWARF shape DIFFERS", which reads like a real regression. It is not; it is the same check on a
  missing path. My first run of this round hit exactly that and I re-ran it with the variable set.

## 8. What I did not verify

- **Windows and macOS.** The fix is a pure emission change and the artifacts stay portable, but
  nothing was run there.
- **The async-`_start_game` run** (§6): compiles, does not run; the correct fix is sketched and
  deliberately not landed.
- **`examples/async-io` under fiber does not run**, and I did not chase it past establishing that the
  cause is "no starter at all", not the `$spawnIndex` defect. It is the same §6 gap.
- **The sync-entry-with-await shapes** (`async/rt-guards` etc.) were checked for artifact identity,
  not for whether they *should* be getting a shell on fiber — that is §6's question.
- **Nothing on the marketplace**, no `.vsix`, no editor. This round touched no extension code.
