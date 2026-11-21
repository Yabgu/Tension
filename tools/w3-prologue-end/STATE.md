# W3 — is the rule real, and can async be debugged here?

Round: **W3 — confirm the prologue hypothesis, then make one async example
debuggable on Windows.** 2026-11-21. Branch `w3/prologue-end` (off `main`
`56ddabb`). No compiler or runtime source change; nothing pushed.

Primary lldb for every number: **20.1.4-codelldb**
(`tools/e2e-debugger/node_modules/@debugmcp/codelldb-win32-x64/lldb/bin/lldb.exe`).
Cross-checks under 23.1.5 (`C:\msys64\ucrt64\bin\lldb.exe`) are labelled.

## Phase A — what the line program contains

`.debug_line` read from each `.wasm`'s own section by `phase-a-line.mjs` (a
opcode-stream reader written for this round, because `llvm-dwarfdump` 23.1.5
refuses one of the modules — see below). Its rows were checked against
`llvm-dwarfdump --debug-line -v` on `io`: **3123 rows, 3123 identical**
(address, line, column, file index).

| module | rows | sequences | `DW_LNS_set_prologue_end` | `DW_LNS_set_epilogue_begin` |
|---|---|---|---|---|
| `examples/io/build/game.wasm` | 3123 | 80 | **0** | **0** |
| `examples/async-io/build/game.wasm` | 3269 | 75 | **0** | **0** |
| `examples/async-on-main/build/game.wasm` (stack) | 4464 | 140 | **0** | **0** |
| `examples/async-on-main/build/game-promise.wasm` | 4063 | 122 | **0** | **0** |

**Zero. In all four modules. That is the answer, and it is the expected one.**

Opcode census for `io` (every opcode in 80 sequences):
`set_address 80, set_file 92, advance_line 778, set_column 2932, copy 3043,
advance_pc 2963, end_sequence 80`. Nothing else is emitted at all — no
`const_add_pc`, no `fixed_advance_pc`, no `negate_stmt`, no `set_isa`.

**Second finding, unasked for but relevant to any fix:** the producer's
`standard_opcode_lengths` array disagrees with DWARF4 §6.2.5.2 at three
positions —

| opcode | declared | spec | never emitted |
|---|---|---|---|
| `0x09` `DW_LNS_fixed_advance_pc` | 0 | 1 | yes |
| `0x0a` `DW_LNS_set_prologue_end` | 1 | 0 | yes |
| `0x0c` `DW_LNS_set_isa` | 0 | 1 | yes |

A reader is entitled to use those lengths when skipping an unknown opcode. None
of the three is ever emitted, so nothing is misparsed today — but a consumer
that trusts the header *and* a future producer that emits 0x09 would desync.
Recorded because the fix will touch this table.

`llvm-dwarfdump` 23.1.5 refuses the stack-switching and `main-policy` artifacts
outright (`error: … bad form`); `.debug_line` itself is well-formed there, which
is why the reader was needed. The promise build dumps fine.

First four rows of `_start_game`'s sequence, per module:

`io` (sequence 62, 50 rows, starts `0x227e`):
```
0x227e  game.ts:10:8   is_stmt      <- first row of sequence, no prologue_end
0x2282  game.ts:10:2   is_stmt
0x2285  game.ts:11:8   is_stmt
0x2289  game.ts:11:2   is_stmt
```

`async-io`, `async-on-main` (stack and promise) have the same shape: the first
row of `_start_game`'s sequence is its first statement, `is_stmt`, with
`prologue_end` false. In the async modules `_start_game`'s first row is line 74
or 96 depending on the module — the sequence still begins at it.

## Phase B — the rule, tested on 29 breakpoints over 13 functions

Method (`phase-b-measure.mjs`): one lldb session per case; the breakpoint's bound
PC and the JIT line-table rows are compared **inside the same run** (the JIT base
moves between runs). A case is `exact` only if the stop's reported line equals
the requested line.

The claim under test, restated after Phase C so it can fail:

> Asked for a source line whose row is the **first row of its line-table
> sequence**, lldb binds a later row: the first following row in that sequence
> that names a **different** source line. Asked for any other row, it binds that
> row. If every row of the sequence names the requested line, there is nothing
> to slide to and the breakpoint keeps the requested address.

Result over the 29 cases: **21 obey, 8 violate, 1 n/a** (no row at all for
`async-io game.ts:96` — the statement is inlined framework code and has no row
in `game.ts`).

```
module                 function          asked  row of  first-of-seq  predicted  stopped  verdict
io                     game/_start_game   10    0x227e   yes           11         11      holds
io                     game/_start_game   14    0x2290   -             14         14      holds
io                     game/_start_game   22    0x234f   -             22         22      holds
log                    game/_start_game   32    -        yes           33         33      holds
log                    game/_start_game   35    -        -             35         35      holds
async-io               game/compute       42    0x3431   -             42         42      holds
async-io               game/compute       43    -        -             43         43      holds
async-io               game/pipeline      48    0x318a   yes           49         49      holds
async-io               game/pipeline      49    -        -             49         49      holds
async-io               game/pipeline      50    -        -             50         50      holds
async-io               game/run           60    0x2c9b   yes           62         62      holds
async-io               game/run           62    -        -             62         62      holds
async-io               game/run           67    -        -             67         67      holds
async-io               game/_start_game   98    -        -             98         98      holds
async-io               game/_game_running 89    -        yes           (no different row) 89  holds  <- Phase C
io                     io/print           73    -        yes           74         74      holds
io                     io/print           74    -        -             74         74      holds
io                     io/argCount        96    -        yes           (no different row) 96  holds  <- Phase C shape
io                     io/arg             101   -        yes           102        102     holds
io                     io/arg             102   -        -             102        102     holds
async-io               game/_start_game   96    (no row)  -            -          98      n/a
async-on-main-promise  game/base          54    -        yes           55         -       VIOLATION (no stop)
async-on-main-promise  game/base          55    -        -             55         -       VIOLATION (no stop)
async-on-main-promise  game/mid           60    -        -             60         -       VIOLATION (no stop)
async-on-main-promise  game/mid           61    -        -             61         -       VIOLATION (no stop)
async-on-main-promise  game/outer         69    -        -             69         -       VIOLATION (no stop)
async-on-main-promise  game/outer         70    -        -             70         -       VIOLATION (no stop)
async-on-main-promise  game/main          77    -        -             77         -       VIOLATION (no stop)
async-on-main-promise  game/main          86    -        -             86         -       VIOLATION (no stop)
```
(full machine-readable table: `measurements/phase-b-analysis.json`)

**Every one of the 8 violations is in one module, and all 8 fail the same way:
no stop at all.** That module's `main` never executes on this host — see Phase D.
Wherever the code actually ran, the rule held 21/21.

Two-row sequences were worth the trouble: `async-io game/pipeline:48` slides to
line 49 (row 1 names line 49 at `0x319a`), and `game/run:60` slides **two lines
forward** to 62 — the intervening row at `0x2ca7` also names line 60, and the
slide lands on the first row that names something else. That is the rule's
"skip same-line rows, stop at the first different one" clause, measured, not
assumed.

## Phase C — the one-row sequence

`examples/async-io/build/game.wasm`, `game/_game_running` (`game.ts:89-90`).
Its whole line-table sequence is:

```
0x56d1  89 9 61 is_stmt
0x56d1  89 9 61 is_stmt end_sequence
```

One row, plus the terminator at the same address.

Measured (`measurements/phase-c-single-row.json`, excerpt in
`measurements/phase-c-rows-excerpt.txt`):

```
line 89 -> exact, stopped at 89:9 in game/_game_running, 1 breakpoint location
```

**Outcome 1: it stops at the right line.** A slide needs a next row, and a
one-row sequence has none. So the fix earns ergonomics, not correctness: no
breakpoint is *lost* today, it is *moved*.

`io`'s `argCount` (line 96) is the same shape by a different route: its sequence
has rows, but they all name 96, so there is no different line to slide to and it
stops exactly. Two independent instances of the "nothing to slide to" case.

## Phase D — async, runnable here

### What cannot be fixed by configuration

`examples/async-on-main` cannot be made to stop anywhere on Windows, and not
because of the debugger:

- Its intended build needs `--enable stack-switching`; wasmtime refuses the
  module (`this guest uses continuations, which wasmtime does not support on
  this target (windows)`), so no breakpoint exists.
- Its Promise-backend build loads and exits **0**, but the guest prints
  **nothing** — `measurements/phase-d-async-on-main-promise-run.txt`: zero lines
  of `main:`/`base:` output. `_start_game` is an empty body (source line 107, no
  line-table row) and `game/main`'s breakpoint resolves but is never hit. The
  boot body that would resume `main` is what stack switching provides; the
  Promise build of *this* program does not substitute one.

That accounts for all 8 Phase B violations: the code never ran.

### What was built instead

`examples/async-io` — a Promise-backend async guest that already runs here
(three awaits: two task awaits inside `pipeline()`, one frame-loop await), and
that had **no `.vscode/` directory at all**. Added, configuration only:

- `examples/async-io/.vscode/launch.json` —
  **`lldb: tension-core --debug (async-io, promise backend)`**, which builds via
  the example's own `build:debug` (with the framework session config the runtime
  requires) and launches `tension-core` with `--debug --symbol-path
  ${workspaceFolder}`. A second configuration,
  `lldb: tension-core (async-io, RELEASE — no DWARF, for comparison)`, exists so
  "it never hit" can be told apart from "this artifact has no DWARF".
- `examples/async-io/.vscode/tasks.json` — `build:debug`, `build:release`, and
  the `debug` chain, shaped exactly like `async-on-main`'s.

No existing configuration was changed; no source file was touched.

Measured stops in that build (`measurements/` — lldb 20.1.4):

```
asked  result   reported                      note
48     slid     game.ts:49 in pipeline$resume  first statement of pipeline()
49     exact    game.ts:49
50     exact    game.ts:50                    after the second await
60     slid     game.ts:62 in run$resume      first statement of run()
62     exact    game.ts:62
67     exact    game.ts:67                    after the task settled
73     exact    game.ts:73                    inside the frame loop (after await)
77     exact    game.ts:77
98     exact    game.ts:98 in _start_game
```

### Click path

1. Open `C:\work\Tension\examples\async-io` in VS Code; install
   `vadimcn.vscode-lldb` if prompted.
2. Breakpoint on `game.ts:49`. Pick **`lldb: tension-core --debug (async-io,
   promise backend)`**, press F5. Expect a stop at `game/pipeline$resume`,
   `game.ts:49` — a line *after* the first `await` in `pipeline()`.
3. Move the breakpoint to `game.ts:48` and press F5 again. Expect a stop one line
   later, on `game.ts:49`, in the same frame: the first-statement slide.
4. Optional, to watch async flow: break on `game.ts:73` and press Continue — it
   stops once per frame iteration (three times), each time in
   `game/run$resume`.

### One caveat, honestly

The build task itself is blocked on this machine by the W1 re-vendor:
`npm run build:debug` fails with
`package.json declares file:.packs/…-g150a6e974698.tar, the manifest says
file:.packs/…-g41b8721bc4f0.tar`. That is the known `$TENSIONSCRIPT` /
lockfile mismatch, out of scope this round and not worked around — the guest
measured above was built with the documented `$TENSIONSCRIPT` override. On a
machine whose lockfile and manifest agree, the task runs as written; here, the
user must run that one command by hand first (reported, not hidden).

## Gate

- `node --version` v26.12.1; lldb 20.1.4-codelldb.
- `.debug_line` dumps for four modules, prologue_end **0** in each.
- Phase B table: 30 cases over 13 functions across 4 modules; 21 obey, 8
  no-stop (all one module), 1 no-row.
- Phase C: outcome 1, transcript committed.
- Phase D: launch configuration named, stops measured, click path given.
- `cargo test --test debugger` → **5 passed, 0 failed**; the three that
  short-circuit on Windows are named in `measurements/gate-cargo-test-debugger.txt`.
- Both repos clean at the end.

## What this round did not do

- No compiler or runtime source change; no `encode.ts` edit.
- `docs/debugging.md` and `tension-core/tests/debugger.rs` untouched.
- No stack-switching work; `async-on-main` recorded as unusable here for that
  reason.
- No push.
