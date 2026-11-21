# DL3 state — round in progress

Round: **DL3 — apply the candidate fix, measure the flips, never block on a long call.**
Brief: `~/work/_cw/roundDL3.brief.txt`. Date 2026-11-21.

## §0 artifacts confirmed present before any change

| artifact | where | confirmed |
|---|---|---|
| clean pin | `TensionScript-a2` `main` @ `41b8721b` | yes |
| candidate patch | `fix/dwarf-first-statement` @ `0f771d74`, `+34/−1` src/dwarf/encode.ts | yes |
| census + manifest | `TensionScript-a2` `fix/dwarf-conformance` @ `6424085e` | yes |
| harness + matrix | `Tension` `fix/dwarf-conformance` @ `f4cbc64` | yes |
| red capture DL1 | `red-capture-2026-11-21.json` | yes |
| red reproduced DL2 | `red-reproduced-2026-11-21.json` | yes (was untracked) |
| lldb | `/usr/sbin/lldb` (found by `which`; `/usr/bin/lldb` is the same install) | yes |

Red baseline re-confirmed on disk before Phase A: both captures hold 82 results,
`JSON.stringify(results)` identical, counts 63/7/1/11.

## Phase A — committed

Commit **`6c4c65f`** on `Tension` `fix/dwarf-conformance`:
`tools/debug-conformance/README.md` + `red-reproduced-2026-11-21.json`.

Headline: **82/82 identical verdicts to DL1**, 0 changed. Second run used a
`dist/` from main `41b8721b`, first used vendored pin `150a6e97` — same DWARF
for these 24 programs.

## Phase B — committed (compiler `64222b3b`)

- `TensionScript-a2` branch `fix/dwarf-prologue` created off `6424085e`.
- `git cherry-pick 0f771d74` — **clean, zero conflicts**.
- `git diff --stat main..HEAD -- src/dwarf/encode.ts` → `35 +-`, `+34 −1`. The
  other files in `main..HEAD` are the census commit the branch was cut from
  (`package.json` 1 line, `tests/debug/*`), unchanged by this round.
- Build: `node scripts/build` on base and on patched, **detached**, each ~11 s.
  Bundle `dist/assemblyscript.js` is deterministic:
  - clean base `6424085e` → `66e6932e6d0621f6…`
  - patched `64222b3b` → `6202020ea805f880…` (rebuilt twice, same hash)
  - (`dist/asc.js` is the minified CLI and is byte-identical across both; the
    compiler is `dist/assemblyscript.js`.)
- Provenance of the installed compiler: the vendored copy at
  `Tension/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js` was
  replaced and its sha256 **equals** the patched bundle's; the patched
  `dist/assemblyscript.js.map` contains `seqStart = start` and
  `set_prologue_end`, the clean map contains neither (and does contain
  `rows[first].addr`). Note the toolchain still prints "vendored … g150a6e97"
  because it asserts package identity, not dist bytes — the dist hash is the
  evidence, not that line.
- Matrix artifacts rebuilt detached: `build-test-programs.mjs --debug --force`,
  **24 built, 0 up to date, exit 0**. `async-on-main.wasm` sha changed
  `983848d2…` → `4c4e1db8…`; single-module census on it 4 → 3 unreachable.

### Pre-existing gate failure found here (before the fix, on the base)

`npm run check` **fails on `6424085e`** (and would fail on the patched branch
identically): tsc `check:config` and `check:import` pass, `lint` reports 3
`no-unused-vars` warnings in `tests/debug/lib/dwarf-reader.js` (516, 518, 630)
— a file added by the census commit. **`main` `41b8721b` lints clean.** So the
gate is red before this round touches anything. Not repaired in this round (it
is DL1's file, outside the four phases); reported as a finding.

## Phase C — measured

Green capture: `node tools/debug-conformance/runner.js --no-build --json
tools/debug-conformance/green-2026-11-21.json`, detached, **12/82 pass, exit 1**
(runner exits 1 on any failure).

Flip table by failure mode (details in `FLIPS-DL3.md`):

    unresolved            63 -> 63
    stopped, no source     7 ->  7
    stopped at wrong line  1 ->  0
    pass                  11 -> 12

- the one flip: `class_method` `class-method.ts:13`, `stopped at 14` -> `pass`.
- `pass -> fail`: **none**.
- 70 cases did not move (63 unresolved, 7 no-source, 11 pass).
- The owner's complaint class (`async_on_main.transcript#1..#4`,
  `async-on-main.ts:50,61,62,63`, inside `async function main`) is `unresolved`
  before and after. **This patch does not fix the reported symptom.**

## Owner's line, measured directly

`examples/async-on-main/game.ts:77` (`print("main: begin")`, first statement of
`export async function main()`) compiled with the patched compiler:

    node ~/work/TensionScript-a2/bin/tensionscript.js game.ts -o /tmp/dl3/l77-patched/game.wasm \
         --runtime incremental --debug --sourceMap --exportStart __start --enable stack-switching
    node tools/e2e-debugger/runner.js --guest /tmp/dl3/l77-patched/game.wasm --file game.ts --line 77

    {"stopped":false,"hit_breakpoint":false,"breakpoints":[{"id":1,"locations":0,"resolved":0}]}
    e2e: breakpoint at game.ts:77 never resolved

The artifact is **byte-identical** to the committed `examples/async-on-main/build/game.wasm`
(sha256 `07b8a219…`), so the patch changes nothing at all for this program.

**And the row exists.** The census on that artifact:

    file …/examples/async-on-main/game.ts lines 29 unreachable 0 locations 224 bytes 2182
    line …/game.ts:77 locations 3 bytes 32
    module-total unreachable_lines 6 unpaired_addresses 0

Same shape in the conformance guest: `async/async-on-main.ts:50,61,62,63` each
have 3 locations and 6 bytes, `unpaired_addresses 0` — and lldb still resolves
**0** locations for them. So the 63 `unresolved` cases are **not** a
missing-row class, and the census's `unreachable_lines` is not the same set.
Not diagnosed this round; recorded because a future fix will need it.

## Phase D — design (running)

| build | `seqStart` | prologue marker | measured |
|---|---|---|---|
| (b) alone, as the candidate writes it | `rows[first].addr` | guarded block kept | **byte-identical artifacts to base, 24/24** — the guard `head.addr > seqStart` is false, so the block never runs. Inert; no 82-case run needed |
| (a) alone | `start` | none | **63/7/1/11 — 0 of 82 moved; census 153 (unchanged)** |
| (b) alone, constructed | `rows[first].addr` | bare `DW_LNS_set_prologue_end` before the loop | **63/7/0/12 — same single flip; census 153 (unchanged)** |
| (a)+(b) as committed, rebuilt | `start` | guarded block | **63/7/0/12, results byte-identical to the Phase C green capture** |

Conclusion: the prologue marker is what flips `class_method`; the pair is what
closes the census holes (153 -> 114). (b) as the candidate writes it is dead
code without (a).

## Gates (all measured on the patched branch, artifacts from the committed build)

| gate | before (base `6424085e`) | after (`64222b3b`) |
|---|---|---|
| `npm run check` | FAIL — 3 lint warnings in `tests/debug/lib/dwarf-reader.js` (516, 518, 630), tsc clean | FAIL, identical output (pre-existing; `main` lints clean) |
| `npm run test:debug:unit` | ok, 5 + 5 cases (parity 1147 B) | ok, 5 + 5 cases (parity 1155 B) |
| `npm run test:debug` | 2 PASS (add-locals, await-locals) | 2 PASS, identical |
| Tension `debugger` suite | 5 passed, 0 failed | 5 passed, 0 failed |
| census | 153 unreachable / 0 unpaired | 114 / 0, ratchet 8 improved 0 worse |
| conformance, 82 cases | 63/7/1/11 | 63/7/0/12 (reproduced twice) |

Report: `DL3-REPORT.md`. Round complete as a measurement; the owner's symptom
(`examples/async-on-main/game.ts:77`) is **not** fixed by this patch.
