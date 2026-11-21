# DL5 phase D — the compiler-side fix cannot reach zero, and here is the measurement

The brief's preferred fix was: emit one range per function body **in addition to**
the per-row ranges, so every line row has a range covering it, and confirm by
extracting the JIT object and asserting **0 of N rows outside a CU range**.

I ran that, plus two stronger variants, and a control. **None of them reached 0,
and the control proves no emitter-side change can.**

Every number below is from `/tmp`-free artifacts: compiler built, `dist/`
installed into `Tension/node_modules`, all 24 debug artifacts rebuilt with
`--force`, then `first-branch.wasm` run under lldb with the release engine
(`[continuations]`) to extract the ELF object, then `dl5/containment.mjs` over
it. `first-branch` is one of the 11 failing cases and was the DL4 sample, so its
baseline number (201/1030) is directly comparable.

## Four emitters, same measurement

| emitter | range pairs in object | distinct | rows | outside | % |
|---|---|---|---|---|---|
| **baseline** (row-split only) | 5267 | 1458 | 1030 | **201** | 19.5% |
| **(a) row-split + one whole-body per body** | 5541 | 1572 | 1030 | **200** | 19.4% |
| **(b) whole-body only** | 274 | 274 | 1030 | **349** | 33.9% |
| **(c) one range `[0, codePayloadSize)`** | 0 | 0 | 1030 | **1030** | 100% |

Three facts follow, and they are independent of each other.

### (c) proves the `start == 0` path is a dead end

`AddressTransform::translate_ranges_raw` begins:

```rust
if start == 0 {
    // It's normally 0 for debug info without the linked code.
    return None;
}
```

A range starting at wasm address 0 is **dropped**, not translated. The compiler's
own address 0 is the first byte of the code-section payload, so "one range for the
whole module" is unrepresentable by construction. 1030/1030 outside.

### (a) proves the whole-body entry survives translation but does not close the holes

The whole-body pairs *are* in the object (274 more pairs than baseline), and the
transform keeps them — the alternative would have collapsed them like everything
else. But the **union of covered bytes** goes from 20,858 (baseline) to 21,058
(+200 bytes) while the uncovered rows go 201 → 200. One row.

### (b) proves the splitting rules are not the lever

Whole-body only is *worse* (349 vs 201), so the per-row splitting is doing real
work and cannot simply be dropped. Neither half is a missing-range problem.

## Where the uncovered rows actually are

Measured on the baseline object's own `.debug_line`/`.debug_ranges`
(`dl5/containment.mjs` plus a gap analysis):

- 1030 rows, 166 merged (disjoint) covered runs.
- 200 rows outside; **74 of them sit exactly at a gap start**, i.e. at the first
  byte after a covered run ends.
- Gap sizes: min 1, p25 30, **p50 122**, p75 172, max 216 bytes. Only 19 of the
  200 gaps are ≤16 bytes.
- Every outside row lies in some gap; the distance to the nearest covered edge is
  p50 21 bytes, p90 60, max 104.

A 122-byte median hole between two covered runs is not "a range endpoint was
rounded to the neighbouring instruction" — that would be a hole of at most one
instruction. It is a whole *stretch of compiled code* that the rewritten range
list does not claim, while the rewritten line table does emit rows inside it.

The shrinking is visible in the direction too: the source's range list for
`first-branch` is 3213 pairs tiling 11,475 bytes; the object's is 5267 pairs
(80% duplicates) covering a union of 20,858 bytes, and its line table has 1030
rows. Both the range list and the row set are *rewritten* by
`clone_line_program` + `translate_ranges_raw` against the per-function address
map, and the two rewrites do not agree. The disagreement is inside the transform,
not in the input it was given: the input tiles perfectly (0 rows outside, 169
1-byte alignment gaps, measured in DL4 and unchanged).

## What this means for the brief's phase D

The compiler-side fix **cannot make the assertion true**, and the brief says that
is the legitimate outcome: stop and report it, do not reach into `third_party/`.

The measurement that would change the answer is not an emitter change at all. It
is one of:

1. **Patch the vendored transform** (`wasmtime-internal-cranelift-50.0.2`,
   `src/debug/transform/`) so the range rewrite and the line rewrite consult the
   same address map. Out of scope this round by standing rule (no edits to
   `third_party/`, `vendored/`, or wasmtime anywhere).
2. **Bypass the transform for the range list only**, i.e. have the runtime hand
   lldb a `.debug_ranges` that is already instruction-aligned. That requires the
   compiler to know the final native layout, which it does not — the layout is
   the JIT's.
3. **Upgrade the pinned wasmtime** and re-measure; `50.0.2` is what
   `tension-core/Cargo.toml` pins and the transform is version-specific.

The cheapest confirming experiment for (1), for whoever owns the vendored tree:
instrument `translate_ranges_raw` to log `(wasm_start, wasm_end) →
[(native_start, native_end)]` for one function, and diff it against the same
function's rows from `clone_line_program`. If a row's native address is inside a
native interval the range iter never produced, the bug is `TransformRangeIter`'s
start/end pairing (`last_start`/`last_end` handling in
`address_transform.rs:392-460`) and not anything upstream of it.

## State of the tree

`src/dwarf/index.ts` is **unchanged** (`git status --short` clean). All four
emitter variants were built, measured, and reverted; the committed compiler is
the baseline (`a82c1536`), `dist/` is reinstalled from it, and the 24 artifacts
were rebuilt from it. The measurements above are the only trace, and they are in
this file rather than in the tree.
