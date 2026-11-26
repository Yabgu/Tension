# DL49 — the record sees what the compile read

**The record now states its read set, the chain rebuilt 70 artifacts without `--force`, the two
debug fixtures are re-pinned — and `--check` reads 10/10, one row more than the brief declared,
which is the only thing this round delivered beyond its terms.**

```
Tension  feat/dl49-read-set @ a55a0ab   (stacked on DL48's feat/dl48-fixture-row @ 2184f20)
         main 57f045c untouched · TensionScript untouched at 184b5d6f
```

---

## 1. Phase 0 — the four measurements that decided the fingerprint

**Cost.** Both trees, hashed with the canonical form: **5.5 ms for the pair**, 70 files /
820 KiB for `tension-framework/assembly` and 69 files / 974 KiB for `std/assembly`. Computed
**once per chain run**, never per artifact. Cost was never the reason this was not asked.

**Which trees vary, and how.** The path strings are **all in `.debug_line`**, none in `data`
and none in `name`:

```
artifact                           debug_line   data   name
async-after-await.wasm                     43      0     0
… (18 rows, identical shape) …
```

43 framework paths each, uniformly. So the 18 are one problem, not two — and it is a
debug-info path problem, which is why a release artifact could not have shown it.

**The 18, named:** `async-after-await`, `async-before-await`, `async-loop-resume`,
`class-method`, `fallback-loop`, `first-after-decls`, `first-branch`, `first-loop`,
`first-statement`, `lambda-body`, `main-policy`, `main-step-replaced`, `promise-fallback`,
`schedule-order`, `second-function`, `stack-switch-resume`, `start-game-entry`, `task-entry`.

**Release artifacts embed a dependency path: never.** 35 release artifacts, **0** embed a
framework or `std` path; **5** embed their own entry path — DL46's count, confirmed, and a
different question from this one.

---

## 2. The record's new shape, and why a per-tree digest is enough

`scripts/lib/read-set.mjs`. A real record, from a build that reads the framework:

```json
{
  "compiler": "035b816380d3…",
  "compilerPath": "node_modules/@yabgu_gm/tensionscript/dist/asc.js",
  "source": "async/main-policy.ten",
  "flags": ["--runtime", "incremental", …],
  "readSet": {
    "std": "2346398912f22cac…",
    "framework": "81ad87d3c84e1ea6…"
  }
}
```

and one from a build that does not — **no `framework` key at all**, so it makes no claim
about that tree and a framework change has no hold on it:

```json
  "source": "thread/count.ten",
  "readSet": { "std": "2346398912f22cac…" }
```

**Two trees, because the split is the only thing that makes the gate true.** `std` is read
by every build (the runtime is always linked), so a std change rebuilds all 35 — legitimate.
`framework` is read by 20 of the 35. One combined digest would rebuild all 35 for a
framework edit, which is over-invalidation and would make the brief's own requirement
("only the records whose builds read that tree") false.

**Canonical form:** `build-record.mjs`'s, so the two agree by construction — files sorted by
repo-relative POSIX path, `<path>\0<sha256>\n` each, one sha256 over the stream. A rename
changes it because the path is in the stream. No mtime appears anywhere.

**Why not a per-file graph.** A tree digest is conservative: it rebuilds more than strictly
necessary and never less. A per-file graph would rebuild less and would need the resolver's
rules restated in a second place — which is precisely how a build and its check come to
disagree, the failure this whole sequence of rounds is about. **The coarse hash is
sufficient; no graph was built.**

**How the walk is not trusted.** `readTreesFor` models the resolver by following import
literals (the compiler exposes no trace — `cli/options.json` has none). A model is what this
project keeps paying for trusting, so it is checked against a `--debug` artifact's
`.debug_line`, which lists every file the compile actually read:

```
check-read-set: 35/35 debug artifacts agree with the walk
```

That comparison is also a `--check` row (**the 10th**), so a future resolver change cannot
break the model silently:

```
guests: read set vs .debug_line   35 debug artifacts   35 of 35 agree   PASS
```

Red case for that row — making the walk claim no build reads the framework:

```
guests: read set vs .debug_line   35 debug artifacts   15 of 35 agree   STALE
rebuild: 9/10 links PASS, 1 STALE/UNKNOWN                          (exit 1)
```

---

## 3. The five behaviours, each measured

| change | result |
|---|---|
| a framework file added | `20 built, 15 up to date` — the readers only |
| that file removed again | `20 built, 15 up to date` — symmetric |
| a `std` file edited (every build reads it) | `35 built, 0 up to date` |
| `record.source` falsified (DL46's rule) | `1 built` |
| `record.compiler` falsified | `1 built (1 for a new compiler)` |
| `record.flags` falsified | `1 built` |
| `record.readSet` falsified (new) | `1 built` |
| **second consecutive run** | **`0 built, 35 up to date`** |

The last line is the point of the round: the skip is now correct rather than merely
present, so the rebuilt artifacts stay built and nothing needs `--force`.

**Declared vs measured rebuild count.** Declared before any run: 70 built on the first run
(35 release + 35 debug — all 70 because a record with no `readSet` key cannot be vouched
for), 0 on the second. Measured: `35 built` release, `35 built` debug, then `0 built` on
both. Exact.

---

## 4. The 18 after the rebuild

```
with a .ten framework path: 20 of 35
with a .ts  framework path:  0 of 35
```

20 rather than 18 because `main-policy` and `rt-guards` also read the framework and were
rebuilt by hand during DL48 while measuring — they were already `.ten`, so they are not in
the 18, and they are correctly in the 20.

---

## 5. Re-pinning — and the test it broke

```
main-policy.wasm      29f78b3dce08 -> 6d105e14ef83   311,696 -> 314,978 bytes
rt-guards.wasm        e57ec0a28eb1 -> 33c018e8ad6f   138,968 -> 140,113
rt-guards.wasm.map    bfca1cf07b7c -> 6108ef240e85   502,936 -> 512,984
```

Each taken from the matching `build/debug/` artifact of the same chain run, with its
`.build.json` beside it — that record is what `--check`'s fixture row quotes on a mismatch,
and a fixture whose record named a different compiler than its bytes would be a new lie.
`6d105e14` is the digest DL48 produced by rebuilding `main-policy` from scratch, which is
the independent confirmation that this is the same artifact.

**The re-pin failed a test, and that is the round's second find.**

```
test a_source_breakpoint_binds_in_a_promise_guest ... FAILED
  stopped in the host rather than the guest:
  stopped=true hit_breakpoint=true file=rt-guards.ten line=96 function=async/rt-guards/_start_game
```

The breakpoint bound at the right file and the right line. The failing assertion rejects a
stop whose function is not `<dir>/rt-guards.ten/_start_game` — the symbol
`f97c0f03b334` emitted. `035b816380d3` emits `async/rt-guards/_start_game`, because DL47
taught `mangleInternalPath` to strip `.ten`/`.tension` as well as `.ts`.

**So the assertion had been green over bytes its own compiler could not produce.**
`tests/support/programs.rs` prefers a *built* artifact when the checkout has a compiler, so
the suite was validating the symbol of an artifact the installed compiler never emits — and
only the corrupted skip condition kept that artifact in place. The read-set fix flushed it
out. This is DL48's flagged risk realised, and it was worth testing rather than assuming.

The assertion now names `async/rt-guards/_start_game`, which a host-frame stop still cannot
match. **`debugger`: `test result: ok. 5 passed; 0 failed`.**

---

## 6. Every gate

| gate | result |
|---|---|
| `--check` | **10/10 links PASS** — no STALE, no UNKNOWN |
| fixtures row | `15 present, each equal to its build` → `15 current` |
| guests row | `35 built after source` → `35 current` |
| read-set row (new) | `35 of 35 agree` |
| debug artifacts with a `.ts` framework path | **0 of 35** |
| `debugger` | **5 passed, 0 failed** |
| threads / fiber / fiber-executor / fiber-runner | **15 / 6 / 7 / 5** |
| async_on_main / async_main_promise | **2 / 2** |
| `--bin` default / audio-only | **307 / 298** |
| second consecutive chain run | **0 built** |
| `main` | `57f045c`, untouched |
| TensionScript | `184b5d6f`, untouched, clean |

---

## 7. What the tree contradicted in this brief

- **The gate's `9/9` is `10/10`.** I added one row — `guests: read set vs .debug_line` —
  because the read-set walk is a *model* of the resolver, and leaving a model unverified at
  the gate is the failure mode this round exists to fix. The brief's declared gate is 9/9;
  the measured result is 10/10 with the extra row proved to go red. If the seat wants
  exactly nine rows, this one is the candidate for removal — but I would not remove it.
- **"The 18 carry `.ts` framework paths" is right about the count and the section.** All 18
  carry them in `.debug_line` only — none in `data`, none in `name` — so they are one
  problem, not the two the brief allowed for.
- **The re-pin was not a bookkeeping step.** It broke `debugger`, and the break was real:
  the assertion encoded a symbol the installed compiler stopped emitting. The brief
  predicted the risk; the round found the failure.
- **A record's missing `readSet` had to mean "rebuild", not "pass".** The brief did not say
  which, and the alternative — treating a record without the key as current — would have
  left the artifacts stale while the new gate read green, reproducing the exact bug.

## 8. What I did not verify

- **No CI run.** Nothing was pushed and no workflow was watched; `--check`, the suites and
  the chain were all run locally.
- **No editor, no Windows.** WIN24 follows this merge.
- **The read-set walk is validated only on this corpus** — 35 debug artifacts, 100% agree.
  A guest importing a package this repo does not use would take the conservative branch
  (both trees), which is correct-but-over-invalidating and untested against a real case.
- **`tension-framework` renaming does not appear in release artifacts** (measured: 0 of 35
  embed a dependency path), so for the release profile the read set prevents a *rebuild
  that changes nothing*. Its value there is future-proofing; its demonstrated value is the
  18 debug artifacts.
- **The two re-pinned fixtures were verified against this machine's artifact**, which
  embeds `DW_AT_comp_dir` of `/home/acakar/work/Tension`. The README's "One non-portable
  detail" section still applies and is unchanged: a rebuild elsewhere is not byte-identical.
