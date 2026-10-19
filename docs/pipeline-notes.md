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
