# DL34 — the rebuild script finds npm on every layout (I74)

**Round:** DL34, 2026-11-23. **One file**, `scripts/rebuild.mjs`, +100/−13. No Rust, no
compiler, no `std`, no test change. **The bundle stayed `3ef8a8f4`.**

**Committed:** `22b994e` (the change) and `ddb413d` (this report), both on branch
`fix/dl34-npm-resolution` in `~/work/Tension` (pushed). CI **`45278878964` — success** on
`22b994e`; **`45279581555` — success** on `ddb413d`.

---

## 1. Phase 0

| | |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`a7c82eb`**, `git status --porcelain` empty, nothing unpushed |
| `TensionScript-a2` | **`fix/dl31-spawn-entry-record`** @ **`41a972e1`**, clean, on origin |
| tree `dist` | **`3ef8a8f4`** (`3ef8a8f49021ef41…`) |
| installed `dist` | **`3ef8a8f4`** — converged by DL33 and unchanged by this round |
| lockfiles | clean in both; no `npm install` ran |

The machine's npm layout, which is the whole subject:

```
which npm  → /usr/sbin/npm
readlink -f → /usr/lib/node_modules/npm/bin/npm-cli.js
node's execPath → /usr/bin/node
```

---

## 2. The failure on the unmodified tree, verbatim

```
$ TENSIONSCRIPT_DIR=/home/acakar/work/TensionScript-a2 npm run rebuild
rebuild: compiler: npm run build

rebuild: stopped — cannot find npm's CLI at /usr/bin/node_modules/npm/bin/npm-cli.js — invoke run build by hand
EXIT=1
```

Native — no `/tmp` copy, no workaround. The guess and the machine disagree by exactly the
Debian layout difference: `dirname(/usr/bin/node)/node_modules/npm` vs
`/usr/lib/node_modules/npm`.

---

## 3. The resolution order implemented, and the line it prints

Four routes, each tried only when the one before it does not answer
(`scripts/rebuild.mjs`, `resolveNpm()`):

1. **`npm_execpath`** — used if set **and** the file exists. Resolved through `realpathSync`.
2. **`npm` on `PATH`** — scanned with `path.delimiter`; `npm.cmd`/`npm.exe` are tried before
   `npm` on Windows. Each candidate is `realpathSync`'d: if the target ends in `.js` it is
   `npm-cli.js` and is run under `process.execPath` (exactly as route 1 does); otherwise it is a
   real executable (`npm.cmd` on Windows, an exotic wrapper on unix) and is **spawned
   directly**, with `shell: true` on Windows because a `.cmd` needs one.
3. **The neighbour-of-node guess**, unchanged, last — so no layout that resolved before stops
   resolving now.
4. **None of them** → the existing explicit error, extended to **name all three paths tried**,
   thrown from the top of `build()` so it lands **before any build step**.

Resolution happens once (memoised), at the **top of `build()`**, and prints:

```
rebuild: npm via npm_execpath → /usr/lib/node_modules/npm/bin/npm-cli.js
```

**Every route was exercised**, not just the one this machine happens to take:

| route | how provoked | line printed |
|---|---|---|
| 1 `npm_execpath` | `npm run rebuild` | `npm via npm_execpath → /usr/lib/node_modules/npm/bin/npm-cli.js` |
| 2 `PATH` | `env -u npm_execpath node scripts/rebuild.mjs` | `npm via PATH → /usr/sbin/npm → /usr/lib/node_modules/npm/bin/npm-cli.js` |
| 3 neighbour of node | `PATH=/nonexistent` + the DL33 node copy | `npm via neighbour of node → /tmp/dl33/node_modules/npm/bin/npm-cli.js` |
| 4 none | `PATH=/nonexistent` + system node | the error below, exit 1 |

Route 2 is the interesting one on this machine: `/usr/sbin/npm` **is a symlink** to
`npm-cli.js`, so the `realpathSync` + `.endsWith('.js')` branch turns it into the same
node-run file route 1 names, rather than spawning a shim. That is the "prefer the cli.js it
points at when that is discoverable" half of the brief's step 2; the direct-spawn half is for
shims that are not symlinks (Windows `.cmd`, and wrapper scripts).

The fail-closed message, verbatim (exit **1**, before any build step):

```
rebuild: stopped — cannot find npm's CLI — tried:
  npm_execpath (unset — not run under `npm run`)
  PATH (no `npm` on it)
  neighbour of node → /usr/bin/node_modules/npm/bin/npm-cli.js (does not exist)
```

**One deliberate scope decision, declared:** `resolveNpm()` is called from `build()`, not at
module load, so **`--check` never resolves npm and its output is unchanged**. `--check` invokes
no npm (it only reads files and compares timestamps), so resolving there would report a fact the
run never uses and would make `--check` fail on a machine that has no npm at all — the opposite
of fail-closed for that path. DL33's `--check` table is therefore byte-comparable with this
round's.

---

## 4. `npm run rebuild`, natively

```
rebuild: npm via npm_execpath → /usr/lib/node_modules/npm/bin/npm-cli.js
rebuild: compiler: npm run build
rebuild: install: node_modules/@yabgu_gm/tensionscript/dist and /std
rebuild: runtime: npm run build:native (release)
rebuild: runtime: cargo build (dev) --no-default-features --features audio,render2d-core,static-sdl3
rebuild: guests: scripts/build-test-programs.mjs (and --debug)
rebuild: chain built; verifying

link                                          expected                      actual                          status
--------------------------------------------  ----------------------------  ------------------------------  -------
compiler: src → dist/assemblyscript.js        built after 2026-11-23 23:17  built 2026-11-23 23:17          PASS
compiler: dist → installed                    3ef8a8f49021 (tree)           3ef8a8f49021 (installed)        PASS
compiler: std → installed std                 81 files identical            81 identical                    PASS
runtime: src → release                        newer than 2026-11-23 18:56   built 2026-11-23 21:40          PASS
runtime: src → debug                          newer than 2026-11-23 18:56   built 2026-11-23 21:42          PASS
fixtures: committed .wasm                     5 present, none behind its …  5 present, all current          PASS
guests: tests/programs/**/*.ts → build/*.wa…  28 built after source         28 current                      PASS
docs: docs/abi/*.md                           generator --check clean       current                         PASS

rebuild: 8/8 links PASS
EXIT=0
```

**The build path has now executed natively on this machine for the first time** — DL33 ran it
around the defect with a node copy in `/tmp`; this ran with nothing but `TENSIONSCRIPT_DIR`.

Bundle after: tree `3ef8a8f49021ef41`, installed `3ef8a8f49021ef41`. **Unmoved.**

---

## 5. Determinism — two runs

```
run 1: exit=0  hash=3ef8a8f49021ef41  installed=3ef8a8f49021ef41  rebuild: 8/8 links PASS
run 2: exit=0  hash=3ef8a8f49021ef41  installed=3ef8a8f49021ef41  rebuild: 8/8 links PASS
```

Identical. (The two run logs are not byte-identical — the tables carry per-run build
timestamps in the `actual` column. The artifacts are what determinism is about, and they match.)

---

## 6. `--check` unchanged

```
rebuild: 8/8 links PASS
EXIT=0
```

Same eight rows, same verdict, and **no npm resolution line** — per the scope decision in §3.
Bundle before and after `--check`: `3ef8a8f4`.

---

## 7. The Windows argument, from the code

Windows keeps working by construction, on all three resolving routes:

- **Route 1.** Under `npm run`, npm sets `npm_execpath` to
  `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js` — the file `npm.cmd` itself invokes.
  It exists, so route 1 answers before anything else is tried, with `process.execPath`
  (`node.exe`) as the interpreter. This is the same invocation the old code performed, so the
  path that worked on Windows is still the path taken there.
- **Route 2.** If `npm_execpath` were absent, the PATH scan tries `npm.cmd`, `npm.exe`, `npm` in
  that order — `npm.cmd` is the one present on the Windows installer's layout. `realpathSync`
  returns the `.cmd` unchanged (it is not a symlink), it does not end in `.js`, so it is spawned
  directly with `shell: true`, which is how a `.cmd` must be started. Splitting `PATH` on
  `path.delimiter` gives `;` there; `process.env.PATH` also reads a `Path`-spelled variable,
  because Node's `process.env` is case-insensitive on Windows.
- **Route 3.** The old guess is `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js`,
  which on the Windows layout is exactly
  `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js` — the path the pre-change code
  used successfully. So **had routes 1 and 2 both missed, the fallback would still have
  resolved on Windows**, and this change cannot have traded that layout for this one.

Not run — WIN16 does that at final SHAs.

---

## 8. Counts

| | |
|---|---|
| `--bin` | **307** passed |
| `--test threads` | **9** passed |
| `--test fiber` | **6** passed |
| `--test fiber-executor` | **7** passed |
| census | **NOT re-run** — nothing compiler-side, `std`-side or Rust-side changed, so the input to `debug-conformance/runner.js` is identical to DL33's `71/82 · 0 skipped · 11 no-source`. Stated, not implied. |

`git status --porcelain` before the commit: ` M scripts/rebuild.mjs` — **one file, as the
brief required.** The build runs changed no tracked file, and no fixture or guest artifact
moved (`guests` link PASS, and DL33 already proved those bytes).

---

## 9. Commits

- **`22b994e`** — `Tension`, branch **`fix/dl34-npm-resolution`**, pushed:
  *rebuild: resolve npm on every layout, not just the node neighbour (I74)*.
- **CI run `45278878964`** on `22b994e` — **success**.

`integration/dwarf-debug` is untouched by this round; the change sits on its own branch for
review, as the brief asked ("push the branch").

---

## 10. Declared versus measured delta

| item | declared | measured |
|---|---|---|
| resolution order | `npm_execpath` → PATH → neighbour → error | **that order, all four exercised** |
| unmodified tree fails | yes, that message | **exit 1, exact message** |
| native `npm run rebuild` | exit 0, 8/8 | **exit 0, 8/8 links PASS** |
| `--check` | exit 0, 8/8, unchanged | **exit 0, 8/8, same output** |
| determinism | identical hash twice | **`3ef8a8f4` both runs** |
| startup line | one line naming route + path | **`rebuild: npm via npm_execpath → /usr/lib/…/npm-cli.js`** |
| bundle | stays `3ef8a8f4` | **`3ef8a8f4`, tree and installed** |
| counts | 307 / 9 / 6 / 7 | **307 / 9 / 6 / 7** |
| files changed | one (`scripts/rebuild.mjs`) | **one, +100/−13** |
| census | not re-run, said so | **not re-run, said so** |

**Nothing moved.** Two things beyond the letter of the brief, both declared: the resolution is
**memoised and called from `build()` only** (§3), and the error message now lists the three
paths rather than one — which the brief's step 4 asked for.

---

## 11. Bugs I made, and what caught them

1. **A dead `tried.push` in route 2** — pushed an explanatory string and then returned
   immediately, so the string could never appear in the error. Caught by reading my own diff
   before committing; removed. (Had it survived it would have been harmless but misleading —
   the kind of line that makes the next reader distrust the list.)
2. **`env PATH=/nonexistent timeout …` failed with `env: 'timeout': No such file or
   directory`** — clearing PATH also hides the tool I was using to bound the test. Caught by the
   error; used `/usr/bin/timeout` and `/usr/bin/node` absolutely thereafter.
3. **Nearly committed to `integration/dwarf-debug` before reading the brief's "push the
   branch"**, which would have put a reviewed change straight onto the integration branch. Caught
   by checking the workflow's `on:` block first — `push:` has no branch filter, so a feature
   branch still gets CI, which is what makes the brief's instruction workable.
4. **`node --check` before trusting a `.mjs` edit** — cheap, and it did run clean both times;
   recording it because I ran the edit twice (§11.1's fix) and checked syntax both times.

---

## 12. What I did not verify

- **Windows, at all** — §7 is an argument from the code and from the layout that `npm.cmd`
  documents, not a run. WIN16 owns that.
- **nvm and Homebrew layouts were not exercised either.** Both put `npm` beside node (route 3's
  shape) and both satisfy route 1 under `npm run`; I argue that from their documented layout, and
  route 3 was exercised here only through a copy that mimics it (`/tmp/dl33/node`).
- **`npm ci`'s own path** — still not exercised (it needs an absent `node_modules`), exactly as
  DL33 noted. If it fires it now goes through the same resolver, so it inherits this fix, but I
  have not watched it succeed.
- **A run under Yarn or pnpm.** `npm_execpath` is set by *those* tools to their own CLI, so
  route 1 would answer with the wrong program and `npm(['ci'])` would fail. The brief's step 1
  says to use `npm_execpath` whenever it exists, and I followed it exactly rather than adding a
  name check that would have quietly narrowed it — but the limitation is real and neither repo's
  tooling invokes the script that way today.
- **The `direct: true` spawn on a unix shell-script shim.** Route 2 takes that branch only when a
  PATH `npm` is a real executable that is not a symlink to a `.js`; this machine's npm is a
  symlink, so the branch is reasoned about, not run.
- **Census and `test:compiler`** — not run, and §8 says why: no input to either changed.
