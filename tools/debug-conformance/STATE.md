# DL4 state — diagnosis only, no fix

Round: **DL4 — find where the address is lost, not another patch.**
Brief: `~/work/_cw/roundDL4.brief.txt`. Date 2026-11-21.
DL3's result (one case fixed, owner's line still unresolved): `DL3-REPORT.md`,
its state kept as `STATE-DL3.md`.

**No fix is attempted this round.** `src/dwarf/encode.ts` is untouched;
`fix/dwarf-prologue` @ `64222b3b` stays as it was, unmerged, unmodified.

## Phase A — done, committed

`TensionScript-a2` `fix/dwarf-prologue` **`a82c1536`**.

Three `no-unused-vars` warnings in `tests/debug/lib/dwarf-reader.js` (516, 518,
630) were variables that existed only to advance a cursor. Fixed by keeping only
the offset — `at = uleb(bytes, at)[1]` — no lint-disable, no rule change.
`npm run check` → **exit 0**. `npm run test` → **exit 0, `[ SUCCESS ]` 71 checks**.
Census byte-identical (24 modules, 18336 lines, 114 unreachable, 0 unpaired).

## Phase B — the DWARF's own account (committed: `dl4/dwarf-side.json`)

For each case: every line-table row for the requested line, the owning CU's
`DW_AT_low_pc`/`high_pc` (absent — the CU carries `DW_AT_ranges` only) with its
range list, and whether each row address is inside a range.

    case                    file:line              rows  spans    first row of seq  in CU ranges
    first_statement_branch  first-branch.ts:5       3    1,2,2    0x12b5           all 3
    first_statement_print   first-statement.ts:7    3    1,4,0    0x12b5           all 3
    class_method            class-method.ts:13      3    23,4,3   0x1fe3           all 3
    io line 10              game.ts:10              3    25,4,3   0x2259           all 3
    io line 14              game.ts:14              5    4,2,14,15,3  0x2284        all 5

**The compiler's DWARF is self-consistent**: 3123 rows over 80 sequences, every
row inside a CU range, ranges tiling 11475 of a 11675-byte span with 169 one-byte
alignment gaps. Nothing here explains the failure.

## Phase C — lldb's account (committed: `dl4/lldb-cases.json`)

Per case: the JIT image's `.text` base/end, breakpoint locations, the stop PC and
its resolved line, and **every** line-table row with lldb's verdict.

    case  base          end           rows  attributed  outside CU  stop
    io10  0x…61db000    0x…61e7000    1410      1155        255    game.ts:10 at pc+0x8f00
    io14  0x…5fda000    0x…5fe6000    1410      1155        255    none        (pc+0x8fde)
    fb5   0x…620c000    0x…6216000    1030       829        201    none        (pc+0x4b80 keepalive)
    fs7   0x…620c000    0x…6216000    1025       826        199    none        (pc+0x4b60 keepalive)
    cm13  0x…61f2000    0x…61fd000    1233      1007        226    class-method.ts:13 at pc+0x8660

**0 of 6108 rows fall outside the registered image.** Every failing verdict is a
row lldb has in its line table and cannot attach to a compile unit.

## Phase D — the decisive measurement (committed: `dl4/jit-object-stats.txt`)

The object wasmtime hands lldb was read out of the live process at the JIT
descriptor address (ELF64 REL, 888248 bytes, 26 sections) and dumped with
`llvm-dwarfdump`:

    .debug_ranges   7656 pairs, 5651 duplicates (74%), 187 gaps totalling 16363 bytes
                    15312 relocations on 7656 pairs
    .debug_line     1410 rows, all inside .text, 80 relocations
                    255 rows (18.1%) OUTSIDE the object's own CU ranges

The same 255 lldb reports. The invariant *every line address is inside a CU
range* is broken **in the object**, before lldb sees it.

## Phase E — attribution

`DL4-REPORT.md` §4. Short form: the range transform
(`translate_ranges_raw` / `TransformRangeIter`, wasmtime-internal-cranelift
50.0.2 `src/debug/transform/address_transform.rs`) maps a range list split at
line-row granularity onto per-instruction slivers (74% duplicates, 16 KB
uncovered), while `clone_line_program` (`line_program.rs`) emits a row per
compiled instruction without consulting those ranges. The trigger is the
compiler's row-granular splitting in `src/dwarf/index.ts`; the invariant break is
in the transform; the next patch belongs in the compiler's range emitter.

## Gates

| gate | expected | measured |
|---|---|---|
| `npm run check` | green | **exit 0** |
| `npm run test` | unchanged | **exit 0**, `[ SUCCESS ] 71 checks` |
| `npm run test:debug:unit` | 5 + 5 | 5 + 5 |
| `npm run test:debug` | 2 PASS | 2 PASS |
| Tension `debugger` suite | 5 passed | 5 passed |
| census | 114 / 0 | 114 / 0, ratchet 8 improved 0 worse |
| conformance, 82 cases | 63 / 7 / 0 / 12 | see below |
