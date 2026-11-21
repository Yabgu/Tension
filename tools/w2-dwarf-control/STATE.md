# W2 — the control experiment: `examples/io/game.ts`, lines 10/11/14/22

Round: **W2 — the differential, from the cleanest comparison available.**
Date 2026-11-21. Branch `w2/dwarf-first-statement` (off `main` `56ddabb`).
**Zero source changes** in either repo; nothing pushed.

## Why this comparison is the clean one

W1 measured `examples/io/game.ts` and found:

```
line 10 → resolves, stops at 11      ← first statement of _start_game
line 11 → stops at 11
line 14 → stops at 14
line 22 → stops at 22
```

Same file, same function, same compiler, same runtime, same lldb. Four source
lines, three good, one bad. Every other comparison in this investigation varies
two or three things at once (platform, lldb version, patched/unpatched). This
one varies only the line number.

## Environment (verbatim)

```
node --version                              v26.12.1
lldb (primary, all tables below)            lldb version 20.1.4-codelldb
                                            tools/e2e-debugger/node_modules/
                                            @debugmcp/codelldb-win32-x64/lldb/bin/lldb.exe
lldb (cross-check only, labelled where used) lldb version 23.1.5
                                            C:\msys64\ucrt64\bin\lldb.exe
llvm-dwarfdump                              LLVM version 23.1.5
                                            C:\msys64\clang64\bin\llvm-dwarfdump.exe
tension-core                                target/release/tension-core.exe (MSVC, static SDL3)
compiler                                    @yabgu_gm/tensionscript 0.14.1
                                            dist/assemblyscript.js sha256 66e6932e6d0621f6…
guest sha256                                81F9D86C79E638E08DC6D18E271A444DDC7A3FD3F2362FDAAB7EE9951F1A5E13
```

The guest was rebuilt from clean on this machine:

```
cd examples/io
node ..\..\scripts\tensionscript.mjs game.ts -o build\game.wasm \
  --runtime incremental --debug --sourceMap --exportStart __start
```

It hashes identically to the W1 artifact, so the control reproduces byte for
byte before any measurement is taken.

*(Provenance note: `npm run compiler:vendor` re-pinned the tarball to `41b8721b`
in W1, which now disagrees with the committed lockfile, so
`scripts/tensionscript.mjs` refuses to run. W2 used its documented escape hatch
`$TENSIONSCRIPT=<repo>/node_modules/@yabgu_gm/tensionscript/bin/tensionscript.js`,
which prints a "NOT the vendored pin" warning. The compiler binary that ran is
byte-identical to the clean pin — see the dist hash above — so the guests are
the pin's guests. No tracked file was edited. Reported, not worked around
silently.)*

## Phase A — the control, reproduced

Transcript: `phase-a-lldb-transcript.txt`. lldb 20.1.4-codelldb.

| asked | resolved | stopped | file:line reported | function |
|---|---|---|---|---|
| 10 | yes (1 location) | yes | **game.ts:11:8** | `game/_start_game` |
| 11 | yes (1 location) | yes | game.ts:11:8 | `game/_start_game` |
| 14 | yes (1 location) | yes | game.ts:14:23 | `game/_start_game` |
| 22 | yes (1 location) | yes | game.ts:22:13 | `game/_start_game` |

**Control holds.** Line 10 stops one line late; 11, 14, 22 stop exactly. Nothing
further in this round is meaningful if this table changes.

## Phase B — the DWARF's own side

Read from the `.wasm`'s sections (`.debug_line`, `.debug_info`, `.debug_ranges`)
with `llvm-dwarfdump` 23.1.5, then parsed by
`phase-b-parse.mjs` → `phase-b-dwarf-rows.json`. Not from `.wasm.map`, not from a
disassembly.

```
llvm-dwarfdump --debug-line   build\game.wasm   > w2-dwarfdump-line.txt
llvm-dwarfdump --debug-info   build\game.wasm   > w2-dwarfdump-info.txt
llvm-dwarfdump --debug-ranges build\game.wasm   > w2-dwarfdump-ranges.txt
```

Owning CU: `game.wasm`, `DW_AT_ranges` at `.debug_ranges` 0 with **3213** range
entries (row-granular tiling). Function DIE `game/_start_game`:
`DW_AT_low_pc 0x2265`, `DW_AT_high_pc 0x23aa` (length form).

| line | row addr | file idx | col | first of sequence | seq start | seq end | row # in seq | in CU ranges | containing range |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 0x227e | 61 | 8 | **yes (row 0)** | 0x227e | 0x239d | 0 | yes | [0x227e, 0x2282) |
| 10 | 0x2282 | 61 | 2 | no | 0x227e | 0x239d | 1 | yes | [0x2282, 0x2285) |
| 11 | 0x2285 | 61 | 8 | no | 0x227e | 0x239d | 2 | yes | [0x2285, 0x2289) |
| 11 | 0x2289 | 61 | 2 | no | 0x227e | 0x239d | 3 | yes | [0x2289, 0x228c) |
| 14 | 0x2290 | 61 | 8 | no | 0x227e | 0x239d | 6 | yes | [0x2290, 0x2294) |
| 22 | 0x234f | 61 | 13 | no | 0x227e | 0x239d | 36 | yes | [0x234f, 0x2357) |

`file_names[61]` is `"game.ts"`. Every row is the **start** of its own range
entry — the tiling is row-granular, so "inside a range" cannot separate these
rows, and does not.

Two structural facts fall out:

1. **Both line-10 rows precede every line-11 row**, and the sequence begins with
   the line-10 row at offset 0.
2. **The sequence starts 25 bytes after the function DIE's `DW_AT_low_pc`**
   (0x2265 → 0x227e). Those 25 bytes carry no line-table row at all: the
   function's prologue is unattributed code.

## Phase C — lldb's side, for the same addresses

Transcripts: `phase-c-lldb-transcript.txt`, `phase-e-imagelist-transcript.txt`.
Machine-readable: `phase-c-lldb-attribution.json`, `phase-c2-address-probe.json`.

**JIT image exists.** `image list`:

```
[ 27] 080A6C5B 0x000002611be31000 JIT(0x2611bf1e040) (0x2611bf1e040)
```

**lldb's registered line table is correct at both line-10 rows.** This is the
crucial measurement — `image lookup -a` at the address of each row answers with
the row's own line:

```
0x…9f20 → JIT(…).PT_LOAD[0]..text + 36640   game/_start_game at game.ts:10:8
0x…9fcd → JIT(…).PT_LOAD[0]..text + 36813   game/_start_game + 173 at game.ts:10:2
0x…9fd2 → JIT(…).PT_LOAD[0]..text + 36818   game/_start_game + 178 at game.ts:11:8
0x…9ffe → JIT(…).PT_LOAD[0]..text + 36862   game/_start_game + 222 at game.ts:14:23
0x…a09c → JIT(…).PT_LOAD[0]..text + 37020   game/_start_game + 380 at game.ts:22:13
```

`image lookup -n` for the function:

```
1 match found in JIT(0x…):
  Address: JIT(…)[0x…9f20]   Summary: JIT(…)`game/_start_game at game.ts:10:8
```

`image dump symtab`, same session:

```
[151] 152 Code 0x…8f20 0x…8f20 0x350 0x02 wasm[0]::function[156]::game/_start_game
```

The symbol's address (module offset `0x8f20`) **is** the line-10 row's address
(native `base + 0x8f20` = `0x…9f20`). Not `DW_AT_low_pc` (wasm `0x2265`), which
is 25 wasm-bytes earlier.

**The DWARF is in the registered image, under lldb's own names.**
`image dump sections` (`phase-c-lldb-sections-transcript.txt`):

```
0x0000000000000009 dwarf-abbrev   --- 0x000104d7 0x000000bc  JIT(…)..debug_abbrev
0x000000000000000a dwarf-str      --- 0x00010593 0x000000c0  JIT(…)..debug_str
0x000000000000000b dwarf-line     --- 0x00010653 0x000022cd  JIT(…)..debug_line
0x000000000000000d dwarf-ranges   --- 0x00012920 0x0001deb0  JIT(…)..debug_ranges
0x000000000000000f dwarf-loc      --- 0x000307d0 0x00006eec  JIT(…)..debug_loc
0x0000000000000011 dwarf-info     --- 0x000376bc 0x0000499a  JIT(…)..debug_info
0x0000000000000013 dwarf-frame    --- 0x0003c056 0x00001da0  JIT(…)..debug_frame
```

with `elf-relocation-entries` beside `debug_line`, `debug_ranges`, `debug_loc`
and `debug_info` (`rela.debug_line`, …). Nothing is missing from the guest's
side of the contract.

**What lldb actually binds.** Asked for line 10, the breakpoint's single
location is `0x…9fd2`, and lldb reports that location's own line entry as
**11**:

```
bp 1 (line 10) → load_address 0x…9fd2, line_entry game.ts:11
bp 2 (line 11) → load_address 0x…9fd2, line_entry game.ts:11
bp 3 (line 14) → load_address 0x…9ffe, line_entry game.ts:14
bp 4 (line 22) → load_address 0x…a09c, line_entry game.ts:22
```

Lines 10 and 11 bind to **the same address**. A *function* breakpoint
(`breakpoint set -n "game/_start_game"`) also stops at `0x…9fd2`, i.e. line 11,
not at the symbol's own address `0x…9f20`.

**A probe that could not answer its question, recorded rather than dropped.**
`phase-c2-address-probe.json`: after the line-10 stop, breakpoints were created
at line 10's own two row addresses (ids 2 and 3, one location each), then the
process was continued. Neither was hit — both addresses are behind the PC by the
time the JIT image exists — so "does a breakpoint *on* the line-10 row report
line 10?" is **unanswered** by that probe. `image lookup -a` answers the same
question without executing, and says yes (line 10).

## Phase D — the differential

| line | expected | resolved | stop line | row addr | first of seq? | in CU ranges? | in JIT image? | lldb lookup -a |
|---|---|---|---|---|---|---|---|---|
| 10 | 10 | yes | **11** | 0x227e (+0x2282) | **yes** (row 0) | yes | yes (`+36640`) | `game.ts:10:8` ✅ |
| 11 | 11 | yes | 11 | 0x2285 (+0x2289) | no (row 2) | yes | yes (`+36818`) | `game.ts:11:8` |
| 14 | 14 | yes | 14 | 0x2290 (+4 more) | no (row 6) | yes | yes (`+36862`) | `game.ts:14:23` |
| 22 | 22 | yes | 22 | 0x234f | no (row 36) | yes | yes (`+37020`) | `game.ts:22:13` |

(native offsets are `..text + N` as `image lookup -a` reports them; one run's
numbers — the JIT base moves between runs, the offsets do not.)

### What is different about line 10

Line 10's first row is the **first row of its sequence and sits at the
sequence's start address** (wasm `0x227e`, native `..text + 36640`), and that
address is also the address of the `game/_start_game` **symbol** (module offset
`0x8f20`); lines 11, 14 and 22 are rows 2, 6 and 36 of the same sequence, 7, 18
and 209 wasm-bytes into it. The DWARF and lldb's registered line table both
attribute the line-10 row addresses to line 10 correctly — `image lookup -a`
answers `game.ts:10:8` and `game.ts:10:2` — but the breakpoint lldb *binds* for
line 10 is at `..text + 36818`, 178 native bytes later, which is the first row
of the **line-11** range; asked for line 10 lldb sets the breakpoint on the next
distinct source line instead. A function breakpoint behaves identically: it
stops at `..text + 36818`, not at the symbol address `..text + 36640`. Lines
11, 14 and 22 are not at the symbol's start, so nothing moves.

In one sentence: **line 10's rows are the function-entry region lldb skips; the
other three lines' rows are not.** Nothing about line 10 is malformed — the row
exists, resolves, is inside the CU ranges, and is reported correctly by
`image lookup -a`; it is simply the address lldb treats as the function's entry
and therefore refuses to put a breakpoint on.

## Phase E — the false claims W1 found (evidence only; nothing rewritten)

See `phase-e-false-claims.md` for the three quotes, line numbers, and the
transcripts that contradict them.

## Phase F — what can be debugged here today

See `phase-f-what-works.md`.

## Gate

- `node --version` v26.12.1; lldb 20.1.4-codelldb (primary), 23.1.5 (cross-check).
- The four-line control reproduced (Phase A), guest hash identical to W1.
- Phase B table for four rows, from `.debug_*` sections.
- Phase C lldb output for four addresses plus the function symbol.
- `cargo test --test debugger` → **5 passed, 0 failed**; three of the five take a
  `cfg!(windows)` early return (not two — measured; see phase E).
- Both repos clean at the end (see the commit that adds this directory).

## What this round did not do

- No fix, no patch, no compiler or runtime edit, no branch carrying either.
- `docs/debugging.md` and `tension-core/tests/debugger.rs` untouched.
- The stack-switching refusal (13 of 24 conformance programs on Windows) is real
  and out of scope here.
