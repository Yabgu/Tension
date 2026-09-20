# bouncing-ball

A ball dropped from three metres, bouncing, and settling — with the *solver*
driving the pixels. Where `hello-triangle` shows the static scene, this one
shows the chain the OGRE capability was built for: a derivative the guest owns,
integrated by the solver, turned into a transform, and drawn through one motion
batch per frame rather than one call per body.

## Run it

```sh
cd examples/ogre/bouncing-ball
./run.sh                              # headless: no display needed
TENSION_OGRE_WINDOW_TEST=1 ./run.sh   # GL3+: a real window, and a bouncing ball
```

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing.

Both modes print a line every thirty frames and a summary at the end:

```
frame 30  height 1.8541375  speed -4.7415
frame 60  height 1.35635  speed 3.5970000000000006
...
ball bounced 3 times, apex heights 3.0 2.0158 1.4435500000000002
```

## What to notice

- **The derivative is the guest's.** `_derivative` is `f(t, y) = [v, g]`, a pure
  function of the state — no clocks, no hidden terms. That is what makes the
  integration reproducible, and it is the whole of the physics contract
  (`tension-solver/GUEST_ABI.md`).
- **The bounce is not the solver's.** A solver integrates smooth derivatives; a
  floor is a discontinuity. It lives in game logic *between* steps: the
  velocity is reflected and scaled, and the corrected state goes back with
  `setState`, so the next step starts from the floor rather than from below it.
- **One call per frame, however many bodies.** `MotionBatch` writes into a table
  the renderer reads from shared memory; `commit()` names the whole table once.
  Entries are *whole transforms*, so a body's scale travels with its position —
  the ball is submitted at 0.02 and every entry repeats it.
- **The loop is paced by the renderer, not by the clock.** The guest reads the
  frame counter, steps the solver by the frames that actually elapsed, and so
  stays in step with the pictures whatever the machine's speed.

## Where the SDK surface is documented

`tension-framework/assembly/ogre/index.ts` — the verbs and the wrappers;
`tension-framework/assembly/ogre/motion.ts` — `MotionBatch` and the motion
table's rules; `tension-framework/assembly/solver.ts` — the solver's class.
`tension-ogre/DESIGN.md` §5.1 and `tension-solver/GUEST_ABI.md` are the design
records behind them.
