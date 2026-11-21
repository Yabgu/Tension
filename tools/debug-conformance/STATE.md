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
