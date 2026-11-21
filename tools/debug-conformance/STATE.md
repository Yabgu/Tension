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

## Phase A — pending

## Phase B — pending

## Phase C — pending

## Phase D — pending

## Phase E — pending
