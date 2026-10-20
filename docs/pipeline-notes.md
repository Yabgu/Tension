# Running the fork's compiler so the rebuild is live

Notes for anyone changing the AssemblyScript fork at
`third_party/assemblyscript`. Written after a prior attempt wasted a cycle
testing stale code.

## The trap

`bin/asc.js` respawns itself, then loads `../dist/asc.js`, which imports the
**bare specifier** `"assemblyscript"`. That resolves through the package's own
`exports` map by ESM self-reference:

```
"name": "assemblyscript",
"exports": { ".": ..., "./asc": ..., "./transform": ..., "./binaryen": ... }
```

ESM self-reference works, so the pipeline **is** live — but two things mislead:

- `require.resolve('assemblyscript')` **fails**, because the package is
  `"type": "module"` and the CJS resolver does not apply the `exports` map. That
  failure is a red herring; do not conclude the pipeline is broken from it.
- `node_modules/assemblyscript` does not exist, so `ls node_modules | grep
  assembly` finds nothing. Also a red herring: self-reference needs no install.

## The reliable invocation

Drive the API directly. No respawn, no ambiguity about which module loaded:

```js
// drive.mjs — run a file through the rebuilt compiler
import asc from "/tmp/as-inspect/assemblyscript/dist/asc.js";
let err = "";
const { error } = await asc.main(process.argv.slice(2), {
  stdout: { write: () => {} },
  stderr: { write: (c) => { err += c; } },
});
process.stdout.write(err + (error ? "FAILURE\n" : "ok\n"));
```

```sh
node drive.mjs path/to/file.ts --noEmit --noColors
```

## Proving the build is live — do this before trusting any test result

A diagnostic probe works, but the cheapest decisive check is to read your own
change out of the built bundle:

```sh
grep -o "arrowKind[^;,)]\{0,30\}" dist/assemblyscript.js | head
```

The library is **minified onto one line**, so `grep -c` counts 1 for everything
and tells you nothing. Use `grep -o | wc -l`, or extract the function body:

```sh
python3 -c "
import re,sys
s=open('dist/assemblyscript.js').read()
for m in re.finditer('resolveThisExpression', s):
    print(repr(s[m.start():m.start()+430]))
"
```

If your change is visible there, the build is live and any test result is real.
If it is not, the build did not pick up your edit — check that the `src` target
reported SUCCESS, not just that `npm run build` exited 0 (`dts` failures are
unrelated to `src`/`cli` but still fail the command).

## Gotchas

- **`file:` dependencies cache by version.** Repacking a tarball into the same
  `acakar-tensionscript-<version>.tgz` name and reinstalling does **not** pick
  up the new contents: npm serves the previously installed package from its
  cache for that version, so every consumer keeps the old `~lib/task-rt` and a
  freshly added export fails at typecheck (`TS2305: no exported member`). A
  tarball refresh after a source change requires a **version bump** in the
  fork's `package.json` before `npm pack`. Measured twice in 4e: the 0.3.2
  repack installed stale contents, and bumping to 0.3.3 fixed it.
- **The `~env` global is dead-code-eliminated in release output when no arrow
  in the module captures `this`.** That is the expected shape, not a missing
  feature: the global is only ever *read* by a capturing arrow's prologue, so
  with no such arrow every store to it is dead, and Binaryen removes the stores
  and the declaration. A load cannot be removed safely, so the callee's `_env`
  read survives as a `drop` — a few frames in the release output of such a
  module carry a dead `i32.load offset=4` from it.
  The consequence for fixtures is that **adding one capturing arrow changes the
  release output shape of the whole module**: the global reappears, and frame
  sizes and offsets shift back to the sizes the mechanism needs. So when a test
  starts capturing `this`, expect its *release* fixture to change in places that
  have nothing to do with the arrow itself, and re-read the diff before
  assuming a regression.
- **Use `local.tee`, never `local.set` + a double read, when emitting a value
  that has to be read twice.** The `~env` delivery needs the callee value for
  both its `_env` and its `_index`, and binding it with a separate `local.set`
  statement and then reading the local twice trips an assertion in Binaryen's
  stack IR optimizer (`local2Stack` in
  `wasm-stack-opts.cpp`: `assert(values.size() > 0)`). That is not a warning: it
  **aborts the compiler in every release build** (`optimizeLevel >= 2` turns
  stack IR on, and the release test run uses `-O`) for several ordinary call
  shapes — a module-level function value called once is enough to reproduce it.
  The `local.tee` shape (`module.local_tee(index, functionArg, true)` as the
  base of the `_env` load, then `local.get` for the index) compiles and is what
  `makeCallIndirect` emits. Treat this as the rule for any future call-site
  emission too, not just this one.
- **`npm run build` exit 0 is not enough.** The `dts` step type-checks with
  stricter settings than the `src` build and can fail the whole command while
  `dist/assemblyscript.js` was written correctly. Check the per-target lines.
- **`dts` demands explicit annotations** the runtime build tolerates —
  `let outer = ...` becomes `TS7022` unless written `let outer: Element | null
  = ...`. Annotating is the fix; suppressing is not.
- **The clone is a scratch tree.** The fork's real source is
  `third_party/assemblyscript`; changes here prove feasibility and are ported,
  not pushed.

## The no-poll rule (scheduler contract)

`docs/scheduler-contract.md` in TensionScript is the language-level scheduler
contract (§4.4 and §8 are the rule). New code introduces **no wait site
without naming what it blocks on** — a condition variable, channel, epoll,
vsync, timer, or stdin. Guest source has zero `while` around a wait (no state
polling); host source has no `try_recv` + sleep and no spin.

The measured audit of every host and guest wait site, and the greps that must
stay at zero, are in `docs/scheduler-implementation-plan.md` §9. A wait site
added without a named primitive is a review failure, not a style nit.

## Adding a completion class: the layout arithmetic

`SessionInfo` sits at `0x100` in the first header page and ends at
`SESSION_INFO_OFFSET + SESSION_INFO_SIZE`. Two alignment rules decide where the
open nonce and the record's size land, and both are enforced in code — a class
addition must satisfy them, not round to a number that looks tidy.

1. **The nonce is a `u64` and `put_u64` refuses a non-8-aligned offset**
   (`arena.rs:511-521`, `LayoutError::Misaligned`). The class-capacity array
   starts at 48 and covers `CLASS_COUNT * 4` bytes, so the nonce's offset
   rounds **up to the next multiple of 8**.
2. **`SESSION_INFO_SIZE` pads to 16**, like every region
   (`every_region_is_aligned_and_in_order` asserts `size % 16 == 0`).

For 13 classes: `48 + 13*4 = 100` → the nonce rounds to **104**;
`104 + 8 (nonce) + 32 (eight reserved words) = 144`, already 16-aligned. The
record ends at `0x100 + 0x90 = 0x190 < 0x200`, so no region moves.

The measured cost of ignoring rule 1: with the nonce at 100 and the size at 140,
`256 + 100 = 356` is not 8-aligned, so **every** `session_open` fails with
`Layout(Misaligned { offset: 356, align: 8 })` — 71 tests, all from one number.
140 fails rule 2 independently (`140 % 16 = 12`).

`104`/`144` are the working set for **thirteen** classes. The next addition
re-derives: `48 + n*4` rounded up to 8 for the nonce, then `+ 8 + 32` rounded up
to 16 for the size — and check `0x100 + size <= 0x200` before assuming no
region moves.

Both rules are now asserts in `session_info_field_offsets_match_the_design_note`,
so the arithmetic fails loudly at the constant rather than at the first open.

## The io gate for bump batches

`assembly/index.ts` does `export * from "./runtime"`, so **every** consumer of
`tension-framework` — including `examples/io`, which only calls `print`,
`readLine`, `argCount` and `arg` — compiles the runtime's layout constants and
geometry code into its wasm. A layout bump therefore changes the code of
programs that never open a session or touch the bumped feature.

Measured for 0.6.0a (`c3178b4b` → `a674dadc`): +3 code bytes, +16 data, +4
globals. Every byte is attributable — the three `__taskBindFamily` calls in
`rt.start()`, the 13-entry capacities array (3 × u32 padded to 16), and the
three class ids plus `FAMILY_AI`. Header/table/memory/export sizes are
unchanged; `type`, `import`, `function`, `table`, `memory`, `export`, `start`,
`element` and `datacount` are byte-identical. Even a build with **only**
`layout.ts` bumped moves 13 function bodies (constant baking plus the shifted
data address), so no split of the bump restores byte-identity.

**The gate for bump batches** is therefore:

- code / data / global movement must be attributed to the bump's own additions,
  in the commit message, at the level of "+3 bytes, the three
  `__taskBindFamily` calls in `rt.start()`";
- **behavior** must be byte-identical at the output level (transcript, exit
  code, render statistics);
- a program that does not carry the runtime (if one exists) keeps the stronger
  wasm-hash check.

The architectural fix is narrowing the barrel (`export *` → explicit exports) so
a guest that imports `print` does not carry the arena's constants. That is a
real SDK API change with its own compatibility question and is **filed as its
own phase** — not a thing to slip into a layout bump.

## `npm run build` does not run `build.sh`

`tension-framework`'s `npm run build` compiles the AssemblyScript against the
**already generated** `assembly/runtime/layout.ts`. It does not invoke
`build.sh`, which is what reads `session.json` and rewrites `layout.ts` and
`build/session.asconfig.json`.

So after changing any arena constant: run
`bash tension-framework/build.sh --hash <new-layout-hash>` **first**, then
`npm run build`. Skipping it compiles the old constants into the guest, and the
symptom is a `session_open` hash mismatch at run time rather than a build error.

`npm test` does run `build.sh` (through `tests/run.sh`), so CI catches a stale
`layout.ts`; a manual `npm run build` would not. That asymmetry is exactly how a
stale guest survives a local loop. The generator is idempotent — re-running it
on an up-to-date tree rewrites `layout.ts` byte-identically — so running it
twice costs nothing and is the safe default.

## "Tests pass" is evidence for the committed tree

A refactor that moves lines can leave a file half-staged: the production change
committed, a matching field added to six `#[cfg(test)]` host literals left in
the working tree. `cargo build` does not compile test modules, so the binary
built and the local suite passed — against a tree that was not the one committed.

The rule: **after any refactor that touches more than one file, run `git status`
before trusting a test run.** An uncommitted hunk that the build does not need
is exactly the kind of thing `cargo build` will not catch and `cargo test` will,
depending on what you remembered to stage.

## An awaitable accessor returns a stamped handle, never an async wrapper

`rt.frame()` was `return frameWait();`, and `frameWait` was `async`. The chain was:

```
gameLoop  --awaits-->  frameWait's own task
frameWait --awaits-->  the (FRAME, 0) record
```

The host woke the FRAME slot, `frameWait` resumed and returned, and
`__taskCompleteResult` pushed `gameLoop` onto the **ready queue** — which only
`__taskTick` drains, and a host-owned loop never calls it. Every intermediate
signal was correct: the wake batch held the right id, the slot resumed, the task
completed. The wake simply landed one layer below the task that needed resuming,
so the symptom was a silent spin with no failing step to point at.

The rule: an accessor a guest `await`s returns a **stamped handle** — a `Task`
whose record carries `(class, key)` — the way `rt.job()` and `rt.frame()` do.
An `async` wrapper parks the *wrapper's* task, not the caller's. Inside a
guest-driven loop the extra layer costs one tick (`rt.runReady()` twice over two
iterations) and hides; under a host loop it is a hang.

The corollary: classification that needs the record is a **synchronous**
function (`rt.classify`), taking the handle after the await. It must not park.

## The header page's tail has no owner, and no check

`0x800` is not the canary gap. The arena's regions are:

| range | owner | checked by |
|---|---|---|
| `0x000..0x100` | `ArenaControl` (256 B) | magic/version on open; `CONTROL_STATE` onward is session-owned |
| `0x100..0x190` | session info (144 B) | — |
| `0x200..0x320` | region table (12 × 24 B) | `region_count` on open |
| `0x320..0x380` | manifest (12 × 8 B) | — |
| **`0x380..0x1000`** | **nobody** | **nothing** |
| `0x1000..0x5F6020` | zero band | `verify_band_is_zero`, at open |
| `0x5F6020..0x800000` | canary lattice | `verify_canary_lattice`, at open |

So `verify_band_is_zero` starts at `HEADER_PAGE_SIZE`, and the lattice covers
`[LAYOUT_FLOOR, memory_base)`. Page 0's tail is in neither, and both checks run
at session **open** — nothing re-checks the arena while the session is live.

The consequence for the wake buffer: staging ids at `0x800` was not detected and
did not trap, but it claimed memory with no owner. Any later use of that padding
would have been a silent collision in the other direction. The buffer now lives
in the control block's session-owned tail (`CONTROL_OFFSET + 184`, after
`CONTROL_SESSION_NONCE`), which is the block the session documents as its own.

## The wake buffer's home

`HOST_WAKE_SCRATCH = session::arena::CONTROL_OFFSET + 184`: `CONTROL_SESSION_NONCE`
ends at 184, `CONTROL_SIZE` is 256, so 72 bytes are free. Nine ids per call,
chunked (`HOST_WAKE_CHUNK = 9`) — a larger batch becomes several `wake` calls,
still batched from the guest's side. Do not move it back into page 0's padding;
that range is unowned (previous section).
