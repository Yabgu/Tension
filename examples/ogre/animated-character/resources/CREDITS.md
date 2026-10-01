# Asset credits

`resources/` is this example's own copy of what it loads: `pack.sh` builds the
volume from the repository, the guest mounts it under `resources/`, and every
load path starts with that prefix.

- **`models/characterMedium.mesh`** —
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
  one `.skeleton` with three `<animation>` elements). **The `.skeleton` files
  have since been removed** — both this one and the mesh's sibling (19f-d):
  the example's pose is computed by the guest from the `.ozz` archives below,
  and the loader accepts the mesh without its skeleton def (19e-b). The v1
  skeleton binaries are pipeline intermediates now, not shipped assets.

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

- **`models/characterMedium_*.ozz`** — the same character's rig and three clips
  as ozz runtime archives (skeleton v2 + animation v7): `_skeleton` (3,295 B,
  58 joints), `_idle` (5,415 B), `_run` (6,404 B), `_jump` (4,050 B). Same
  source and licence as the mesh (Kenney, CC0). Pipeline: the Kenney FBX →
  Blender 5.2.2 (one scene, the three clips retargeted onto the character
  armature, as `convert-kenney-anim.py` does) → glTF → `gltf2ozz`
  (ozz-animation at `744eb9d`; the build recipe is committed in
  `tension-framework/tests/fixtures/ozz/CREDITS.md`) →
  `tension-ogre/tests/remap-ozz.py`, which rewrites the archives into OGRE's
  bone order — 58 joints, `Hips` at 19, `LeftForeArm` at 28 — mapping by joint
  name and dropping gltf2ozz's two non-bone object nodes (`Root`,
  `characterMedium`).
