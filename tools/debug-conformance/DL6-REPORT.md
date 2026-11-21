# DL6 report — the eleven first statements, and a faster harness

Round DL6. Brief `~/work/_cw/roundDL6.brief.txt`, 2026-11-22.
Compiler `~/work/TensionScript-a2` branch `fix/dwarf-prologue` @ `c8fd330b`.
Harness `~/work/Tension` branch `fix/dwarf-conformance`.

## Headline

The owner's line works. `examples/async-on-main/game.ts:77` stops at
`game.ts:77` in `game/main`, three runs out of three, on the shippable release
engine — and reports no source with the same engine on a guest built by the
unpatched compiler.

The suite goes **59 pass / 17 no-source / 6 wrong-line → 71 / 11 / 0**. Twelve
cases move, all failure → pass, no pass regresses. The eleven that remain are
proven, per case, to be a different defect: **the address lldb stops at is
outside every compile-unit range**, 11 of 11, while the passing control case is
inside.

## 1. Phase 0 — durability

| | Tension | TensionScript-a2 |
|---|---|---|
| branch / HEAD | `fix/dwarf-conformance` / `497cc83` | `fix/dwarf-prologue` / `a82c1536` |
| `git status --short` | clean | clean |
| `origin/<branch>` before | `497cc83` (equal) | branch did not exist |

Pushed, each verified with `git rev-parse --show-toplevel` first (one branch
name, two repositories):

    /home/acakar/work/TensionScript-a2  ->  github.com/Yabgu/TensionScript.git
      fix/dwarf-conformance       6424085ec9823cafccfe7f966974ad997f1173e7
      fix/dwarf-first-statement   0f771d74ae51243526d08cccfdba67b301c20927
      fix/dwarf-prologue          a82c153645dc06a45cab54aec18c749c360df2be
    /home/acakar/work/Tension           ->  (harness remote)
      fix/dwarf-conformance       497cc838d64cb6a90a87aee0104b325345095343

Push only: no merge, no rebase, no force, no delete, no PR, no commit to `main`
in either repo. **Asymmetry:** this protects everything up to the push. The
commits made after it this round (five in the compiler tree, four in the
harness) are not on either remote.

## 2. Phase A — the A/B, and DL5's claim is withdrawn

DL5 reported "`class_method` passes on a capable engine without DL3's patch".
That could not have been true: every artifact DL5 measured was built at
`a82c1536`, which *contains* the patch. There was no unpatched reference.

Built one: a detached worktree at `41b8721b`, the 24 artifacts rebuilt
`--force`, the same 82 cases on the same engine.

| side | commit | `dist/assemblyscript.js` sha256 |
|---|---|---|
| unpatched | `41b8721b` | `66e6932e…bbd9de` |
| patched | `a82c1536` | `6202020e…09ed827` |

`dist/asc.js` is byte-identical on both sides (`cc8f13ff…`); the compiler is
`assemblyscript.js`. All 24 artifact hashes differ between the sides
(`dl6/artifacts-unpatched.sha256`, `artifacts-a82c1536.sha256`).

    unpatched  59 pass / 17 no-source / 6 wrong-line
    patched    71 pass / 11 no-source / 0 wrong-line

**12 cases differ, all failure → pass.** `class_method` is `wrong-line`
(stopped at 14, expected 13) unpatched. **The patch is load-bearing, by twelve
cases rather than the one DL3 measured.** DL5's claim is withdrawn.

## 3. Phase B — the throughput fix

`runner.js` takes `--workers N` (default 8), prints one line per completed case
(`ok 12/82 name`, else the verdict and its detail), and records `workers` in the
capture header. The classification moved to `lib/cases.js`; `--workers 1` runs it
inline, the pool runs it in `lib/case-worker.js`, so there is one implementation
and the two paths cannot disagree. The load probe stays on the main thread — it
is cached per (program, executors) and re-probing per worker would measure the
same fact eight times.

`--only` also learned that an **exact name wins**: the needle `transcript#1`
matched `#1`, `#10` and `#11`, so the first run of this check silently selected
twenty-one cases instead of twenty. Found by the check, not by reading the code.

The check, `dl6/serial-parallel-subset.txt`, 20 cases, same engine:

    --workers 1   11 no-source / 9 pass
    --workers 8   11 no-source / 9 pass
    differing: none          same name set in all three lists

Verdicts **and** observed lines identical, 20/20 (`dl6/serial-20.json`,
`dl6/parallel-20.json`). Serial ≈ 7 min; 8 workers ≈ 75 s.

## 4. Phase C — the two edits

1. **`standard_opcode_lengths`** corrected for `0x09`, `0x0a`, `0x0c` per DWARF4
   §6.2.5.2. The emitted header, read byte-wise out of `.debug_line`:

       opcode_base 13
       standard_opcode_lengths 1..12: [0,1,1,1,1,0,0,0,1,0,0,1]
       DWARF4 6.2.5.2              : [0,1,1,1,1,0,0,0,1,0,0,1]   matches: True

2. **`DW_LNS_set_prologue_end` on exactly one row of every sequence**, no
   condition, no gate. The candidate patch's gate (`head.addr > seqStart`) was
   false exactly when the body's first mapped row sits at the body's first byte.
   Verified in the dump: each sequence carries exactly one `prologue_end`.

Where the marker lands was **measured both ways**, because the brief's suggested
boundary is not the one that wins:

| placement | pass | no-source |
|---|---|---|
| on the sequence's first row, at the body's first byte | **71** | **11** |
| on the first row naming a source line (the brief's boundary) | 66 | 16 |

The brief's boundary loses `main_policy#1`, `fallback_loop#1`,
`main_step_replaced#1`, `schedule_order#9`, `spawn_refusals#1`. The commit keeps
the edge row and records the departure.

One unit assertion was updated, not weakened: `tests/debug/unit/dwarf.js`
asserts the emitted line program byte for byte, and the marker adds one byte.
The expected sequence is still the whole sequence and now pins the marker too.

## 5. Phase D — the matrix

Engine `tension-core/target/release/tension-core` (rebuilt by DL5, 2026-11-21,
`async backend: continuations`, `stale: false`), `--workers 8`, 82 cases, run
twice on the same compiler binary — **per case identical both times**.

    pass         59 -> 71
    no-source    17 -> 11
    wrong-line    6 -> 0
    unresolved    0 -> 0
    no-stop       0 -> 0
    skipped       0 -> 0

Moved (12, all up):

    async_statement_before_await     wrong-line(12, exp 11) -> pass
    class_method                     wrong-line(14, exp 13) -> pass
    schedule_order.transcript#1      wrong-line(148, exp 147) -> pass
    schedule_order.transcript#3      wrong-line(155, exp 154) -> pass
    schedule_order.transcript#5      wrong-line(162, exp 161) -> pass
    schedule_order.transcript#7      wrong-line(169, exp 168) -> pass
    main_policy.transcript#1         no-source -> pass
    fallback_loop.transcript#1       no-source -> pass
    main_step_replaced.transcript#1  no-source -> pass
    schedule_order.transcript#9      no-source -> pass
    thread_count.transcript#1        no-source -> pass
    spawn_refusals.transcript#1      no-source -> pass

Not moved (11, all `no-source`, all the first statement of a function):
`first_statement_print`, `first_statement_branch`, `first_statement_loop`,
`task_entry_first_statement`, `lambda_body`, `second_function_in_file`,
`entry_surface_main`, `rt_guards#1`, `rt_guards#2`, `spawn_join#1`,
`two_workers#1`.

**Do the eight first-statement cases pass? No.** **Did anything regress? No.**

`game.ts:77` — `dl6/game-77.txt`, three runs:

    {"stopped":true,"hit_breakpoint":true,"file":"game.ts","line":77,
     "function":"game/main","breakpoints":[{"id":1,"locations":2,"resolved":2}]}
    e2e: guest stopped at game.ts:77 (game/main)

and the same command on the guest the unpatched compiler builds:

    {"stopped":true,...,"file":"","line":0,"function":"",
     "breakpoints":[{"id":1,"locations":2,"resolved":2}]}
    e2e: guest stopped at :0 (?)

## 6. Phase E — the transform memo

`dl6/PHASE-E-DL6.md`. Three options with their measured row and case effects:
patch vendored wasmtime (up to 199/1025 rows, up to 11/11 cases, needs the
standing rule lifted by name); work around it in the compiler (the additive
whole-body range buys **1 row of 201**; the module-wide range is dropped
entirely because `translate_ranges_raw` returns `None` for `start == 0`; not
emitting a row in the prologue was **not built** and is bracketed at 59–66 pass,
below 71); or report upstream and record it (0 rows, 0 cases, nothing to
maintain). No recommendation — that is the user's call.

## 7. Why the eleven fail — the round's decisive measurement

For each of the eleven, the JIT object was extracted from the running process
and the address lldb actually stops at was tested against the CU's own
`DW_AT_ranges` (`dl6/PHASE-C-D-DL6.md` has the table):

    first_statement_print        0x7ffff755dae0   outside   0x62 B hole
    first_statement_branch       0x7ffff755dae0   outside   0x64 B hole
    first_statement_loop         0x7ffff754a841   outside   0x5f B hole
    task_entry_first_statement   0x7ffff5ae5400   outside   0x5e B hole
    second_function_in_file      0x7ffff5951b60   outside   0x62 B hole
    entry_surface_main           0x7ffff5b0cae0   outside   0x5e B hole
    rt_guards#1                  0x7ffff751f6fa   outside   0x88 B hole
    rt_guards#2                  0x7ffff751f72e   outside   0x54 B hole
    spawn_join#1                 0x7ffff74ca09a   outside   0x3e B hole
    two_workers#1                0x7ffff74c70f7   outside   0x10 B hole
    lambda_body                  0x7ffff7543ae0   outside   0x61 B hole
    first_after_decls (PASSES)   0x7ffff7549837   INSIDE    —

**11 of 11 failing stops are outside every CU range; the passing control is
inside.** The row that lands in the hole is the sequence's leading-edge row —
the row the marker sits on, which is why marking it fixes the *line* wherever a
second, covered location exists and can never make the stop report *source*
where the function's entry itself is uncovered. The compiler's own object has
**0 of 2283** rows outside its ranges; the object wasmtime hands lldb has **199
of 1025** (19.4%).

## 8. Gates

| suite | result |
|---|---|
| `npm run check` | **exit 0** (after the unit-test update, re-run) |
| `npm test` | **exit 0, 71 checks** |
| `npm run test:debug:unit` | **5 + 5**, parity 1155 B |
| `npm run test:debug` | **2 PASS** (`add-locals` 2 stops/5 vars, `await-locals` 1 stop/2 vars) |
| Tension `debugger` test | **5 passed, 0 failed** (18.02 s) |
| census | **114 unreachable, 8 improved / 0 worse** — unchanged from DL5 |
| conformance, 82 cases | **71 pass / 11 no-source / 0 wrong-line / 0 skipped**, twice, per case identical |
| serial vs parallel (20) | **identical 20/20**, workers 1 and 8 |
| `game.ts:77` | **stops at game.ts:77**, 3/3 |

Declared delta in the brief was zero for the taxonomy's sake and a claimed
change in `pass`. `pass` moved 71 → 71 relative to DL5's *patched* baseline,
but DL5's baseline was mislabelled: the true unpatched baseline is 59, and this
round's answer is 71 with a compiler whose two edits are now measured
individually.

## 9. Files

Compiler (`~/work/TensionScript-a2`, `fix/dwarf-prologue`):
- `src/dwarf/encode.ts` — opcode lengths corrected; `prologue_end` unconditional, edge-row placement (`e72eb823`)
- `tests/debug/unit/dwarf.js` — expected line-program byte sequence now includes the marker (`c8fd330b`)

Harness (`~/work/Tension`, `fix/dwarf-conformance`):
- `tools/debug-conformance/lib/cases.js` — new: one case, run and classified
- `tools/debug-conformance/lib/case-worker.js` — new: the pool's worker
- `tools/debug-conformance/runner.js` — `--workers`, progress lines, exact-name `--only`
- `tools/debug-conformance/README.md` — workers, progress, `--only` semantics
- `tools/debug-conformance/STATE.md` — DL6 (DL5's moved to `STATE-DL5.md`)
- `tools/debug-conformance/DL6-REPORT.md` — this file
- `tools/debug-conformance/dl6/PHASE-A-DL6.md` — the A/B
- `tools/debug-conformance/dl6/PHASE-C-D-DL6.md` — the marker and the matrix
- `tools/debug-conformance/dl6/PHASE-E-DL6.md` — the memo
- `tools/debug-conformance/dl6/game-77.txt` — the owner's line, before and after
- `tools/debug-conformance/dl6/ab-unpatched.json`, `final.json`, `v1.json`, `v2.json` — captures
- `tools/debug-conformance/dl6/serial-20.json`, `parallel-20.json` — the check
- `tools/debug-conformance/dl6/serial-parallel-subset.txt` — the 20 names
- `tools/debug-conformance/dl6/artifacts-*.sha256` — which compiler built which artifacts
- `tools/debug-conformance/dl6/extract-object.py` — JIT object extraction

## 10. What I did not verify, and what I assumed

- **The eleven are not fixed.** 71 of 82, not 82. The route to them is a
  vendored-wasmtime change or an upstream fix, and neither is in this round.
- **The transform has not been instrumented.** "The input tiles perfectly and the
  output does not" is strong, and matches `translate_ranges_raw`'s source, but no
  logging was added to the vendored crate — it is out of bounds by standing rule.
  The decisive experiment is named in `PHASE-E-DL6.md`.
- **The compiler-side workaround that would avoid the hole was not built** (drop
  the leading-edge row and mark the first mapped row instead). Its effect is
  bracketed by two adjacent measurements (59 and 66 pass), not measured.
- **Only the release engine was used for the round's numbers.** `final.json`
  records `async backend: continuations`, `stale: false`. I did not re-run the
  matrix on the debug engine this round; DL5 measured them per-case identical.
- **Two runs of the same compiler binary, not two builds.** `v1.json` and
  `final.json` agree per case, and the two builds produced a byte-identical
  `dist/assemblyscript.js` (`d297c3a1…`) and 24 byte-identical artifacts, so this
  is close to a rebuild-independence check but not a cross-machine one.
- **`llvm-dwarfdump` cannot read the `.debug_*` sections of the fourteen
  continuation-module `.wasm` files** at all (`error: … bad form`), and it cannot
  read the unpatched build either — pre-existing, unrelated to this round. Where
  that mattered I read the JIT object's ELF or parsed the wasm's section bytes
  myself.
- **The unit-test change is a test *of ours* being updated to the new emitted
  bytes.** It is still an exact whole-sequence assertion. Anyone reading "1 test
  changed" should check that claim against the diff, which is in `c8fd330b`.
- Assumed: `--json` captures from `--workers 8` are ordered by case rather than
  by completion (they are re-ordered into `results[index]` before writing, and
  the earlier serial/parallel comparison would have caught a mismatch).
- **No Windows work, no `docs/debugging.md` rewrite, no `debugger.rs` change, no
  edits to `third_party/`, no PR, no push to `main`.**
