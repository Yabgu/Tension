# Phase E — the transform decision memo

No code. Three options for the eleven `no-source` rows that survived phase D,
with the row and case counts each one was measured to buy. **This is the user's
decision, not a recommendation.**

The measured starting point, all from this round and DL5:

- 11 of 82 cases fail, all `no-source`, all the first statement of a function.
- For each of the eleven, the address lldb stops at is **outside every CU
  range** — 11 of 11, holes of `0x10`–`0x88` bytes immediately before the next
  covered run (`PHASE-C-D-DL6.md`). The one passing control case is inside.
- The compiler's own object has 0 of 2283 rows outside its ranges. The object
  wasmtime hands lldb has 199 of 1025 outside (19.4%), uniformly across all 24
  artifacts (16.5%–19.8%, DL5 phase C).
- The row that lands in each hole is the sequence's leading-edge row — the row
  the prologue_end marker sits on. That row is what makes 12 cases pass; it is
  also what stops 11 others from reporting source.

## Option 1 — patch vendored wasmtime

`wasmtime-internal-cranelift-50.0.2/src/debug/transform/address_transform.rs`:
`translate_ranges_raw` / `TransformRangeIter`, against
`line_program.rs`'s `clone_line_program`.

- **Row effect:** the 199 of 1025 rows outside ranges on `first-statement`, if
  the transform's range rewrite is made to agree with the rows it emits. The
  `no-source` class is that defect and only that defect, per the measurement
  above.
- **Case effect:** up to 11 of 11. Every failing stop is inside a hole, so a
  transform that leaves no hole has no case left to fail — but this is a
  ceiling, not a promise: the eleven also need the stop's *line* to be right,
  which the marker supplies, and that has only been verified for the ten whose
  breakpoint has a second, covered location.
- **Cost:** a vendored fork, re-applied on every wasmtime bump.
- **Risk:** low if it is one condition; high if it needs understanding the
  reordering. It is currently under a standing rule ("do not edit
  `third_party/`"), so taking it needs the rule lifted, by name.

## Option 2 — work around it in the compiler

Measured variants, each a full rebuild of the 24 artifacts and 82 cases or a
JIT-object extraction:

| emitter | rows outside ranges |
|---|---|
| current (row-split ranges) | 201 / 1030 |
| row-split **+ one whole-body range per body** | **200** / 1030 |
| whole-body ranges only | 349 / 1030 |
| one range `[0, payloadSize)` (control) | 1030 / 1030 — `translate_ranges_raw` returns `None` for `start == 0` |

So the additive fix the brief hoped for buys **one row out of 201**, and the
module-wide escape hatch is not expressible at all.

The other compiler-side move is to stop emitting the leading-edge row, so no row
ever sits in the prologue hole. **Not built.** What is measured brackets it:
without a marker anywhere the compiler scores 59 pass / 17 no-source, and with
the marker on the first mapped row 66 / 16 — both below the 71 / 11 that the
leading-edge row plus the marker gives. It would very likely trade 12 cases for
0.

- **Row effect:** −1 (the additive form) to roughly −199 (if holes close by
  never placing a row in one) at the cost of the 12 cases above.
- **Cost:** none per se; the work is in `src/dwarf/*` and stays in our tree.
- **Risk:** it can never be complete, because the holes are created downstream
  of us.

## Option 3 — report upstream, record it, live with it

- **Row effect:** 0. The census manifest already records 114 unreachable lines
  with an 8-improved / 0-worse ratchet; the containment ratio (16.5–19.8 % of
  rows outside CU ranges) is the number to watch when an upstream fix lands, and
  `dl5/containment.mjs` measures it.
- **Case effect:** 0; 71 of 82 stay green and 11 stay red, visibly, in a suite
  that now says `no-source` rather than `unresolved`.
- **Cost:** none. **Risk:** the defect is upstream-dependent and nobody is
  tracking it but us.

## What the memo cannot tell you

The three options differ in row count by two orders of magnitude, but the
transform's own behaviour has still not been instrumented — the claim that
`translate_ranges_raw` drops these runs rests on "the input tiles perfectly, the
output does not", plus reading the vendored source. One measurement would settle
it and it belongs with whoever owns the vendored tree: build with
`TransformRangeIter`'s `last_start`/`last_end` pairing logged for
`first-statement.wasm`, and compare the emitted native ranges against
`clone_line_program`'s rows for the same function.
