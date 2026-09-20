# bouncing-bodies

Sixty-four spheres dropped into a box, colliding with each other and with the
walls. This is the one that shows **physics**: not a body following an equation
it was given, but a pile of bodies whose motion comes out of contacts — a solver
advancing the state, a contact pass between sub-steps, and impulses carrying
momentum from one body to the next.

It is the fifth member of the OGRE family, and the one where the *simulation* is
the subject: `hello-triangle` builds a mesh, `hello-mesh` loads one,
`bouncing-ball` drops one, `walking-stickman` poses a rig, and this one drops
sixty-four that hit each other.

What the physics honestly is:

- **spheres and axis-aligned planes.** Every body is a sphere; the box is a
  floor and four walls. No other collider pair, and no rotation in the narrow
  phase.
- **one impulse pass per contact.** No iteration and no stacking solver, so a
  tall pile would sink and jitter — which is why this is a box of bodies and not
  a pyramid, and why sleeping is on the design's future-work list.
- **a positional bias, not projection.** Penetration is corrected by a velocity
  term, which leaves a few millimetres of overlap at rest — measured, not
  assumed.
- **no angular dynamics.** The bodies translate and do not turn. A rolling
  orientation would be a kinematic face on a linear model: pleasant, and not
  what the simulation computed.

## Run it

```sh
cd examples/ogre/bouncing-bodies
./run.sh                          # opens a 640x480 window, and the box fills it
TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only: no display needed
./run.sh --bodies=256             # a bigger box (the cap is 1365)
```

A window is the default. With no `DISPLAY` and no `WAYLAND_DISPLAY` there is
nothing to open one on, so `./run.sh` prints
`no display available; falling back to renderer=null` and runs the structural
path instead — exit 0 either way. (`tension-ogre/tests/run.sh` keeps the
opposite default: CI has no display.)

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing.

Both modes print a status line every sixty frames, and a summary at the end:

```
frame 60   bodies 64  rest-count 28  max|v| 3.68  contacts 29
frame 120  bodies 64  rest-count 42  max|v| 3.35  contacts 56
...
simulated 64 bodies, 54.5 contacts/frame, K=4 sub-steps
max|v| 0.27, kinetic energy 0.068
rendered 304 frames, 223192 non-background pixels
```

The numbers are one run's: the loop is paced by the frames that actually
elapsed, so a slower machine simulates the same 60 frames with different
sub-step timing.

## What to notice

- **The cadence is the design.** Four sub-steps per nominal frame, each one
  advance → read → detect → resolve → write. The sub-step *size* is fixed
  (1/240 s) rather than the sub-step *count* per call: with a fixed count, a
  frame that advanced by two rendered frames halved the resolution and the same
  pile settled to 0.16 m/s windowed against 0.027 m/s headless. Physics must not
  depend on the renderer's pacing, and the fix is in the layer, not the example.
- **One call per frame, however many bodies.** `MotionBatch` writes the table
  and `commit()` names it once; the bodies' poses travel through shared memory,
  not through a verb each.
- **The state's layout is not interleaved.** It is Verlet's `[q, v]`: every
  body's position, then every body's velocity. The layer's accessors are the only
  place that is written down, and a guest that reads the raw vector has to know
  it.
- **Writing the state back between steps is free.** A body thrown upward reaches
  the same apex with a `state` + `set_state` every step as without one — the
  measurement the impulse channel rests on, and the reason contacts can live
  between steps instead of inside the derivative.

## Where the SDK surface is documented

`tension-framework/assembly/physics.ts` — `World`, `Body`, `Contacts`, `resolve`
and what is deliberately not in them; `tension-framework/assembly/solver.ts` —
the integrator the layer drives; `tension-framework/assembly/ogre/motion.ts` —
the table the poses travel in; and `tension-ogre/DESIGN.md` §5.1 (the state model
and the measured cost) and §14 (the acid test this example's sibling fixture
runs).
