# DL62 — a suspending `async` method lowers on fiber; the eight declarations stay, with reasons

**The lowering is done and proven. The declarations did not come off — and that is the
measured result, not a shortcut.** With all eight removed the corpus builds **23 of 23**, so
I126's compile-time gap is closed; but none of those eight examples *runs* on fiber yet, for
two causes that are not this round's.

```
Tension        feat/dl59-ready-queue  e28b6de   clean   CI success (46092798075)
TensionScript  feat/dl59-ready-queue  70ae8944  clean   CI success (46094995708)
```

---

## 1. Phase 0 — the dependency, re-verified

`spawn-ready` still prints `entry / ran 1 / ran 2 / ran 3`, and `--check` was **10/10** before
any edit. I95 stays closed.

## 2. I141 — already fixed, and the Windows number

The matcher was **not** stale in `dadd134`: WIN28's `995673a` ("threads: the refusal matcher
asserts the current contract, not pre-DL51's") is in `main`, and it asserts the reason
(`this guest requires `), the act (`refusing by name`), **exit 2**, empty stdout, and the
platform phrase. So decision 5's work was already done; what this round owes is the two
numbers.

- **Linux, measured here**: `test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured;
  0 filtered out; finished in 3.55s`
- **Windows**: `15 passed` — from `995673a`'s own commit message, which records
  "Measured with the same file on both hosts: 15 passed on Windows, 15 on Linux". **I did not
  run Windows in this round.** `Tension/.github/workflows/e2e-debug.yml` has a single
  `runs-on: ubuntu-latest` and no Windows matrix, which is *why* the number has been missing
  for three rounds: nothing in this repo's CI can produce it. WIN28 measured it on the
  Windows host and wrote the number into the commit.

No further Windows failure was found in that commit, so there is no hidden real defect behind
the matcher change to report.

## 3. The lowering: the shape, and why the tree pointed there

The refusal was narrower than its message: only a **suspending** method was refused; one
without an `await` had its modifier cleared. So the gap was exactly "a method body that must
survive a suspension".

The brief proposed lifting the body to a top-level function whose first parameter is the
receiver, plus a `this` → `$self` rewrite. **The tree supports a cheaper shape**, and I took
it: keep the body a **member** of its class.

```
class Counter {
  async run(id: i32): void { … await leaf(id); this.count += value; … }
}
  ⇒ class Counter {
      run$body(id: i32): void { … await leaf(id); this.count += value; … }   // a member
      run(id: i32): Task<void> { let $rec = new Counter$run$Rec(this, id); … }  // the entry
    }
    class Counter$run$Rec extends Task<void> { $p0: Counter; $p1: i32;
                                               drive(): void { … this.$p0.run$body(this.$p1) … } }
    function Counter$run$Start(): i32 { … $rec.$p0.run$body($rec.$p1) … }
```

Why this rather than the proposed one:

- **No `this` rewriting at all.** A `$self` rewrite would be a walk over every node kind that
  can hold an expression, and it would still miss a closure that captures `this` — the case
  the brief's own second fixture is about. Keeping the body a member makes `this` mean what it
  always meant, in the body and in every arrow inside it.
- **One list.** `[receiver?, …parameters]` drives the record's fields, its constructor, the
  drive body's arguments and the entry's constructor arguments, so the four cannot disagree.
- **Names carry the class** (`Counter$run$Rec`), because two classes may both declare
  `async run()`. Artifacts are filed **beside** the class declaration, so a nested class's
  record still resolves its own name in its own namespace.

`compileExpressionStatement` also now recognizes a **method** call in statement position —
`c.run(1);` is a spawn — matched through the resolved element's *declaration*, not its name
(`Foo.run` and `Bar.run` are different members with one spelling).

**Refusals, all by name:**

- an async **accessor**: `an async accessor (the stackful backend)`;
- an async method on a **generic** class: `an async method on a generic class (the stackful
  backend)` — the receiver field would need `C<T>` forwarding this transform does not build;
- an async **arrow in a field initializer**: `an async function expression with an await (the
  stackful backend)`.

That last one is a finding of its own. It was previously refused as
`async arrow functions (async lowering)` — naming no backend, for a program the stackful
transform never saw. The cause: `latchAsyncUsage` (`transforms.ts`) never scanned a **class
field's initializer**, so `hasAwait` stayed false for a program whose only `await` lives in
one, and `applyInTreeTransforms` selected the *generic* lowering. Field initializers are
scanned now, so the right transform sees the program and refuses it in its own words. No
shipped artifact moves: the only programs this reaches are ones that were already refused.

## 4. The fixtures, and the red case

`probe/async-method.ten` — `this` read **after** the await and accumulated:

```
ctr before 1
ctr after 10
```

`probe/async-method-closure.ten` — `this` captured by arrows declared **after** the await:

```
closure reads 7
closure wrote 9
```

`async_method.rs` asserts each twice — the artifact (`scheduler::ready` imported, `__driveSlot`
exported, `backend=fiber` declared) and the transcript — plus ten identical runs. Committed as
`fixtures/fiber/async-method*.wasm` and added to **Stackful proofs**, so CI runs the gate with
no compiler.

**Red, same file, same flags, pre-change compiler:**

```
ERROR AS100: Not implemented: an async method (the stackful backend)
 46 │ async run(id: i32): void {
    │ ~~~~~~~~~~~~~~~~~~~~~~~~~~
exit 1
```

**Green after:** exit 0, transcript above.

## 5. The declarations: removed, measured, and put back

With all eight `--stackful-backend promise` flags removed:

```
build-examples: 23 example(s) built        exit 0
```

— so the corpus now compiles on the default (fiber) backend with **no** declaration. That is
I126's actual claim, and it is banked as evidence even though the flags return.

Running them, fiber vs their `promise` transcripts:

| example | fiber | why |
|---|---|---|
| `ogre/animated-character` | exit 0, **no output** | `resources/models/characterMedium.mesh did not load (errno -5)` |
| `ogre/bouncing-ball` | exit 0, **no output** | `…Barrel.mesh did not load (errno -5)` |
| `ogre/bouncing-bodies` | exit 0, **no output** | `…cube.mesh did not load (errno -5)` |
| `ogre/hello-mesh` | exit 0, **no output** | `…Barrel.mesh did not load (errno -5)` |
| `ogre/hello-triangle` | **rc=124** | stalls right after `requesting a swapchain rebuild` |
| `ogre/input-camera` | rc=124 | hangs under `promise` too — the known hang |
| `platform-control` | rc=1 | its own assertion: `the host never applied the resize within 10 frames` |
| `async-io` | rc=1 | `Unexpected 'null'` at `~lib/task.ts:405` |

`-5` is `-EIO` (`session/mod.rs:82`) — the code an in-flight session job is swept to on a
fatal fault. The volume itself mounts fine on both backends (`res: mounted "resources/" …`
is identical in both transcripts); it is the **mesh job** that fails.

**Two causes, neither the method lowering:**

1. **Session/ogre jobs return `-EIO` on fiber.** `async-io` is the cleanest evidence:
   it has **no async methods at all** (one `await compute(20)` between free functions) and
   fails the same family of way. Its fiber path is untouched by this round.
2. **The frame/render loop.** `hello-triangle` and `platform-control` both live on
   `await rt.frame()`; one stalls at a swapchain rebuild, the other counts ten frames without
   the host applying a resize.

Both predate the change. Built with the **pre-DL60** compiler, `async-io` on fiber prints
`session_open` and then nothing — it was already broken there. So decision 2's escape clause
applies per example, and all eight keep their declaration.

**What did NOT change:** with the flags restored, every one of the seven runnable examples
produces **byte-identical guest output** to its pre-change `promise` transcript (normalising
the random temp-pack path). `ogre/input-camera` hangs before and after — named, not chased.

## 6. Gates

| gate | result |
|---|---|
| `--check` (`TENSIONSCRIPT_DIR` set) | **10/10 links PASS**, delta **none** |
| threads · fiber · fiber-executor · fiber-runner | **15 · 6 · 7 · 5** |
| async_on_main · async_main_promise · debugger | **2 · 2 · 5** |
| park_frame · input_sources · spawn_ready · async_method | **2 · 1 · 3 · 4** |
| `--bin` | **311 passed** |
| `build:examples` | **23 of 23**, exit 0 |
| `run:examples` | **16 ran · 1 hung · 1 refused** — unchanged |
| CI | Tension **success** `46092798075` · TensionScript **success** `46094995708` |

**The artifact delta was declared as `none` before measuring, one row moved, and the cause
was found rather than accepted.** `debug/main-policy.wasm` shifted 15 bytes in `.debug_line`
and `.debug_ranges`, with the code and symbol sections byte-identical. Cause: this round's
refactor handed the start function's argument nodes the **function's** source range instead
of each parameter's own, and DWARF attributes instructions through those ranges. Restoring
per-node ranges returned every artifact to its committed bytes: 10/10, nothing regenerated.

## 6a. One CI red, quoted: the self-host refused my own code twice

The first push of this round turned **Bootstrap (debug)** red (`46092794660`):

```
ERROR TS2322: Type '~lib/array/Array<src/ast/TypeParameterNode> | null' is not assignable
              to type '~lib/array/Array<src/ast/TypeParameterNode>'
   1103 │ if (declaration.typeParameters != null && declaration.typeParameters.length != 0) {
ERROR AS100: Not implemented: Interface hidden classes
```

Both are my own new code, refused by a compiler that is the shipping one:

- **`interface MethodLift`** — the self-host does not accept an interface in that position, so
  it is a **class** with a constructor now (which is the shape the transform already uses).
- **the null narrowing** — the self-host does not narrow a nullable *property* across `&&`;
  binding it to a local first (how `transformFunction` already writes it) fixes it.

Fixed and both `bootstrap:debug` **and** `bootstrap:release` run locally before re-pushing:
exit 0 each, and this repo's own suite afterwards reports zero `fixture mismatch`. This is the
second round in a row where the bootstrap caught a class of error `node scripts/build` cannot
see — it compiles the tree with *itself*.

## 6b. What Tension's CI does and does not check

`e2e-debug.yml` has one job on `ubuntu-latest`, initialises only the `ImageViewer` submodule,
and **runs neither `scripts/rebuild.mjs --check` nor any compiler build**. So:

- the "10/10, delta none" row above is a **local** measurement with
  `TENSIONSCRIPT_DIR=~/work/TensionScript-a2` — which is how this project has always verified
  it, and it is the only place the fixture bytes are compared against a fresh build;
- the two new `fixtures/fiber/async-method*.wasm` were produced by **this branch's** compiler,
  so a fresh clone on the vendored pin would report them behind until the pin is bumped with
  the branch. That is the same arrangement `spawn_ready` landed under in DL61; it is worth
  saying out loud because "CI is green" does not cover it.

## 7. What the tree contradicted in this brief

- **"Its async-method path works" (continuation, decision 3).** It did not exist: the same
  `AS100` refusal was backend-independent, so *no* stackful backend lowered an async method
  before this round. The lift now gives continuation one too, and the shape it produces there
  inherits a pre-existing defect: `export async function main(){ await run(1); }` with
  `run` itself awaiting prints `before / after 0` **twice** on continuation — measured
  identically with the pre-change compiler and with a plain *free* async function, so it is
  not method-specific and not this round's. It is I126-adjacent (nested awaits through
  `main`), and I am naming it rather than fixing it.
- **"I141's matcher is still stale."** It was fixed in `995673a`, already in `main`.
- **The brief's proposed lift shape.** The tree supports the cheaper one above; the `$self`
  rewrite would have been strictly more code for the same result, and weaker on the closure
  case the brief itself asks for.
- **An unrelated observation, not touched:** `src/compiler.ts:11564` contains a stray
  `console.log('DEBUG arity: …')` that predates this round (`d56db162`). It is noise in a hot
  path and worth deleting in a rename-free round.

## 8. What I did not verify

- **Windows.** `threads` on Windows is `15 passed` **quoted from `995673a`**, not run here;
  this repo's CI has no Windows runner.
- **Why a session job returns `-EIO` on fiber.** Named, narrowed to "the mesh job, not the
  mount, and not the method lowering", not explained. That is the next round's subject if the
  OGRE examples are to leave `promise`.
- **`ogre/input-camera`'s hang** — in the census before and after; not chased (out of scope).
- **The `async`-arrow-in-a-field refusal is not a CI gate.** It is measured and quoted, but no
  automated test asserts it: the compiler is not installed in Tension's CI, and TensionScript's
  own suite has no case for it yet.
- **macOS.**
