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
| `unresolved` | the breakpoint matched no location — lldb never bound it to an address |
| `no stop` | it resolved, and execution ran to the end without stopping |
| `stopped with no source file (…)` | it stopped, and the frame names no file we asked for |
| `stopped at N` | it stopped in the right file on a **different** line |
| `pass` | resolved ≥ 1, stopped on a breakpoint, right file, and `line === expected` |

They fail for different reasons, and "it stopped" is not a pass. A harness that
rounds `stopped at N` up to green reports the owner's own complaint as working.

## lldb is a dependency

Missing lldb **fails** the command with install instructions and exit 2. A skip
would be a hole in a gate whose purpose is finding holes.

## Run

    node tools/debug-conformance/runner.js                  # every case
    node tools/debug-conformance/runner.js --only async     # a name substring
    node tools/debug-conformance/runner.js --json out.json  # also a table
    node tools/debug-conformance/runner.js --no-build       # use artifacts as-is

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
