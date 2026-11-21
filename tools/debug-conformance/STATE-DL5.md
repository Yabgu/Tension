# DL5 state — the baseline was wrong

Round: **DL5 — take the real baseline, then fix what is left.**
Brief: `~/work/_cw/roundDL5.brief.txt`. Date 2026-11-21.
Earlier rounds: `DL3-REPORT.md`, `DL4-REPORT.md`, `STATE-DL3.md`, `STATE-DL4.md`.

## Phase 0 — inventory (before any change)

| | Tension | TensionScript-a2 |
|---|---|---|
| branch | `fix/dwarf-conformance` | `fix/dwarf-prologue` |
| HEAD | `b9d1ce51aa49` | `a82c153645dc` |
| `git status --short` | clean | clean |
| origin ref for that branch | `origin/fix/dwarf-conformance` = `75156e2` | none |
| `origin/<branch>..HEAD` | **8** | n/a |
| `HEAD..origin/<branch>` | **0** | n/a |

`origin/fix/dwarf-conformance` at `75156e2` is an **ancestor** of HEAD
(`git merge-base --is-ancestor` succeeds) and is DL3's phase-B commit: the branch
was published once, 8 commits ago, and has not been touched remotely since.
`HEAD..origin` is 0, so nothing from another agent needs reconciling. No fetch,
pull, rebase, merge or push was performed this round.

### Engine binaries present

```
tension-core/target/release/tension-core   31941392 B   2026-11-16T03:00:11
tension-core/target/debug/tension-core    402252656 B   2026-11-20T22:05:59
newest file under tension-core/src/                      2026-11-20T21:49:35
```

The release binary is **3.8 days older than the sources it was built from**. That
is DL4's trap; Phase A makes it impossible to repeat silently.

## Phase A — done, committed `17eccb3`

Verdict vocabulary is now `pass | wrong-line | no-source | no-stop | unresolved |
skipped(reason) | error(reason)`. `skipped` is counted apart from `fail`.

A case is skipped by a **probe**, not by inference: the engine is run on the
artifact with no debugger and its stderr read. Reasons:

    guest-refused            failed to parse WebAssembly module (continuation guest,
                             engine without stack switching); engine message stored
    engine-arg-unsupported   `unknown option --executors` — a stale binary
    engine-error             any other non-zero exit

Every capture records the engine: path, mtime, newest source mtime, `stale`, and
the `async backend:` line. The run warns when the binary predates its sources and
when the backend line is missing.

## Phase B — the real baseline (both engines measured)

Release engine as-resolved (`tension-core/target/release/tension-core`,
mtime 2026-11-16, sources 2026-11-20, **stale**, no `async backend:` line):

    12 pass, 63 skipped, 7 no-source   (skipped: 38 guest-refused, 25 engine-arg-unsupported)

Capable engine (`TENSION_CORE=target/debug/tension-core`, `[continuations]`):

    **71 pass, 11 no-source, 0 skipped**   ← the real baseline
    exit 1 (11 cases fail)

Per-case delta (release → capable): 36 guest-refused → pass, 23
engine-arg-unsupported → pass, 12 pass → pass, 7 no-source → no-source,
2 guest-refused → no-source, 2 engine-arg-unsupported → no-source.

**59 of the 63 "failures" were the binary.** The real defect list is 11 cases,
all `no-source`, all at a *first statement* of a function:

    first_statement_print  first-statement.ts:7      locations 2, resolved 2
    first_statement_branch first-branch.ts:5         locations 2, resolved 2
    first_statement_loop   first-loop.ts:6           locations 2, resolved 2
    task_entry_first_statement task-entry.ts:8       locations 2, resolved 2
    lambda_body            lambda-body.ts:10         locations 2, resolved 2
    second_function_in_file second-function.ts:10    locations 2, resolved 2
    entry_surface_main     start-game-entry.ts:8     locations 2, resolved 2
    rt_guards.transcript#1 rt-guards.ts:92           locations 1, resolved 1
    rt_guards.transcript#2 rt-guards.ts:95           locations 2, resolved 2
    spawn_join.transcript#1 spawn-join.ts:122        locations 2, resolved 2
    two_workers.transcript#1 two-workers.ts:110      locations 2, resolved 2

Notably `wrong-line` is now **0**: `class_method` passes on the capable engine
without needing DL3's patch, so the DL3 flip was real but is not the remaining
defect.

### Third tally — release rebuilt for this round (`cargo build --release`, 9m15s)

    tension-core/target/release/tension-core   33545888 B   2026-11-21T22:14:04
    $ tension-core --help | grep backend
    async backend: continuations (wasmtime stack switching)

Capture: `dl5-release-rebuilt-2026-11-21.json`. This is the configuration a
developer would actually ship, and the number to quote from now on.

## Phase C — done: `no-source` is uniform, not program-specific

Method: per artifact, lldb runs the guest with a module-regex keepalive and
`dl5/extract-object.py` writes the ELF object wasmtime handed lldb to disk;
`dl5/containment.mjs` then reads that object's `.debug_line`/`.debug_ranges` with
`llvm-dwarfdump` and counts rows inside no CU range. Offline, one dump per
artifact, no per-row lldb calls.

| artifact | rows | outside | % | range pairs | dup pairs | gaps |
|---|---|---|---|---|---|---|
| async-after-await | 2126 | 394 | 18.5 | 7911 | 5150 | 357 |
| async-before-await | 2128 | 394 | 18.5 | 7915 | 5152 | 357 |
| async-loop-resume | 2316 | 423 | 18.3 | 8999 | 5959 | 368 |
| async-on-main | 1797 | 322 | 17.9 | 6010 | 3742 | 251 |
| class-method | 1233 | 226 | 18.3 | 6407 | 4651 | 179 |
| count | 2506 | 416 | 16.6 | 11378 | 8022 | 247 |
| fallback-loop | 2317 | 411 | 17.7 | 8969 | 5921 | 356 |
| first-after-decls | 1212 | 221 | 18.2 | 6360 | 4622 | 175 |
| first-branch | 1030 | 201 | 19.5 | 5267 | 3809 | 165 |
| first-loop | 1215 | 224 | 18.4 | 6348 | 4611 | 176 |
| first-statement | 1025 | 199 | 19.4 | 5259 | 3804 | 165 |
| lambda-body | 1232 | 226 | 18.3 | 6401 | 4644 | 179 |
| main-policy | 2291 | 410 | 17.9 | 8937 | 5919 | 356 |
| main-step-replaced | 2310 | 418 | 18.1 | 8955 | 5925 | 357 |
| promise-fallback | 2098 | 396 | 18.9 | 8679 | 5936 | 325 |
| rt-guards | 2235 | 437 | 19.6 | 8892 | 6033 | 317 |
| schedule-order | 2787 | 530 | 19.0 | 9793 | 6287 | 419 |
| second-function | 1031 | 204 | 19.8 | 5263 | 3806 | 166 |
| spawn-join | 3145 | 522 | 16.6 | 12948 | 8852 | 344 |
| spawn-refusals | 2507 | 420 | 16.8 | 11390 | 8039 | 248 |
| stack-switch-resume | 2302 | 407 | 17.7 | 8989 | 5954 | 363 |
| start-game-entry | 1745 | 321 | 18.4 | 7162 | 4828 | 279 |
| task-entry | 2164 | 393 | 18.2 | 8098 | 5286 | 354 |
| two-workers | 3158 | 522 | 16.5 | 13118 | 9001 | 344 |

**Uniform: 16.5%–19.8% on every one of the 24 artifacts, 67.1%–68.6% of range
pairs are duplicates.** It is not a property of the 11 failing programs — the
`no-source` class is that ~18% of rows happen to be the *first* row of a
breakpoint the matrix asks for. `first-branch` reproduced DL4's 201/1030 exactly
with a different ASLR seed, so the measurement is stable.

Evidence: `dl5/per-artifact-rows.json`.

## Phase D — the compiler-side fix cannot reach zero; measured, reverted

Brief's preferred fix (one whole-body range *in addition to* the per-row ones),
plus three further emitters, all measured on `first-branch.wasm` by extracting
the JIT object:

| emitter | object pairs | distinct | rows | outside |
|---|---|---|---|---|
| baseline (row-split only) | 5267 | 1458 | 1030 | **201** (19.5%) |
| (a) row-split + whole bodies | 5541 | 1572 | 1030 | **200** (19.4%) |
| (b) whole bodies only | 274 | 274 | 1030 | **349** (33.9%) |
| (c) one range `[0, payloadSize)` | 0 | 0 | 1030 | **1030** (100%) |

- (a) is the brief's fix: **one row better than baseline. It does not reach 0.**
- (c) is the control: `translate_ranges_raw` opens with `if start == 0 { return
  None }`, so a module-wide range is dropped entirely. No emitter can express it.
- Gap analysis on the baseline object: 166 disjoint covered runs, 200 rows
  outside, **74 of them at a gap start**, median gap **122 bytes** (p25 30,
  p75 172, max 216). Not an instruction-rounding artefact — a stretch of compiled
  code the rewritten range list does not claim while the rewritten line table
  emits rows inside it.

**Conclusion: the invariant break is inside the vendored transform, not the
emitter.** The input it is given tiles perfectly (0 rows outside, DL4). Full
write-up: `dl5/PHASE-D-DL5.md`.

Tree state: `src/dwarf/index.ts` unchanged and `git status` clean; all four
variants built, measured, reverted; `dist/` reinstalled from the committed
baseline; 24 artifacts rebuilt from it.

## Phase E — not run (droppable, and D consumed the round)

The brief allows dropping E if D consumes the round. D is a negative result with
a control, which is worth more than a half-measured prologue change on a tree
that cannot pass its own assertion.
