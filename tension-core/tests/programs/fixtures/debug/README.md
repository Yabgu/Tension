# `fixtures/debug` — the debug guest the breakpoint tests bind in

`rt-guards.wasm` (and the source map the compiler wrote beside it) is a
**`--debug --sourceMap` build of `../../async/rt-guards.ts`**, committed as
bytes. `tension-core/tests/debugger.rs` sets a source breakpoint at
`rt-guards.ts:96` in it and asserts that the process stops there.

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

The vendored pin, proven by the one line the repo's compiler entry point prints
on every build:

```
tensionscript: 0.14.1 from /home/acakar/work/Tension/node_modules/@yabgu_gm/tensionscript/bin/tensionscript.js (vendored yabgu_gm-tensionscript-0.14.1-g9697d1361c3f.tar)
```

i.e. `third_party/TensionScript` at **`03e0507b`** (`v0.14.0-9-g03e0507b`),
packed as `yabgu_gm-tensionscript-0.14.1-g9697d1361c3f.tar` — the spec the root
`package.json` devDependency names.

## Regenerating it

From the repository root, with the pin installed (`npm install`):

```sh
node scripts/tensionscript.mjs tension-core/tests/programs/async/rt-guards.ts \
  --outFile tension-core/tests/programs/fixtures/debug/rt-guards.wasm \
  --sourceMap --runtime incremental --target release --optimizeLevel 0 --debug

# the stack-switching guest (its flags are `build-test-programs.mjs`'s
# ASYNC_ON_MAIN_FLAGS plus --debug --sourceMap)
node scripts/tensionscript.mjs tension-core/tests/programs/async/main-policy.ts \
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

- `rt-guards.wasm`: 138,968 bytes,
  SHA-256 `b360ea1a21062b81051ba777e0aa6b658dbfbd8363ef678a5aef10bbe179d4f3`
- `rt-guards.wasm.map`: 502,936 bytes,
  SHA-256 `8138a368f84b6c90d566197ead4da3cae4f64dbb4e01d828b5d2777597f48382`
- `main-policy.wasm`: 311,696 bytes,
  SHA-256 `fd9ec2d90d7329652efc5b11dea3ba680f22523c31b965f2a345edfcfa0bc7c8` (no map: the async breakpoint test asserts a stop, not the
  startup report's map line, and the map is 1.2 MB)

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
`-f rt-guards.ts -l 96` against the line table's file names, measured here by
rebuilding the same source with `--compDir /nonexistent/runner/work/Tension` and
binding the breakpoint anyway.

The *function* name in a stop carries the module path, so it reads
`tension-core/tests/programs/async/rt-guards/_start_game` for this fixture
(the path relative to the repository root, which is where the command above
runs) rather than the `async/rt-guards/_start_game` a `build/debug/` artifact
gets. The assertion is on `rt-guards/_start_game`, which both satisfy.
