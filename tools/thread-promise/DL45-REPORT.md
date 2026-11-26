# DL45 — `.tension` for guests, and the declaration file that quiets the editor

| | |
|---|---|
| `~/work/Tension` | `feat/dl45-ten-extension` off `develop` (`11dd7c6`) — tip **`b980b8c`** |
| `~/work/TensionScript-a2` | `feat/dl45-ten-extension` off `develop` (`f045fc5a`) — tip **`3aa5cb80`** |
| CI (Tension) | **`45858425940` success** — `E2E debug` (`45848693310` was green at the rename tip too) |
| CI (TensionScript) | **`45858413491` success — all 17 jobs**, `Coverage` included; the two red attempts before the fix are §9 |
| installed compiler | `96c7d1c0825a` → **`f97c0f03b334`** (the table is a compiler change — §4) |
| `--check` | **9/9 PASS** at the tip; runtime digests `dc2cf96275ae` → **`fefddc6e7a0b`** (`src/debug.rs` is an input) |
| guests / artifacts / records | **30** sources → **35** artifacts → **70** records, plus **15** committed fixture records |
| `main` | untouched in both repos (`56ddabb`, `3f59ec08`) |

**Three decisions were taken on the record, not silently:** the compiler identity had to
move (§4), the brief's "0 of 70 artifact bytes moved" is not literally attainable (§5),
and Tension's CI cannot compile a guest at all (§8).

---

## 1. What the three WIP files were

The seat found the tree carrying `cli/index.js`, `cli/options.json` and
`tests/cli/guest-extension.js` uncommitted, with no `.tension` file anywhere. I read
them as my own work and kept all three unchanged, except for one lint warning the CI
gate refused (§9). They are committed as `f12f4c68`:

- `cli/index.js` — `ENTRY_EXTENSIONS = [".tension", ".ten", ".ts"]`, the refusal by name
  before anything is read, and `entryExtensionOf()`. The table governs **entry files
  only**; `extension` (`.ts`, for `~lib/…`, `rt/index-*` and relative imports) is
  untouched, because every library the compiler ships is genuinely TypeScript until
  self-host.
- `cli/options.json` — `--warn-deprecated-extension`, `bool`, default **false**.
- `tests/cli/guest-extension.js` — five assertions, spawning `bin/tensionscript.js`.

The flag is silent by default and there is no heuristic about which tree is being
compiled. That was the WIP's choice and it is the right one: several suites assert the
exact bytes of a compile's stdout, and the compiler's own sources are `.ts` by design,
so an unconditional notice would fire on every compile in this repository.

## 2. Phase 0 — the entry extension, proved against the old compiler

**The question.** Does the compiler accept an arbitrary entry extension today?

**The answer: no, and the layer is `cli/`.** The pre-DL45 entry loop stripped a trailing
`.ts` and then appended `.ts` unconditionally:

```js
sourcePath = sourcePath.replace(/\\/g, "/").replace(extension_re, "").replace(/\/$/, "");
let sourceText = await readFile(sourcePath + extension, baseDir);   // ← unconditional
```

**The demonstration**, run against the compiler that was **still installed**
(`96c7d1c0825a`, built from `f045fc5a` — i.e. before this round):

```
$ node scripts/tensionscript.mjs .../dl45old.ten -o /tmp/dl45/old.wasm --runtime incremental ...
ERROR TS6054: File 'tension-core/tests/programs/conformance/dl45old.ten.ts' not found.
FAILURE 1 parse error(s)          # exit 1
```

The error names a file nobody wrote. `src/` was not involved: the parser's
`mangleInternalPath` only strips a trailing `.ts` for internal paths, and never sees an
entry path.

**What the fix does.** A spelling outside the table is refused **by name**, with the list
in the message, before any file is read; a spelling inside it is tried as spelled first,
then the table in declared order, then `stem/index.*` for each. Measured with the new
compiler (`f97c0f03b334`):

```
.foo   -> FAILURE Guest source '…/probe.foo' has the extension '.foo', which is not one
          this compiler accepts. Accepted: .tension, .ten, .ts (.ts is deprecated).   exit 1
.ts    -> compiles, silent                                              (default)
.ts --warn-deprecated-extension -> WARNING: … deprecated guest extension '.ts' … on stderr
absent.tension -> ERROR TS6054: File '…/absent.tension' not found.      (as spelled)
```

**The site census, per site** — the number in brackets is what had to change:

| site | what was there |
|---|---|
| build glob (`build-test-programs.mjs`) | `endsWith(".ts")` [1], `replace(/\.ts$/,"")` [2], empty-tree message [1] |
| alias table (`program-aliases.mjs`) | 5 `source` strings |
| check (`rebuild.mjs`) | guest glob [1], `basename(…,".ts")` [2], row title [1], `findSourceFor` [1] |
| runner (`tests/programs/runner.mjs`) | 1 source path |
| `tests/debugger.rs` | **6** filename literals (breakpoint file + recipe) |
| `tests/launch_config.rs` | 2 (the `.ts` enumerator, the "compiles the file it opens" assertion) |
| `.vscode/tasks.json` + `launch.json` | 21 command strings |
| `tension-core/src/debug.rs` | **1 — host code**, the lldb recipe's file hint |
| census (`tools/debug-conformance/`) | `cases.js` source lookup [1], `matrix.json` **25** case rows |
| fixture READMEs + `programs/README.md` | 6 files |
| committed fixture records / build records | 15 / 70, rewritten by the build |
| CI (`.github/workflows/e2e-debug.yml`) | **0 steps** — one comment; this job installs no compiler (§8) |

**Declared delta, before running:** 30 sources renamed (35 artifacts, because five come
from `PROGRAM_ALIASES`), 70 build records + 15 fixture records rewritten, fixture `.wasm`
bytes only where the fixture embeds its own source path, release artifacts identical
except where the artifact embeds its entry path, debug artifacts all moved, suites
unchanged, one new CLI test with 5 assertions. **Measured delta** is in §5 and §6; each
part is accounted for, and the one part I declared too optimistically (release bytes) is
stated as a finding rather than smoothed over.

## 3. Phase B — the rename

30 files, `git mv` so history follows. `examples/async-on-main/` untouched (decision 1:
the user's live edits, and no glob that would reach it — the glob is
`tests/programs/**`). Compiler sources stay `.ts` (decision 2). Historical prose keeps
its spelling (decision 7): the DWARF attribution table in `docs/debugging.md` still reads
`async-on-main.ts` and now carries a note saying so, and `tools/thread-promise/DL*-REPORT.md`
is untouched.

Rebuilt **through the documented chain, never `--force`**:

```
build-test-programs: 35 built, 0 up to date, 35 total (35 for a new compiler)
```

The skip condition rebuilt everything because the compiler identity moved — DL36's
mechanism naming its own reason in the log. A rename alone would *not* have triggered it
(`git mv` keeps the source's mtime), which is worth knowing: on a tree that renames
without changing the compiler, the records would have kept naming `.ts` and nothing would
have said so.

## 4. The compiler identity **had to move** — the brief's gate 5 premise was wrong

Gate 5 says "compiler identity unchanged (`96c7d1c0825a` — no compiler source should have
moved)". **Phase A requires a compiler source change**: the table lives in
`cli/index.js`, and `dist/asc.js` — one of the two identity bundles (`COMPILER_BUNDLES`,
DL43/I102) — *is* the CLI bundle. So `npm run build` produces a different `asc.js`, and
re-vendoring it necessarily moves the identity:

```
96c7d1c0825a   (f045fc5a — cannot compile .tension)
f97c0f03b334   (3aa5cb80 — can)
```

Re-vendored at the a2 tip via `npm run compiler:vendor` + `npm install`, submodule pinned
to `3aa5cb80`'s tree. `--check`'s `compiler: dist → installed` row reads
`f97c0f03b334 (tree) / f97c0f03b334 (installed)` — PASS, because the two agree. **The
identity moving is not a regression; it is the round.** A rename cannot move it, and the
table can.

The other digest moved for the same reason in the other direction: `src/debug.rs` is one
of tension-core's 84 inputs, so the runtime digest went `dc2cf96275ae` → `fefddc6e7a0b`,
release and debug alike.

## 5. The byte gate — what actually moved, and why

**Method.** Every artifact's sha256, captured *before* touching anything
(`/tmp/dl45/A.txt`, `/tmp/dl45/A-debug.txt`, 35 + 35), compared against the rebuild.

**Release: 30 of 35 byte-identical.** The five that moved are exactly the five whose
module embeds its own entry path as a UTF-16 string in the data section:

```
async-main-promise  ·  promise-fallback  ·  rt-guards  ·  two-waiters-late  ·  wake-on-worker
```

Verified as *the* explanation, three ways:

1. **The compiler change is codegen-neutral.** A `.ts` copy of each of the five, built by
   the new compiler, reproduces the old compiler's bytes exactly (5/5) — so nothing in
   the CLI table reached the emitter.
2. **Only `data` differs** for the two that showed a clean section split
   (`promise-fallback`, `wake-on-worker`); the other three also move `code`/`global`.
3. **The equal-length experiment.** Building a `.ts` copy whose *path length* equals the
   `.tension` path (`thread/two-waiters-lateZZZZZ.ts`) makes **only the data section
   differ**, at exactly the UTF-16 path string — so the `code`/`global` movement in (2) is
   address constants following a layout shift, not a different program.

A second rebuild of all 35 (release and debug) afterwards reproduced **byte-identical
artifacts** — an unasked-for determinism check that passed.

**Debug: 35 of 35 moved**, for the same reason plus the DWARF file-name entry
(`.debug_line`: `conformance/async-before-await.ts` → `.tension`; the entry path occurs
once; the first probe measured +303 bytes on a hand-built pair).

**So the brief's "0 of 70 artifact bytes moved" is not attainable, and it is worth saying
why precisely:** the artifact records the source it was built from, in two places — a
UTF-16 static for 5 of 35 programs, and the line table for all 35 debug builds. A rename
that moved no byte would mean the artifact did not know its own source. The gate's *intent*
— "nothing but the name changed" — is what §5's three measurements establish.

## 6. Records

**70 of 70 build records** rewritten by the build that measured them, `source` naming
`.tension` — verified: `0` records still ending `.ts`. **15 committed fixture records**
likewise (`0` stale). Fixture `.wasm` bytes: **5 of 15 refreshed** (contract/async-on-main,
debug/main-policy, debug/rt-guards, thread/two-waiters-late, thread/wake-on-worker — the
ones that embed their path); the other 10 were already byte-identical.

`fixtures/debug/main-policy.wasm` had **no** record before this round (a legacy fixture
committed without one); it now has one, which is why the fixture-record count reads 15 and
not 14.

## 7. The declaration file — `types/tension-guest.d.ts`

Shipped at **`TensionScript-a2/types/tension-guest.d.ts`**, documented path, consumed by
editors and by nothing that emits code. The recipe is `docs/guest-editor.md`.

Contents, quoted from the file's own declarations:

```ts
type i32 = number; type i64 = number; type u32 = number; type u64 = number;
type u8 = number;  type u16 = number; type usize = number; type isize = number;
type f32 = number; type f64 = number; type bool = boolean;
declare function print(text: string): void;
declare class TaskRecord { class_: i32; key: i32; payload: i32; status: i32;
                           f0: f32; f1: f32; tag: i32; done: i32; }
declare abstract class TaskPolicy { readonly crossesThreads: bool;
                                    abstract create(task: TaskBase): void;
                                    abstract await(task: TaskBase): void; }
declare abstract class TaskBase { slot: i32; home: i32; settled: bool; status: i32;
                                  policy: TaskPolicy | null; entry: i32; }
declare class Task<T> extends TaskBase { value: T; recordValue: TaskRecord | null;
                                         _record: TaskRecord; drive(): void;
                                         __parkRecord(): TaskRecord | null; }
declare function __inlineAwait(task: TaskBase): void;
declare function __taskBindTable(capacity: i32): void;
declare function __spawnIndexOf(start: () => i32): i32;
declare function __spawnThread(id: i32, entryIndex: i32, argSlot: i32): i32;
declare function __threadJoin(id: i32): i32;
declare function __executorExit(id: i32): i32;
```

**Three declarations were checked and one was withdrawn while writing it**, which is the
whole discipline the brief asked for:

- `__setTaskPolicy` **does not exist**. `t = f() on pool` lowers to a write of
  `task.policy` (`src/compiler.ts:13917`); the field is declared and the builtin is not.
- the `$starts` index field is **`entry`**, not `spawnIndex`.
- **`policy.await` is `abstract await(task: TaskBase): void`** — *not* the generic
  `await<T>(t: Task<T>): T` the brief sketched. Declaring the sketch would have been a
  false error about correct code, which is the failure mode the file exists to prevent.
- **`line` does not exist** (the framework declares `write`, `print`, `readLine`,
  `argCount`, `arg`, `log`, `logStructured`), so it is not declared.

**The zero-delta proof, measured.** `tsc --noEmit` on a real guest
(`async/async-on-main`, copied to `.ts` in a temp directory so the extension is not the
subject):

| | errors |
|---|---|
| without the declarations | **13** (`TS2304 Cannot find name 'i32'` ×10, `TS1206` ×1, …) |
| with the declarations | **3** |

The three that remain are named in `docs/guest-editor.md` §4 and none is fixable by a
declaration: `@external` on an ambient function (`TS1206`), `async f(): i32` (`TS1064` —
in TensionScript an async function's declared type *is* its result type), and `~lib/…`
module resolution.

No artifact byte and no suite count moved: the file is not in the compiler's build inputs
(`src/`, `cli/`, `std/`, `package.json`, `tsconfig-base.json`), no guest imports it, and
the 70 artifacts are identical before and after it (they are, in fact, identical across a
full rebuild — §5).

## 8. The editor recipe, and the gate in CI

`TensionScript-a2/docs/guest-editor.md` carries the `files.associations` snippet
(`*.tension`/`*.ten` → `typescript`), the `tsconfig` `include` that names the declaration
file, the `.gitattributes` `linguist-language=TypeScript` lines (added), and the honest
caveat: **mapping to `typescript` keeps the server, so the declarations are what silence
it; a grammar-only language id silences it by removing completion and hover too.**

**CI, in two halves, because the two repos can prove different things:**

- **TensionScript `45849179499`** — `tests/cli/guest-extension.js` is wired into
  `test:cli` (`node tests/cli/options.js && node tests/cli/guest-extension.js`), which is
  in `npm test`, which the Compiler and Coverage jobs run. The Coverage job's log carries:

  ```
  Coverage  Collect coverage  2026-11-26T15:34:56.5705712Z  [ SUCCESS ] guest-extension: 5 checks
  ```

  So the table's five assertions execute in CI, and the job compiled `.tension` and `.ten`
  entries to do it — that is the "a CI run compiled `.tension` guests" evidence.
- **Tension `45848693310` success.** Its `E2E debug` job **installs no compiler at all**
  (`.packs/` is gitignored, I19), so it runs the committed fixtures and never compiles a
  guest — by design, and unchanged by this round. No CI step in that workflow spelled
  `.ts`, so there was nothing to update; the suites passing there prove the *fixtures*
  match the renamed sources' behaviour, not that `.tension` compiles on that runner.

## 9. Gates

| gate | result |
|---|---|
| threads | **15 passed** (`test result: ok. 15 passed; 0 failed`) |
| fiber | **6 passed** |
| fiber-executor | **7 passed** |
| async_on_main | **2 passed** |
| async_main_promise | **2 passed** |
| debugger | **5 passed** |
| fiber-runner | **5 passed** |
| `--bin` default | **307 passed** |
| `--bin` audio-only | **298 passed** |
| `--check` (tip) | **9/9 PASS**; runtime `fefddc6e7a0b` both profiles; identity `f97c0f03b334` |
| census | **71/82 pass, 0 skipped, 11 no-source**, no stale-engine warning |
| guests | **30 sources / 35 artifacts / 70 records / 15 fixtures**, no new program |

### `Coverage` was red twice, and it was mine — now green

The first two attempts at this tip (`45849179499`, `45855042633`) failed with JavaScript
heap exhaustion — `Ineffective mark-compacts near heap limit`, 4 084 MB, exit 134 — in the
`Collect coverage` step, **after every suite had passed** (the last `[ SUCCESS ] 71 checks`
is `test:atomics`, the last script in `npm test`). It was green on `develop` (DL44's
`45693396996`), and the only thing this branch adds to that run is
`tests/cli/guest-extension.js`.

**What it costs, measured.** A compile loads the whole 20 MB compiler bundle, so **one
child's coverage JSON is ~7.8 MB**. Measured with `c8 --temp-directory`:

| | files | bytes |
|---|---|---|
| test's contribution, first version | 14 | **46 MB** |
| test's contribution, final version | 2 | **264 KB** |

**Why the fix is a scratch directory and not a deletion.** Deleting `NODE_V8_COVERAGE` for
the children does not work: c8 re-injects the real temp directory into any descendant that
has no such variable — measured, a grandchild of a child that had deleted it reported the
path again. The empty string writes nothing on Node 26 (measured: 0 files) but that is one
version's behaviour, and **CI runs Node 24, which is not installable here** — so it is not
a contract. A directory the test creates and deletes is the one form whose meaning does not
depend on which Node reads it: the bytes land where c8 does not look, and
`process.on("exit")` removes them.

**Proven in the environment that failed:** `Coverage` in **`45858413491` is success**, and
its log carries `[ SUCCESS ] guest-extension: 5 checks`. The same line appears in
`Compiler (windows, node current)`, so the test also runs on Windows.

## 10. Two regressions I caused and fixed, both found by running the suites

1. **`tension-core/src/debug.rs` hardcoded `.ts`** in the lldb recipe it prints. The
   artifact's line table now says `conformance/first-branch.tension`, so the printed
   `breakpoint set -f rt-guards.ts` named a file that does not exist and bound nowhere.
   Host code, not a test — greps for `.ts` under `tests/` would not have found it.
2. **The JIT symbol carries the extension.** The stop is attributed to
   `async/rt-guards.tension/_start_game`, because the mangled module prefix *is* the entry
   path; the debugger test asserted `rt-guards/_start_game`. Both had to move together —
   a test asserting the old symbol would have passed against a stale binary and told
   nobody.

Two more CI-only findings: an unused import in the new CLI test failed
`eslint --max-warnings 0` (I had run the test, not the gate), and the census's
`matrix.json` named 25 case files as `.ts`, which left **all 82 cases** `unresolved
(locations 0, resolved 0)` until they were converted.

**A pre-existing failure, unchanged by this round:** `launch_config`'s
`every_program_has_its_own_configuration` compares 30 programs against 10 debug
configurations — it is red on `develop` too (30 vs 10 there), is not in any CI step, and
my change left the comparison exactly as it was. It is not this round's to fix.

## 11. Commits

```
TensionScript-a2  f12f4c68  cli: guest entry sources may be .tension, .ten, or .ts — and nothing else
TensionScript-a2  2473e52a  types: the guest language's declaration surface, and the editor recipe
TensionScript-a2  3aa5cb80  tests: drop an unused import the lint gate refuses
TensionScript-a2  67041717  tests: the CLI test's compiles do not join the coverage corpus
TensionScript-a2  368742df  tests: the CLI test's compiles write their coverage to a scratch directory
Tension           167a863  guests: the programs are .tension, and the tree says so everywhere it spells them
Tension           5e79e1a  rebuild: the fixture row asks whether the source's content moved, not when
Tension           b980b8c  debug, census: the tools that name a guest file follow the rename too
Tension           7c0276d  docs: DL45 report — the table, the rename, the declarations, and the coverage job measured
```

`5e79e1a` is worth its own line: after the rename, `--check` read 8/9 with five fixtures
"behind source" — **none of which was stale** (their sources were byte-identical; only the
path moved, so the source gained a commit and the fixture gained none). The row now asks
whether the source's *content* moved since the fixture's commit (blob at that commit vs
`HEAD`, searched under every accepted spelling), with the time rule kept as the first
attempt and as the only answer for a fixture older than its source. A genuine content
change still reads STALE — measured: one appended comment, committed, gave
`0 missing, 1 behind source` and `rebuild: 8/9`.

## 12. What I did not verify

- **No editor was opened.** Whether VS Code renders a `.tension` file with the
  associations and the declaration program in place is **not measured**. The 13→3 count is
  `tsc` on a `.ts` copy, which is the closest thing to the server's answer that can be
  produced without a GUI, and it is not the same thing.
- **A full local `npx c8 -- npm test` at the default heap after the fix was started but not
  finished** (it was still in its last third when this report was written: 17 suites green,
  1.7 GB of corpus). The CI job *is* finished, at the same command and a default heap, and
  it passed — so the claim rests on `45858413491`, not on the local run.
- **Node 24 was never run locally** — this host has only Node 26. That is why the fix chose
  a form whose behaviour does not depend on the version, instead of the empty-string
  spelling that happened to work here.
- **Windows.** a2's six Compiler jobs include Windows and are green, which runs the *CLI*
  suite there; Tension's Rust tests, the census, and the debugger suite are Ubuntu-only
  (WIN23 is the round that converges Windows).
- `npm ci`, publishing, and `main` — untouched.
