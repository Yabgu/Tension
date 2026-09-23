# walking-stickman

A rigged stickman swinging an arm, driven the way an animated character is:
the guest owns a phase, the solver integrates it, the phase becomes a bone
rotation, and the rotation reaches the renderer through the **bone table** —
one call per frame, however many bones are posed.

It is the third member of the OGRE family, and the one that shows the rig:
`hello-triangle` builds a mesh out of memory, `hello-mesh` loads one from disk,
and this one loads a mesh that *deforms*.

Two things about it are load-bearing, and neither is guessable:

- **The material must be PBS.** HlmsUnlit has no skeletal animation in its
  shaders at all, so an Unlit rig is a mesh that never moves while every bone
  transform is perfectly correct. PBS is also what a light can shade — until
  chunk 10 this example lived on the emissive-only shape (a PBS datablock with
  no light rig shows only what it emits); now it carries a real diffuse and a
  directional light, and the stickman has a lit side and a dark one.
- **Bones are named by index.** The rig belongs to the renderer, so the guest
  cannot look a bone up by name; `ARM_BONE` in `game.ts` is the index chunk
  5b's probe measured by rotating each bone in turn and watching the silhouette.

## Run it

```sh
cd examples/ogre/walking-stickman
./run.sh                          # opens a 640x480 window, and a stickman walks in it
TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only: no display needed
```

A window is the default. With no `DISPLAY` and no `WAYLAND_DISPLAY` there is
nothing to open one on, so `./run.sh` prints
`no display available; falling back to renderer=null` and runs the structural
path instead — exit 0 either way. (`tension-ogre/tests/run.sh` keeps the
opposite default: CI has no display.)

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing.

Both modes print a line every fifteen frames — a quarter of a cycle, so the
samples show the swing's whole range — and a summary at the end:

```
frame 15  phase 1.4660765716752367  swing 0.39780876
frame 30  phase 3.036872898470134  swing 0.041811384
frame 45  phase 4.60766922526503  swing -0.39780876
...
stickman took 3 steps
```

The numbers are one run's: the loop is paced by the frames that actually
elapsed, not by a fixed timestep.

## What to notice

- **The cadence is a derivative, not a clock.** `_derivative` returns `2π` per
  second and the solver integrates it, so the walk keeps step with the pictures
  whatever the machine's speed — the same contract `bouncing-ball` uses for
  gravity.
- **One call per frame, however many bones.** `BoneBatch` writes into a table
  the renderer reads from shared memory; `commit()` names the whole table once.
  Entries are *whole transforms*, so an entry that sets a rotation sets the
  position and scale with it — a bone posed at its rest place and nowhere else
  is `setRotation`'s job, and it does exactly that.
- **A batch is all-or-nothing.** An entry naming a dead renderable or a bone
  index past the end of the rig refuses the whole call and moves nothing. The
  count is the legible part: `commit()` returns how many entries were accepted,
  so `1` is success for a one-entry batch and `0` is a refusal.
- **A bone's transform is local.** Rotating the arm does not move the pelvis,
  the head or the mesh: the rig is a chain, and only the bones the guest poses
  change.
- **He is lit, and the light is placed where both sides of him can be seen.**
  One white directional light at **intensity 20**, from the camera's upper left:
  the direction in the record is the way the light *travels* — down, to the
  right of the screen and away from the camera — so the source is up, left and
  in front, and the walking figure keeps a lit side and a dark one. A light on
  the camera's own axis would light everything the viewer can see and hide the
  shading entirely (chunk 10 measured a light 54.7° off the view axis leaving
  its "dark" half at 133/255). Intensity 20 and not 1 because `intensity` is a
  **power scale**, not a normalised factor: at 1.0 a lit surface measures
  26/255 — lit, and visually black.

## Where the SDK surface is documented

`tension-framework/assembly/ogre/index.ts` — the verbs and the wrappers;
`tension-framework/assembly/ogre/bones.ts` — `BoneBatch` and the bone table's
rules; `tension-framework/assembly/ogre/wire.ts` — the records, the region
layouts, and the record readers (`isRigged`, `boneCount`); and
`tension-ogre/DESIGN.md` §5.1 — the design record behind the rig, including the
probe's per-bone sweep that chose `ARM_BONE`.
