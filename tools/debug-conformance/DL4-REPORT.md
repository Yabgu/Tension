# DL4 report — where the address is lost

Round: **DL4**. Brief: `~/work/_cw/roundDL4.brief.txt`. Date 2026-11-21.
Trees: `~/work/TensionScript-a2` (compiler), `~/work/Tension` (runtime, harness).
**No fix this round.** `src/dwarf/encode.ts` is untouched.

---

## 0. The headline, before the details

The round's premise was that 63 cases are `unresolved` because the debugger cannot
attribute an address. That is not what they are.

**The 63 `unresolved` cases are exactly the 63 cases whose guest the engine
refuses to compile.** Set equality, both directions, checked against the matrix:

```
unresolved cases (green-2026-11-21.json)      63
cases in the 14 guests the engine refuses     63
sets equal                                    true
in unresolved, not refused-guest              0
in refused-guest, not unresolved              0
```

14 of the 24 conformance guests are continuation modules, and the runtime binary
the harness resolves (`tension-core/target/release/tension-core`, built **Nov 16**)
runs in **Promise** mode on this host:

```
Error: async-before-await.wasm
Caused by: 1: cannot define continuation types when stack switching is disabled (at offset 0x26)
```

The guest process exits at module parse. lldb sees `locations 0, resolved 0`, the
harness classifies that as `unresolved`, and the round inherited "63 debugger
failures" that are in fact 63 *unmeasured* cases.

The same guest run on `target/debug/tension-core` (built **Nov 20**) —

```
INFO core: async backend: continuations (wasmtime stack switching)
before await
after await
```

— executes normally. `resolveTensionCore()` prefers `target/release`, which is
stale with respect to `tension-core/src/async_backend.rs`.

And the confirming measurement is not subtle. Same artifact, same harness, only
the engine binary changed:

```
TENSION_CORE=tension-core/target/debug/tension-core \
  node tools/e2e-debugger/runner.js --guest examples/async-on-main/build/game.wasm \
       --file game.ts --line 77
→ {"stopped":true,"hit_breakpoint":true,"file":"game.ts","line":77,
   "function":"game/main","breakpoints":[{"id":1,"locations":2,"resolved":2}]}
→ e2e: guest stopped at game.ts:77 (game/main)
```

**The owner's line binds.** It always would have, on an engine that can run the
guest. The rest of the round measures the **19 cases that do run** — 7 `stopped
with no source file`, 11 pre-existing passes, `class_method` (flipped by DL3) —
because those are where a DWARF defect actually lives (§3–§5).

---

## 1. Phase A — the branch passes its own checks

Three ESLint `no-unused-vars` warnings, all in `tests/debug/lib/dwarf-reader.js`,
all variables that existed only to advance a cursor:

- `516:6  'mtime'`  — the line program's file-entry mtime, never read;
- `518:6  'length'` — the file-entry length, never read;
- `630:12 'ignored'` — an operand of a standard opcode the reader skips.

Fixed by keeping only the offset the parse returns:

```js
at = uleb(bytes, at)[1];                          // mtime, then length
for (let i = 0; i < count; ++i) cursor = uleb(bytes, cursor)[1];
```

No lint-disable, no rule change, no suppression. Commit **`a82c1536`** on
`TensionScript-a2` `fix/dwarf-prologue`.

```
npm run check   exit 0   (check:config, check:import, eslint --max-warnings 0)
npm run test    exit 0   ([ SUCCESS ] 71 checks in the final suite)
census          byte-identical to DL3's output: 24 modules, 18336 lines,
                114 unreachable, 0 unpaired
```

`npm run check` is green on the branch for the first time since the census
commit. `main` was already green; the census commit's new reader file was what
turned it red, and that is now paid.

---

## 2. Phase D — the decisive table

Measured on the five cases the brief names. `row addr (DWARF)` is the address in
the compiler's `.debug_line`; `native` is the same logical row in the JIT image
after wasmtime's transform; `in CU ranges?` is lldb's own answer at that address
(`ResolveLoadAddress(a).GetLineEntry().IsValid()`).

| case | expected | row addr (DWARF) | in CU ranges? (all rows of the line) | JIT base | JIT end | native rows, row − base | lldb lookup -a | lldb stop |
|---|---|---|---|---|---|---|---|---|
| `first_statement_branch` | `first-branch.ts:5` | `0x12b5 0x12b6 0x12b8` | source: 3/3 · image: 1/4 | `0x…620c000` | `0x…6216000` | `0x4ae0` OUT, `0x4b27` OUT, `0x4b69` **in**, `0x4b78` OUT | line-table match, **empty Summary** | stops at `0x4ae0`, **no file/line** |
| `first_statement_print` | `first-statement.ts:7` | `0x12b5 0x12b6 0x12ba` | source: 3/3 · image: 1/5 | `0x…620c000` | `0x…6216000` | `0x4ae0` OUT, `0x4b1f` OUT, `0x4b2a` OUT, `0x4b42` **in**, `0x4b4e` OUT | line-table match, **empty Summary** | stops at `0x4ae0`, **no file/line** |
| `class_method` (DL3's flip) | `class-method.ts:13` | `0x1fe3 0x1ffa 0x1ffe` | source: 3/3 · image: 4/5 | `0x…61f2000` | `0x…61fd000` | `0x8660` **in**, `0x86cf` **in**, `0x86da` **in**, `0x8748` **in**, `0x8754` OUT | `class-method.ts:13` | stops at `0x8660` → **pass** |
| `io/game.ts:10` | `game.ts:10` | `0x2259 0x2272 0x2276` | source: 3/3 · image: 3/6 | `0x…61db000` | `0x…61e7000` | `0x8f00` **in**, `0x8fa2` OUT, `0x8fad` OUT, `0x9220` **in**, `0x924e` **in**, `0x9250` OUT | `game/_start_game at game.ts:10:8` | stops at `0x8f00` → **right line** |
| `io/game.ts:14` | `game.ts:14` | `0x2284 0x2288 0x228c 0x229a 0x22a9` | source: 5/5 · image: 3/4 | `0x…5fda000` | `0x…5fe6000` | `0x8fde` OUT, `0x8ff3` **in**, `0x8ffe` **in**, `0x9019` **in** | first row: line-table match, **empty Summary** | stops at `0x8fde`, **no file/line** |

Whole-module counts behind the table (every line-table row, not just the
target line):

| case | rows in image | rows inside a CU range | rows outside | % outside |
|---|---|---|---|---|
| io10 / io14 (`examples/io`) | 1410 | 1155 | **255** | 18.1% |
| `first_statement_branch` | 1030 | 829 | **201** | 19.5% |
| `first_statement_print` | 1025 | 826 | **199** | 19.4% |
| `class_method` | 1233 | 1007 | **226** | 18.3% |

**Zero** rows fall outside the registered image in any case (`base ≤ row <
base+0xc000`, `.text` size `0xc000` throughout).

---

## 3. The three questions, answered from the table

**1. Is the row address inside the JIT image's registered range?** Yes, without
exception — 0 of 6108 rows fall outside `.text`. The proof row is `io14`'s first
row `0x7ffff5fe2fde`: base `0x7ffff5fda000`, offset `0x8fde`, and `.text` is
`0xc000` bytes. The runtime registers an image that covers the code; the bug is
not there.

**2. Is it inside the CU's `DW_AT_ranges`?** Not for the rows that fail — and the
failure is present in the object wasmtime builds, not created by lldb. Proof row:
`first_statement_branch`'s own line-5 breakpoint address, image offset `0x4ae0`,
is *outside* every range in that object, while a sibling row at `0x4b69` is
inside. 255 of 1410 rows are outside in `examples/io`, 201 of 1030 in
`first-branch.wasm`.

**3. If both are true, what does `image lookup -a` return?** When both are true it
returns the source line and the function — `image lookup -f game.ts -l 10` gives
`Summary: JIT(…)`game/_start_game at game.ts:10:8`. When the range is missing,
the address is still matched in the line table (it is a line-table address) but
its `Summary` is empty and lldb logs exactly the sentence the brief quotes:

```
error: JIT(0x…)(…) unable to resolve a line table file address 0x… back to a compile unit, please file a bug and attach the address and file.
```

So lldb is not misparsing anything we can see; it is being handed an object whose
line table and range list disagree.

---

## 4. Phase E — which layer owns it

Two defects, in two different layers, and one of them is not a defect at all.

### 4a. The 63 — the runtime build (`tension-core`), not the debugger

`tools/e2e-debugger/lib/resolve.js::resolveTensionCore()` prefers
`tension-core/target/release/tension-core`. That binary is from **Nov 16**;
`src/async_backend.rs` — the file that decides whether the host gets
continuations or the Promise seam, and that makes the host *start* on a target
without stack switching — landed **Nov 20** (`12092c2`). The resolved binary
therefore runs in `AsyncBackend::Promise` and refuses 14 of the 24 guests at
module parse.

Owner: **the runtime artifact the harness resolves**
(`tension-core/src/async_backend.rs::build` → `AsyncBackend::Promise`, surfaced
through `resolveTensionCore()`'s preference). Single confirming measurement:
point `TENSION_CORE` at `tension-core/target/debug/tension-core` (which reports
`async backend: continuations (wasmtime stack switching)`) and re-run those 63
cases; they must leave the `unresolved` class.

That subset has been run (`dl4/continuations-subset.txt`), and it does what the
diagnosis predicts:

    async_statement_before_await   PASS   async-before-await.ts:11
    async_statement_after_await    PASS   async-after-await.ts:13
    async_resume_in_loop           PASS   async-loop-resume.ts:13
    stack_switch_nested_resume     PASS   stack-switch-resume.ts:13
    task_entry_first_statement     FAIL   task-entry.ts:8 → no source file (4b)

and `examples/async-on-main/game.ts:77` stops at `game.ts:77` in `game/main`.
The one survivor in that list — `task_entry` — stops at the right address with
no source, which is §4b's defect, not the engine's.

No compiler change, no DWARF change, and no lldb change can move those 63, and
none should be attempted on their account.

### 4b. The 7 — the DWARF transform inside the JIT object (wasmtime), triggered by our range granularity

The object wasmtime hands lldb was read out of the live process (at the JIT
descriptor address) and dumped with `llvm-dwarfdump` — see
`dl4/jit-object-stats.txt`:

```
object                     ELF64 REL, 888248 bytes, 26 sections
.text                      address 0x…61db000, size 0xc000
.debug_ranges              7656 pairs, 5651 duplicates (74%), 187 gaps / 16363 bytes
.rela.debug_ranges         15312 relocations
.debug_line                1410 rows (all inside .text), 80 relocations
rows outside CU ranges     255 of 1410 (18.1%)
```

The compiler's own `.debug_ranges` is a clean tiling (3213 pairs, 88% of them
≤4 bytes, 169 one-byte gaps, **0 rows outside**). The transform turns that tiling
into per-instruction slivers with duplicates and gaps.

The mechanism is visible in the vendored source (read, not modified):

- `wasmtime-internal-cranelift-50.0.2/src/debug/transform/address_transform.rs`
  — `translate_ranges_raw` / `TransformRangeIter` map each `(start,end)` pair
  through the function's address map, rounding a non-instruction boundary to the
  previous `gen_end` / next `gen_start`. Thousands of 1–4 byte source pairs land
  in the same native instruction, which is where the 74% duplicates come from,
  and the rounding leaves the gaps.
- `…/transform/line_program.rs` — `clone_line_program` emits one row per compiled
  instruction whose wasm offset has a source row, and never consults the range
  list. So rows are placed at addresses the range list does not claim.

Owner of the invariant break: **the transform** (a vendored dependency we may not
change this round). Owner of the trigger: **the compiler's range emitter**,
`src/dwarf/index.ts`, which splits the CU's `DW_AT_ranges` at every line row
(2296 pairs of 2–4 bytes, 546 of 1 byte, out of 3213).

The next patch should therefore be a compiler change, and it should be additive:
emit **one range per function body in addition to** the row-split ranges.
Overlapping range entries are legal, the union is what a consumer tests, and a
whole-body range gives `translate_ranges_raw` a pair whose endpoints are function
boundaries. The module comment in `src/dwarf/index.ts` says whole-body entries
alone were rejected because "a whole-body entry hides any internal range that
begins and ends strictly inside it" — which is an argument against *replacing*,
not against *adding*.

**The single measurement that would confirm it:** rebuild with both, then check
the object, not the wasm — extract the JIT object as `dl4/lldb-extract.py` does
and assert `0 of 1410` line rows outside `DW_AT_ranges` (today: 255). If that
number does not reach 0, the next suspect is `clone_line_program`'s row placement,
not the range list.

I did **not** run that experiment: it edits `src/dwarf/encode.ts`, which this
round forbids.

---

## 5. The `io/game.ts:10` vs `:14` differential

On this host the case runs, and the two lines behave as the brief says they can —
but the difference between them is **not** a property of either line.

- Both are in `export function _start_game`, one CU, one build, one artifact.
- Line 10: `DWARF` rows `0x2259, 0x2272, 0x2276`; image rows `0x8f00, 0x8fa2,
  0x8fad, 0x9220, 0x924e, 0x9250` — **3 of 6 inside** a CU range. The first row,
  `0x8f00`, is inside → the breakpoint stops and prints
  `game/_start_game at game.ts:10:8`.
- Line 14: `DWARF` rows `0x2284, 0x2288, 0x228c, 0x229a, 0x22a9`; image rows
  `0x8fde, 0x8ff3, 0x8ffe, 0x9019` — **3 of 4 inside**. The first row, `0x8fde`,
  is *outside* → the breakpoint stops at the right address with no source file.

The structural difference is which of the transform's slivers each row landed in.
Note the direction: the brief records line 10 misbehaving and line 14 stopping
exactly (measured on Windows); on this Linux host line 10 is the one that
resolves and line 14 is not. A difference that inverts with the platform is not a
property of the two lines — it is a property of the range slivers, which move
with the emitted code.

There is one real asymmetry worth noting for the next round: lldb's line table
has 6 rows for line 10 and 4 for line 14 (the compiler emitted 3 and 5), so the
transform also *changes the row count* per line. That is the same
`clone_line_program` behaviour: it emits one row per compiled instruction, not one
per source row.

---

## 6. Gates

| gate | required | measured |
|---|---|---|
| `npm run check` | green | **exit 0** — `check:config`, `check:import`, `eslint --max-warnings 0` all clean |
| `npm run test` | unchanged | **exit 0**, `[ SUCCESS ] 71 checks` in the final suite |
| `npm run test:debug:unit` | 5 + 5 | **5 + 5** (`dwarf unit tests: ok (5 cases)`, `library-path test: ok (5 cases)`, parity 1155 B) |
| `npm run test:debug` | 2 PASS | **2 PASS** (`add-locals` 2 stops/5 vars, `await-locals` 1 stop/2 vars) |
| Tension `debugger` suite | 5 passed | **5 passed**, 0 failed, 0 ignored |
| census | 114 / 0 | **114 / 0**, ratchet `8 improved, 0 worse` |
| conformance, 82 cases | 63 / 7 / 0 / 12 | **63 / 7 / 0 / 12** (re-run this round, `dl4-gate-2026-11-21.json`; per case identical to `green-2026-11-21.json`) |

**Declared delta: zero, and zero is what happened.** No compiler behaviour
changed, so no conformance or census number moved.

Additional measurement (not a gate, and it uses a different engine binary on
purpose): the five async group-A cases re-run with
`TENSION_CORE=tension-core/target/debug/tension-core`, i.e. the continuation
backend — 4 PASS, 1 `no source file`; and the owner's own line stops at
`game.ts:77`. See `dl4/continuations-subset.txt`.

---

## 7. Files created or changed

`TensionScript-a2` (`fix/dwarf-prologue`, local, not pushed):
- `tests/debug/lib/dwarf-reader.js` — three cursor-only variables replaced by
  offset reads; commit `a82c1536`. Working tree clean.

`Tension` (`fix/dwarf-conformance`, local, not pushed):
- `tools/debug-conformance/STATE.md` — rewritten for DL4
- `tools/debug-conformance/STATE-DL3.md` — DL3's state, renamed (git mv)
- `tools/debug-conformance/dl4/dwarf-probe.mjs` — Phase B extractor
- `tools/debug-conformance/dl4/dwarf-side.json` — Phase B data
- `tools/debug-conformance/dl4/lldb-probe.py` — Phase C per-case lldb driver
- `tools/debug-conformance/dl4/lldb-cases.json` — Phase C data (5 cases / 6108 rows)
- `tools/debug-conformance/dl4/jit-object-stats.txt` — Phase D object dump stats
- `tools/debug-conformance/dl4/continuations-subset.txt` — the debug-engine
  re-measurement of §4a
- `tools/debug-conformance/dl4/lldb-extract.py` — the memory sweep that pulls the
  JIT object out of the process (so the next round can reproduce §4b)
- `tools/debug-conformance/dl4-gate-2026-11-21.json` — the gate run's capture
- `tools/debug-conformance/DL4-REPORT.md` — this file

---

## 8. What I did not verify, and what I assumed

- **I did not fix anything.** `src/dwarf/encode.ts` is untouched; the patch from
  DL3 stays as it was.
- **I did not re-run all 63 cases with the continuations engine.** I ran the five
  async group-A cases, the owner's own line, and one engine-level probe of every
  guest. The full 82-case matrix against `target/debug/tension-core` is the
  measurement the next round should do first: it is what turns 63 blank rows into
  63 verdicts, and 4 of the 5 sampled so far are `pass`.
- **I did not prove the proposed range fix works.** §4b names the experiment;
  running it would edit the compiler, which this round forbids.
- **The transform reading is from source plus the object's shape**, not from an
  instrumented wasmtime. I read `address_transform.rs` and `line_program.rs` in
  `wasmtime-internal-cranelift-50.0.2` and matched them to the measured
  duplicates/gaps; I did not add logging to the vendored crate.
- **`class_method`'s table row is the DL3 result**, measured again here with a
  different ASLR seed; the flip itself was measured in DL3.
- **The Windows `io:10`/`:14` observation is not reproduced** — this host is
  Linux and the direction is reversed here. I13 stays open.
- **The conformance gate still reports 63/7/0/12**, which is the declared delta,
  but 63 of those are unmeasured cases rather than failures. The gate is not
  wrong; its *label* is. Changing the harness's classification (refused-guest ≠
  unresolved) is a harness change and out of scope for a diagnosis round — but it
  is the first thing the next round should land, because otherwise the number
  keeps hiding 63 rows.
- **Assumptions I proceeded on:** that the conformance runner's engine is
  `resolveTensionCore()`'s answer with no `TENSION_CORE` in the environment (the
  runner prints it: `engine tension-core/target/release/tension-core`); that the
  JIT object I extracted (888 KB, 26 sections, `.wasmtime.engine` present) is the
  object lldb parsed for that run — it is the buffer at the JIT descriptor address
  lldb itself lists, and its `.debug_line` row addresses match lldb's entries
  exactly (1410 rows, same first address); and that `llvm-dwarfdump` applies the
  `.rela.*` relocations for a relocatable object, which it did — the dumped
  addresses are process addresses in `.text`, not zero-based offsets.
