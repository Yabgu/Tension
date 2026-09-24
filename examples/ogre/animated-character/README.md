# animated-character

Four characters, one mesh, four skins, three clips — and the clips are OGRE's
own. The guest names a clip and a time each frame; the renderer's
`SkeletonAnimation` does the deforming. No bone is posed by hand. (The mesh is a
Kenney "characterMedium" — CC0; the example kept its name when the asset changed
in chunk 12.)

It is the third member of the OGRE family, and the one that shows a rig being
*animated*: `hello-triangle` builds a mesh out of memory, `hello-mesh` loads one
from a packed volume, and this one loads a mesh that deforms — four times over,
from **one** mesh resource, with four materials and four textures.

Two things about it are load-bearing, and neither is guessable:

- **The material must be PBS, lit, and textured through slot 0.** HlmsUnlit has
  no skeletal animation in its shaders at all, so an Unlit rig is a mesh that
  never moves while every bone transform is perfectly correct. PBS is also what
  a light can shade, and the texture needs one detail that is invisible until
  it is wrong: the texture must be created with
  `TextureFlags::AutomaticBatching`, because the Hlms samples through an array
  of 2D texture arrays and a texture without the flag is never packed into one
  — the character then draws lit and black (`tension-ogre/DESIGN.md` §5.1).
- **Clips are named, and the clock is the guest's.**
  `submitAnimation(renderableId, clipName, timeMs)` takes *absolute* time, not a
  delta: the guest computes `elapsed % duration`, and the adapter calls
  `setTime` on the named clip. The durations are hardcoded from the probe that
  converted the clips (idle 1.333 s, run 0.667 s, jump 0.500 s); a verb to ask
  for them is a `§12` item.

## Run it

```sh
cd examples/ogre/animated-character
./run.sh                          # opens a 640x480 window, four characters animated in it
TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only: no display needed
```

A window is the default. With no `DISPLAY` and no `WAYLAND_DISPLAY` there is
nothing to open one on, so `./run.sh` prints
`no display available; falling back to renderer=null` and runs the structural
path instead — exit 0 either way. (`tension-ogre/tests/run.sh` keeps the
opposite default: CI has no display.)

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing. A
windowed run is about 5 seconds of animation (300 frames at 60 Hz) plus startup.

Both modes print the clip table; the windowed run also reports what the last
frame held, and how much moved:

```
clips: idle run jump run (1.333333s, 0.666667s, 0.5s, fourth offset +0.333s)
rendered 19068.0 non-background pixels
quadrants (back-left, back-right, front-left, front-right): q0=5952.0px rgb(183.4,184.7,183.5) q1=5669.0px rgb(213.8,216.4,214.7) q2=3900.0px rgb(157.6,161.7,161.9) q3=3547.0px rgb(198.2,199.9,200.2)
motion: 6415.0 pixels changed between frame 150 and 300
animated 4 characters, 3 clips, 300 frames
done: 4 characters, one mesh, four skins, three clips
```

The numbers are one run's.

## What to notice

- **One mesh, four renderables, four materials.** The mesh resource is loaded
  once and named by all four renderables; each has its own PBS datablock, whose
  slot 0 is one of the four skin textures. The four characters stand on a 2×2
  grid (`GRID_X`/`GRID_Z` in `game.ts`) under a camera four units back.
- **The four skins are four textures — and they are DDS, not PNG.** This
  install's `Image2` codec set is DDS-only: realising a PNG texture throws
  `Image format is unknown` (measured). The pack's four skins are therefore
  converted (`magick humanMaleA.png humanMaleA.dds`, uncompressed 24-bit) and
  the volume carries both — the PNG as the source asset, the DDS as what the
  renderer reads.
- **The clip is a name and a time.** `submitAnimation(1, "idle", ms)`,
  `submitAnimation(2, "run", ms)`, `submitAnimation(3, "jump", ms)`, and the
  fourth character runs too, at `+0.333 s` — half a run cycle (0.667 s) behind
  the third, so the two runners are visibly out of phase. The guest wraps the
  time itself; the adapter never learns a duration.
- **The motion is the renderer's, not the guest's.** The example submits no
  bone transforms at all — `BoneBatch` is not called. What deforms the mesh is
  OGRE's animation system, stepped by the clip time the guest sent. The
  `motion:` line is the self-check: two frames a couple of hundred frames
  apart, compared pixel by pixel — a still camera and a clear background mean
  every changed pixel is a bone that moved. (Nothing else in the frame moves;
  the count would be 0 for a frozen rig, and the example asserts on it.)
- **The quadrants are the four skins.** The back row projects higher and the
  front row lower, so each character owns one screen quadrant; the per-quadrant
  pixel count and mean colour is the check that all four were drawn *and* that
  they are wearing different textures — four counts, four different means.
- **He is lit, and the light is placed where both sides of him can be seen.**
  One white directional light at **intensity 20**, from the camera's upper
  left. Intensity 20 and not 1 because `intensity` is a **power scale**, not a
  normalised factor: at 1.0 a lit surface measures 26/255 — lit, and visually
  black.

## Where the SDK surface is documented

`tension-framework/assembly/ogre/animation.ts` — `submitAnimation` and what the
adapter does with it; `tension-framework/assembly/ogre/index.ts` — the verbs
and the wrappers; `tension-framework/assembly/ogre/wire.ts` — the records, the
region layouts, and the record readers (`isRigged`, `boneCount`); and
`tension-ogre/DESIGN.md` §5.1 — the design record behind the renderer, the
conversion chain and the animation verb. (`bones.ts` and `BoneBatch` are still
there and still the way to pose a rig by hand — `walking-stickman`'s arm swing
used to demonstrate them; this example no longer does.)

## Assets

What this example loads is packed, not read from an OGRE install: `resources/`
holds the source tree (committed), `pack.sh` turns it into `build/assets.tns`
with the Zig packer, and `run.sh` hands the guest the volume's path. The guest
mounts it under `resources/` and every load path starts with that prefix — the
loader reads meshes (and skeletons) out of the volume, and a path no mount
carries fails with `-ENOENT` rather than falling back to the disk.

`resources/models/characterMedium.mesh` + `.skeleton` are Kenney's *Animated
Characters 3* "characterMedium" (CC0 1.0), converted by
`tension-ogre/tests/convert-kenney.py`; the skeleton also carries the pack's
**three clips** — `idle`, `run`, `jump` — baked in by
`tension-ogre/tests/convert-kenney-anim.py`; and `resources/textures/` holds the
pack's **four skins** as PNG (source) and DDS (what the renderer reads).
`resources/CREDITS.md` names the source, the licence and the chain for each.
