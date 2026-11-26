# DL48 — the fixture row compares the artifact, not the source's history

**The comparison is fixed. It is not 9/9, and the reason is a real finding rather than a
false positive — so the round stops here, as its own rules require.**

```
Tension  feat/dl48-fixture-row @ 51a6624   (stacked on DL47's feat/dl47-ten-everywhere @ 7ad75a4)
         main 57f045c untouched · TensionScript untouched at 184b5d6f
fixtures: committed .wasm -> build   15 present, each equal to its build
                                     13 current, 2 behind, 0 not built        STALE
```

---

## 1. What the old code measured, and what the new code measures

**Old** — a proxy. For each committed `.wasm` it found a *source* by basename and asked
`fixtureIsCurrent`, which compared **git commit time** and then, for ties, the source
*blob's* history:

```js
const source = findSourceFor(rel);          // by basename, against a source tree
if (source === null) continue;              // <-- five fixtures were skipped here
if (!fixtureIsCurrent(rel, full, sourceRel, source)) older += 1;
```

It answered "has the source changed since the fixture was committed?" That is not the
question the row exists to ask. DL48's case: two comments in `thread/wake-on-worker.ten`
name sibling guests, the rename correctly updated them, the source's commit time moved, and
the row called a correct fixture STALE:

```
build/wake-on-worker.wasm            sha256 32b809546361de1e
fixtures/thread/wake-on-worker.wasm  sha256 32b809546361de1e   identical
```

A comment never reaches a release artifact. **The fixture was right and the row was wrong.**

**New** — the direct measurement. For each committed fixture, find the artifact of the same
program and compare sha256:

```js
const artifact = fixtureArtifact(rel);            // by artifact name, not by source
if (!existsSync(artifact)) { notBuilt.push(...); continue; }
const want = captureHash(artifact);
const have = captureHash(full);
if (want !== have) behind.push(`${rel}: fixture ${have.slice(0,12)} != build ${want.slice(0,12)} ...`);
```

Pairing rule: `fixtures/debug/<name>.wasm` is a `--debug --sourceMap` build (its README says
so) and pairs with `build/debug/<name>.wasm`; every other fixture directory holds release
bytes and pairs with `build/<name>.wasm`.

### The second defect the proxy was hiding

A fixture was paired to a source **by basename**, and five of the fifteen
(`fixtures/fiber/*-fiber.wasm`) have no source of their own — they are `PROGRAM_ALIASES`
builds of a base program under different flags. `if (source === null) continue;` meant those
five were **never compared at all**, inside a row that printed "15 present, all current".
Pairing by artifact name needs no source and covers all fifteen.

### Three states, not two

| state | meaning | what to do |
|---|---|---|
| `current` | fixture and artifact are byte-identical | nothing |
| `behind` | an artifact exists and differs — both digests named, plus the fixture's own `build.json` compiler where it has one | decide which side is out of date |
| `not built` | no artifact for this fixture | run the chain — this is *not* staleness |

Conflating the last two is what made the old row unreadable.

**Helpers:** five are deleted, not left dead — `fixtureIsCurrent`, `findSourceFor`,
`lastCommit`, `blobAt`, `fixtureCommit`. Nothing else called any of them (checked across
`scripts/`, `tension-core/`, `tools/`). `GUEST_EXTENSIONS` is no longer imported by
`rebuild.mjs`; it stays in `runner.mjs` and in this module's `guestStem`/`isGuestSource`,
and the comment claiming `findSourceFor` walked it — and that the compiler's table still
read `.tension` first — is corrected.

`row()` gained an optional `detail` list printed under the table, so the digests a verdict
rests on are on screen rather than implied.

---

## 2. The red case

One byte of a currently-matching fixture flipped at offset 100:

```
fixtures: committed .wasm -> build   15 present, each equal to i…  12 current, 3 behind, 0 not built   STALE
    .../fixtures/thread/wake-on-worker.wasm: fixture 7d4762024399 != build 32b809546361
      (.../build/wake-on-worker.wasm) [fixture built by f97c0f03b334]
rebuild: 8/9 links PASS, 1 STALE/UNKNOWN        (exit 1)
```

Restored from a saved copy; `git status` on the fixture directory is empty.

**Not built**, proven separately by moving `build/suspend-serve.wasm` aside — the row names
the missing path and does not call it stale:

```
.../fixtures/thread/suspend-serve.wasm: no tension-core/tests/programs/build/suspend-serve.wasm
```

---

## 3. Why it is 8/9 and not 9/9 — the finding, not a failure to fix

Two committed debug fixtures are **genuinely behind**:

```
fixtures/debug/main-policy.wasm: fixture 29f78b3dce08 != build 3101af466beb  [fixture built by f97c0f03b334]
fixtures/debug/rt-guards.wasm:   fixture e57ec0a28eb1 != build 33c018e8ad6f  [fixture built by f97c0f03b334]
```

**The cause is DL47, and it is the mechanism DL47 itself measured.** DL46 (`50d183e`)
re-pinned both fixtures. DL47 then changed the compiler — `f97c0f03b334` → `035b816380d3` —
and correctly declared that all 35 debug artifacts move, because `mangleInternalPath` now
drops the extension and every mangled name and DWARF reference shortens. DL47 rebuilt the
artifacts and **did not re-pin the two committed fixtures that mirror them.**

The verdict is robust, not an artefact of a stale artifact. `build/debug/main-policy.wasm`
on this tree is itself pre-rename, so it was rebuilt from scratch as well:

```
fixture        29f78b3dce08ed94
on-disk       3101af466beb48a6     (pre-rename paths)
fresh build   6d105e14ef837dc9     (current compiler, current tree)
```

The fixture matches neither. It is behind.

**I did not re-pin them.** The brief forbids it twice — "No fixture is rebuilt to make the
number fit … the report says so and the round stops; the seat decides" (§1.3) and "any
fixture regeneration" under NOT in this round (§4). Re-pinning also changes what five
`debugger.rs` assertions bind their breakpoints against, which is a decision about test
input, not a formatting fix.

**The decision is one line:** re-pin those two fixtures to the current build, as DL46 did —
after which this row reads `15 current` and `--check` is 9/9. I have not run it.

---

## 4. A separate finding, reported and not fixed

**18 of the 35 debug artifacts still embed `.ts` framework paths** — they predate DL47's
rename and were never rebuilt against it:

```
debug artifacts with .ten framework paths:   1   (rt-guards, rebuilt by hand while measuring)
debug artifacts with .ts  framework paths:  18
```

The `guests:` rows cannot see it: a guest's record states its own source, compiler and
flags, and a **rename of a dependency** changes none of them. So `70 of 70 current` is true
as stated and the tree is still stale, in the same class as the DL47 lesson that a skip
test which ignores part of what a record states can be wrong. Fixing it means teaching the
skip test about dependencies — a different change, out of this round's scope.

---

## 5. What the tree contradicted in this brief

- **The stale fixture was `wake-on-worker.wasm`, not `dwarf-guest/game.wasm`** — the seat's
  measurement is right and DL47's report was wrong twice: `dwarf-guest` lives under
  `tension-core/tests/fixtures/`, which this row never enumerates, and the provenance
  argument was invented for a verdict about a different file. Corrected in its own commit.
- **"confirm 9/9" is not reachable within the round's own rules** — two fixtures are behind
  for a real reason. Details in §3.
- **The old row was checking 10 fixtures, not 15.** The five `fiber/*-fiber` alias builds
  were skipped by the null-source `continue`.

## 6. What I did not verify

- No editor, no CI run; nothing was pushed except this branch.
- I did not confirm that re-pinning the two debug fixtures leaves `debugger.rs` green — that
  is the check the seat should run before or with the decision in §3.
- The `18 stale debug artifacts` finding is counted by grepping for a framework path string
  in `.debug_line`; I did not verify a per-artifact semantic equivalence beyond the two I
  rebuilt by hand.
