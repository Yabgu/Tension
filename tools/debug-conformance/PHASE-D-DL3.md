# DL3 Phase D — which half is load-bearing

The candidate patch (`0f771d74`) has two halves:

- **(a)** the line sequence starts at the **function body** (`seqStart = start`)
  instead of at the first mapped row.
- **(b)** a prologue marker: set the head row's file/line/column, then
  `DW_LNS_set_prologue_end` + `DW_LNS_copy`, so the function's first statement
  gets a row of its own.

Each build below is the compiler with **only** that half, rebuilt from
TensionScript `fix/dwarf-prologue` (`64222b3b`), 24 debug artifacts rebuilt with
`--force`, 82 conformance cases re-run. `matrix.json`, the harness and the 82
cases are unchanged from the red capture.

Baselines: red = `red-capture-2026-11-21.json` (63/7/1/11, census
`unreachable_lines 153`), committed (a)+(b) = `green-2026-11-21.json`
(63/7/0/12, census 114).

## Results

| build | `seqStart` | prologue marker | unresolved | no-source | wrong-line | pass | census unreachable |
|---|---|---|---|---|---|---|---|
| red (base) | `rows[first].addr` | none | 63 | 7 | 1 | 11 | 153 |
| **(a) alone** | `start` | none | 63 | 7 | 1 | 11 | 153 |
| **(b) alone, as written** | `rows[first].addr` | guarded block | — | — | — | — | — (artifacts byte-identical to base, 24/24) |
| **(b) alone, constructed** | `rows[first].addr` | bare `DW_LNS_set_prologue_end` | 63 | 7 | 0 | 12 | 153 |
| (a)+(b) as committed | `start` | guarded block | 63 | 7 | 0 | 12 | 114 |

Captures: [`phase-d-a-only-2026-11-21.json`](phase-d-a-only-2026-11-21.json),
[`phase-d-b-only-2026-11-21.json`](phase-d-b-only-2026-11-21.json).

## (a) alone — measured, no effect

Conformance: **0 of 82 cases moved.** Verdicts identical to red, per case:
63 `unresolved`, 7 `no source file`, 1 wrong line (`class_method`), 11 pass.
Census: **identical to base** (153 unreachable, 0 improved, 0 worse).

This is mechanically consistent: starting the sequence at the body adds an
address *state* but no *row*. Rows are only created by `DW_LNS_copy`, and the
first copy still happens at `rows[first].addr`, so the interval
`[start, rows[first].addr)` — the prologue — still has no row covering it. What
(a) does change is which function wasmtime attributes the sequence to (it picks
the function from the sequence's first row address), and that alone changes no
verdict here.

## (b) alone, as the candidate writes it — provably inert

The block is guarded by `if (head.addr > seqStart)`. With `seqStart =
rows[first].addr`, that condition is false by construction (`head` *is*
`rows[first]`), so the block never executes. Measured rather than argued: this
variant's 24 rebuilt artifacts are **byte-identical to the base artifacts**
(`sha256` compared 24/24). Identical bytes cannot produce different verdicts, so
no 82-case run was spent on it.

**Consequence for reading the candidate:** half (b) is not a standalone change.
It is dead code unless (a) is present. The patch is (a) → enables (b), and the
observable effect is (b)'s row, not (a)'s `seqStart`.

## (b) alone, constructed — why a constructed variant was needed

To ask "is the prologue marker itself load-bearing", (b) has to be expressed in
a way the candidate's guard forbids: keep `seqStart = rows[first].addr` and emit
a bare `DW_LNS_set_prologue_end` immediately before the loop, so the flag lands
on the head row the loop is about to copy. No synthetic row at the body start,
no moved `seqStart`.

This is **my construction, not the candidate's code** — the candidate contains
no such build. It is here to separate "the marker matters" from "the extra row
covering the prologue matters".

### Result — the marker alone reproduces the flip

    unresolved 63 / no source 7 / wrong line 0 / pass 12
    class_method: stopped at 14 -> pass   (the same single flip)
    census: unchanged, 153 unreachable, 0 improved, 0 worse

So **the prologue marker is what fixes `class_method`**, and half (a) is not
needed for that verdict. What (a) does add is visible only when compared per
case against (a)+(b): four `no source file` cases gain a **second** resolved
location (`locations 1, resolved 1` -> `locations 2, resolved 2`) —
`first_statement_print`, `first_statement_branch`, `lambda_body`,
`second_function_in_file` — and their verdict does not change. That second
location is the row at the body start that only the pair produces, and it is
also what the census sees: 153 -> 114 unreachable lines.

## Which half is load-bearing

- **For the one conformance flip: (b)**, the prologue marker. (b) alone
  (constructed) flips `class_method` with no help from (a).
- **For the census: neither alone, both together.** (a) alone 153, (b) alone
  153, (a)+(b) 114. The saved lines are the prologue bytes
  `[start, rows[first].addr)`, which only get a row when the sequence starts at
  the body (a) *and* the block emits a copy there (b).
- **As the candidate is written, (a) gates (b).** That coupling is an artifact of
  the `if (head.addr > seqStart)` guard, not a necessity: the constructed (b)
  shows the marker works at `seqStart = rows[first].addr` too.

**No case regressed in any of the three builds**, and no assertion was weakened
to get here.
