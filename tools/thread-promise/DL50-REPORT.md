# DL50 — two gates that could not answer their own question

**One fixed, one blocked. The fixtures row is fixed and proved on both hosts. The Coverage fix is
written, measured end to end and committed — but it cannot be pushed, because the credential lacks
`workflow` scope, so there is no CI run id.**

```
Tension        feat/dl50-two-gates      @ (this commit)   ← Phase B, pushed
TensionScript  feat/dl50-coverage-heap  @ 56ab3e8a…       ← Phase A, LOCAL ONLY (push refused)
```

---

## 1. Phase A — Coverage, measured

### The corpus

A full local `npm test` under `NODE_V8_COVERAGE` (Node 26, exit 0, **1742 `SUCCESS` lines**, last one
`[ SUCCESS ] 71 checks` — `test:atomics`, the last script, exactly the line CI showed before it died):

```
total                      3.09 GB in 820 files
compile children (>5 MB)   3.02 GB in 382 files   97.7%
everything else            0.07 GB in 438 files
```

DL45 recorded 2.9 GB; this is 3.09 GB, i.e. the same corpus to within a few percent.

### What dominates it

Grouping the 820 files by write time (a gap > 3 s starts a new group), two groups hold **2.59 GB
of the 3.09 GB** — and within them it is compile children:

```
group  files    size     compiles
  4     261   977.4 MB     121
 10     410  1608.1 MB     200
```

Each compile child is ~8 MB: it loads the whole bundle and writes one coverage JSON.

### The decisive measurement: the corpus *is* the coverage

Dropping the compile children and asking the reporter what is left:

```
$ c8 report --temp-directory <non-compile files only>
Statements : 96.23% ( 307/319 )
```

Against the whole corpus:

```
Statements : 89.82% ( 83694/93173 )
```

**307 statements of 93,173 — 0.3%.** The compiler's own coverage is what those compiles record. So
option **(a)** ("every child compile writes to a scratch dir") would not shrink this corpus, it would
delete the job's subject. That is the round's first finding: the brief's preferred fix is the one the
measurement rules out.

### The reporter's need, both halves

Same machine, same finished corpus:

```
npx c8 report --temp-directory ./.coverage                     -> exit 134, core dumped
                                                                  "<--- Last few GCs --->"
NODE_OPTIONS=--max-old-space-size=8192 npx c8 report …          -> exit 0
                                                                  Statements : 89.82% ( 83694/93173 )
```

Reproduced the CI failure locally on Node 26 and closed it with the heap. Exactly the experiment §2
Phase A asked for, and it needed no guess.

### What DL47 added: nothing

The brief said "the threshold was crossed by this round's change, so the delta should be visible". It
was not, and the tree says why:

```
$ git diff --name-only 113fdd24..184b5d6f -- tests/
(empty)
$ git diff --stat 113fdd24..184b5d6f
 cli/index.js | 114 ++++++++---
 src/ast.ts   |  19 +++-
```

Between the last green tip and the red one **no test file changed** — the compile count and the corpus
size are identical. And DL45's own report already recorded this reporter needing 8 GB
(`NODE_OPTIONS=--max-old-space-size=8192 npx c8 report …`), getting CI to fit by shaving one test's
contribution from 46 MB to 264 KB. That fix still holds — measured now at **1 file, 180 KB**.

**So this is a knife-edge, not a regression.** DL45's margin was ~0.0016% of the corpus. A gate whose
margin is that thin was never a property; the next byte anywhere crosses it. That is the honest
diagnosis, and it is why the fix is a named heap waiver rather than another shave.

### The fix, and the waiver named

`.github/workflows/test.yml`, `Coverage` job only:

```yaml
    - name: Collect coverage
      env:
        NODE_OPTIONS: --max-old-space-size=8192
      run: |
        npx c8 --temp-directory ./.coverage -r none -- npm test
        echo "coverage corpus: $(du -sh ./.coverage | cut -f1) in $(ls ./.coverage | wc -l) files"
    - name: Output coverage summary
      env:
        NODE_OPTIONS: --max-old-space-size=8192
      run: npx c8 report --temp-directory ./.coverage -r text-summary
```

* **Waived:** the reporter gets 8 GB instead of the default. Named in the workflow comment with the
  abort/complete pair above.
* **Not bypassed:** every suite still runs and no count changes — the summary is the same at any heap.
* **New:** the corpus size is printed every run (`du -sh` + file count) so the trend is visible
  instead of discovered as a red job, and the temp dir is named so the two steps cannot disagree
  about where it is.
* **Rejected (c)** (per-suite reporting): it changes what the summary means, and 8 GB closes it today
  with the numbers recorded for the day it stops doing so.

Local verification of the report step exactly as the workflow now runs it: **exit 0,
`Statements 89.82% (83694/93173)`**.

## 2. BLOCKED — the workflow change could not be pushed

```
$ git push -u origin feat/dl50-coverage-heap
! [remote rejected] … (refusing to allow an OAuth App to create or update workflow
                        `.github/workflows/test.yml` without `workflow` scope)
```

The `gh` token lacks the `workflow` scope, so **no CI run exists and gate 3 is unmet**. I did not
reach for the SSH key to get around it: an SSH push would carry the same change past a restriction the
platform applied to this credential, and that is a decision for the seat, not for me.

To unblock, any one of:

1. `gh auth refresh -s workflow` (interactive, one-time), then I push and watch the run;
2. the seat pushes `feat/dl50-coverage-heap` (`56ab3e8a`, one file, YAML only);
3. the seat applies the same three lines to its copy.

The branch is local, clean, and contains only the workflow file.

---

## 3. Phase B — the fixtures row, fixed and proved on both hosts

**Old:** byte equality for every committed fixture. **New:** the comparison is chosen by a property of
the bytes — a fixture carrying `.debug_line` is compared by **DWARF shape**; everything else by
**bytes**.

`.debug_line` is exactly what carries `DW_AT_comp_dir`, so asking whether it is present asks the right
question; the property decides, not the directory name.

The comparator is the compiler checkout's own `tests/debug/census.js`, imported from that checkout the
same way `build-record.mjs` already is — one definition of what a line table means, and no second copy
here to drift. Addresses are excluded (an unpaired row's address is an absolute code offset); every
other field was measured to survive a `--compDir` change.

**The row says which comparison it used, per fixture.** The status cell carries the split and each
DWARF comparison names its host:

```
fixtures: committed .wasm -> build   15 present, equal by bytes …  15 current (13 bytes, 2 dwarf)  PASS
    …/fixtures/debug/main-policy.wasm: DWARF shape matches — units 1, files 21, lineRows 846,
        unreachable 6, unpaired 0 (host linux; bytes embed DW_AT_comp_dir and are not compared)
    …/fixtures/debug/rt-guards.wasm: DWARF shape matches — units 1, files 17, lineRows 871,
        unreachable 6, unpaired 0 (host linux; …)
```

### Linux, every row

```
compiler: src → dist/assemblyscript.js        159 inputs → 36f62922be1d     PASS
compiler: dist → installed                    035b816380d3 (tree)            PASS
compiler: std mirror (no compile reads it)    81 files identical             PASS
runtime: src → release                        84 inputs → 72beb026264c      PASS
runtime: src → debug                          84 inputs → 72beb026264c      PASS
fixtures: committed .wasm -> build            15 present, equal by bytes …  PASS
guests: tests/programs/**/*.ten → build/*.w…  35 built after source         PASS
guests: built by the installed compiler       70 of 70 current              PASS
guests: read set vs .debug_line               35 of 35 agree                PASS
docs: docs/abi/*.md                           generator --check clean       PASS
rebuild: 10/10 links PASS
```

### Windows — measured, not delegated

This box is WSL, so Windows `node.exe` (`v26.8.1`, `process.platform = win32`) was available. A clone
at `C:\dl50\Tension` on this branch, `.packs` tarball + manifest copied, `npm install --ignore-scripts`,
then **70 artifacts built by Windows**: 35 release, 35 debug.

**Before the fix, on those Windows-built bytes** — the seat's failure, reproduced:

```
fixtures: committed .wasm -> build   13 current, 2 behind   STALE
  …/fixtures/debug/main-policy.wasm: fixture 6d105e14ef83 != build 5a298e6b4deb
      (build/debug/main-policy.wasm) [fixture built by 035b816380d3]
  …/fixtures/debug/rt-guards.wasm: fixture 33c018e8ad6f != build cefe78d4960e
      (build/debug/rt-guards.wasm) [fixture built by 035b816380d3]
```

Same compiler on both sides of the inequality — the whole bug in two lines.

**After the fix, same tree, same bytes:**

```
fixtures: committed .wasm -> build   15 present, equal by bytes …  15 current (13 bytes, 2 dwarf)  PASS
    …/main-policy.wasm: DWARF shape matches — units 1, files 21, lineRows 846, unreachable 6,
        unpaired 0 (host win32; …)
    …/rt-guards.wasm:   DWARF shape matches — units 1, files 17, lineRows 871, unreachable 6,
        unpaired 0 (host win32; …)
```

`units 1, files 17, lineRows 871, unreachable 6, unpaired 0` is the seat's own WIN24 measurement, from
a Windows build made here independently.

**Two rows are not green on that clone, and are not this round's:** `runtime: src → release/debug` read
`binary missing` — the scratch clone never built the Rust runtime, and it has no cargo. Every row that
can be evaluated on Windows passes, including the two that failed.

**`0 built` on Windows** (gate 8), second consecutive run:

```
build-test-programs: 0 built, 35 up to date, 35 total
build-test-programs: 0 built, 35 up to date, 35 total — debug artifacts in …\build\debug
```

### The red cases

1. **A genuinely different line table fails.** `rt-guards` rebuilt at `--optimizeLevel 2`:
   `DWARF shape DIFFERS — 6 unreachable vs 17`, row `14 current, 1 behind`, `--check` 9/10, exit 1.
   Restored.
2. **A corrupt release fixture still fails** (bytes comparison untouched for 13 of 15). One byte of
   `fixtures/thread/two-workers.wasm` flipped at offset 200:
   `fixture 480b1d7958da != build 545676a847af`, STALE. Restored.
3. **A `--compDir`-only difference passes**, which is the fix's positive case: the same source built
   with `--compDir 'D:\a\Tension\…'` gives `6bb549ce6f76b91a` (315,068 B) against the fixture's
   `6d105e14ef83` (314,978 B) — bytes differ by 90, shape identical, row PASS.

---

## 4. What the tree contradicted

- **"The threshold was crossed by this round's change, so the delta should be visible."** No test file
  changed between the green and red tips (§1). There is no delta; there was a knife-edge.
- **Option (a) is ruled out by measurement**, not by preference: the compile children are 97.7% of the
  corpus *and* they are the coverage.
- **"Windows `--check` is 9/10"** — reproduced, and the two failures are exactly the two debug
  fixtures. On a scratch clone two further rows are unevaluable (no runtime binary), so this report
  claims the fixtures row, not a 10/10 for a tree this machine could not fully build.
- **`c8` is not a dependency.** `npx c8` floats — version `12.0.0` today, from the npm cache, with no
  entry in `devDependencies`. A reporter that can change without a commit in this repository is a
  second way this gate could answer differently than its words. **Reported, not changed:** pinning it
  is a dependency decision (and I115's tarball naming is the user's), so it is a recommendation.

## 5. What I did not verify

- **No CI run at all for Phase A** — the push was refused (workflow scope). Gate 3 is unmet and the
  Coverage job's green is unproven in CI, though the report step is proven locally end to end.
- **Windows 10/10** as a whole: the fixtures row, the guests rows and `0 built` are verified on
  `host win32`; the two `runtime:` rows need a Rust build this machine cannot do.
- The Windows numbers come from a clone at `C:\dl50\Tension`, not from the WIN24 tree at
  `C:\Work\Tension` (which is clean, at `main` `2abe6e7`, and has no `node_modules` installed).
- I did not measure the corpus on Node 24 (not installable here); the CI failure was on Node 24 and
  the local abort/complete pair is Node 26.
