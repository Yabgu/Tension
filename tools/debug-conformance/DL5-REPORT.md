# DL5 report — the baseline was wrong; the real one is 71/11

Round: **DL5**. Brief: `~/work/_cw/roundDL5.brief.txt`. Date 2026-11-21.
Trees: `~/work/TensionScript-a2` (compiler), `~/work/Tension` (runtime, harness).

---

## 0. The headline

```
                        before (as-resolved)         the real baseline
unresolved / skipped    63 "unresolved"              63 skipped → 59 of them pass
pass                    12                           71
no-source               7                            11
correct                     12/82                     71/82
```

Fifty-nine of the sixty-three "failures" that four rounds argued about were a
**stale interpreter binary**. The defect list that survives is 11 cases, all one
class: `no-source`. Phase D then shows that class is **not** fixable from the
compiler side, with a control experiment.

---

## 1. Phase A — the harness can no longer mistake "did not run" for "failed"

New vocabulary, `format: debug-conformance v2`:

- `pass` — resolved ≥ 1, stopped, right file, `line === expected`
- `wrong-line` — stopped in the right file on a different line; `expectedLine`
  and `observedLine` both recorded
- `no-source` — stopped, frame names no file we asked for
- `no-stop` — resolved, ran to completion without stopping
- `unresolved` — the guest **ran** and the breakpoint matched zero locations
- `skipped` — the case did not run; **`reason` is mandatory**
- `error` — the harness itself failed (`reason: harness-error`)

`skipped` is counted apart from `fail` and printed as `SKIP`. It is neither green
nor a debugger failure.

**The exact mechanism that detects a refused guest.** A probe, not an inference:

```js
// tools/debug-conformance/runner.js :: makeLoadProbe
const run = spawnSync(binaryPath, ["--debug", ...extra, guest], { cwd, timeout, maxBuffer });
const stderr = run.stderr ?? "";
if (/unknown (option|argument) `([^`\n]*)`/.test(stderr))
    → skipped(engine-arg-unsupported)   // e.g. a binary built before --executors
else if (/failed to parse WebAssembly module/.test(stderr))
    → skipped(guest-refused)            // the engine's own message stored in the row
else if (run.status !== 0)
    → skipped(engine-error)
else → run it under lldb
```

The engine is run on the artifact **with no debugger**, before lldb is involved,
so the answer cannot be a debugger verdict. Results are cached per
(program, executors) — one probe per guest, not per case.

**The engine is recorded once per capture**, in the JSON header:

```json
"engine": {
  "path": "/…/tension-core/target/release/tension-core",
  "relative": "tension-core/target/release/tension-core",
  "mtime": "2026-11-16T02:00:11.742Z",
  "newestSource": { "path": "tension-core/src/session/mod.rs", "mtime": "2026-11-20T20:49:35.781Z" },
  "stale": true,
  "backend": null
}
```

**Fail loudly on a stale engine.** When `mtime < newestSource.mtime` the run
writes a warning naming both paths and dates, and when `backend` is `null` it
says whether continuation guests can run is unverified:

```
debug-conformance: WARNING — the engine binary is older than its sources.
  binary        tension-core/target/release/tension-core (2026-11-16T02:00:11.742Z)
  newest source tension-core/src/session/mod.rs (2026-11-20T20:49:35.781Z)
  …a stale engine measures a binary nobody has.
debug-conformance: WARNING — … did not print an `async backend:` line.
  Whether continuation guests can run here is therefore unverified.
```

`resolveTensionCore()`'s preference order is **unchanged** — that is the user's
decision, as the brief requires. The warning is what makes it survivable.

---

## 2. Phase B — three tallies, side by side

All with the same taxonomy, same matrix, same 24 artifacts (rebuilt for this
round from compiler `a82c1536`).

| engine | mtime | `async backend:` | pass | skipped | no-source | exit |
|---|---|---|---|---|---|---|
| release **as-resolved** | 2026-11-16T02:00 | *(no line)* — `stale: true` | **12** | **63** (38 `guest-refused`, 25 `engine-arg-unsupported`) | **7** | 1 |
| debug `target/debug` | 2026-11-20T22:05 | `continuations` | **71** | 0 | **11** | 1 |
| release **rebuilt this round** | 2026-11-21T22:14 | `continuations` | **71** | 0 | **11** | 1 |

`cargo build --release` took **9m15s**. The rebuilt release and the debug engine
agree **per case, all 82** — so the third tally is the shippable configuration and
confirms the second rather than adding anything.

**The delta between engines is the finding:**

```
skipped(guest-refused)        → pass     36
skipped(engine-arg-unsupported) → pass   23
pass                          → pass     12
no-source                     → no-source 7
skipped(guest-refused)        → no-source  2
skipped(engine-arg-unsupported) → no-source 2
```

59 of 63 recovered to `pass`; the other 4 became `no-source`, which is why the
`no-source` count rises 7 → 11. Nothing regressed.

**The 11 real failures**, all at a function's first statement:

```
first_statement_print        first-statement.ts:7       locations 2, resolved 2
first_statement_branch       first-branch.ts:5          locations 2, resolved 2
first_statement_loop         first-loop.ts:6            locations 2, resolved 2
task_entry_first_statement   task-entry.ts:8            locations 2, resolved 2
lambda_body                  lambda-body.ts:10          locations 2, resolved 2
second_function_in_file      second-function.ts:10      locations 2, resolved 2
entry_surface_main           start-game-entry.ts:8      locations 2, resolved 2
rt_guards.transcript#1       rt-guards.ts:92            locations 1, resolved 1
rt_guards.transcript#2       rt-guards.ts:95            locations 2, resolved 2
spawn_join.transcript#1      spawn-join.ts:122          locations 2, resolved 2
two_workers.transcript#1     two-workers.ts:110         locations 2, resolved 2
```

`wrong-line` is **0** on a capable engine: `class_method` passes without DL3's
patch. DL3's one fix was real, but it is not what remains.

---

## 3. Phase C — per-artifact containment; the hole is uniform

Method (committed as scripts): lldb runs each guest with a module-regex keepalive
and `dl5/extract-object.py` writes the ELF object wasmtime handed lldb to disk;
`dl5/containment.mjs` then reads that object's `.debug_line` and `.debug_ranges`
with `llvm-dwarfdump` and counts rows inside no CU range. Offline, ~100× cheaper
than resolving every row through lldb (DL4's per-row walk cost 83 s/artifact).

```
async-after-await     2126 rows   394 out  18.5%   7911 pairs  5150 dup  357 gaps
async-before-await    2128        394      18.5    7915        5152      357
async-loop-resume     2316        423      18.3    8999        5959      368
async-on-main         1797        322      17.9    6010        3742      251
class-method          1233        226      18.3    6407        4651      179
count                 2506        416      16.6   11378        8022      247
fallback-loop         2317        411      17.7    8969        5921      356
first-after-decls     1212        221      18.2    6360        4622      175
first-branch          1030        201      19.5    5267        3809      165
first-loop            1215        224      18.4    6348        4611      176
first-statement       1025        199      19.4    5259        3804      165
lambda-body           1232        226      18.3    6401        4644      179
main-policy           2291        410      17.9    8937        5919      356
main-step-replaced    2310        418      18.1    8955        5925      357
promise-fallback      2098        396      18.9    8679        5936      325
rt-guards             2235        437      19.6    8892        6033      317
schedule-order        2787        530      19.0    9793        6287      419
second-function       1031        204      19.8    5263        3806      166
spawn-join            3145        522      16.6   12948        8852      344
spawn-refusals        2507        420      16.8   11390        8039      248
stack-switch-resume   2302        407      17.7    8989        5954      363
start-game-entry      1745        321      18.4    7162        4828      279
task-entry            2164        393      18.2    8098        5286      354
two-workers           3158        522      16.5   13118        9001      344
```

**Uniform: 16.5 %–19.8 % on every one of 24 artifacts**, 67 %–69 % duplicate range
pairs. It is not confined to the 11 failing programs — the class is that roughly
one row in five is outside a range, and the 11 failures happen to be breakpoints
that land on one. `first-branch` reproduced DL4's `201/1030` exactly under a
different ASLR seed, so the number is stable rather than incidental.

---

## 4. Phase D — the preferred fix cannot make the assertion true

The brief's fix (one whole-body range *in addition to* the per-row ones) was
built, installed, measured, and reverted. Two stronger variants and a control went
with it. All on `first-branch.wasm`, measured the same way as Phase C.

| emitter | object range pairs | distinct | rows | outside | % |
|---|---|---|---|---|---|
| **baseline** (row-split only) | 5267 | 1458 | 1030 | **201** | 19.5 |
| **(a) row-split + one whole-body per body** | 5541 | 1572 | 1030 | **200** | 19.4 |
| **(b) whole-body only** | 274 | 274 | 1030 | **349** | 33.9 |
| **(c) one range `[0, codePayloadSize)`** | 0 | 0 | 1030 | **1030** | 100.0 |

- **(a) is the brief's fix, and it buys one row.** The whole-body pairs survive
  the transform (they are present in the object: +274 pairs), but the union of
  covered bytes only rises 20 858 → 21 058. One row out of 201. **It does not
  reach 0.**
- **(c) is the control that settles the question.** `translate_ranges_raw` opens
  with `if start == 0 { return None }` — a range beginning at wasm address 0 is
  dropped, not translated. The compiler's address 0 is the first byte of the code
  payload, so "one range for the whole module" is **unrepresentable by
  construction**. A perfect emitter cannot express it.
- **(b) shows the splitting rules are not the lever** — dropping the row-split
  entries makes it half again worse, so they are doing real work.

**Where the uncovered rows are** (baseline object): 166 disjoint covered runs;
200 rows outside; **74 of the 200 sit exactly at a gap start**; gap sizes min 1,
p25 30, **median 122**, p75 172, max 216 bytes. Only 19 gaps are ≤16 bytes.

A 122-byte median hole is not "a range endpoint was rounded to the neighbouring
instruction" — that would be at most one instruction. It is a stretch of compiled
code that the rewritten range list does not claim while the rewritten line table
emits rows inside it. The transform rewrites both against the per-function address
map, and the two rewrites disagree. The **input** it is given tiles perfectly (0
rows outside, 169 one-byte alignment gaps, DL4 and unchanged), so the defect is
inside the transform, not in what the compiler hands it.

Per the brief, that is the stopping condition: *"If the compiler-side fix cannot
make that assertion true, stop and report that — with the measurement showing
why. That is a legitimate outcome and the right one; do not reach into
`third_party/` to force it."* I stopped.

**The one experiment that would localise it further**, for whoever owns the
vendored tree: instrument `translate_ranges_raw` to log
`(wasm_start, wasm_end) → [(native_start, native_end)]` for one function and diff
it against that function's rows from `clone_line_program`. If a row's native
address lies inside a native interval the range iterator never produced, the bug
is `TransformRangeIter`'s `last_start`/`last_end` pairing
(`address_transform.rs:392–460`), not anything upstream of it. That is a guess
about *where in that function* it lives, backed by the gap shape; it is not a
diagnosis of the logic.

Tree state: `src/dwarf/index.ts` unchanged, `git status` clean, `dist/`
reinstalled from the committed compiler, 24 artifacts rebuilt from it.

---

## 5. Phase E — not run

Droppable per the brief when D consumes the round, and D produced a negative
result with a control, which is worth more than a half-measured prologue change
on a tree that cannot pass its own assertion. `class_method` also already passes
on a capable engine without any prologue change, so the wrong-line class the
phase targets is currently empty.

---

## 6. Gates

All on the restored baseline tree, after every experiment was reverted.

| gate | required | measured |
|---|---|---|
| `npm run check` | green | **exit 0** |
| `npm test` | 71 checks | **exit 0**, `[ SUCCESS ] 71 checks` |
| `npm run test:debug:unit` | 5+5 | **5 + 5**, parity 1155 B |
| `npm run test:debug` | 2 PASS | **2 PASS** (`add-locals` 2 stops/5 vars, `await-locals` 1/2) |
| Tension `debugger` suite | 5 passed | **5 passed**, 0 failed, 0 ignored (18.14 s) |
| census | 114 / 0 | **114 / 0**, ratchet `8 improved, 0 worse` |
| conformance, as-resolved engine | v2 taxonomy | 12 pass / 63 skipped / 7 no-source |
| conformance, capable engine | v2 taxonomy | **71 pass / 0 skipped / 11 no-source** |

**Declared delta, and what moved.** The taxonomy change moves verdict strings by
construction. The declared mapping, also in the phase-A commit message:

```
"stopped with no source file (…)"      -> no-source
"stopped at N"                         -> wrong-line
"no stop"                              -> no-stop
(old) unresolved on a refused guest    -> skipped(guest-refused | engine-arg-unsupported)
(old) unresolved on a running guest    -> unresolved
```

The counts that must **not** move did not: `npm run check`, `npm test`, the unit
suites, the Tension debugger count, and the census are all identical to DL4.

---

## 7. Files created or changed

`Tension` (`fix/dwarf-conformance`, local, not pushed):
- `tools/debug-conformance/runner.js` — v2 verdicts, load probe, engine record,
  stale warning
- `tools/debug-conformance/README.md` — the new vocabulary and the probe
- `tools/debug-conformance/STATE.md` — DL5 (DL4's kept as `STATE-DL4.md`)
- `tools/debug-conformance/STATE-DL4.md` — renamed
- `tools/debug-conformance/dl5-release-2026-11-21.json` — tally on the stale engine
- `tools/debug-conformance/dl5-debugengine-2026-11-21.json` — tally on the debug engine
- `tools/debug-conformance/dl5-release-rebuilt-2026-11-21.json` — tally on the rebuilt release
- `tools/debug-conformance/dl5/containment.mjs` — offline row-in-range analyser
- `tools/debug-conformance/dl5/extract-object.py` — pulls the JIT ELF out of the process
- `tools/debug-conformance/dl5/per-artifact-rows.sh` — the 24-artifact sweep
- `tools/debug-conformance/dl5/enum.py` — per-row lldb walk (superseded by the above)
- `tools/debug-conformance/dl5/per-artifact-rows.json` — Phase C table
- `tools/debug-conformance/dl5/PHASE-D-DL5.md` — the four-emitter measurement
- `tools/debug-conformance/DL5-REPORT.md` — this file

`TensionScript-a2` (`fix/dwarf-prologue`, local, not pushed):
- **nothing.** The phase-D experiments were built from this tree and reverted;
  `git status --short` is clean and `src/dwarf/index.ts` matches `a82c1536`.

---

## 8. What I did not verify, and what I assumed

- **I did not fix the `no-source` class.** It has 11 members and the compiler-side
  fix cannot reach the assertion. That is measured, not asserted, but it means the
  round ends with a defect list rather than a fix.
- **I did not run Phase E**, so the prologue rule from W2 is untested on Linux.
  Note that `wrong-line` is already 0 on a capable engine, so there may be nothing
  there to fix.
- **The transform reading is source plus object shape**, not instrumented
  wasmtime. I read `translate_ranges_raw`/`TransformRangeIter` and
  `clone_line_program`, and matched them to the measured duplicates and gaps; I
  did not add logging to the vendored crate (out of scope) or build a patched one.
  The claim "the defect is inside the transform" rests on the input tiling
  perfectly and the output not — not on having watched the transform do it.
- **Phase C used the debug engine** to register the JIT image (it is the one that
  was verified capable first); the containment measurement is a property of the
  compiler + cranelift transform, not of which host binary loads it, and the
  rebuilt release produced the same per-case verdicts. I did not re-extract all 24
  objects under the rebuilt release.
- **The rebuilt release binary is uncommitted** (it is a build artifact) — a
  later round must rebuild it, or the warning added in Phase A will fire and say
  so, which is the point.
- **Windows is not measured.** Its own brief.
- **Assumed:** that a `spawnSync` probe exiting 0 means the guest loads (a guest
  that parses and then traps would exit non-zero and be labelled `engine-error` —
  no such case occurred in this matrix, but the probe is stricter than "parses");
  that `llvm-dwarfdump` applies `.rela.*` for a relocatable object (it does — the
  dumped addresses land inside `.text`); and that the object extracted at the JIT
  descriptor address is the one lldb parsed (same 1410→1030 row counts and first
  addresses as lldb's own line table).
- **`origin/fix/dwarf-conformance` is 8 commits behind this branch** and was last
  written by DL3. I did not fetch, pull, rebase, merge or push; if another agent
  has published to it since, `HEAD..origin/…` was 0 when I measured and I would
  not have seen a later write.
