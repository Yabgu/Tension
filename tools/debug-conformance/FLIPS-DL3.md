# DL3 flip table — candidate patch vs the red baseline

Inputs, both committed, both 82 cases over the same 24 programs and the same
`matrix.json` (this file and the matrix were not touched between the two runs):

- before: [`red-capture-2026-11-21.json`](red-capture-2026-11-21.json) — clean
  compiler, reproduced byte-identically by
  [`red-reproduced-2026-11-21.json`](red-reproduced-2026-11-21.json).
- after: [`green-2026-11-21.json`](green-2026-11-21.json) — the same compiler
  with `0f771d74` (`fix/dwarf-first-statement`, cherry-picked unchanged onto
  `fix/dwarf-conformance` as `64222b3b`), artifacts rebuilt with `--force`.

## By failure mode

    unresolved            63 -> 63     (-0)
    stopped, no source     7 ->  7     (-0)
    stopped at wrong line  1 ->  0     (-1)
    pass                  11 -> 12     (+1)
    total                 82 -> 82

**One case flipped, and it is the wrong-line case.** Every `unresolved` case is
still unresolved and every `no source file` case still stops in a file we did
not ask for. The patch changes which failure mode one case is in; it does not
close the two large classes.

## The one flip

    class_method   class-method.ts:13
      before  stopped at 14   (locations 1, resolved 1)
      after   pass            (line 13)

Line 13 is the first statement of the method body; line 14 is the statement
after it. Before the patch, the breakpoint bound to the function and lldb
attributed it to the second row of the sequence — the row that starts after the
prologue — which is exactly the "right file, wrong line" complaint.

## pass -> fail

**None.** No regression; all 11 pre-existing passes are still passes
(`first_statement_after_declarations`, `promise_backend_before_await`,
`class_constructor`, and 8 of `rt_guards.transcript#3..#10`).

## Did not move — 70 cases

- `unresolved`, 63 — every async, stack-switching, thread and transcript case:
  `async_statement_before_await`, `async_statement_after_await`,
  `async_resume_in_loop`, `stack_switch_nested_resume`,
  `task_entry_first_statement`, `entry_surface_main`, all of `async_on_main`
  (4), `main_policy` (4), `fallback_loop` (6), `main_step_replaced` (4),
  `schedule_order` (14), `thread_count` (5), `spawn_join` (7),
  `two_workers` (8), `spawn_refusals` (5).
- `stopped with no source file (empty)`, 7 — `first_statement_print`,
  `first_statement_branch`, `first_statement_loop`, `lambda_body`,
  `second_function_in_file`, `rt_guards.transcript#1`, `rt_guards.transcript#2`.
- `pass`, 11 — the regression guards above.

**A note on the owner's complaint.** The complaint is
`examples/async-on-main/game.ts:77`, `print("main: begin")` — the first
statement of an `async function` body, before any suspend. The matrix's closest
rows are `async_on_main.transcript#1..#4` (`async-on-main.ts:50,61,62,63`,
inside `export async function main()`), and all four are `unresolved` before
**and** after the patch. So this patch does not fix the reported symptom; it
fixes a different one-line case (`class_method`) that happens to be in the
wrong-line class.

## What this means for the three mechanisms

The three failure modes need three explanations and the patch supplies one
partial one:

1. **wrong line (1 case)** — explained and closed by the patch: a sequence that
   starts at the first *mapped* row leaves the method's first statement with no
   row of its own, and the debugger falls through to the next one.
2. **no source file (7)** — untouched. The breakpoint resolves, the guest stops,
   and the frame names no file (`(empty)`): the stop is in code the line program
   does not describe, not in code it describes badly.
3. **unresolved (63)** — untouched. `locations 0` means lldb matched no address
   at all — the line is absent from the line program, or present with no span.
   The async/thread/transcript cases dominate this class.
