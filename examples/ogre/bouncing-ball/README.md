# bouncing-ball

A ball dropped from three metres, bouncing, and settling — with the *solver*
driving the pixels. Where `hello-triangle` shows the static scene, this one
shows the chain the OGRE capability was built for: a derivative the guest owns,
integrated by the solver, turned into a transform, and drawn through one motion
batch per frame rather than one call per body.

## Run it

```sh
cd examples/ogre/bouncing-ball
./run.sh                          # opens a 640x480 window, and a ball bounces in it
TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only: no display needed
```

A window is the default. With no `DISPLAY` and no `WAYLAND_DISPLAY` there is
nothing to open one on, so `./run.sh` prints
`no display available; falling back to renderer=null` and runs the structural
path instead — exit 0 either way, and the physics is identical, because the
solver never sees the pixels. (`tension-ogre/tests/run.sh` keeps the opposite
default: CI has no display.)

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing.

Both modes print a line every thirty frames and a summary at the end. The
numbers below are one run's: the loop is paced by the frames that actually
elapsed, so the apex heights wobble in the last digits from run to run.

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
table's rules; `tension-framework/assembly/solver.ts` — the solver's class;
`tension-framework/assembly/ogre/wire.ts` — the records, and the factories this
example builds its camera, material and renderable with.
`tension-ogre/DESIGN.md` §5.1 and `tension-solver/GUEST_ABI.md` are the design
records behind them.

## Assets

What this example loads is packed, not read from an OGRE install: `resources/`
holds the source tree (committed), `pack.sh` turns it into `build/assets.tns`
with the Zig packer, and `run.sh` hands the guest the volume's path. The guest
mounts it under `resources/` and every load path starts with that prefix — the
loader reads meshes (and skeletons) out of the volume, and a path no mount
carries fails with `-ENOENT` rather than falling back to the disk.
