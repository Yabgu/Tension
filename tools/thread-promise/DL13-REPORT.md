# DL13 — `fix/dwarf-prologue` is on `main`

First merge to `main` in this arc. Six commits, fast-forward, tree content-neutral.
`~/work/TensionScript-a2` `main` @ **`646e6058`**, pushed; PR **#77** merged.
Harness `~/work/Tension` untouched at `integration/dwarf-debug 6bcb28a`.

## 0. Phase 0

```
fix/dwarf-prologue @ 646e6058            (working tree was on fix/plain-worker)
git fetch origin                         (no new refs)
main..fix/dwarf-prologue        6
fix/dwarf-prologue..main        0
merge-base --is-ancestor main fix/dwarf-prologue   → FF-OK
origin refs/heads/main                  41b8721b4c…c5cb…   ← as expected
origin refs/heads/fix/dwarf-prologue    646e6058c0…70d0
```

The six commits, exactly the ones listed:

```
646e6058 async: an async main runs on the Promise backend
c8fd330b debug(unit): pin the prologue_end byte in the line-program sequence
e72eb823 dwarf: the line program's opcode lengths, and a prologue end on every sequence
a82c1536 debug: advance the line-table cursor without naming the fields it skips
64222b3b dwarf: start each line sequence at the function body, and mark the prologue
6424085e debug: the DWARF line census, and the ratchet it was missing
```

`git diff --stat 646e6058 fix/dwarf-prologue` empty — the branch head **is** the
verified tree.

## 1. Phase A — the PR

**#77** — https://github.com/Yabgu/TensionScript/pull/77
base `main` ← head `fix/dwarf-prologue`, `mergeable: MERGEABLE`, six commits visible.

Body as submitted carried:

- **the census** — 25 matrix rows → 82 cases over 24 programs; at `646e6058`
  **71 pass / 11 `no-source` / 0 wrong-line / 0 unresolved / 0 skipped**, unpatched
  baseline 59 / 17 / 6;
- **the two defects** — 6 `wrong-line` from a missing `DW_LNS_set_prologue_end`, and
  63 `unresolved` that were *not* compiler work (stale release engine refusing 14
  continuation modules), stated separately so the count is not misread;
- **the async fix** — no shell at all on the Promise build, gated on a
  reachability-blind `hasAwait`; the new third shell and the `hasAsyncMain` latch;
- **cross-platform** — Linux builds `45b3535e`; Windows produced the same bytes from
  the same commit (attributed to the Windows round, re-confirmed here for Linux);
- **what is not fixed** — the 11 `no-source` are upstream wasmtime's range
  transform, with the compiler object at 0 rows outside its CU ranges and the JIT
  object at ~19%; the analysis lives in the harness repo at
  `tools/debug-conformance/dl6/PHASE-E-DL6.md`.

Two count corrections were made to the draft before submission: 25 artifacts (not
24) for the byte-identity claim, and the `async-on-main` transcript is **28** guest
lines (the earlier "30" included two log lines).

## 2. Phase B — the merge

**Method: plain fast-forward** (`git merge --ff-only`), then `git push`.

```
git rev-parse HEAD                 646e6058c0c39f78bdf623b8c70568a420d370d0
git ls-remote origin refs/heads/main   646e6058c0c39f78bdf623b8c70568a420d370d0
```

A fast-forward was chosen over rebase-and-merge deliberately: **it preserves the six
SHAs unchanged**, so the commit Windows and Linux both verified (`646e6058` → bundle
`45b3535e`) is the commit on `main` — no re-cut hashes to re-establish. No squash, no
merge commit, no force-push.

```
git log --oneline -7
646e6058 async: an async main runs on the Promise backend
c8fd330b debug(unit): pin the prologue_end byte in the line-program sequence
e72eb823 dwarf: the line program's opcode lengths, and a prologue end on every sequence
a82c1536 debug: advance the line-table cursor without naming the fields it skips
64222b3b dwarf: start each line sequence at the function body, and mark the prologue
6424085e debug: the DWARF line census, and the ratchet it was missing
41b8721b Merge pull request #76 from Yabgu/fix/resume-sent-types
```

**Tree did not move:** `git diff --stat 646e6058 HEAD` → empty.

GitHub recorded it as merged with `mergeCommit == 646e6058` (state `MERGED`), i.e. it
saw the same fast-forward.

## 3. Phase C — `main` itself

**1. Bundle hash.** Clean `npm run build` of `main`:

```
dist/assemblyscript.js   45b3535e91aed73e75723035f6a07d1ab74ad57528e6c2730066f6cbc10835de
```

Exactly the hash both platforms produced from this tree. (`dist/asc.js` is
`e635a221…`; it is the bootstrap stub and proves nothing about the compiler.)

**2. Suites on `main`:**

| suite | exit | summary |
|---|---|---|
| `npm run check` | **0** | tsc --noEmit + `eslint --max-warnings 0`, clean |
| `npm test` | **0** | 20 test groups `[ SUCCESS ]`, no failure block |
| `npm run test:compiler -- --parallel` | **0** | `[ SUCCESS ]`, 7 pre-existing feature skips (`relaxed-simd`, `reference-types`, `gc`, `exception-handling`, `bindings/raw`, `bindings/esm`, `features/threads` instantiation) |

**3. The prologue fix is present — an A/B that fails without it.** The census needs a
release engine; this is the cheap direct check, and it is a measurement, not an
inference. Same source (`conformance/first-statement.ts`), same flags, two compilers:

| | pre-fix `41b8721b` (`66e6932e…`) | `main` `646e6058` (`45b3535e…`) |
|---|---|---|
| `standard_opcode_lengths[DW_LNS_set_prologue_end]` | **1** — wrong, DWARF4 §6.2.5.2 says 0 | **0** |
| rows flagged `prologue_end` | **0** | **64** |
| total line rows | 2219 | 2283 |

Read with `llvm-dwarfdump --debug-line`. The pre-fix bundle hash `66e6932e…` matches
what DL6 recorded for unpatched `41b8721b`, so the A/B is against the same compiler
that round used.

**4. `git status --short` on `main`: empty.**

## 4. CI

**32/32 checks pass on PR #77**, and the push run on `main`
(`45049314651`) completed **success** in 13m44s. Windows compiles on both Node lines
(`node current` 5m09s / 7m47s, `node lts/*` 7m43s / 7m59s) — two runs each, one for
the PR and one for `main`. No failures, nothing skipped by me, no workflow edited.

## 5. State, and one loose end

```
~/work/TensionScript-a2   main  646e6058  clean, pushed
~/work/Tension            integration/dwarf-debug  6bcb28a  clean, untouched
```

**Loose end, deliberate:** `Tension/node_modules/@yabgu_gm/tensionscript/dist/` still
holds `767d3d7a` (the `fix/plain-worker` build) because this round does not touch the
harness. `main`'s own `dist/` is now `45b3535e`. Any later round that measures a
thread guest must install the branch compiler explicitly, or it will measure `main`'s
and see different exports.

## 6. What I did not verify

- **The Windows bundle hash** was not reproduced here. It is reported by the Windows
  round; I only re-derived the Linux side. CI's Windows compiler jobs pass on both
  Node versions, which is corroborating but is not a hash.
- **The census was not re-run on `main`.** The artifacts are byte-identical between
  `41b8721b`'s parent tree and this one (verified in DL9), and the compiler bundle is
  the hashed, verified one, so the 71/11 stands on the tree identity rather than on a
  fresh 12-minute run.
- `git status --short` empty is on `main` **after** the rebuild; `dist/` is ignored,
  so a clean tree does not mean `dist/` is unbuilt.
- The PR body cites the harness-repo memo path for the upstream defect; a reviewer
  without that checkout has only the summary in the body.
