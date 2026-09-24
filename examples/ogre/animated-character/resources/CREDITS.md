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
  one `.skeleton` with three `<animation>` elements, 43,978 bytes). The example
  plays them through the animation verb — one clip per character, the fourth a
  half-cycle behind — so each clip's name and duration are load-bearing.

- **`textures/humanMaleA.png`, `humanFemaleA.png`, `zombieMaleA.png`,
  `zombieFemaleA.png`** — the pack's four skins (`Skins/`), same source and
  licence. One per character, named by that character's slot-0 material.

- **`textures/humanMaleA.dds`, `humanFemaleA.dds`, `zombieMaleA.dds`,
  `zombieFemaleA.dds`** — the same four skins in the form the renderer reads.
  This install's `Image2` codec set is DDS-only (a PNG aborts realisation with
  "Image format is unknown", measured in round 13c), so each skin is converted
  with ImageMagick — `magick humanMaleA.png humanMaleA.dds`, uncompressed
  24-bit RGB, 256×256, 262,271 bytes each — and both forms travel in the
  volume: the PNG as the source asset, the DDS as the runtime one.
