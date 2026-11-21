# DL6 state — the eleven first statements, and a faster harness

Round: **DL6 — the eleven first statements, and a faster harness.**
Brief: `~/work/_cw/roundDL6.brief.txt`. Date 2026-11-22.
Earlier rounds: `STATE-DL3.md`, `STATE-DL4.md`, `STATE-DL5.md`.

## Phase 0 — durability: inventory, then push (no merge, no rebase, no PR)

Both repositories, before anything else:

| | Tension | TensionScript-a2 |
|---|---|---|
| branch | `fix/dwarf-conformance` | `fix/dwarf-prologue` |
| HEAD | `497cc83` | `a82c1536` |
| `git status --short` | clean | clean |
| `origin/fix/dwarf-conformance` | `497cc83` (in sync) | did not exist |

`git rev-parse --show-toplevel` was run before each push: the harness branch
lives in `/home/acakar/work/Tension` and the compiler branches in
`/home/acakar/work/TensionScript-a2`. No fetch, pull, rebase, merge or force.

Pushed (`git push -u origin <branch>`), remote SHAs read back with
`git ls-remote origin 'refs/heads/fix/*'`:

    /home/acakar/work/TensionScript-a2
      fix/dwarf-conformance      6424085ec9823cafccfe7f966974ad997f1173e7
      fix/dwarf-first-statement  0f771d74ae51243526d08cccfdba67b301c20927
      fix/dwarf-prologue         a82c153645dc06a45cab54aec18c749c360df2be
    /home/acakar/work/Tension
      fix/dwarf-conformance      497cc838d64cb6a90a87aee0104b325345095343  (already at HEAD)

The compiler remote previously carried `main` and feature branches only; the
three `fix/dwarf-*` branches are new there. **Asymmetry:** this protects
everything up to the moment of the push. Commits made later in this round are
not covered until pushed again, and this round pushes nothing else.

## Phase B — the harness runs on a bounded pool, and it is checked

`runner.js` now takes `--workers N` (default 8) and prints **one line per
completed case** (`ok 12/82 name`, else the failing verdict with its detail).
The classification moved to `lib/cases.js` so the inline path (`--workers 1`) and
the pool (`lib/case-worker.js`) run the *same* function; the load probe stays on
the main thread because it is cached per (program, executors) and re-probing it
per worker would multiply the same measurement. `workers` is recorded in the
capture header.

`--only` also learned that an exact name wins: the needle `transcript#1` matched
`transcript#1`, `#10` and `#11` before, so a filter meant to select twenty cases
selected twenty-one. That was caught by the first run of this check, not by
reading the code.

The check is `dl6/serial-parallel-subset.txt` — 20 cases, the 11 `no-source`
survivors plus 9 passes spread over every program group — run twice on the same
engine:

    TENSION_CORE=tension-core/target/release/tension-core \
      node tools/debug-conformance/runner.js --no-build --workers 1 <20 names> --json dl6/serial-20.json
    ...                                                       --workers 8       --json dl6/parallel-20.json

**Verdicts and observed lines identical, 20/20** (`differing: none`). Same name
set in all three of subset / serial / parallel. Timings on this machine: serial
≈ 7 min, `--workers 8` ≈ 75 s (~5.6x). Four full-matrix runs at 8 workers cost
what one serial run did.

## Phase C — the marker, measured two ways. Compiler `e72eb823`, `c8fd330b`

1. `standard_opcode_lengths` corrected for `0x09`, `0x0a`, `0x0c` (DWARF4
   §6.2.5.2). Emitted header verified byte-wise: `[0,1,1,1,1,0,0,0,1,0,0,1]`.
   Bought no case — lldb knows `0x0a` — but the commit that emits `0x0a` is not
   the one to leave the table lying about it.
2. `DW_LNS_set_prologue_end` on exactly one row of every sequence, no gate.

Placement measured both ways: **edge row (body's first byte) 71 / 11**;
**first row naming a source line 66 / 16**. The brief's boundary is the second
and loses five cases; the compiler keeps the first and says so.

`tests/debug/unit/dwarf.js` asserts the line program byte for byte; the marker
adds one byte, so the expected sequence was updated to the new whole sequence
(not shortened, not weakened) and now pins the marker too.

## Phase D — 59/17/6 → 71/11/0, and the eleven are a different defect

Engine release (2026-11-21, continuations, `stale: false`), `--workers 8`, run
twice on the same binary, per case identical. 12 moved, all failure → pass, no
regression. `game.ts:77` stops at `game.ts:77` in `game/main`, 3/3, and reports
no source on the unpatched compiler's guest.

For all 11 remaining cases the JIT object was extracted and the stop address
tested against the CU's `DW_AT_ranges`: **11 of 11 outside every range** (holes
`0x10`–`0x88` B before the next covered run); the passing control is inside.
Compiler object 0/2283 rows outside; JIT object 199/1025 (19.4%).

## Phase E — memo only

`dl6/PHASE-E-DL6.md`: three options with row/case counts; no recommendation.
The compiler cannot express full coverage (`start == 0` ranges are dropped;
whole-body ranges buy 1 row of 201). The decision belongs to the user, and
patching the vendored tree needs the standing rule lifted by name.

## Gates (DL6)

    npm run check ............ exit 0
    npm test ................. exit 0, 71 checks
    test:debug:unit .......... 5 + 5, parity 1155 B
    test:debug ............... 2 PASS
    Tension debugger test .... 5 passed (18.02 s)
    census ................... 114 unreachable, 8 improved / 0 worse
    conformance .............. 71 pass / 11 no-source / 0 wrong-line / 0 skipped
    serial vs parallel (20) .. identical 20/20
    game.ts:77 ............... stops at game.ts:77

Not on either remote: the compiler commits after `a82c1536` and the harness
commits after `497cc83`. Phase 0 protected everything up to the push, nothing
after it.
