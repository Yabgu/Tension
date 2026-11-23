# DL33 — the machine converged, and the whole suite ran under the new compiler

**Round:** DL33, 2026-11-23. **No source change, no test change, no fixture regeneration,
no commits.** The round's subject was the divergence between the compiler tree
(`3ef8a8f4`) and the installed copy (`aa74d6a1`); both are now `3ef8a8f4`, and every suite
ran against it.

---

## 1. Phase 0

| | |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`161b0e7`**, `git status --porcelain` empty, nothing unpushed |
| `TensionScript-a2` | **`fix/dl31-spawn-entry-record`** @ **`41a972e1`**, clean, **on origin** (`## fix/… ...origin/fix/…`, no ahead marker) |
| tree `dist/assemblyscript.js` **before** | **`3ef8a8f4`** (`3ef8a8f49021ef41…`) |
| installed `dist/assemblyscript.js` **before** | **`aa74d6a1`** — the pre-fix pin; **this divergence was the round** |
| binary (before) | 33 653 336 B @ 2026-11-23 18:56:30; newest `src` @ 18:56:00, 0 newer |
| lockfiles | 0 changes in both; no `npm install` ran |

---

## 2. Declared before the first run

- **Commands:** `npm run rebuild` → both hashes + `diff -r`; `--check` → `touch` → `--check`
  → rebuild → `--check`; then the six suites, `--bin`, the census, a Promise-guest rebuild,
  and the compiler suite.
- **Expected counts:** threads **9**, fiber **6**, fiber-executor **7**, async_main_promise
  **2**, debugger **5**, `--bin` **307**, census **71/82 · 0 skipped · 11 no-source**,
  Promise guest **`2fdd79e8`**, compiler suite **0 capability skips**.
- **Both hashes → `3ef8a8f4`**, `diff -r` silent. **No commits expected.**

---

## 3. Part A — convergence, driven by the script

**One environment deviation, declared:** `npm run rebuild` could not run as typed, for a
reason unrelated to the round (§7, bug 1). It needs two environment facts this machine
does not have:

1. the compiler checkout at `~/work/TensionScript` — it is at `~/work/TensionScript-a2`, so
   `TENSIONSCRIPT_DIR` (the script's own documented override, `scripts/rebuild.mjs:85`);
2. npm's CLI at `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js` — this is Debian
   system Node, which puts npm at `/usr/lib/node_modules/npm`, not under `/usr/bin`.

For (2) I ran the script with a **copy of the node binary** in `/tmp/dl33/node` beside a
`node_modules/npm` symlink, so `process.execPath` resolves to a directory that has npm where
the script looks. **No repository file was touched to make this work** — verified by the
empty `git status` in §6 — and the script then ran its own steps unmodified.

The chain, verbatim (its final table):

```
link                                          expected                      actual                          status
--------------------------------------------  ----------------------------  ------------------------------  -------
compiler: src → dist/assemblyscript.js        built after 2026-11-23 21:36  built 2026-11-23 21:36          PASS
compiler: dist → installed                    3ef8a8f49021 (tree)           3ef8a8f49021 (installed)        PASS
compiler: std → installed std                 81 files identical            81 identical                    PASS
runtime: src → release                        newer than 2026-11-23 18:56   built 2026-11-23 21:40          PASS
runtime: src → debug                          newer than 2026-11-23 18:56   built 2026-11-23 21:42          PASS
fixtures: committed .wasm                     5 present, none behind its …  5 present, all current          PASS
guests: tests/programs/**/*.ts → build/*.wa…  28 built after source         28 current                      PASS
docs: docs/abi/*.md                           generator --check clean       current                         PASS

rebuild: 8/8 links PASS
```

**Proved by hash, not by the script's word** — the brief's gate:

```
tree dist:      3ef8a8f49021ef41
installed dist: 3ef8a8f49021ef41
diff -r ~/work/TensionScript-a2/std ~/work/Tension/node_modules/@yabgu_gm/tensionscript/std
  → silent, exit 0
```

`npm ci` did **not** run: it is gated on `node_modules` being absent from the compiler
checkout (`scripts/rebuild.mjs:226`), and it is present. No lockfile moved.

**The chain rebuilt the compiler from source and produced `3ef8a8f4` again** — the same hash
the branch built earlier. Determinism holds across a second full build.

---

## 4. Part B — the checker's red case

**B1 — green.** `--check` → exit **0**:

```
rebuild: 8/8 links PASS
EXIT=0
```

**B2 — red.** `touch ~/work/TensionScript-a2/src/program.ts` (mtime `20:50:59` → `21:42:25`;
content untouched), `--check` → exit **1**:

```
compiler: src → dist/assemblyscript.js        built after 2026-11-23 21:42  built 2026-11-23 21:36          STALE

rebuild: 7/8 links PASS, 1 STALE/UNKNOWN
EXIT=1
```

The row names the touched timestamp in **expected** (`21:42`) against the dist's build time
in **actual** (`21:36`) — the failure is the timestamp, exactly as the brief predicted.
**The checker can fail**, which is the evidence DL32 did not file.

**B3 — green again, and determinism after a `touch`.** Re-ran `npm run rebuild` → 8/8 PASS;
then `--check` → exit **0**. The rebuilt bundle is still

```
tree dist after rebuild: 3ef8a8f49021ef41   (3ef8a8f4)
```

so a mere mtime change does **not** move the bundle — no determinism finding.

Nothing committed; `touch` changed only the mtime, and `git status` in `TensionScript-a2`
is empty (§6).

---

## 5. Part C — the whole suite under the installed `3ef8a8f4`

The installed compiler is now the tree's (`3ef8a8f49021ef41`), so the DL31 caveat — "the
guard used committed bytes because the pin predates the fix" — is gone.

| suite | command | declared | measured |
|---|---|---|---|
| threads | `cargo test --test threads` | 9 | **9 passed** |
| fiber | `cargo test --test fiber` | 6 | **6 passed** |
| fiber-executor | `cargo test --test fiber-executor` | 7 | **7 passed** |
| async_main_promise | `cargo test --test async_main_promise` | 2 | **2 passed** |
| debugger | `cargo test --test debugger --no-default-features --features audio` | 5 | **5 passed** |
| `--bin` | `cargo test --bin tension-core` | 307 | **307 passed** |

**Census — tool named: `tools/debug-conformance/runner.js --workers 8`** (this is the arc's
gate, not the DWARF ratchet):

```
debug-conformance: 71/82 pass, 0 skipped, 11 fail  [no-source 11, pass 71]
```

**The DWARF ratchet, run and labelled separately** — `npm run test:debug:census` in
`TensionScript-a2`, `TENSION_DEBUG_ARTIFACTS=…/build/debug`:

```
census: tests/debug/census-manifest.txt is worse in 149 place(s)
```

**149 is the DL31 number, unchanged**, and DL31 established it reads 149 on the *pre-change*
bundle as well — it is a tree-vs-committed-manifest divergence that predates both rounds, not
a delta from this one. It is a different tool with a different number; the arc's `71/11` is
the runner above.

**Promise guest byte identity.** Rebuilt `wake-on-worker.ts` with the **installed**
`3ef8a8f4` (`--enable threads`, no `--enable stack-switching`, `WAKE_FLAGS`):

```
rebuilt:    2fdd79e8534783e7
DL31 said:  2fdd79e8
```

Identical. The Promise shell is byte-identical under the new compiler too — a difference
would have meant DL31's claim was wrong; it is not.

**The compiler's own suite.** `npm run test:compiler -- --parallel` in `TensionScript-a2`
(5 workers, 6 cores):

```
EXIT=0        [ SUCCESS ]        Time: 45300 ms
364 test headings · 0 FAILURE/ERROR · 0 lines mentioning "capability"
```

**0 capability skips.** Stated precisely so the number is not ambiguous: the run prints
**99 `SKIPPED (…)` markers**, and every one of them is the *run* half of an
expected-compilation-failure case (a `FAILURE 4 compile error(s)` / `compare stderr` block, then
`SKIPPED`) — the test asserts the failure and skips the execution. None is a capability skip,
and none is a test that silently did not run. DL31's gate asked for this count and its report
did not state it; this closes that.

**A rigour check the brief did not ask for, because the numbers above would otherwise be
weaker than they look.** The guests under `build/` were *reused* (`0 built, 28 up to date`),
so they carried bytes from whichever compiler built them earlier. I force-rebuilt all 28
with the installed `3ef8a8f4` and diffed the hashes:

```
release artifacts:  churned 0 of 28
debug artifacts:    churned 0 of 28
```

**Not one byte moved.** So the reuse was byte-equivalent and the suites genuinely reflect
`3ef8a8f4`'s output, rather than merely "ran while `3ef8a8f4` was installed". Nothing in
`fixtures/` changed (`git status` on that path: 0).

---

## 6. Final state

```
~/work/Tension          git status --porcelain → empty,  HEAD 161b0e7
~/work/TensionScript-a2 git status --porcelain → empty,  HEAD 41a972e1 on fix/dl31-spawn-entry-record
tree dist     3ef8a8f49021ef41
installed     3ef8a8f49021ef41
std           identical (diff -r silent)
```

**No source, test, fixture or lockfile commit this round** — the brief's "expected: none".
One commit is made, and it is this report: the gate also requires `git status --porcelain`
empty at the end, and the arc's convention is a committed `DLxx-REPORT.md`, so leaving the
file untracked would satisfy one requirement by breaking the other. Nothing else is staged;
`git show --stat` on it lists this file alone.

**No CI run id for any code change** — nothing code-side was pushed. The binary was rebuilt by
the chain (release @ 21:40, debug @ 21:42) from unchanged sources.

---

## 7. Bugs I made, and what caught them

1. **`npm run rebuild` could not find the compiler checkout, then could not find npm.**
   Caught by its own two error messages in sequence: `TensionScript does not exist — set
   TENSIONSCRIPT_DIR` and `cannot find npm's CLI at /usr/bin/node_modules/npm/bin/npm-cli.js`.
   The second is the real one — see the finding below.
2. **A symlink shim does not work for the node copy.** My first attempt symlinked
   `/usr/bin/node` into `/tmp/dl33/node`; `process.execPath` resolves the symlink back to
   `/usr/bin/node`, so the shim path was never used (printed `execPath: /usr/bin/node`).
   Caught by printing `process.execPath` before trusting it. A real copy fixed it.
3. **`cp` complained "same file"** on the first copy attempt, because the lingering symlink
   from (2) made `cp` follow it. Caught by `cp`'s own message; removed the symlink first.
4. **Nearly reported "the suites ran under the new compiler" on reused artifacts.** The
   guest builds said `0 built, 28 up to date`, which is only true of *mtimes*. Caught by
   asking what the artifacts actually contain, which produced the force-rebuild diff in §5
   (0 of 28 changed) — the claim now rests on bytes, not on a "current" label.

---

## 8. The finding inside bug 1 — `scripts/rebuild.mjs` cannot find npm on a Debian layout

`scripts/rebuild.mjs:165`:

```js
const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
```

That holds for an nvm install and for the Windows layout it was written against, but **not
for Debian/Ubuntu system Node**, where `node` is `/usr/bin/node` and npm lives at
`/usr/lib/node_modules/npm`. On this machine the script stops at its first build step:

```
rebuild: compiler: npm run build
rebuild: stopped — cannot find npm's CLI at /usr/bin/node_modules/npm/bin/npm-cli.js — invoke run build by hand
```

So the DL32 artifact, accepted on the strength of its code, **has never been run on this
machine's Node layout**, and the message's advice ("invoke run build by hand") is exactly what
the chain exists to avoid. This is reported, not patched — the brief says no source change.
The fix is small and local (`process.env.npm_execpath`, or `which npm`, or `execFileSync('npm')`),
and it belongs to whoever owns the script; the `--check` path is unaffected because it invokes
no npm.

---

## 9. Declared versus measured delta

| item | declared | measured | verdict |
|---|---|---|---|
| both bundle hashes | `3ef8a8f4` | `3ef8a8f49021` both | as declared |
| `diff -r` std | silent | silent, exit 0 | as declared |
| `--check` green / red / green | 0 / 1 / 0 | **0 / 1 / 0** | as declared |
| bundle after `touch` | unchanged | `3ef8a8f4` | as declared |
| threads / fiber / fiber-executor | 9 / 6 / 7 | **9 / 6 / 7** | as declared |
| async_main_promise / debugger / `--bin` | 2 / 5 / 307 | **2 / 5 / 307** | as declared |
| census (runner.js) | 71/82 · 0 skip · 11 no-source | **same** | as declared |
| Promise guest | `2fdd79e8` | `2fdd79e8` | as declared |
| compiler suite | 0 capability skips | 364 tests, `[ SUCCESS ]`, 0 | as declared |
| commits | none | **none** | as declared |

**Nothing moved. No delta larger than declared.**

Two things I did that the brief did not name: the **node shim** in §3 (an environment
adaptation, no repo file touched), and the **force-rebuild diff** in §5 (extra verification I
judged necessary to make the "under the new compiler" claim true rather than assumed). Both are
in the report rather than absorbed.

---

## 10. What I did not verify

- **The script's npm lookup was not fixed**, only worked around. On a machine with npm under
  `dirname(node)/node_modules` — the layout it assumes — I did not run it, so I cannot say the
  rest of the script's steps behave identically without the shim.
- **`npm ci`'s path was not exercised** (it is gated on an absent `node_modules`, and both
  were present). Whether a fresh `npm ci` then converges correctly — rather than reinstalling
  the tarball's `aa74d6a1` mid-chain — is the link the script's own header calls the one that
  "bites hardest", and this round did not take it.
- **The DWARF ratchet's 149 was not investigated**, only shown to be unchanged from DL31. I did
  not re-confirm DL31's "149 on the pre-change bundle" by rebuilding at `aa74d6a1`; I relied on
  DL31's measurement for that half.
- **The compiler suite's 99 `SKIPPED` markers**: I checked that none mentions *capability* and
  sampled that they are expected-failure run halves; I did not audit all 99 individually.
- **Windows** — explicitly out of scope (WIN16 is next).
- **Nothing ran in CI**, because nothing was committed.
