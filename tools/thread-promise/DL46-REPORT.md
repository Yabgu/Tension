# DL46 — `.ten` is the canonical guest spelling

| | |
|---|---|
| `~/work/Tension` | branch **`feat/dl46-ten-canonical`** @ **`9c87286`** (off `main` `cae892c`), clean |
| `~/work/TensionScript-a2` | branch **`feat/dl46-ten-canonical`** @ **`80876492`** (off `develop` `368742df`), clean |
| `main` | **untouched** — Tension `cae892c`, TensionScript `main` = `develop` = `368742df` |
| `--check` | **9/9** at the tip; `inputs 800f07d27523` / `bundles f97c0f03b334` (unchanged), runtime `fefddc6e7a0b` → **`ff87421e5d2b`** (`src/debug.rs` is an input) |
| gate | threads **15** · fiber **6** · fiber-executor **7** · async_on_main **2** · async_main_promise **2** · debugger **5** · fiber-runner **5** · `--bin` **307**/**298** · census **71/82** · CLI test **5 checks** |

**Nothing was pushed.** No reset of a product tree, no `--force`, no rebuild forced.

**Six things the brief got wrong, or that the tree decided for me.** Each is measured below
rather than argued: the name is **4 characters shorter, 8 UTF-16 bytes**, not 5/10 (§2.1);
the per-artifact release delta is **−16 or 0**, not −8 (§4); **4 committed fixtures move**,
not 0 (§5); the documented chain **skipped all 35** until I fixed the skip condition (§3);
the debugger suite **failed** and needed the host changed, not the test (§6); and the
compiler's deprecation notice now recommends the wrong spelling, which I may not fix (§9).

---

## 1. Phase 0 — the site census, per site

| site | count | what it is |
|---|---|---|
| guest sources | **30** | `tension-core/tests/programs/**/*.tension` |
| build records | **70** | `build/*.build.json` + `build/debug/*.build.json` |
| committed fixture records | **15** | `fixtures/*/*.wasm.build.json` |
| committed fixture `.wasm` | **15** | 4 of them embed a path (§5) |
| build glob | **0 literals** | `isGuestSource()` — generic by construction |
| alias source strings | **5** | `scripts/lib/program-aliases.mjs` |
| `guest-extensions.mjs` | 1 table + prose | `GUEST_EXTENSIONS` |
| `rebuild.mjs` | 1 | the `guests:` row label (plus a DL45 history comment, kept) |
| `build-test-programs.mjs` | 3 prose | comments naming a program |
| `debugger.rs` | **13** | breakpoint file names and the JIT symbol |
| `launch_config.rs` | 3 | the `.ts` enumerator's assertion |
| `.vscode/tasks.json` + `launch.json` | **21 + 1** | command strings and one comment |
| `programs/README.md` | 9 | the program→test table |
| fixture READMEs | 11 | regeneration recipes |
| `docs/debugging.md` | 1 + 1 | a measurement row (kept) and the note above it (changed) |
| CI steps (Tension) | **0** | no step spells a guest path; this job compiles no guest |
| `tools/debug-conformance/matrix.json` | **25** | breakpoint `file` fields — §6 |
| extension repo `package.json` | **0 changes** | verified below |

**The extension needs no change, verified rather than assumed:**

```
$ python3 -c "…package.json…"
extensions: ['.tension', '.ten']        ← both claimed since EXT1
id: tension
$ grep -c tension syntaxes/tension.tmLanguage.json
1        ← the only hit is `source.tension`, a scope name, not an extension
```

So `.ten` has opened as TensionScript since EXT1 shipped; nothing to do, and I changed
nothing there (brief §4 forbids it).

### 1.1 The declared delta, written before anything was touched

```
30 sources renamed · 70 build records + 15 fixture records rewritten
release: 5 of 35 move, each -8 bytes
debug:   35 of 35 move, predicted total -4808 bytes
fixture .wasm: 4 of 15 move        ← NOT the brief's 0
suites unchanged, guests 35, census 71/82
```

## 2. The rename

30 × `git mv`, so git records **R100** (100% similarity) for every one:

```
$ git show --name-status --format="" 50d183e | awk '{print $1}' | sort | uniq -c
     30 M
     30 R100
```

`examples/async-on-main/game.ts` untouched — both the file and the glob, which names the
extension so it cannot sweep the example up.

### 2.1 The arithmetic, measured

```
len('.tension') = 8   -> 16 UTF-16 bytes
len('.ten')     = 4   ->  8 UTF-16 bytes
difference      = 4 characters, 8 bytes
```

The brief says **5 characters / 10 bytes**. It is **4 / 8**: `.tension` is `.ten` plus
`sion`. This matters because the whole per-artifact prediction is built on it, and the
prediction was wrong in a second way too (§4).

---

## 3. The first real finding: the documented chain skipped everything

Run per the brief — the documented chain, no `--force`:

```
$ node scripts/build-test-programs.mjs
build-test-programs: 0 built, 35 up to date, 35 total
```

**Nothing rebuilt**, and every record still named `.tension`. The skip condition was
mtime + compiler identity + flags. None of those can see a rename: `git mv` preserves the
mtime, and the record's own `source` field was not part of the test.

DL45's commit message had flagged exactly this as a known gap ("on a tree that renames
without changing the compiler, the records would have kept naming `.ts` and nothing would
have said so"). This round hit it. Fixed by making the record's source part of the skip:

```js
const upToDate =
    !force && existsSync(wasm) &&
    statSync(wasm).mtimeMs >= statSync(ts).mtimeMs &&
    identity.hash !== null && record !== null &&
    record.compiler === identity.hash &&
    record.source === rel &&              // ← added: a rename is visible
    sameFlags(record.flags, usedFlags);
```

Then, and only then, `35 built, 0 up to date, 35 total`.

**This is the round's most useful finding**: without it, the brief's "70 records rewritten"
would have been false while every command reported success.

---

## 4. The byte gate, per profile

**Method.** sha256 of all 70 artifacts before the rename (`/tmp/dl46-A-*.txt`), then after.
For every mover, the pre-rename artifact was **rebuilt from a `.tension` copy** of its
source with the same flags and compared to the recorded baseline hash — which both proves
the compiler deterministic and isolates the name as the only changed input.

### 4.1 Release: 5 of 35, and the set is exactly the prediction

| artifact | moved? | predicted |
|---|---|---|
| async-main-promise | yes | yes |
| promise-fallback | yes | yes |
| rt-guards | yes | yes |
| two-waiters-late | yes | yes |
| wake-on-worker | yes | yes |
| other 30 | no | no |

```
predicted set == measured set: True
unpredicted movers: none
predicted but did not move: none
```

All five reproduced the **pre-rename bytes exactly** from a `.tension` copy (5/5 `True`).

**But the per-artifact delta was not −8:**

```
async-main-promise   -16 B   (23588 -> 23572)
promise-fallback      +0 B   (162116 -> 162116)
rt-guards            -16 B   (26136 -> 26120)
two-waiters-late     -16 B   (29999 -> 29983)
wake-on-worker        +0 B   (30012 -> 30012)
```

**Why, measured.** The only section whose size differs is `data`. Inside it the path is a
length-prefixed UTF-16 string — old prefix `0x40` (64 bytes) → new `0x38` (56) for
`async/async-main-promise` — so the string itself is 8 bytes shorter. The remaining 8 are
the runtime object header that records the string's size plus the block's alignment: in two
of the five the padding absorbs the 8 bytes (net 0), in three it does not (−16). Normalising
the string in the old artifact and re-diffing still leaves a length mismatch of 8, which is
where the header's own size field lives.

**`code` is byte-identical for two of five, and moves for three** — the same split DL45
reported, for the same reason, shown rather than asserted:

```
artifact               code identical  global identical
async-main-promise     False           False
promise-fallback       True            True
rt-guards              False           False
two-waiters-late       False           False
wake-on-worker         True            True
```

and the WAT diff says what the difference *is* — data-segment base addresses moving by the
shift, with every constant that refers to them following:

```
<  (global $~lib/rt/__rtti_base i32 (i32.const 3600))
>  (global $~lib/rt/__rtti_base i32 (i32.const 3584))
<  (data $13 (i32.const 796) "\…@\00\00\00a\00s\00y\00n\00c…t\00e\00n\00s\00i\00o\00n…")
>  (data $13 (i32.const 780) "\…8\00\00\00a\00s\00y\00n\00c…t\00e\00n…")
```

So the gate's "name bytes only, `code` byte-identical where it is" holds in the precise
sense: **the only input that changed is the path**, proven by reproducing old bytes from the
old spelling; the byte-level consequences include address relocation, because a shorter name
moves the data layout, and no rename can avoid that.

### 4.2 Debug: 35 of 35, predicted 35

```
debug: 35 compared, 35 moved (predicted 35)
moved set == all 35: True
old bytes reproduced from .tension (same basename): 35/35
measured total debug delta: -4816   (predicted -4808)
```

**A false start worth recording:** my first reproduction attempt got **0 of 35**, because I
wrote the rebuilt artifacts to `/tmp/dl46/dold-<name>.wasm` — and a debug build embeds its
**source-map URL**, which names the *output* basename. Same basename → 35/35 reproduced.

The 8-byte total error is entirely in the five artifacts that carry the data-section string:

| artifact | predicted | measured | off |
|---|---|---|---|
| async-main-promise | −464 | −472 | −8 |
| promise-fallback | −172 | −164 | +8 |
| rt-guards | −256 | −264 | −8 |
| two-waiters-late | −312 | −320 | −8 |
| wake-on-worker | −336 | −328 | +8 |

and the corrected model reproduces every one exactly:

```
debug delta = -4 × (UTF-8 occurrences in .debug_line)  +  (the release-profile delta for
                                                            that same source)
```

because a DWARF name is plain bytes (−4 per char) while the data-section string behaves as
measured in §4.1 (−16 or 0).

### 4.3 Determinism, unasked for

After the branch shuffle forced a rebuild by mtime, both profiles were rebuilt again:

```
release: 35 compared, 0 changed by the second rebuild
debug:   35 compared, 0 changed by the second rebuild
```

## 5. Committed fixtures: 4 of 15, not 0

A fixture is a copy of a build artifact, so the same rule applies:

| fixture | moves | why |
|---|---|---|
| `debug/main-policy.wasm` | yes | 26 UTF-8 DWARF occurrences |
| `debug/rt-guards.wasm` | yes | 62 UTF-8 + 1 UTF-16 |
| `thread/two-waiters-late.wasm` | yes | 1 UTF-16 |
| `thread/wake-on-worker.wasm` | yes | 1 UTF-16 |
| the other 11 | no | neither form |

`fixtures/debug/rt-guards.wasm` **had** to be refreshed regardless of bytes: `tests/debugger.rs`
sets a breakpoint *by file name* and `guest_debug` prefers the committed fixture over a fresh
build, so a stale fixture makes the breakpoint bind nowhere. Its `.map` was refreshed with it.
All 15 fixture records were rewritten and now name `.ten` (0 remain on `.tension`).

## 6. Two regressions the rename caused, and what fixed them

**1. The debugger suite failed — `4 passed; 1 failed`.**

```
the report must carry the lldb recipe line
  `lldb: breakpoint set -f rt-guards.ten -l <line>`
```

The host pinned the extension: DL44 wrote `.tension` into `tension-core/src/debug.rs`
because "the extension has to be the one the artifact's line table carries". Pinning a third
extension would inherit the same defect for every guest still spelled `.tension`.

So it is now **derived from the module**: `GuestDebugInfo.source_file` scans the bytes for
`<stem>.tension` / `.ten` / `.ts`, longest first (`x.ten` is a *prefix* of `x.tension`).
Measured, same artifact stem, two spellings built side by side:

```
/tmp/dl46/a/rt-guards.wasm  (from .tension) -> breakpoint set -f rt-guards.tension -l <line>
/tmp/dl46/b/rt-guards.wasm  (from .ten)     -> breakpoint set -f rt-guards.ten -l <line>
```

Back to **5 passed**.

**2. The census reported `0/82 pass … [unresolved 82]`.** Its case matrix spelled 25
breakpoint files as `.tension`; lldb was asked for files no line table has. Converted →
**71/82 pass, 0 skipped, 11 no-source**, unchanged.

(I also hit a **third**, self-inflicted: `git reset --hard` to restore `main` silently took
an uncommitted `rebuild.mjs` edit with it. It was re-applied and committed in the same round,
and the ledger is in §11.)

## 7. `--check`, every row, at the tip

```
$ TENSIONSCRIPT_DIR=/home/acakar/work/TensionScript-a2 node scripts/rebuild.mjs --check

compiler: src → dist/assemblyscript.js        159 inputs → 800f07d27523     recorded 800f07d27523           PASS
compiler: dist → installed                    f97c0f03b334 (tree)           f97c0f03b334 (installed)        PASS
compiler: std mirror (no compile reads it)    81 files identical            81 identical                    PASS
runtime: src → release                        84 inputs → ff87421e5d2b      recorded ff87421e5d2b           PASS
runtime: src → debug                          84 inputs → ff87421e5d2b      recorded ff87421e5d2b           PASS
fixtures: committed .wasm                     15 present, none behind its…  15 present, all current         PASS
guests: tests/programs/**/*.ten → build/*.w…  35 built after source         35 current                      PASS
guests: built by the installed compiler       70 recorded by f97c0f03b334   70 of 70 current                PASS
docs: docs/abi/*.md                           generator --check clean       current                         PASS

rebuild: 9/9 links PASS
```

The `guests:` row reads **`.ten`**, as required. Compiler identity is **unchanged**
(`800f07d27523` / `f97c0f03b334`) — no compiler source moved. The runtime digest moved
`fefddc6e7a0b` → `ff87421e5d2b` because `src/debug.rs` is one of its 84 inputs (§6).

## 8. Suites, from their own lines

| suite | line |
|---|---|
| threads | `test result: ok. 15 passed; 0 failed; …` |
| fiber | `test result: ok. 6 passed; 0 failed; …` |
| fiber-executor | `test result: ok. 7 passed; 0 failed; …` |
| async_on_main | `test result: ok. 2 passed; 0 failed; …` |
| async_main_promise | `test result: ok. 2 passed; 0 failed; …` |
| debugger | `test result: ok. 5 passed; 0 failed; …` (after §6) |
| fiber-runner | `test result: ok. 5 passed; 0 failed; …` |
| `--bin` default | `test result: ok. 307 passed; 0 failed; …` |
| `--bin` audio-only | `test result: ok. 298 passed; 0 failed; …` |
| census | `debug-conformance: 71/82 pass, 0 skipped, 11 fail [no-source 11, pass 71]`, host `lldb /usr/bin/lldb`, engine `tension-core/target/release/tension-core [continuations]` |
| `tests/cli/guest-extension.js` | `[ SUCCESS ] guest-extension: 5 checks` |

Guests **35**; no new program.

**A `.ten` guest compiled, and runs:**

```
$ node scripts/tensionscript.mjs .../async/async-on-main.ten -o /tmp/dl46/async-on-main.wasm \
    --runtime incremental --target release --enable stack-switching --exportStart __start --optimizeLevel 0
< exit 0, 17897 bytes >

$ sha256sum /tmp/dl46/async-on-main.wasm  tension-core/tests/programs/build/async-on-main.wasm
c56e0925528bd0c1…  /tmp/dl46/async-on-main.wasm
c56e0925528bd0c1…  tension-core/tests/programs/build/async-on-main.wasm      ← identical

$ ./tension-core/target/release/tension-core /tmp/dl46/async-on-main.wasm
INFO  core: executor: continuation (wasm suspend, resumed by the executor table)
carried: 11
carried: 12
carried: 13
suspensions: 7
total: 33
```

## 9. The docs, and which rule I applied where

**Rule: a doc that records a measurement keeps its spelling; a doc that tells someone what
to type gets the new one.** Applied site by site:

| file | treatment |
|---|---|
| `tools/thread-promise/DL*-REPORT.md` | **untouched** — past rounds describe trees as they were |
| `docs/debugging.md` DWARF table rows | **kept** — a measurement from before DL45, still `.ts` |
| `docs/debugging.md` note above that table | **changed** — it tells a reader what the file is called now: "renamed twice since, `.ts` → `.tension` (DL45) → `.ten` (DL46)" |
| `programs/README.md`, five fixture READMEs | **changed** — they list files that exist today and give commands to run |
| `.vscode/tasks.json` / `launch.json` | **changed** — commands to type |
| `TensionScript/docs/guest-editor.md` | **changed** — leads with `.ten`, keeps both associations |
| `TensionScript/types/tension-guest.d.ts` | **changed**, one clause — its opening comment names the extension a guest is opened with |
| `tests/cli/guest-extension.js` header | **changed**, comment only (below) |

`docs/guest-editor.md`, the diff that matters:

```
-## 1. Tell the editor that `.tension` and `.ten` are TypeScript
+## 1. Tell the editor that `.ten` and `.tension` are TypeScript
   "files.associations": {
-    "*.tension": "typescript",
-    "*.ten": "typescript"
+    "*.ten": "typescript",
+    "*.tension": "typescript"
   }
-    "**/*.tension"
+    "**/*.ten"
+`.ten` is the canonical spelling (DL46); `.tension` — the longer spelling DL45 chose —
+stays accepted, so both associations are here and either opens with the server attached.
```

**The CLI test: assertions unchanged, message fixed** (brief Phase B). It still asserts
**5 checks**, and `bytes.tension.equals(bytes.ten)` is still true because all three spellings
still compile to identical bytes. What changed is its header, which called `.tension`
canonical — now false.

### 9.1 A consequence I could not fix, and am not hiding

The compiler's deprecation notice still says:

```
WARNING: 'n.ts' uses the deprecated guest extension '.ts'.
         Rename it to '.tension' — the compiler accepts it now and will not forever.
```

`.tension` is `ENTRY_EXTENSIONS[0]` in `cli/index.js`, and **§4 of the brief forbids editing
compiler sources**, so the notice now recommends an *accepted* spelling rather than the
canonical one. The test asserts the notice as it is (it must reflect the compiler, not the
project's wish), and its header records the mismatch so the next round that may touch `cli/`
finds it. **This is a real inconsistency introduced by this round.**

## 10. Commits

```
TensionScript  80876492  docs: the editor recipe leads with .ten
Tension        d54dace  build: the skip must see the record's source, and .ten is canonical
Tension        50d183e  guests: the 30 sources are .ten, and everything that spells a guest path says so
Tension        9c87286  debug: the lldb hint names the file the artifact carries, not the canonical one
```

Both on `feat/dl46-ten-canonical`; `main` (`cae892c`) and `develop`/`main` (`368742df`)
untouched, nothing pushed.

**The branch is an assumption I had to make.** The brief never says to branch, and gate 8
says "`main` untouched by you" — which cannot hold if the work lands on it. Every prior round
worked on a feature branch and the seat handles refs, so I committed to
`feat/dl46-ten-canonical` in both repos and left `main`/`develop` at their tips. If you
wanted the work on `main`, it is a fast-forward.

## 11. What I did not verify

- **No editor window was opened.** `.ten` opening as TensionScript rests on the extension
  *claiming* it (`extensions: ['.tension', '.ten']`, read at §1) and on EXT2's tokenizer
  assertions — not on a running window.
- **The committed extension is EXT2's 0.1.0**, installed before this round. It already claims
  `.ten`, so nothing was rebuilt or reinstalled; I did not verify the install still loads it.
- **The `-16 / 0` split is measured, not derived.** I traced it to the UTF-16 string, the
  runtime header that records its size, and block alignment — and confirmed the *rule* by
  reproducing the release deltas for all five — but I did not read the compiler's string
  allocator to predict which artifacts land on which side.
- **Windows** — nothing ran there; the branch has not been fast-forwarded or pushed.
- **The `.tension` path still builds** — asserted by the CLI test's three-spelling equality
  (5 checks) and by rebuilding every artifact from a `.tension` copy (40 builds, all byte-equal
  to a baseline), but I did not run the *suite* against a tree checked out at `.tension`.
- **The `docs/debugging.md` breakpoint table's line numbers** still refer to the old file;
  they were measurements, and I did not re-measure whether `34/35/36` still hold on
  `async-on-main.ten`.
