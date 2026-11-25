# W4 — does the fix work where the control exists?

Round: **W4 — does the compiler change produce the same behaviour on the machine
whose measurements defined the defect?** 2026-11-22. Branch `w4/dwarf-prologue`
(off `wb1/native-build` `f83380b`, merged with `w3/prologue-end` `8e63bd3`).
Nothing pushed; `main` at `56ddabb` untouched in both repos.

Primary lldb for every number: **20.1.4-codelldb**
(`tools/e2e-debugger/node_modules/@debugmcp/codelldb-win32-x64/lldb/bin/lldb.exe`).
No 23.1.5 cross-check was taken this round; nothing here is 23.1.5-shaped.

## Preflight

```
TensionScript  main @ 41b8721b
  git status --short         M third_party/binaryen
  submodule status           +1c8a8765… (tension-v131.0.0)   committed e84dfd8e
Tension        wb1/native-build @ f83380b   (clean)
  installed compiler version 0.14.1
  dist/assemblyscript.js    66e6932e6d0621f63be0d085d4ff83b35ca5d639341d0f54fdf5bbc275bbd9de
node v26.12.1 · lldb 20.1.4-codelldb
```

Matches the architect's preflight, including the two declared divergences:
`main` @ `41b8721b` (the brief said so), the installed pin `66e6932e`, and
`third_party/binaryen` at `1c8a8765` against the committed `e84dfd8e`. The
`M` is that divergence and was left alone.

**What the preflight did not say, and cost the round an hour:**
`TensionScript/third_party/binaryen-out/` did not exist, so `npm run build`
rebuilt Binaryen from the diverged submodule, and that local bundle
(`dist/binaryen.js`, 14 729 938 B, `-O1`) **cannot compile a stack-switching
guest** — `bin/tensionscript.js` dies with `RuntimeError: memory access out of
bounds` inside `resume_with_handlers`. The pin's own bundle (in the tarball,
25 837 014 B) can. Every number below was therefore taken with the pin's
bundle installed. See "one unasked-for finding".

## Phase A — the clean baseline, re-measured

Four modules rebuilt here with the clean pin (`66e6932e`), the brief's standard
commands:

```
io        examples/io/build/game.wasm              4b5760bc…  (12 843 B)
log       examples/log/build/game.wasm             40e4d4ed…  (13 176 B)
async-io  examples/async-io/build/game.wasm        e15a2db1…  (163 355 B)
promise   examples/async-on-main/build/game-promise.wasm  dcfff161…  (305 654 B)
```

W3's 30 breakpoints, same procedure (`tools/w3-prologue-end/phase-b-run.mjs`,
`cases-phase-b.json` untouched), same expected lines:
`measurements/phase-a.json`, `measurements/phase-a.log`.

```
exact                       15
slid                         7   (6 real + the no-row case)
no stop                      8
```

The six real sliders reproduced **exactly** as W3 reported:

| module | function | asked | stopped |
|---|---|---|---|
| io | game/_start_game | 10 | 11 |
| log | game/_start_game | 32 | 33 |
| async-io | game/pipeline | 48 | 49 |
| async-io | game/run | 60 | 62 |
| io | io/print | 73 | 74 |
| io | io/arg | 101 | 102 |

The seventh "slide" is `async-io game/_start_game` line 96, which has no row in
`game.ts` at all (the statement is inlined framework code); it stops at 98 and
W3 counted it `n/a`. The eight no-stops are the eight `async-on-main-promise`
cases. **The control reproduced. W3's 21 obey / 6 slide / 8 violate / 1 no-row
is confirmed on this host, today.**

## Phase B — build the patched compiler

`git checkout fix/dwarf-prologue` → **`c8fd330b`** (matches). Built here with
`npm run build` (14 s), which is esbuild + dts over the TypeScript; no
emscripten was involved, and none was needed.

The provenance gate:

```
1. built, before copying   d297c3a196bec2963c275aa0038cadf4dcd4e5cb855396b918471167e35b3e72
2. after copying to Tension d297c3a196bec2963c275aa0038cadf4dcd4e5cb855396b918471167e35b3e72
3. Linux at c8fd330b        d297c3a196bec2963c275aa0038cadf4dcd4e5cb855396b918471167e35b3e72
```

**Three out of three identical.** This machine's build of the patched compiler
is byte-identical to Linux's, which is what W1 found for the clean pin
(`66e6932e`, also reproduced here from a local build of `main`).

`dist/asc.js` is `cc8f13ff…` on both clean and patched — the brief's point that
hashing it proves nothing, confirmed.

The emitted artefacts all changed (patched → clean):

| artefact | patched | clean |
|---|---|---|
| io | `d25094fc…` | `4b5760bc…` |
| log | `200a9179…` | `40e4d4ed…` |
| async-io | `035edb09…` | `e15a2db1…` |
| async-on-main promise | `28d9f1fb…` | `dcfff161…` |
| async-on-main stack | `029a8c8b…` | `6a9da7c1…` |

All five differ. A patched line program is different bytes, as it must be.

## Phase C — the 30 breakpoints, again

`measurements/phase-c.json`, `measurements/phase-c.log`, and the joined table in
`measurements/phase-c-table.md`.

```
                        phase A            phase C
exact                      15                 21
slid                        7                  1   (the no-row case, line 96)
no stop                     8                  8
```

**slid: 6 → 0.**

The six former sliders, one by one (`measurements/phase-c2-six-sliders.json`,
re-measured on the end-state dist):

| module | asked | before | after |
|---|---|---|---|
| io | 10 | 11 | **10** exact |
| log | 32 | 33 | **32** exact |
| async-io | 48 | 49 | **48** exact |
| async-io | 60 | 62 | **60** exact |
| io (io.ts) | 73 | 74 | **73** exact |
| io (io.ts) | 101 | 102 | **101** exact |

- **Regressions: none.** Every case that stopped exactly in phase A still stops
  exactly (`phase-c-table.md`, column 7). The 21 exact after = the 15 from
  phase A + the 6 that used to slide.
- The eight `async-on-main-promise` cases are **unchanged: no stop**, as the
  brief required them to be. That guest never runs `main` here (I16b): the
  prompt build loads and exits 0 printing nothing.
- `async-io` line 96 still reports 98. That is not a slide — there is no row for
  line 96 in `game.ts` (`rowCountForRequestedLine: 0` in both phases), so lldb
  binds nothing at 96 and the stop at 98 is a different statement.

## Phase D — the marker is in the bytes

Read from each `.wasm`'s own `.debug_line` by W3's own reader, unchanged:
`dumps/*.summary.json`, `dumps/*.rows.txt`.

| module | rows | sequences | `DW_LNS_set_prologue_end` | `DW_LNS_set_epilogue_begin` |
|---|---|---|---|---|
| io | 3203 (was 3123) | 80 | **80** (was 0) | 0 |
| async-io | 3344 (was 3269) | 75 | **75** (was 0) | 0 |
| async-on-main promise | 4185 (was 4063) | 122 | **122** (was 0) | 0 |
| async-on-main stack | 4604 (was 4464) | 140 | **140** (was 0) | 0 |

**Exactly one per sequence, in every module.**

`standard_opcode_lengths`, emitted for opcodes `0x01..0x0c`:

```
0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1
```

which is DWARF4 §6.2.5.2: `0x09` (fixed_advance_pc) 1, `0x0a` (prologue_end) 0,
`0x0c` (set_isa) 1. The three opcodes W3 recorded as wrong are now right, and
the reader's `declaredLengthsThatDifferFromDwarf4Spec` list is empty.

First four rows of `_start_game`'s sequence in the patched `io` (sequence 62,
51 rows, `0x2259`–`0x2391`):

```
0x2259  game.ts:10:8  is_stmt  prologue_end   <- new: the leading edge, marked
0x2272  game.ts:10:8  is_stmt
0x2276  game.ts:10:2  is_stmt
0x2279  game.ts:11:8  is_stmt
```

Against W3's clean reading — same sequence started at `0x227e` with line 10's
own row and no marker — the sequence now begins 37 bytes earlier, at the body's
first byte, and the marker is on that leading edge.

`llvm-dwarfdump` 23.1.5 (`C:\msys64\clang64\bin`) reads the patched `io`
artifact: `dumps/io.dwarfdump-v.txt`, 80 rows flagged `prologue_end`, one per
sequence. The self-check against the reader: **3203 rows, 3203 identical**
(address, line, column, file index, flags). It still cannot read the
continuation modules.

## Phase E — the transform defect, where it may run

The four cases the brief named, measured with `phase-b-measure.mjs` and a direct
`lldb` batch run for `frame info` (`measurements/phase-e.json`):

| program | line | resolved | stopped | file:line |
|---|---|---|---|---|
| rt-guards | 92 | 1/1 | yes | `rt-guards.ts:92:7` in `…/rt-guards/_start_game` |
| rt-guards | 95 | 1/1 | yes | `rt-guards.ts:95:…` |
| spawn-join | 122 | — | no | guest refused before lldb |
| two-workers | 110 | — | no | guest refused before lldb |

`spawn-join` and `two-workers` are thread programs; their build carries
`--enable stack-switching`, and the runtime refuses them:

```
this guest uses continuations, which wasmtime does not support on this target
(windows) — recompile the guest without `--enable stack-switching` (the Promise
backend)
```

That is I16, named in the brief as out of scope. They cannot be measured here
at all.

**`rt-guards` does not show the no-source shape here.** Both lines stop, resolve
to one location, and report a file and a line. And they do so on **both**
compilers: I rebuilt `rt-guards` from the clean pin
(`f37c88e0…`) and measured 92 and 95 as exact before reinstalling the patch.

That is a difference from Linux's verdicts, and the honest statement of it is
narrow: Linux's 11 `no-source` cases were measured by the conformance harness,
on its own artefact set, with its own runner; here it is one program, at
`--optimizeLevel 0 --debug`, through `phase-b-measure.mjs`. The two are not the
same experiment, and I did not re-run the Linux harness on Windows. What can be
said: the one transform-defect case that runs on this host runs cleanly.

## One unasked-for finding

`TensionScript/dist/binaryen.js` rebuilt from the diverged submodule
(`1c8a8765`, `-O1`, 14 729 938 B) **cannot compile a stack-switching guest**:

```
RuntimeError: memory access out of bounds
  at n.resume_with_handlers (src/module.ts:…)
  at nC (src/builtins.ts:…)  ← compileCallExpressionBuiltin
```

Same trace on the clean **and** the patched compiler, so it is not the fix. With
the pin's own bundle (from
`.packs/yabgu_gm-tensionscript-0.14.1-g41b8721bc4f0.tar`, 25 837 014 B) the same
command succeeds. For every module this round measured, the choice does not
change a single output byte — verified both ways:

```
clean+local  io 4b5760bc  log 40e4d4ed  async-io e15a2db1  promise dcfff161
clean+pin    io 4b5760bc  log 40e4d4ed  async-io e15a2db1  promise dcfff161
```

so phases A and C are not contaminated by the swap. Recorded, not chased: it is
a build-provenance defect, not a debugger one, and `I16` is somebody else's
round.

## End state of the machine

Dist installed = the **clean pin** again (`66e6932e`), plus the pin's own
`binaryen.js` (`049d0269…`) — the only combination under which every module
builds. Every example artefact and every `tests/programs/build/debug` artefact
was rebuilt with the clean pin at the end, so nothing on disk is a patched
artefact wearing the pin's hash.

To put the patch back for a look:

```
cd C:\work\TensionScript && git checkout fix/dwarf-prologue && npm run build
copy dist\*.js C:\work\Tension\node_modules\@yabgu_gm\tensionscript\dist\
# leave binaryen.js as it is (the pin's)
```

## Gate

- `node v26.12.1`; lldb **20.1.4-codelldb**.
- Phase A reproduced W3: 15 exact / 6 slide / 1 no-row / 8 no-stop.
- Phase B: three hashes all `d297c3a1…`; five artefacts all changed.
- Phase C: `slid 6 → 0`; no regressions; 8 `async-on-main-promise` unchanged.
- Phase D: one `prologue_end` per sequence in all four modules; opcode array
  `0,1,1,1,1,0,0,0,1,0,0,1`.
- Phase E: 2 exact, 2 not runnable here (I16).
- `cargo test --test debugger` → **5 passed, 0 failed**
  (`measurements/cargo-test-debugger.txt`). Three short-circuit on Windows, at
  `tests/debugger.rs:469` (`a_source_breakpoint_binds_in_a_promise_guest`),
  `:556` (`a_guest_without_dwarf_cannot_be_stopped_at_a_source_line`) and
  `:613` (`a_source_breakpoint_binds_in_a_stack_switching_guest`). The brief
  said two; the file has three `if cfg!(windows)` returns.
- Both repos clean; `main` untouched in both; nothing pushed.

## What moved that should not have

Nothing in the source of either repo. The one non-behavioural change is the
`dist/binaryen.js` swap described above, which is a machine state, not a
repository edit, and which changed no measured byte.

`cargo test` needed `--no-default-features --features audio` on this host:
the default features pull `llama-cpp-2`, whose vendored CMake build fails here
(`MSBUILD : error MSB1009 … install.vcxproj`, and before that `No
CMAKE_C_COMPILER could be found`), unrelated to the debugger. With those
features off the binary is the same debugger path and all five tests run.
