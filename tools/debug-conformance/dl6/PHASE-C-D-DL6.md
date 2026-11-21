# Phase C and D — the marker, and what it bought

## The two edits (compiler commit `e72eb823`, branch `fix/dwarf-prologue`)

1. **`standard_opcode_lengths`** corrected for `0x09`, `0x0a`, `0x0c` per DWARF4
   §6.2.5.2. Before: `[0,1,1,1,1,0,0,0,0,1,0,0]`. After: `[0,1,1,1,1,0,0,0,1,0,0,1]`.

   Verified on the emitted artifact (`first-branch.wasm`, read straight out of
   the `.debug_line` custom section with a byte-level reader, not a disassembly):

       unit_length 15741  version 4  header_length 2924
       min_inst_len 1  max_ops_per_inst 1  default_is_stmt 1
       line_base -5  line_range 14  opcode_base 13
       standard_opcode_lengths 1..12: [0,1,1,1,1,0,0,0,1,0,0,1]
       DWARF4 6.2.5.2              : [0,1,1,1,1,0,0,0,1,0,0,1]   matches: True

   This change bought **no conformance case**. lldb knows `0x0a` and reads the
   program past it either way. It is corrected because a library that does not
   know the opcode skips by this table, and because the commit that starts
   emitting `0x0a` is not the one to leave the table lying about it.

2. **`DW_LNS_set_prologue_end` on exactly one row of every sequence**, with no
   condition. `marked` is set by whichever of the two paths emits first, so
   every sequence is covered exactly once; the `head.addr > seqStart` gate is
   gone.

## Where the marker lands — measured two ways

| placement | pass | no-source | wrong-line |
|---|---|---|---|
| marker on the sequence's first row, at the body's first byte (the **edge row**) | **71** | **11** | 0 |
| marker on the first row naming a source line | 66 | 16 | 0 |

The second is the boundary the round's brief pointed at. It **loses five cases**:
`main_policy#1`, `fallback_loop#1`, `main_step_replaced#1`, `schedule_order#9`,
`spawn_refusals#1`, all of which pass with the edge row. The commit keeps the
edge row and says so.

Verified in the dump that the marker is where the code says: every sequence has
exactly one `prologue_end`, on its first row.

## Phase D — the matrix

Engine `tension-core/target/release/tension-core` (rebuilt DL5, 2026-11-21,
`async backend: continuations`, `stale: false`), `--workers 8`, 82 cases.

    pass         59 -> 71
    no-source    17 -> 11
    wrong-line    6 -> 0
    unresolved    0 -> 0
    no-stop       0 -> 0
    skipped       0 -> 0

**12 cases moved, every one failure → pass, no pass regressed:**

    async_statement_before_await      wrong-line(12, exp 11) -> pass
    class_method                      wrong-line(14, exp 13) -> pass
    schedule_order.transcript#1       wrong-line(148, exp 147) -> pass
    schedule_order.transcript#3       wrong-line(155, exp 154) -> pass
    schedule_order.transcript#5       wrong-line(162, exp 161) -> pass
    schedule_order.transcript#7       wrong-line(169, exp 168) -> pass
    main_policy.transcript#1          no-source -> pass
    fallback_loop.transcript#1        no-source -> pass
    main_step_replaced.transcript#1   no-source -> pass
    schedule_order.transcript#9       no-source -> pass
    thread_count.transcript#1         no-source -> pass
    spawn_refusals.transcript#1       no-source -> pass

## The eleven that did not move

All eleven are the first statement of a function:

    first_statement_print       first-statement.ts:7      locations 2
    first_statement_branch      first-branch.ts:5         locations 2
    first_statement_loop        first-loop.ts:6           locations 2
    task_entry_first_statement  task-entry.ts:8           locations 2
    lambda_body                 lambda-body.ts:10         locations 2
    second_function_in_file     second-function.ts:10     locations 2
    entry_surface_main          start-game-entry.ts:8     locations 2
    rt_guards.transcript#1      rt-guards.ts:92           locations 1
    rt_guards.transcript#2      rt-guards.ts:95           locations 2
    spawn_join.transcript#1     spawn-join.ts:122         locations 2
    two_workers.transcript#1    two-workers.ts:110        locations 2

**The marker is not the problem, and this round proves it per case.** For each
of the eleven the JIT object was extracted and the address lldb actually stops
at was tested against the CU's own `DW_AT_ranges`:

    case                          hit address           in CU ranges   hole before next run
    first_statement_print         0x7ffff755dae0        False          0x62 B
    first_statement_branch        0x7ffff755dae0        False          0x64 B
    first_statement_loop          0x7ffff754a841        False          0x5f B
    task_entry_first_statement    0x7ffff5ae5400        False          0x5e B
    second_function_in_file       0x7ffff5951b60        False          0x62 B
    entry_surface_main            0x7ffff5b0cae0        False          0x5e B
    rt_guards#1                   0x7ffff751f6fa        False          0x88 B
    rt_guards#2                   0x7ffff751f72e        False          0x54 B
    spawn_join#1                  0x7ffff74ca09a        False          0x3e B
    two_workers#1                 0x7ffff74c70f7        False          0x10 B
    lambda_body                   0x7ffff7543ae0        False          0x61 B
    ------------------------------------------------------------------------------
    first_after_decls (PASSES)    0x7ffff7549837        True           —

**11 of 11 failing stops are outside every CU range; the passing control is
inside.** The prologue_end row is the row that lands in that hole, which is why
marking it fixes the *line* for two-location cases (the second location is
covered and correct) but cannot make the stop report source: lldb stops at the
uncovered address first, because it is the function's entry.

The compiler's own object has 0 of 2283 rows outside its ranges. The object
wasmtime hands lldb has 199 of 1025 outside (19.4%). The ranges are the
transform's, not the emitter's — DL5's phase-D result, unchanged by this round.
