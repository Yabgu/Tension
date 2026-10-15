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

- **`npm run build` exit 0 is not enough.** The `dts` step type-checks with
  stricter settings than the `src` build and can fail the whole command while
  `dist/assemblyscript.js` was written correctly. Check the per-target lines.
- **`dts` demands explicit annotations** the runtime build tolerates —
  `let outer = ...` becomes `TS7022` unless written `let outer: Element | null
  = ...`. Annotating is the fix; suppressing is not.
- **The clone is a scratch tree.** The fork's real source is
  `third_party/assemblyscript`; changes here prove feasibility and are ported,
  not pushed.
