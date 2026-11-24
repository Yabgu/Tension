# The debug conformance gate

Every feature we have, asked of the debugger: *does a source breakpoint in this
line stop here, in this file?*

The matrix is [`matrix.json`](matrix.json) and **cases are added there and
nowhere else** — there is no per-case lldb script to edit. A row names a
program, the source file a breakpoint should be set in, and either a
`// @marker` line (group A) or a transcript print function whose every call site
becomes its own case (group B). 25 rows expand to **82 cases** over 24 programs.

## Three questions, asked separately

For each case the runner compiles a guest, runs `tension-core` under lldb in
batch mode, and classifies:

| verdict | meaning |
|---|---|
| `skipped` | the case **did not run**; a `reason` is mandatory (`guest-refused`, `engine-arg-unsupported`, `engine-error`, `harness-error`) |
| `unresolved` | the guest ran and the breakpoint matched no location — lldb never bound it to an address |
| `no-stop` | it resolved, and execution ran to the end without stopping |
| `no-source` | it stopped, and the frame names no file we asked for |
| `wrong-line` | it stopped in the right file on a **different** line (`expectedLine` and `observedLine` both recorded) |
| `pass` | resolved ≥ 1, stopped on a breakpoint, right file, and `line === expected` |

They fail for different reasons, and "it stopped" is not a pass. A harness that
rounds `wrong-line` up to green reports the owner's own complaint as working.

`skipped` is **not** a failure — it is "unknown" — and it is not green either. The
tally prints it apart from `fail`. Before v2 the runner called every
non-resolution `unresolved`, which is how 63 guests that the engine refused to
load were read as 63 debugger defects for four rounds.

## Loadability is probed, and the engine is recorded

Before a case runs under lldb, the engine is run on the artifact **without a
debugger** and its stderr read. A guest it will not parse is
`skipped(guest-refused)` with the engine's own message in the row; a flag it does
not accept (an older binary) is `skipped(engine-arg-unsupported)`. Inferring
either from "lldb found no location" is the mistake v2 removes.

Every capture records the engine's path, mtime and the `async backend:` line it
prints, and the run **warns loudly** when the binary predates the newest file
under `tension-core/src/`. A stale interpreter turns continuation guests into
phantom failures, which is exactly what happened: `target/release/tension-core`
was built 2026-11-16, four days before the per-target async backend landed.

    TENSION_CORE=<path>   # measure a specific engine; the capture records which

## lldb is a dependency

Missing lldb **fails** the command with install instructions and exit 2. A skip
would be a hole in a gate whose purpose is finding holes.

## Run

    node tools/debug-conformance/runner.js                  # every case
    node tools/debug-conformance/runner.js --only async     # a name substring
    node tools/debug-conformance/runner.js --only class_method --only lambda_body
    node tools/debug-conformance/runner.js --json out.json  # also a table
    node tools/debug-conformance/runner.js --no-build       # use artifacts as-is
    node tools/debug-conformance/runner.js --workers 8      # the default
    node tools/debug-conformance/runner.js --workers 1      # serial, for a baseline

Cases are independent — each owns its `.cache/work/<case>/` directory and spawns
its own engine — so they run on a bounded pool of worker threads, `--workers N`,
**8 by default**. `--workers 1` runs them inline on one thread; the classification
is the same module (`lib/cases.js`) on both paths, so the two cannot disagree
about what a verdict means. The capture records the worker count, because two
runs that were measured under different parallelism should say so.

**Run it alone.** A case is only as trustworthy as the machine it ran on: lldb is
spawned per case, and when other work is competing for the cores its attach or its
breakpoint binding fails — which the runner records as `unresolved`
("the guest ran and the breakpoint matched no location"), not as a pass, but the
*number* still moves. Measured twice: **62/82 with 14 `unresolved`** while eight
`cargo test` suites were running on the same box, **71/82** on the same tree with
nothing else going (DL38; I23 named the same effect earlier). A census quoted next
to other measurements needs that context or it is misleading.

One line is printed per completed case (`ok 12/82 name`, or the failing verdict
with its detail), so a long run can be followed instead of polled blind. The
[tally](#three-questions-asked-separately) at the end is unchanged.

`--only` takes a case name or a substring, and **an exact name wins**: the
needle `transcript#1` names one case, not `transcript#1`, `#10`, `#11`. A needle
that names no case falls back to a substring. Without that rule a filter meant to
select twenty cases silently selected twenty-one, and a comparison between two
runs is only as good as its case *set*.

The 20-case serial-vs-parallel check lives in `dl6/`: the same twenty names, run
once at `--workers 1` and once at `--workers 8`, case for case identical (see
`DL6-REPORT.md`).

The artifacts come from `scripts/build-test-programs.mjs --debug`, which builds
with the compiler `scripts/tensionscript.mjs` resolves — the **vendored pin**
(`150a6e97`), not TensionScript `main`'s tip. Point it elsewhere with
`$TENSIONSCRIPT=<path>/bin/tensionscript.js`, which prints a loud line saying the
pin was not used.

## The red baseline

[`red-capture-2026-11-21.json`](red-capture-2026-11-21.json) is the measured
starting point, and it is not a summary — it is the table, one row per case:

    unresolved                   63
    stopped with no source file   7
    stopped at <wrong line>       1   (line 14)
    pass                         11
    total                        82

**Reproduced.** [`red-reproduced-2026-11-21.json`](red-reproduced-2026-11-21.json)
is a second full run on the clean compiler with nothing applied, and its
`results` array is **identical to the byte** — same 82 cases, same verdicts,
same `detail` strings, same `breakpoint` objects. **0 of 82 changed verdict.**
That is what makes a before/after comparison downstream mean anything: the red
number is a property of the tree, not of one afternoon.

The reproduction also ran with `$TENSIONSCRIPT` pointing at a `dist/` built from
TensionScript `main` (`41b8721b`) while the first run used the vendored pin
(`150a6e97`). Identical verdicts, which agrees with the line census in the
compiler repo: the two bases emit the same DWARF for these 24 programs.

## Relation to the census

This gate says *how a breakpoint fails*. The compiler repo's
`tests/debug/census.js` says *how much DWARF is missing* — `unreachable_lines`
and `unpaired_addresses`, per file and in total, ratcheted. Neither replaces the
other: a case can be `unresolved` with every line reachable (the breakpoint named
a file the DWARF under a different name), and a line can be unreachable with no
case naming it. Read both tables before claiming a fix.

## Add a case

1. Add a guest under `tension-core/tests/programs/conformance/`, named for the
   feature, with one `// @stop` marker — or a `print(…)` transcript.
2. Add its flags to `PROGRAMS` in `scripts/build-test-programs.mjs` (the
   `conformance` folder default is `PLAIN_FLAGS`; an async case must say so, or
   it silently measures the promise backend under an async case's name).
3. Add one row to `matrix.json`.
4. Re-run with `--json` and record what it does. A new case that passes is a
   case you have not understood yet.
