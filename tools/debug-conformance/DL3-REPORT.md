# DL3 report — the candidate patch, measured

Round: **DL3**. Brief: `~/work/_cw/roundDL3.brief.txt`. Date 2026-11-21.
Trees: `~/work/TensionScript-a2` (compiler), `~/work/Tension` (runtime, harness).
Everything below was measured in this round; nothing is recollection.

## 1. The seven §0 artifacts existed before I touched anything

| artifact | where | how I confirmed |
|---|---|---|
| clean pin | `TensionScript-a2` `main` @ `41b8721b` | `git log -1 main` |
| candidate patch | `fix/dwarf-first-statement` @ `0f771d74`, `+34/−1` `src/dwarf/encode.ts` | `git show --stat 0f771d74` |
| census + manifest | `fix/dwarf-conformance` @ `6424085e` | `git show --stat`; 18,828-line `tests/debug/census-manifest.txt` |
| harness + matrix | `Tension` `fix/dwarf-conformance` @ `f4cbc64` | `git log -1`; `matrix.json` (25 rows → 82 cases) |
| red capture DL1 | `red-capture-2026-11-21.json` | 82 results, 63/7/1/11 |
| red reproduced DL2 | `red-reproduced-2026-11-21.json` | present, **untracked** before Phase A |
| lldb | `/usr/bin/lldb` | present; the runner finds `/usr/sbin/lldb` first via `which` (both files exist, same size and mtime) |

I also re-confirmed the red number on disk before Phase A: both captures hold 82
results and `JSON.stringify(results)` is identical — **0 of 82 changed**.

## 2. Phase A — what DL2 left untracked is now committed

Commit **`6c4c65f`** on `Tension` `fix/dwarf-conformance`:
`tools/debug-conformance/README.md` and
`tools/debug-conformance/red-reproduced-2026-11-21.json`.

The reproducer's headline still reads: **82/82 identical verdicts to DL1**, 0
changed. It used a `dist/` from TensionScript `main` (`41b8721b`) where DL1 used
the vendored pin (`150a6e97`), so the red number is a property of the tree.

## 3. Phase B — the patch, unchanged

- Branch `fix/dwarf-prologue` created off `6424085e`; **`git cherry-pick 0f771d74`
  applied clean, zero conflicts.** Nothing retyped.
- `git diff --stat main..HEAD -- src/dwarf/encode.ts` →

      src/dwarf/encode.ts | 35 ++++++++++++++++++++++++++++++++++-
      1 file changed, 34 insertions(+), 1 deletion(-)

  (The other paths in `main..HEAD` are the census commit the branch was cut from
  — `package.json` +1, `tests/debug/*` — unchanged by this round.)
- Builds detached, ~11 s each, deterministic: base `6424085e` →
  `dist/assemblyscript.js` sha256 `66e6932e…`; patched `64222b3b` →
  `6202020e…` (rebuilt three times, same hash every time).

**How I verified the installed compiler is the patched one** (the step the brief
asks about):

```bash
sha256sum ~/work/TensionScript-a2/dist/assemblyscript.js \
          ~/work/Tension/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js
# both 6202020ea805f88079f110c41be7ed20d3663a0b7614fc3e9718ff61409ed827
grep -c "seqStart = start"     ~/work/TensionScript-a2/dist/assemblyscript.js.map  # 1
grep -c "set_prologue_end"     ~/work/TensionScript-a2/dist/assemblyscript.js.map  # 1
# on the clean build: 0 and 0, and "rows[first].addr" 1
```

Two traps worth recording. First, `dist/asc.js` — the minified CLI — is
**byte-identical between clean and patched**; the compiler is
`dist/assemblyscript.js`, so a hash comparison of `asc.js` would have "proved"
the wrong thing. I did copy `dist/*.js` once while the tree was on the clean
commit; the hash check caught it, and it was corrected before any artifact was
built. Second, the toolchain still prints *"vendored … g150a6e97"* because
`assertVendoredCompiler` checks package identity, not dist bytes — that line is
not evidence that the patched compiler ran; the hash is.

Artifacts: `build-test-programs.mjs --debug --force`, **24 built, 0 up to date,
exit 0**; `async-on-main.wasm` sha `983848d2…` (base) → `4c4e1db8…` (patched).

**Gate finding, made before anything was committed on Phase B:**
`npm run check` **fails on the base commit `6424085e`**, and fails identically on
the patched branch — `check:config` and `check:import` pass, `lint` reports 3
`no-unused-vars` warnings in `tests/debug/lib/dwarf-reader.js` lines 516, 518,
630, a file the **census commit added**. `main` (`41b8721b`) lints clean. So gate
#1 of §4 is red before this round touches anything. Not repaired here (it is
DL1's file, outside the four phases); reported as a finding.

## 4. Phase C — the green capture, same 82 cases

`runner.js --no-build --json green-2026-11-21.json`, detached, **12/82 pass**
(the runner exits 1 on any failure). `matrix.json`, the harness and every case
are untouched between the two captures.

### Flips, by failure mode

    unresolved            63 -> 63     (-0)
    stopped, no source     7 ->  7     (-0)
    stopped at wrong line  1 ->  0     (-1)
    pass                  11 -> 12     (+1)

Per-case transitions: 63 `unresolved→unresolved`, 7 `no-source→no-source`,
11 `pass→pass`, 1 `wrong-line→pass`.

**The one flip** is `class_method` (`class-method.ts:13`):
`stopped at 14` → `pass`. Right file, right line — the exact failure class the
owner describes as "right file, wrong line".

### pass → fail

**None.** All 11 pre-existing passes are still passes:
`first_statement_after_declarations`, `promise_backend_before_await`,
`class_constructor`, and 8 of the showcase print lines
(`rt_guards.transcript#3…#10`).

### Did not move — 70 cases

- `unresolved` (63): every async and stack-switching case
  (`async_statement_before_await`, `async_statement_after_await`,
  `async_resume_in_loop`, `stack_switch_nested_resume`,
  `task_entry_first_statement`, `entry_surface_main`), all of `async_on_main`
  (4), `main_policy` (4), `fallback_loop` (6), `main_step_replaced` (4),
  `schedule_order` (14), `thread_count` (5), `spawn_join` (7), `two_workers`
  (8), `spawn_refusals` (5).
- `stopped with no source file (empty)` (7): `first_statement_print`,
  `first_statement_branch`, `first_statement_loop`, `lambda_body`,
  `second_function_in_file`, `rt_guards.transcript#1`, `rt_guards.transcript#2`.
- `pass` (11): the guards above.

### The owner's own line is not fixed

`examples/async-on-main/game.ts:77` is `print("main: begin")`, the first
statement of `export async function main()`. Built with the patched compiler and
driven under lldb:

    node tools/e2e-debugger/runner.js --guest <patched game.wasm> --file game.ts --line 77
    {"stopped":false,"hit_breakpoint":false,"breakpoints":[{"id":1,"locations":0,"resolved":0}]}
    e2e: breakpoint at game.ts:77 never resolved

That artifact is **byte-identical** to the committed `build/game.wasm`
(`07b8a219…`) — the patch changes nothing for this program. The matrix's nearest
rows, `async_on_main.transcript#1..#4` (`async-on-main.ts:50,61,62,63`, inside
`async function main`), are `unresolved` before *and* after.

**And the row exists.** The census on both artifacts:

    line …/examples/async-on-main/game.ts:77   locations 3  bytes 32
    line async/async-on-main.ts:50             locations 3  bytes 6
    module-total unreachable_lines 3-6   unpaired_addresses 0

So the 63 `unresolved` cases are **not** a missing-row class: the rows are
there, with spans and inside the unit's ranges, and lldb still binds zero
addresses. That is the census README's own warning ("a case can be `unresolved`
with every line reachable") turning out to be the main class here. Not diagnosed
this round.

## 5. Phase D — which half is load-bearing

All three variant builds come from `fix/dwarf-prologue`, artifacts rebuilt
`--force`, 82 cases re-run, cases unchanged. Full working notes:
[`PHASE-D-DL3.md`](PHASE-D-DL3.md).

| build | `seqStart` | prologue marker | unresolved | no-source | wrong-line | pass | census unreachable |
|---|---|---|---|---|---|---|---|
| red (base) | `rows[first].addr` | none | 63 | 7 | 1 | 11 | 153 |
| (a) alone | `start` | none | 63 | 7 | 1 | 11 | 153 |
| (b) alone, as written | `rows[first].addr` | guarded block | inert — 24/24 artifacts byte-identical to base | | | | |
| (b) alone, constructed | `rows[first].addr` | bare `DW_LNS_set_prologue_end` | 63 | 7 | 0 | 12 | 153 |
| (a)+(b) as committed | `start` | guarded block | 63 | 7 | 0 | 12 | 114 |
| (a)+(b), re-measured | `start` | guarded block | 63 | 7 | 0 | 12 | 114 |

Findings:

1. **(a) alone moves nothing** — 0 of 82 verdicts, census identical to base.
   Mechanically right: moving the sequence start adds a row *address* but no
   *row*; rows only come from `DW_LNS_copy`, and the first copy still lands at
   `rows[first].addr`, so the prologue interval stays uncovered.
2. **(b) as the candidate writes it is dead code without (a).** Its guard is
   `if (head.addr > seqStart)`, and `head` *is* `rows[first]`, so with
   `seqStart = rows[first].addr` the condition is false. Measured, not argued:
   that variant's 24 artifacts are byte-identical to the base build, so no
   82-case run was spent on it.
3. **The prologue marker is what flips `class_method`.** (b) alone, constructed
   the only way the guard permits (marker emitted before the loop, `seqStart`
   untouched), reproduces the flip exactly: 63/7/0/12, `class_method` → `pass`,
   no census change.
4. **The census improvement needs both halves.** 153 → 114 only under (a)+(b);
   (a) alone 153, (b) alone 153. The 39 saved lines are prologue bytes that get
   a row only when the sequence starts at the body *and* the block emits a copy
   there. The pair also gives four `no source file` cases a **second** resolved
   location (`locations 1` → `2`, verdict unchanged): `first_statement_print`,
   `first_statement_branch`, `lambda_body`, `second_function_in_file`.

**So, plainly:** the candidate fixes one conformance case out of 64 failing
ones, and the mechanism that does it is (b), not (a). (a)'s contribution is
invisible to the conformance gate and visible only to the census. The coupling
of (b) behind (a)'s guard is an artifact of how the candidate was written, not
a requirement — the constructed (b) shows the marker works with `seqStart`
unmoved.

The committed build was restored (`git checkout -- src/dwarf/encode.ts`, clean
against `HEAD`), rebuilt and re-run a third time: 12/82, `results` array
**byte-identical** to the Phase C green capture (0 of 82 differ), compiler and
artifact hashes identical. The flip is stable, not a flake.

## 6. Pre-existing suites, before and after

| suite | before (base `6424085e`) | after (patched `64222b3b`) | delta |
|---|---|---|---|
| `npm run check` (compiler) | **FAIL** — tsc clean, lint 3 warnings in `tests/debug/lib/dwarf-reader.js` (516, 518, 630) | **FAIL**, byte-identical output | none — pre-existing |
| `npm run test:debug:unit` | ok: dwarf 5 cases, library-path 5 cases | ok: dwarf 5 cases, library-path 5 cases; parity 1147 B → 1155 B | none (the unit test asserts cli↔lib parity, not a byte count) |
| `npm run test:debug` | PASS add-locals (2 stops, 5 vars), PASS await-locals (1 stop, 2 vars) | identical | none |
| Tension `debugger` suite | 5 passed, 0 failed, 0 ignored (14.21 s) | 5 passed, 0 failed, 0 ignored (10.61 s) | none |
| line census (`test:debug:census`) | 24 modules, 18,336 lines, `unreachable_lines 153`, `unpaired_addresses 0` | `114`, `0`; ratchet: **8 improved, 0 worse** | improves, 0 worse |
| debug conformance, 82 cases | 63 / 7 / 1 / 11 | 63 / 7 / 0 / 12 | +1 pass, from the wrong-line class only |

No pre-existing suite changed state; the only substantive deltas are the
conformance count and the census, both accounted for above. No assertion was
weakened, no case edited, no skip added.

## 7. Files created or changed

`Tension` (`fix/dwarf-conformance`, local — not pushed):
- `tools/debug-conformance/README.md` — committed (DL2's, was untracked)
- `tools/debug-conformance/red-reproduced-2026-11-21.json` — committed (was untracked)
- `tools/debug-conformance/STATE.md` — created, updated after each phase
- `tools/debug-conformance/green-2026-11-21.json` — created (Phase C capture)
- `tools/debug-conformance/FLIPS-DL3.md` — created (flip table by failure mode)
- `tools/debug-conformance/PHASE-D-DL3.md` — created (three-build decomposition)
- `tools/debug-conformance/phase-d-a-only-2026-11-21.json` — created
- `tools/debug-conformance/phase-d-b-only-2026-11-21.json` — created
- `tools/debug-conformance/phase-d-ab-recheck-2026-11-21.json` — created
- `tools/debug-conformance/DL3-REPORT.md` — this file

`TensionScript-a2` (`fix/dwarf-prologue`, local — not pushed):
- `src/dwarf/encode.ts` — the cherry-pick itself, `+34/−1`, commit `64222b3b`; no other commit, working tree clean

Outside the trees: `/tmp/dl3/*` (build script, variant sources, capture copies,
census dumps) — scratch, not evidence of record; the committed captures are.

## 8. The commands, so the next round can copy them

```bash
# a long run: start detached, never in the foreground
cd ~/work/Tension
setsid nohup sh -c 'node tools/debug-conformance/runner.js --no-build \
    --json tools/debug-conformance/green-2026-11-21.json \
    > /tmp/dl3-green.log 2>&1; echo "EXIT=$?" >> /tmp/dl3-green.log' \
  >/dev/null 2>&1 </dev/null & disown

# poll — each call returns in milliseconds
tail -3 /tmp/dl3-green.log
grep -q "EXIT=" /tmp/dl3-green.log && echo DONE || echo RUNNING
ls ~/work/Tension/tools/debug-conformance/.cache/work | wc -l   # 0..82, one dir per case
```

The runner prints the whole table only at the end, so the `.cache/work` count is
the only progress signal; it needs no `--json` and no inspection of the log. One
run of 82 cases takes **~20 min** on this host (14 min for the first, 20 min for
the rest — the first was warmer).

Compiler build + install + artifact rebuild, also detached
(`/tmp/dl3/build.sh <label>`):

```bash
export PATH=$HOME/emsdk:$HOME/emsdk/upstream/emscripten:$PATH
cd ~/work/TensionScript-a2 && node scripts/build
cp dist/*.js ~/work/Tension/node_modules/@yabgu_gm/tensionscript/dist/
cd ~/work/Tension && node scripts/build-test-programs.mjs --debug --force
```

## 9. What I did not verify, and what I assumed

- **The owner's symptom is not fixed.** `game.ts:77` still resolves 0 locations
  (measured, §4). This round fixes one `class_method` line, not the complaint.
- **The `unresolved` class (63 cases) is not diagnosed.** What I did establish
  is that its lines have rows with nonzero spans and paired addresses, so it is
  not the census's `unreachable_lines` class. Why lldb binds nothing there is
  open; the next round should suspect something other than the line program
  (the debugger's view of the JIT image, the CU's name for the source file, or
  function attribution) rather than encoding more rows.
- **The `no source file` class (7) is untouched and undiagnosed.** (a)+(b) gives
  four of them a second resolved location but their verdict does not change.
- **The census improvement is not a user-visible improvement.** 153 → 114
  unreachable lines, and no case moved for any of those lines. It is a real
  change in the emitted DWARF; it is not a breakpoint that now works.
- **Windows: not run.** I13 stays OPEN; I claim nothing there.
- **Only the declared gates were run.** I did not run the compiler's full
  `npm test` or the whole `cargo test`, so "no pre-existing test changes state"
  is verified for §4's six gates, not for every suite in either repo.
- **`npm run check` is red on the base and stays red** (§3). It is a pre-existing
  hole in a file DL1 added; repairing it was outside the four phases.
- **`docs/debugging.md` not read as truth, not rewritten** (I2). It lives on
  `fix/dwarf-async-line-table` @ `d81864c`; disposition: untouched, still known
  wrong.
- **Nothing was pushed and no PR was opened.** `main` is untouched in both trees
  (`TensionScript-a2` `41b8721b`, `Tension` `56ddabb`); all work is on local branches.
- **Assumptions I proceeded on:** that `/tmp/artifacts-before` (snapshotted
  before I installed anything) really were the base build — supported by its
  18,828-line census matching the committed manifest byte-for-byte and by the
  base-equivalent variant rebuilding all 24 artifacts byte-identically; and that
  the toolchain re-resolves `dist/` at each compile rather than caching it —
  supported by artifact hashes changing immediately after an install and only
  then.
