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
