# async-on-main

`await` on main: a stackful continuation chain on **one** store, with no host,
no worker and no OS thread.

```sh
npm start      # build the guest and run it under tension-core
```

## What you are looking at

`main` awaits a three-deep chain (`outer` → `mid` → `base`), then loops three
times awaiting `mid` again. Six suspensions, all of them `main`'s own, all served
by the module's core loop — which the compiler emits into `__start` when the
guest is built with `--enable stack-switching`. There is no capability, no
session, no `rt.frame()` and no thread anywhere in the program; the only import
it carries is `tension::io`, for the transcript itself.

The transcript is the proof, line by line:

```text
main: before await outer(1) — bodies run=0        the call ran nothing
    outer: runs, x=1                              …all three bodies run here,
    mid: runs, x=1                                between the pre- and post-await
    base: runs (bodies run=3)                     lines, after main parked
    mid: after await base, b=7                    a local survived a suspension
    outer: after await mid, m=8
main: after await outer(1) — bodies run=3, a=16
main: total before the loop=16
main: loop i=0 before await
    …
main: loop i=0 total=23                           the running total crossed a park
main: loop i=1 total=40
main: loop i=2 total=67
main: done, total=67
```

Two properties are being shown, and they are the two a state machine has to work
for and a stack gets for free:

- **a call runs nothing** — `outer(1)` creates a continuation and returns, so the
  three bodies print only once `main` has parked on the await;
- **a local survives a suspension** — `a` and `total` are assigned before an
  await and read after it, and they hold what they were given.

## The other path

The same `await` in a build *without* `--enable stack-switching` is lowered as a
state machine (Promise), which parks through the host. Which mechanism is which,
and what each costs, is `docs/task-model.md` at the repository root.

## Reading the source

`game.ts` is one file, and its header says what each part is for. The host-side
assertions on the transcript are `tension-core/tests/async_on_main.rs`; that test
reads this example's own `npm run build` line rather than restating it, so the
two cannot drift.

## Debugging

`.vscode/launch.json` runs `tension-core --debug` over the guest; the interesting
breakpoint is the line after any `await`, where the locals are where the source
says they are because the frame never left.
