# bouncing-bodies

Sixty-four spheres dropped into a box, colliding with each other and with the
walls. This is the one that shows **physics**: not a body following an equation
it was given, but a pile of bodies whose motion comes out of contacts — a solver
advancing the state, a contact pass between sub-steps, and impulses carrying
momentum from one body to the next.

It is the fifth member of the OGRE family, and the one where the *simulation* is
the subject: `hello-triangle` builds a mesh, `hello-mesh` loads one,
`bouncing-ball` drops one, `animated-character` poses a rig, and this one drops
sixty-four that hit each other.

What the physics honestly is:

- **spheres and axis-aligned planes.** Every body is a sphere; the box is a
  floor and four walls. No other collider pair, and no rotation in the narrow
  phase.
- **one impulse pass per contact.** No iteration and no stacking solver, so a
  tall pile would sink and jitter — which is why this is a box of bodies and not
  a pyramid. What keeps the pile still is **sleeping**: a body that has stopped
  moving is deactivated, and the pile ends at zero rather than creeping.
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

Both modes print a status line every sixty frames, and a summary at the end.
The run ends when the last body sleeps — or at the frame cap, if it never does:

```
frame 60   bodies 64  asleep 16/64  max|v| 2.34  contacts 62
frame 180  bodies 64  asleep 58/64  max|v| 1.09  contacts 54
frame 240  bodies 64  asleep 59/64  max|v| 0.02  contacts 49
simulated 64 bodies for 287 frames, 44.9 contacts/frame, K=4 sub-steps
asleep 64/64, max|v| 0.0, kinetic energy 0.0
rendered 291 frames, 223096 non-background pixels
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
- **Sleeping is per body, and its threshold is a trade.** A body sleeps after
  thirty frames whose average speed is below 0.1 m/s. The number is grounded: the
  pile's creep measured 0.057 m/s, so a threshold at 0.05 would sleep nothing —
  and 0.1 means a body genuinely travelling at 0.09 m/s sleeps too, which is the
  trade. The signal is displacement per frame rather than velocity, because a
  resting body's *velocity* carries the positional bias it was last pushed out
  by (~0.14 m/s at a 4 mm penetration) while its position does not move at all.
- **The state's layout is not interleaved.** It is Verlet's `[q, v]`: every
  body's position, then every body's velocity. The layer's accessors are the only
  place that is written down, and a guest that reads the raw vector has to know
  it.
- **Writing the state back between steps is free.** A body thrown upward reaches
  the same apex with a `state` + `set_state` every step as without one — the
  measurement the impulse channel rests on, and the reason contacts can live
  between steps instead of inside the derivative.

## `--angular`: the bodies tumble

```
./run.sh --angular              # opens a window
TENSION_OGRE_HEADLESS=1 ./run.sh --angular
```

With the flag the world runs the **angular model** (chunk 8): orientation is part
of the state (a unit quaternion, with its derivative `q' = ½ω⊗q` beside the
linear velocity), each body carries a diagonal inertia, and the contact impulse
gains a torque `I⁻¹(r × j n)` — friction at the ground contact is what rolls a
body, and it is the half a linear model cannot have.

What to notice: the bodies are drawn from a **six-colour palette cycled by body
index**, so the pile reads as distinct bodies rather than one mass — and the
floor has its own dark neutral, so the ground reads as ground. (One material per
colour, chosen when each renderable is submitted; the motion table poses bodies
and never touches their material.) **The bodies are lit** — one white
directional light at intensity 20 from above and in front — so every cube shows
a lit face and a dark one, and a tumbling body's faces change shade as it turns.
The **floor stays emissive** on purpose: it is scenery, and an unlit-hemisphere
floor would go black the moment a light exists. Intensity 20 rather than 1
because `intensity` is a power scale: at 1.0 a lit surface measures 26/255,
which is a surface that is lit and looks black. The cubes arrive, jostle, and
**turn** — then come to rest. The
summary line reports the census: 64 of 64 bodies exceed 0.1 rad/s at some point,
59 of 64 turn more than 30° over the run, and the pile reaches `asleep 64/64,
kinetic energy 0.0` by frame 136, at which point the picture stops. Their
orientations are simulated, not painted on: the adapter receives the quaternion
in the motion record and calls `setOrientation` with it.

**The honest bit:** the collider is a sphere and the mesh is a cube. The physics
simulates spheres and planes only, so a cube's corner can pass a little way into
what it hits (by up to its circumradius, ~0.17 units for a 0.2-unit body). The
tumbling is real; the collision shape is not a box yet — that and a wheel or
capsule collider are on the future-work list.

**And the pile comes to rest, which it could not do before chunk 9a.** A sphere
that reaches rolling has no slip left for friction to act on, so without a
resistance term it rolls forever (chunk 8c2 measured 0.128 m/s held for a hundred
frames). Chunk 9a adds a contact-only, pure-angular spin decay, and the effect on
this demo is the difference between a pile that never stops and one that reaches
`asleep 64/64, kinetic energy 0.0` at frame 136: the run now ends on the
`asleepCount() == bodies` condition rather than at the frame cap, and the picture
freezes with every body at the orientation it stopped in. The coefficient is 13
(1/s) — grounded in the acid test's own clauses, not tuned here (DESIGN.md §5.1,
§12).

## Where the SDK surface is documented

`tension-framework/assembly/physics.ts` — `World`, `Body`, `Contacts`, `resolve`
and what is deliberately not in them; `tension-framework/assembly/solver.ts` —
the integrator the layer drives; `tension-framework/assembly/ogre/motion.ts` —
the table the poses travel in; and `tension-ogre/DESIGN.md` §5.1 (the state model
and the measured cost) and §14 (the acid test this example's sibling fixture
runs).

## Assets

What this example loads is packed, not read from an OGRE install: `resources/`
holds the source tree (committed), `pack.sh` turns it into `build/assets.tns`
with the Zig packer, and `run.sh` hands the guest the volume's path. The guest
mounts it under `resources/` and every load path starts with that prefix — the
loader reads meshes (and skeletons) out of the volume, and a path no mount
carries fails with `-ENOENT` rather than falling back to the disk.
