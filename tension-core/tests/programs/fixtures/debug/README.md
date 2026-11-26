# `fixtures/debug` — the debug guest the breakpoint tests bind in

`rt-guards.wasm` (and the source map the compiler wrote beside it) is a
**`--debug --sourceMap` build of `../../async/rt-guards.ten`**, committed as
bytes. `tension-core/tests/debugger.rs` sets a source breakpoint at
`rt-guards.ten:96` in it and asserts that the process stops there.

## Why it is committed

Because the job that runs those assertions has **no compiler**. It used to
vendor one, and it failed on a fresh runner before a single test ran:

```
npm error path /home/runner/work/Tension/Tension/.packs/yabgu_gm-tensionscript-0.14.1-g9697d1361c3f.tar
npm error enoent ENOENT: no such file or directory
```

`.packs/` holds the canonicalised compiler tarball, is gitignored, and is
rebuilt per machine from the `third_party/TensionScript` gitlink — so a runner
that has not built it cannot install it. Committing the *artifact* instead of
the *compiler* is the same trade the two committed example guests under
`tests/fixtures/` make (`dwarf-guest`, `legacy-guest`), and the same one
`examples/*/build/*.wasm` make: bytes that a test is about travel with the test,
and the recipe that produced them travels beside it.

This is not a substitute for building. `tests/support/programs.rs` resolves a
debug guest in three steps — **this fixture**, then
`scripts/build-test-programs.mjs --debug` if
`node_modules/@yabgu_gm/tensionscript` exists, then one printed line naming what
is missing and what to run. A developer's checkout can regenerate and inspect;
CI reads these bytes and nothing else.

## Which compiler built it

**The pin at DL49** (this changed twice since the fixtures were first committed, and
each time the bytes below moved with it):

```
.yabgu_gm-tensionscript-0.14.1-g184b5d6fda16.tar
installed bundle identity 035b816380d3
```

i.e. `third_party/TensionScript` at **`184b5d6f`**, packed as
`yabgu_gm-tensionscript-0.14.1-g184b5d6fda16.tar` — the spec the root
`package.json` devDependency names, and the one `node_modules/.bin/tensionscript`
runs. The compiler's own `dist/assembly.js.build.json` is the authority for the
identity; a fixture's `.build.json` beside it records the same value.

**Why these two fixtures are re-pinned at DL49** (DL48 found them behind). DL47
taught `mangleInternalPath` to strip `.ten`/`.tension` as well as `.ts`, which
shortens every mangled identifier and every DWARF path, so *all* debug artifacts
move. The build record could not see it — it stated the entry source, the compiler
and the flags, and a rename of a **dependency** is none of those three — so the
chain skipped these two along with the other 33 and left them built by
`f97c0f03b334`. DL49 added a read-set digest to the record, rebuilt everything, and
re-pinned these bytes from the rebuild.

## Regenerating it

From the repository root, with the pin installed (`npm install`):

```sh
node scripts/tensionscript.mjs tension-core/tests/programs/async/rt-guards.ten \
  --outFile tension-core/tests/programs/fixtures/debug/rt-guards.wasm \
  --sourceMap --runtime incremental --target release --optimizeLevel 0 --debug

# the stack-switching guest (its flags are `build-test-programs.mjs`'s
# ASYNC_ON_MAIN_FLAGS plus --debug --sourceMap)
node scripts/tensionscript.mjs tension-core/tests/programs/async/main-policy.ten \
  --outFile tension-core/tests/programs/fixtures/debug/main-policy.wasm \
  --sourceMap --runtime incremental --target release --optimizeLevel 0 --debug \
  --enable threads --enable stack-switching
```

Those are the flags `scripts/build-test-programs.mjs --debug` appends for
`rt-guards` (its `PLAIN_FLAGS` plus `--debug --sourceMap`), with `--outFile`
pointing here instead of `build/debug/`. `--optimizeLevel 0` is what keeps the
line table answering the source it came from; higher levels do compile with
DWARF now (the pin compiles `schedule-order` at `-O2` with all four `.debug_*`
sections), so this is a choice about breakpoints, not a limit.
`--sourceMap` is not cosmetic either: 0.14.x emits the `.debug_*` sections only
when `--debug` **and** `--sourceMap` are both set, and the `--debug` startup
report asserts the map resolves beside the artifact.

## Bytes

Re-pinned by DL49 (`035b816380d3`), each copied from the matching
`build/debug/` artifact of the same chain run:

- `rt-guards.wasm`: 140,113 bytes,
  SHA-256 `33c018e8ad6ffec224a9d9516eb5cc3c00b26f878b935bad537ae4d090c3f6e1`
  (was 138,968 bytes / `b360ea1a2106…` under `f97c0f03b334`)
- `rt-guards.wasm.map`: 512,984 bytes,
  SHA-256 `6108ef240e8581d3cfa241c90eb7260305d21943a230941e44dfa50b51c520b6`
  (was 502,936 bytes / `8138a368f84b…`)
- `main-policy.wasm`: 314,978 bytes,
  SHA-256 `6d105e14ef837dc90c3182647b679055bc7fed6f0cef5901636a5c12873401aa`
  (was 311,696 bytes / `fd9ec2d90d73…`; no map committed — the async breakpoint
  test asserts a stop, not the startup report's map line, and the map is 1.3 MB)

These are the bytes `node scripts/build-test-programs.mjs --debug` produces, which
is the point: `tension-core/tests/support/programs.rs` prefers a **built** artifact
when the checkout has a compiler, so a fixture left behind a compiler change is a
fixture nothing checks.

`rt-guards.wasm` is the **Promise** guest (built without stack switching);
`main-policy.wasm` is the **stack-switching** guest. Both carry
`name`, `sourceMappingURL`, `.debug_abbrev`, `.debug_info`, `.debug_line` and
`.debug_ranges` — `.debug_info` + `.debug_line` together are what makes the host
pass the guest through (`tension-core/src/dwarf/mod.rs`,
`has_debug_sections`) and what makes a line-table breakpoint possible at all.

`main-policy.wasm` exists because of a compiler fix: 0.14.1 as built from
`03e0507b` threw `type form is not a function type` on any continuation type and
shipped **no** `.debug_*` sections for a stack-switching guest. The pin now
carries that fix, and this fixture is the proof the async breakpoint test needs.

## One non-portable detail

`DW_AT_comp_dir` records the compiler's working directory at build time
(`/home/acakar/work/Tension` above), as it does for `dwarf-guest`. The bytes are
therefore reproducible on the machine that ran the command and not
byte-identical to a rebuild elsewhere — nothing here asserts a hash, and the
breakpoint does not depend on the recorded directory existing: lldb matches
`-f rt-guards.ten -l 96` against the line table's file names, measured here by
rebuilding the same source with `--compDir /nonexistent/runner/work/Tension` and
binding the breakpoint anyway.

The *function* name in a stop carries the module's **internal path**, which is the
entry path with its extension stripped (`mangleInternalPath`, since DL47) — so a
stop reads `…/async/rt-guards/_start_game`, with no `.ten` anywhere in it. The
assertion in `debugger.rs` is on `async/rt-guards/_start_game`, and it read
`rt-guards.ten/_start_game` until DL49: that older spelling was what
`f97c0f03b334` emitted, and it stayed green only because this suite was running
against an artifact built by that compiler rather than the installed one.
