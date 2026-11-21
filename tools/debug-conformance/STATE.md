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
| lldb | `/usr/bin/lldb` | yes |

Red baseline re-confirmed on disk before Phase A: both captures hold 82 results,
`JSON.stringify(results)` identical, counts 63/7/1/11.

## Phase A — committed

Commit **`6c4c65f`** on `Tension` `fix/dwarf-conformance`:
`tools/debug-conformance/README.md` + `red-reproduced-2026-11-21.json`.

Headline of the reproducer: **82/82 identical verdicts to DL1**, 0 changed.
Second run used a `dist/` from main `41b8721b`, first used vendored pin
`150a6e97` — same DWARF for these 24 programs.

## Phase B — pending

## Phase C — pending

## Phase D — pending
