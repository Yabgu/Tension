# DL47 — every TensionScript source becomes `.ten`

**One round, one change: 174 TensionScript sources renamed from `.ts` to `.ten`, the
resolver taught to find them, and the proof that the rename moved nothing but the name.**

The rule is the user's and it is about reading: *"it is really wrong to view them as .ts in
vscode it cripples the experience hugely."* A `.ten` file opens as TensionScript; a `.ts`
file opens as TypeScript and argues with valid guest code.

```
Tension        feat/dl47-ten-everywhere @ c5e612f   (main 57f045c untouched)
TensionScript  feat/dl47-ten-resolver   @ 184b5d6f  (develop untouched)
               installed compiler 035b816380d3 · --check 8/9, one row explained
```

---

## 1. Phase 0 — what the tree said

**The classification.** `git ls-files '*.ts' | grep -v tests/programs/` = **176**,
matching the brief. **Zero of them import a `node:` module** — the brief's claim held for
every file, so no file had to be left behind as genuine TypeScript. Per group:

| group | `.ts` | renamed | survivor |
|---|---|---|---|
| tension-framework | 106 | 105 | `index.d.ts` (a declaration file) |
| examples | 28 | 27 | `async-on-main/game.ts` (the user's) |
| tension-ogre | 18 | 18 | — |
| tools | 13 | 13 | — |
| apps | 4 | 4 | — |
| tension-solver | 3 | 3 | — |
| packages | 2 | 2 | — |
| tension-input | 1 | 1 | — |
| tension-core | 1 | 1 | — |
| **total** | **176** | **174** | **2** |

Nine of the 176 carry no guest-only syntax (`i32`, `@external`, `~lib/`); each was read
individually and all nine are guests — two `export *` barrels, one pure-log line, three
games that only `print`, one editor entry, and `runtime/layout.ts`, which is *generated*.
**`*.d.ts`: exactly one**, `tension-framework/index.d.ts`, not renamed.

**Does a relative `.ten` import resolve?** No — measured before any edit:

```
$ printf 'export function helper(): i32 { return 7; }' > b.ten
$ printf 'import { helper } from "./b"; ...' > a.ten
$ node scripts/tensionscript.mjs a.ten -o a.wasm
ERROR TS6054: File 'b.ts' not found.        FAILURE 1 parse error(s)
```

So Phase A was required, and it was not a one-line change.

**Package imports.** `examples/io/node_modules/tension-framework` is a **symlink** to
`../../../tension-framework`; `ascMain` names the entry file. Resolution goes through the
`node_modules`/`paths` branch of `getFile`, which built `${plainName}${extension}` — one
more site that hardcoded `.ts`.

**The framework's pre-rename output:** `1afa738e372b4256`, 90,612 bytes.

---

## 2. Phase A — the resolver

Two changes that are one thing: a `.ten` file that imports `./b` must find `b.ten`.

**`cli/index.js` — one helper, four call sites.** `readFirstOf(base, baseDir)` tries
`base{ext}` in `ENTRY_EXTENSIONS`' declared order and answers text *and* path together, so
a diagnostic names the file that was actually read. It is used by relative imports
(`./b`, then `b/index`), custom `--lib` dirs, and the `node_modules`/`--path` branch;
`listFiles` accepts `.ten`/`.tension` in a custom lib dir. `.d.ts` fallback and `~lib`'s
in-memory map are unchanged (the map is already keyed without an extension).

Additive by construction: **every file spelling is tried before any `index` spelling**, so
a tree of only `.ts` resolves exactly as it did and `b/index.ts` still loses to `b.ts`.

**`src/ast.ts` — `mangleInternalPath` strips every accepted extension.** This is the change
the brief does not enumerate and Phase A cannot be finished without. Resolution alone is
not enough: the compiler matches an import against a parsed file by *internal path*, and
this function mangled `.ts` only. `b.ten` became internal path `b.ten` while the import
asked for `b`, `Program#lookupForeignFile` returned null, and the compiler **died with a
bare `AssertionError: assertion failed` at `program.ts:1401`** — not a diagnostic, a crash.
It is the only hardcoded `".ts"` in `src/` (checked: one hit, this one).

**`cli/index.js` — the `--sourceMap` post-pass.** Found by measuring, not by review: the
first vendored build of this branch compiled all 35 release artifacts and **silently failed
all 35 debug ones** (`FAILURE Source of file 'async/async-main-promise.ten' not found.`),
because `getSource` looks a file up by its internal path and the post-pass still stripped
`.ts` alone. That is why the chain first appeared to have "moved 1 of 35" — an artefact of
a broken compiler, not a finding. `stripEntryExtension` is the same helper the resolver
uses, and `extension_re` had exactly one remaining reader, so it is gone.

**Three controls, measured:**

| control | result |
|---|---|
| `import "./b"`, `b.ten` present, no `b.ts` | COMPILED, 97 bytes |
| `import "./c"`, only `c.ts` | COMPILED, 97 bytes — unchanged |
| `import "./missing"`, nothing there | `ERROR TS6054: File 'missing.ts' not found.` — **the same text as before** |
| ambiguity: both `b.ten` and `b.ts` | **`.ten` wins**, because it is `ENTRY_EXTENSIONS[0]` — one definition shared with the entry search; proven both ways round (a broken `.ten` produces its error, a broken `.ts` does not) and deterministic over three builds |

---

## 3. Phase B — the rename, and the bytes

**174 `git mv`s** in one commit, because imports cross every group boundary: renaming
`tension-framework/assembly/io.ten` without its importers in `examples/` in the same commit
would leave a tree that does not build at any intermediate point.

**What else had to move, each found by a failure rather than by reading:**

- `tension-framework/package.json` — `ascMain`, the `build` entry, `files`, `assets:fonts`.
  Left as `.ts`, the package's own build compiles a file that no longer exists.
- **Six generators**, not the brief's two: `tools/codegen/generate.mjs` (ogre),
  `tension-framework/tools/font/bake-ttf.mjs` (fonts), `scripts/gen-session.mjs` (layout),
  `scripts/build-2d-guest.mjs` (graph), `examples/2d/isometric/build.mjs` +
  `examples/2d/synthetic/emit.mjs` (scene), and `packages/cli/src/*.js` (the `tension` 2d
  CLI writes `graph.generated`). Each was re-run and its output verified `.ten`.
- **Seven `.gitignore`s** naming `*.generated.ts`, and `packages/cli`'s `DEFAULTS.entry` —
  a project scaffolded by the CLI would otherwise be born with the spelling this round
  exists to remove.
- `examples/res/package.json`'s `assembly/index.ts`, which no `ascMain` sweep would catch.

**One mistake of mine, and its correction.** Renaming the pattern inside `.gitignore`
stopped those rules matching, so `git add -A` committed four generated `.ts` build products
(`examples/2d/*/src/graph.generated.ts`). They are removed from the index and from disk,
and the ignore rules now name `.ten`.

**One ambiguity, resolved by hand.** `rt.ts` also exists as *compiler* std
(`TensionScript/std/assembly/rt.ts`), so a basename sweep turned a reference to the
compiler's own file into `rt.ten` in `tension-core/src/thread.rs`. Reverted to name the
std's `rt.ts` explicitly. `async.ts` collides the same way; both were checked line by line
and every other hit names a Tension file.

### Artifacts, per profile

**Phase A's own byte effect**, isolated before any rename — old compiler vs new compiler on
identical `.ten` sources:

| profile | compared | moved |
|---|---|---|
| release | 35 | **0** |
| debug | 35 | **35** |

The mechanism, proven section by section rather than asserted (`async-main-promise`, old vs
new compiler, same output name):

```
  1 type        identical (94B)      10 code     identical (18982B)
  2 import      identical (50B)      11 data       identical (3895B)
  3 func        identical (268B)     0:name           DIFFERS (18013B → 17785B)
  6 global      identical (183B)     0:.debug_info    DIFFERS (27059B → 26835B)
  7 export      identical (43B)      0:.debug_line    identical (21733B)
                                     0:.debug_ranges  identical (31022B)
total 121525 → 121073 bytes
```

`code` is **byte-identical**. The difference is the mangled identifier: `mangleInternalPath`
now drops the extension, so `$async/async-main-promise.ten/main` became
`$async/async-main-promise/main` — 5 bytes shorter, and it is written into `name` and into
DWARF's `.debug_info`. **Release artifacts carry no debug sections**, which is exactly why
they did not move, and the prediction "0 release, 35 debug" held.

**Phase B's byte effect on the framework**, where the *source* genuinely renamed. Old tree
+ new compiler reproduces the pre-rename hash exactly (`1afa738e372b4256`); new tree is
`efa8da90416a94bb`, 90,626 bytes — **+14**. Same content compiled as `index-copy.ts` and
`index-copy.ten` gives identical bytes, so the delta is not the spelling at the module
being compiled: it is **7 embedded module paths × +2 UTF-16 bytes** for `.ts` → `.ten` in
`data`, and the `__stack_pointer` global moving with it.

---

## 4. Gates

| gate | result |
|---|---|
| threads | **15 passed, 0 failed** |
| fiber | **6 passed, 0 failed** |
| fiber-executor | **7 passed, 0 failed** |
| fiber-runner | **5 passed, 0 failed** |
| async_on_main | **2 passed, 0 failed** |
| async_main_promise | **2 passed, 0 failed** |
| debugger | **5 passed, 0 failed** |
| `--bin` default | **307 passed, 0 failed** |
| `--bin` audio-only | **298 passed, 0 failed** |
| debug-conformance census | **71/82 pass, 0 skipped, 11 no-source** — unchanged |
| `tests/cli/guest-extension.js` | **5 checks** |
| `packages/cli` | **15 pass, 0 fail** |
| `--check` | **8/9** — see below |
| guests / artifacts | **35 / 70**, no new program |

**An example built and run** (`examples/solver/world`, not `async-on-main`):

```
=== TensionCore world demo: a YAML spring, integrated by rk45 ===
t  = 3.1000000000000016
y0 = 0.0008648497927193077   (analytic: 1 + cos(t) = 0.000864849726720518)
y1 = -0.04158066242590479   (analytic: -sin(t) = -0.04158066243328916)
match: |err| = 6.599878976665252e-11
--- end ---
```

**Framework build hash:** `1afa738e372b4256` → `efa8da90416a94bb`, explained above.

### `--check` 8/9 — the one row

```
compiler: src → dist/assemblyscript.js        159 inputs → 36f62922be1d     PASS
compiler: dist → installed                    035b816380d3 (tree)            PASS
compiler: std mirror                          81 files identical             PASS
runtime: src → release / debug                84 inputs → 72beb026264c      PASS ×2
fixtures: committed .wasm                     0 missing, 1 behind source     STALE
guests: tests/programs/**/*.ten               35 built after source          PASS
guests: built by the installed compiler       70 of 70 current               PASS
docs: docs/abi/*.md                           generator --check clean        PASS
```

The stale fixture is `tension-core/tests/fixtures/dwarf-guest/game.wasm`. That row compares
**git commit time** of a committed `.wasm` against its source (deliberately: mtime gives
false STALE after any rebase — the comment at `scripts/rebuild.mjs:502-509` says so). The
rename commit touched `game.ten`, so the source now post-dates the binary.

It is left stale on purpose. The fixture is a **locked historical input**: its README records
that it was built by TensionScript 0.14.0 and that its bytes stand for 0.14.1 too, and the
bytes embed `game.ts` in `name`/`.debug_info`. Rebuilding it under today's compiler would
replace a provenance record with a different artifact, and nothing needs it: `e2e_debug.rs`
passes the module through untouched and names no source file. This is the false positive the
row's own comment describes — a rename is not a rebuild. **I did not weaken the check to
make it green.**

---

## 5. What the tree contradicted in the brief

- **"the two generators"** — there are **six** (§3). The `tension` 2d CLI in `packages/cli`
  is JavaScript the rename never touches, but it *emits* a guest source.
- **"5 release artifacts embed their source path"** — measured on this corpus the answer is
  **0 release, 35 debug**, for a different reason than DL46's: the release artifacts carry
  no name or debug sections at all, so nothing in them can move.
- **Phase A was not optional and was not small.** The brief anticipated "if Phase 0 shows
  relative resolution is already extension-agnostic, skip to Phase B". It is not: three
  separate layers rejected `.ten` — resolution, `mangleInternalPath`, and the source-map
  post-pass — and the second one fails as a *crash*, not an error.
- **`.tension` in `ENTRY_EXTENSIONS`** is accepted but nothing was ever spelled that way in
  this tree (`git ls-files '*.tension'` = 0 both before and after).

## 6. What I did not verify

- **No editor was opened.** Whether a `.ten` file now renders as TensionScript in VS Code is
  **not measured** — the extension (`tension-vscode` 0.2.0, `*.ten` in its `extensions`) is
  installed on this host but I did not open a window.
- **No CI run.** The branch is pushed; no workflow was watched, so "green in CI" is unknown.
- **`--check` is 8/9, not the 9/9 declared in §3** of the brief, for the fixture reason above.
- **Windows is untouched** — `packaging`, path separators and the CRLF question belong to the
  convergence round that follows this one.
- **`tension-framework`'s published-package path** was exercised only by `npm run build`, not
  by an install of the published tarball from another project.
- **The 2d CLI's dev server** (`dev.js`) was edited for its output path but not run.
