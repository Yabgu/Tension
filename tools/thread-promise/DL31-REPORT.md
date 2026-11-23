# DL31 — the spawn entry is recorded where it is created

**Round:** DL31, 2026-11-23. One compiler change: `__spawnIndexOf(anAsyncFunction)`
answers the `f$spawnStart` the lowering built, not the factory `f`.

**Bundle:** `aa74d6a1` → **`3ef8a8f4`**. Compiler commit `41a972e1` on
`fix/dl31-spawn-entry-record` in `TensionScript-a2` (branch, not `main` — `main` is
production). Harness commit `21be9ed` on `integration/dwarf-debug`.

---

## 1. Phase 0

| | |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`33a821a`**, `git status --porcelain` empty, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | installed `dist/assemblyscript.js` = **`aa74d6a1`** |
| binary | 33 653 336 B @ **2026-11-23 18:56:30**; newest `tension-core/src` @ 18:56:00; **0 newer** |
| lockfile | `package-lock.json` clean; no `npm install` ran |

---

## 2. Declared before the first run

- **Bundle: unknown, expected to differ.** A match would mean the change did not land
  where I thought it did. It moved — §4.
- **Test:** `an_async_worker_entry_is_served_as_its_spawn_entry` in
  `tension-core/tests/threads.rs`, guest `programs/thread/spawn-entry-async.ts`, fixture
  committed with the bundle that built it and the `.gitignore` negation checked
  (`.gitignore:73`, `!tension-core/tests/programs/fixtures/thread/*.wasm`).
- **Counts:** `--test threads` **8 → 9**; `Wake path guard` filter **3 → 4**;
  `--bin` 307, census 71/11, `test:compiler` 0 skips, fiber 6, fiber-executor 7 unchanged.

**Not declared, because I did not foresee it** — two additions, both forced by measurement
and both argued in §7: a new fixture resolver, and a deadline in the test.

---

## 3. The three code sites

### 3.1 The record — `src/program.ts:580-604`

```ts
spawnEntries: Map<DeclarationStatement,DeclarationStatement> =
  new Map<DeclarationStatement,DeclarationStatement>();
```

**Delta from the brief, declared:** the brief specifies `Map<FunctionDeclaration, string>`
and a *string* value. A string cannot work, and I have the crash to prove it (§8, bug 1).
The transform runs at `afterParse`, before any element exists, so **no internal name
exists yet** — which is precisely what `asyncSpawnStarts`' own comment says about the
declarations it holds:

> `// The declaration, not the name: the compiler resolves it after`
> `// initialization, when the internal name exists.`

So the value is the **spawn entry's declaration**, resolved later through
`elementsByDeclaration`. The key is `DeclarationStatement` rather than
`FunctionDeclaration` because that is what `prototype.declaration` and
`elementsByDeclaration` are typed as — no cast at either end, and both sibling
collections (`asyncSpawnStarts`, `asyncEntries`) already key on it.

### 3.2 The write — `src/async/stack.ts:801-808`

Added at the site that creates the spawn entry (Gate 3d), immediately after
`artifacts.push(spawnFunction)` and before the existing `asyncSpawnStarts.push`:

```ts
this.program.spawnEntries.set(declaration, spawnFunction);
```

Nothing else in the transform changed; the collision check is untouched.

### 3.3 The read — `src/builtins.ts:12486-12502`

Replaced exactly one line:

```ts
-  compiler.spawnIndexTargets.set(helper, target.internalName);
+  let declaration = target.prototype.declaration;
+  let entries = compiler.program.spawnEntries;
+  let spawnName = target.internalName;
+  if (entries.has(declaration)) {
+    let element = compiler.program.elementsByDeclaration.get(assert(entries.get(declaration)));
+    let spawnFunction: Function | null = null;
+    if (element) {
+      if (element.kind == ElementKind.Function) spawnFunction = <Function>element;
+      else if (element.kind == ElementKind.FunctionPrototype)
+        spawnFunction = compiler.resolver.resolveFunction(<FunctionPrototype>element, null);
+    }
+    if (!spawnFunction) {
+      compiler.error(DiagnosticCode.Not_implemented_0, ctx.reportNode.range,
+        "the spawn entry this async function's lowering recorded cannot be resolved (a compiler bug, not a program error)");
+      return module.unreachable();
+    }
+    spawnName = spawnFunction.internalName;
+  }
+  compiler.spawnIndexTargets.set(helper, spawnName);
```

**Membership decides plain-versus-transformed**, exactly as the brief requires: no entry →
the function is its own spawn entry (`__workerMainPlain`). A recorded entry that fails to
resolve is a **diagnostic**, never a silent fallback to `target.internalName` — a miss
cannot masquerade as "this is a plain function".

No string operation, no suffix constant, no name comparison. The written name is only what
finds the `target`; the answer comes from the recorded relationship.

`emitStartsTable` (`src/compiler.ts:1660-1704`) is **unchanged** — it appends the name it is
handed and answers that name's index, as before.

---

## 4. The segment and the answer

`ans2.ts` — one async entry and one sync entry, both named:

```
api(workerEntryAsync)=3
api(syncEntry)=4

elem $$starts$elem (table $$starts) (i32.const 0) func
  $ans2/workerEntryAsync$start $~asyncMainStart $~lib/async/__coreloopAwait
  $ans2/workerEntryAsync$spawnStart $ans2/syncEntry
```

Index 3 is `workerEntryAsync$spawnStart`; index 4 is the plain function answering **its own**
index. Before the fix the same source answered **4** — which is the factory — and 4 is where
`syncEntry` now sits.

**Bundle:** `npm run build` → `dist/assemblyscript.js` = **`3ef8a8f4`** (from `aa74d6a1`).

---

## 5. End to end — the worker runs its body

`programs/thread/spawn-entry-async.ts`, `THREAD_FLAGS` (which include
`--enable stack-switching`), fixture 27 666 B `62e2460568f500a7…`. Termination is the
committed `wake-on-worker` shape in the sense DL29/DL30 both paid for: the **body** stops the
executor (`__executorExit(1)`) *after* printing, and main only joins. Main calling
`__executorExit` right after spawning is what killed the worker before it could serve, which
is how DL29 reported index 3 as producing nothing.

```
main: spawnIndexOf=3
main: spawn=0
worker: entered (async entry)
worker: AFTER the await, value=0
INFO  thread: executor 1 exports no `__taskWake`, so it serves no wake path; …
INFO  thread: executor 1 left the park seam having recorded 0 park(s)
main: join=0
main: done
EXIT=0
```

Nothing stranded, no refusal, no `detached`. Element segment for this build is 4 entries —
`[0] $start · [1] ~asyncMainStart · [2] coreloop · [3] $spawnStart` — and the answer is 3.

Same run with the pre-fix compiler: `main: spawnIndexOf=4`, `main: spawn=0`, **no worker
line**, and `EXIT=124` — it does not exit, because main joins a worker that was never served.

---

## 6. The alias gate — **not met**, and it cannot be met in this round

The brief requires: *"`let g = workerEntryAsync; __spawnIndexOf(g)` answers 3 too. Identity is
the declaration, not the written name."*

Both forms I tried are refused by the builtin, and **identically at `aa74d6a1`** — so this is
pre-existing, not caused by my change:

```
let g = workerEntryAsync;      → ERROR AS100: Not implemented: a spawn entry that does not
                                 name a function (the stackful backend)
const g = workerEntryAsync;    → same
export { f as otherName };     → ERROR TS2304: Cannot find name 'otherName'  (re-export does
                                 not introduce a local binding)
```

The builtin's guard is `start.kind != NodeKind.Identifier` → `lookupIdentifierExpression` →
`ElementKind.Function | FunctionPrototype`. A local holding a function reference resolves to a
**Local**, not a Function, so it is refused before the map is ever consulted. Making that work
means resolving a local's initializer to its function element — a change to the *argument
shape* of the builtin, not to the identity record, and outside "one compiler change".

**What the gate is actually testing is satisfied by construction, and I can show it another
way:** the answer is derived from `target.prototype.declaration` → map → declaration →
`internalName`, so the written name never contributes to it. The measured evidence is that
**the same source text answered `4` before and `3` after**, with no name anywhere in the diff.
If the message were name-derived (`target + "$spawnStart"` — the approach the brief rejects),
`spawnName` would be computed in `builtins.ts`; it is not, it is read from a record the
lowering wrote.

**Reported as a gate not met rather than quietly dropped**, with the pre-existing refusal
measured on both bundles.

---

## 7. What I added that the brief did not name

Both are consequences of measurement, not scope creep, and both are visible in the diff.

### 7.1 `guest_thread_fixture_as_committed` — `tests/support/programs.rs`

`guest_thread_fixture` prefers **rebuilding from source** when a compiler is installed, on the
stated principle "a checkout that can build should measure the source it has". For this guest
that principle is wrong, and I measured it:

```
built with the vendored pin (aa74d6a1):    spawnIndexOf=4, no worker line, EXIT=124
built with the fixed compiler (3ef8a8f4):  spawnIndexOf=3, body runs, exit 0
```

The vendored pin **predates the fix**, so a source build in this checkout produces the
defective guest — and the run **hangs** (main joins a worker that never exits) instead of
failing. That is what my first `--test threads` run did: it passed in 2.84 s, then after
`build-test-programs.mjs --force` it rebuilt the artifact with the pin and the test hung for
12 minutes until I killed it.

So this test takes the **committed bytes**, for `guest_debug`'s reason: here the artifact under
test *is* a compiler behaviour, and only one compiler produces it. The resolver's doc says when
to go back to `guest_thread_fixture` — once the pin advances past `3ef8a8f4`.

### 7.2 A deadline in the test

The defect's signature is a **hang**, not a wrong exit code. An unbounded `wait` turns a
regression into a hung CI job with no message — silence, which is what this arc exists to
remove. The test polls `try_wait` against a 30 s deadline, kills, and then asserts with the
guest's own captured lines in the message. The negative control exercises exactly this (§8).

---

## 8. The negative control

**What I changed:** the map read disabled, and nothing else —

```ts
-  if (entries.has(declaration)) {
+  if (false && entries.has(declaration)) { // MUTATION: map read disabled
```

Rebuilt (`cdd36a8d`), rebuilt the fixture with that compiler, ran the test.

**The failing assertion, verbatim:**

```
test an_async_worker_entry_is_served_as_its_spawn_entry ... FAILED
panicked at tests/threads.rs:696:5:
the run did not finish in 30 s — the worker was never served and `__threadJoin` is waiting
on it. That is how the pre-fix `__spawnIndexOf` fails (it answers the factory's index, so
`__serveOne` queues nothing and the created task is never driven); stdout:
main: spawnIndexOf=4
test result: FAILED. 0 passed; 1 failed; … finished in 30.01s
```

The mutant fixture is `38e299583e1ee7e6` — **byte-identical to the artifact the vendored pin
produces**, which independently confirms the pin carries the pre-fix line.

**Reverted:** `src/builtins.ts` restored from a copy (`grep -c MUTATION` → 0), rebuilt →
**`3ef8a8f4`**, fixture rebuilt and `cmp`-identical to the good bytes (`62e2460`), suite green.

---

## 9. Gates

| item | declared | measured |
|---|---|---|
| bundle | unknown, expected to differ | **`3ef8a8f4`** (from `aa74d6a1`) |
| `--test threads` | 8 → **9** | **9 passed** · 0 failed |
| CI `Wake path guard` filter | 3 → **4** | `running 4 tests` · `4 passed; 5 filtered out` |
| `--bin` | 307 | **307** pass |
| census `--workers 8` | 71 / 11 | **71 / 82 pass, 0 skipped, 11 no-source** |
| `test:compiler` | 0 capability skips | **`[ SUCCESS ]`**, 0 `capability` lines |
| `--test fiber` | 6 | **6** |
| `--test fiber-executor` | 7 | **7** |
| Promise shell | unchanged | **byte-identical** (§10) |

**Census caveat, because two tools answer to "census".** `tests/debug/census.js --check`
(the DWARF ratchet, `npm run test:debug:census`) reports **149 worse** — and it reports
**149 worse on the pre-change bundle too**, so that is a tree-vs-manifest divergence that
predates this round, not my delta. The `71 / 11` the arc quotes is
`tools/debug-conformance/runner.js --workers 8`: `71/82 pass, 0 skipped, 11 fail [no-source
11, pass 71]`. Both are stated so the number in this table is unambiguous.

---

## 10. The Promise shell — nothing changed

The brief asks to state it, and it is stronger than "should not have changed": the same guest
(Promise shell, `WAKE_FLAGS` minus stack switching) compiled by both bundles is
**byte-identical**:

```
wake-on-worker.ts   bundle aa74d6a1 → 2fdd79e8534783e7
wake-on-worker.ts   bundle 3ef8a8f4 → 2fdd79e8534783e7     cmp: identical
```

Which is what the design predicts: `StackfulAsyncTransform` never runs without stack
switching, so `spawnEntries` is empty, so every call site takes the `target.internalName`
branch. The whole threads suite — `count`, `spawn-join`, `two-workers`, `spawn-refusals`,
`async-on-main` — passes unchanged.

---

## 11. Commits

- **`41a972e1`** — `TensionScript-a2`, branch `fix/dl31-spawn-entry-record`:
  *compiler: record the spawn entry where the lowering creates it (I57)*.
  Bundle `aa74d6a1 → 3ef8a8f4`. **Not pushed** — see §12.
- **`21be9ed`** — `Tension` `integration/dwarf-debug`: *test(thread): an async worker entry is
  served as its spawn entry (I57)*. Guest, fixture, fixtures README, the resolver, the test,
  the CI filter.
- **CI:** run **`45258432001`** on `21be9ed` — **success**. The `Wake path guard` step ran
  `running 4 tests` → `4 passed; 0 failed; … 5 filtered out`, and the new test passed there
  **with no compiler installed**, which is the committed-fixture path working in the job that
  has none (the whole reason the fixture is committed).

The rebase onto `246ddc2` + `a66088b` (which landed while I worked) was clean; `21be9ed` is the
rebased commit.

---

## 12. Bugs I made, and what caught them

1. **Recorded the name the brief specified, and it crashed the compiler.**
   `spawnEntries.set(declaration, spawnName)` with the value a `string` → **compiler crash**
   (`▌ Whoops, the TensionScript compiler has crashed during compile`, no stack trace) for
   `__spawnIndexOf(<async fn>)`, while the sync case compiled fine. Caught by bisecting my own
   probe into `t3.ts`/`t4.ts` (sync vs async). Root cause: no element — hence no internal
   name — exists at transform time, so `emitStartsTable` was handed a name nothing owned. The
   fix was to store the declaration, and the **source had already said so** in the comment
   above `asyncSpawnStarts.push`. That comment was three lines from where I was editing; I
   should have read the neighbouring code before writing the record.
2. **Built the wrong thing first.** `npm run asbuild:release` emits
   `build/assemblyscript.release.wasm`; the bundle is `npm run build` (esbuild over `src/`).
   Caught by the hash staying `aa74d6a1` and `dist/`'s mtime being a day old — the brief's own
   stop condition is what surfaced it.
3. **A 12-minute hang I initially mistook for a slow test.** After `--force` rebuilt the
   fixture with the vendored pin, the test hung in `__threadJoin`. Caught by cancelling and
   comparing the two artifacts' hashes (`38e29958` vs `62e2460`) and running each under
   `timeout`. That measurement is what produced §7.1.
4. **A stale-guest report from my rebase.** `npm run rebuild -- --check` said `1 stale`; the
   `.ts` mtime had been rewritten by `git rebase` while `build/*.wasm` kept its old mtime.
   Content was unchanged — confirmed by rebuilding and getting `cmp`-identical bytes. Fixed by
   rebuilding so the artifact is newer; both links now PASS.
5. **`npm run build:compiler` does not exist** (the first thing I typed). Caught immediately.

---

## 13. What I did not verify

- **The `TensionScript-a2` branch is not pushed.** The commit is local on
  `fix/dl31-spawn-entry-record`. Pushing to that repository is a separate decision (it is the
  upstream project, `main` is production) and this round was scoped to the harness repo plus a
  local compiler change; the bundle hash is what the fixture records either way.
- **The vendored pin still predates the fix**, so `guest_thread_fixture` — every *other*
  thread test — still rebuilds with `aa74d6a1`. That is fine for them (none calls
  `__spawnIndexOf`), but it means the **pin advance is a precondition** for going back to a
  source build for this guest. `npm run rebuild -- --check` reports the compiler links
  `UNKNOWN` for the same reason.
- **The alias gate is unmet** (§6), and I did not attempt to make the builtin accept a local,
  because that is a different change from the one this round is.
- **`f$spawnStart` is served but not *resumed*.** The body in this program awaits a
  non-suspending `leaf()`, so the run proves the entry is served and the body runs — not that
  a suspension is resumable. DL30 §4.3 measured that the stackful suspension registers
  **0 parks**, so resumption is still the missing primitive; that is I60's, and this fix does
  not depend on it (the record is a property of the lowering, not of the suspension
  mechanism — the brief's forward-compatibility requirement).
- **Parameterised async functions** keep `entry = -1` (Gate 3d, no spawn entry), so
  `__spawnIndexOf` on one answers its own index and would still be served as a factory. Not
  measured this round; the map has no entry for them, which is the truthful "no spawn entry"
  answer, but whether that path should refuse instead is a separate question.
- **`scripts/rebuild.mjs`'s compiler links** were already `UNKNOWN` and I did not chase why;
  the two links in my brief's scope (`fixtures`, `guests`) both PASS after §12.4.
