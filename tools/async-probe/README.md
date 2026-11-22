# async-probe — the four questions of round AP1, as runnable probes

This directory is evidence, not a feature. It answers four questions about what
the async backends can do on a given platform, and it changes no behaviour.

- **`run.sh`** — reproduces every measurement to stdout, building nothing inside
  the repository (artifacts land in `$AP1_OUT`, default `/tmp/ap1`).
- **`programs/shared-probe.wat`** — a hand-written shared-memory guest: two
  atomic RMWs, an executor-count check, and one spawned worker that RMWs the same
  memory. Written by hand so the question is about the *host*, not a compiler.
- **`programs/promise-main-framework.ts`** and **`programs/promise-main-io-only.ts`**
  — two `async main` programs that differ only in the import path of `print`.
  The pair isolates one `await` in imported library code as the thing that
  switches a Promise build off.
- **`transcript-linux.txt`** — the captured output of `run.sh` on Linux x86-64.
- **`AP1-REPORT.md`** — the answers, with file-and-line citations.
- **`AP1-IMPLICATIONS.md`** — what each answer makes possible and forbids.

## Building the `.ts` probes needs `$TENSIONSCRIPT`

`run.sh` sets `TENSIONSCRIPT` to the compiler installed at
`node_modules/@yabgu_gm/tensionscript` because this checkout declares a pin
tarball that is not on disk (AP1-REPORT.md §0). Do the same by hand if you build
one program:

    TENSIONSCRIPT=$PWD/node_modules/@yabgu_gm/tensionscript/bin/tensionscript.js \
      node scripts/tensionscript.mjs <probe>.ts -o /tmp/out.wasm \
      --runtime incremental --target release --exportStart __start

`promise-main-framework.ts` resolves `tension-framework` through a
`node_modules` directory above the source file; `run.sh` links the example's into
its scratch directory rather than adding files to `examples/async-on-main`.
