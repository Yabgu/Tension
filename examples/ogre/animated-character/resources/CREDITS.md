# Asset credits

`resources/` is this example's own copy of what it loads: `pack.sh` builds the
volume from the repository, the guest mounts it under `resources/`, and every
load path starts with that prefix.

- **`models/characterMedium.mesh`, `models/characterMedium.skeleton`** —
  Kenney, *Animated Characters 3*
  (<https://kenney.nl/assets/animated-characters-3>).
  **Licence: CC0 1.0 Universal** (public domain dedication,
  <https://creativecommons.org/publicdomain/zero/1.0/>) — use for personal,
  educational and commercial purposes, no attribution required. This file
  credits anyway: the point of CC0 here is that the pipeline that produced the
  asset can be rebuilt by anyone, and the recipe is the interesting part.

  Conversion: FBX → Blender 5.2.2 LTS (io_ogre 0.9.0) → `.mesh.xml` +
  `.skeleton.xml` → `OgreMeshTool -V 1.10` → `.mesh` + `.skeleton`. The recipe
  is committed at `tension-ogre/tests/convert-kenney.py`, so a future character
  is a re-run, not archaeology. The converted rig is 58 bones (`LeftForeArm` at
  index 28, `Hips` at 19), 3.765 units tall at scale 1, resting in an A-pose,
  facing +Z.

- **The skeleton's three animations** — `idle` (1.333 s), `run` (0.667 s),
  `jump` (0.500 s), from the pack's `Animations/{idle,run,jump}.fbx`, same
  source and licence as the character. Converted by
  `tension-ogre/tests/convert-kenney-anim.py` (all three clips in one scene →
  one `.skeleton` with three `<animation>` elements, 43,978 bytes).

- **`textures/humanMaleA.png`, `humanFemaleA.png`, `zombieMaleA.png`,
  `zombieFemaleA.png`** — the pack's four skins (`Skins/`), same source and
  licence. Each is the texture for one of the four characters the example is
  being rewritten to show.
