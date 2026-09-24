# Fixture asset credits

The fixtures share one resource tree, unlike the examples (which carry their
own next to the guest a reader studies). They are tests: the assets exist to be
loaded, and every fixture that loads anything mounts the same volume, packed by
`tests/pack.sh` from this directory.

The skeletons sit **in `meshes/`, beside the meshes that link them**, not in a
`skeletons/` directory: the loader derives a rigged mesh's skeleton from the
mesh's own path (`.../meshes/characterMedium.mesh` →
`.../meshes/characterMedium.skeleton`) and reads it as a sibling (chunk 11). A
skeleton in another directory is a skeleton the importer never finds.

- `meshes/characterMedium.mesh`, `meshes/characterMedium.skeleton` — Kenney,
  *Animated Characters 3* (<https://kenney.nl/assets/animated-characters-3>),
  **CC0 1.0 Universal** (<https://creativecommons.org/publicdomain/zero/1.0/>;
  no attribution required). Conversion: FBX → Blender 5.2.2 LTS (io_ogre
  0.9.0) → `.mesh.xml` + `.skeleton.xml` → `OgreMeshTool -V 1.10` →
  `.mesh` + `.skeleton`; the recipe is `tension-ogre/tests/convert-kenney.py`.
  The rig is 58 bones (`LeftForeArm` 28, `Hips` 19) and the shape that replaced
  the OGRE-media `Stickman` in chunk 12. The skeleton also carries the pack's
  three clips — `idle` 1.333 s, `run` 0.667 s, `jump` 0.500 s — converted by
  `tension-ogre/tests/convert-kenney-anim.py`; nothing in the fixtures plays
  them (the bone table poses the rig), they are inert data the load path
  carries.
- `textures/humanMaleA.png`, `humanFemaleA.png`, `zombieMaleA.png`,
  `zombieFemaleA.png` — the pack's four skins (`Skins/`), same source and
  licence.
- `textures/humanMaleA.dds`, `humanFemaleA.dds`, `zombieMaleA.dds`,
  `zombieFemaleA.dds` — the same four skins in the form this install's
  `Image2` reads (its codec set is DDS-only; a PNG aborts with "Image format is
  unknown", measured in 13c). Converted with ImageMagick (`magick x.png
  x.dds`), uncompressed 24-bit RGB, 256×256. The fixtures load no texture of
  the pack yet — the example is what binds them — but both trees carry the same
  assets, and the PNG stays as the source.
- `meshes/Barrel.mesh` — the OGRE-Next media set (`ogre-next`, `Media/models/`),
  redistributed under that set's licence.
- `meshes/cube.mesh` — the OGRE-Next media set, same terms.
- `meshes/Smiley.mesh`, `meshes/Smiley.skeleton` — the OGRE-Next media set.
  Still here, and still rigged, because `guest-angular` needs a **unit sphere**
  as the visual body for its sphere colliders — a humanoid is not one. It goes
  when a CC0 sphere does, not before.
- `textures/ASCII.dds` — the OGRE-Next media set (`Media/materials/textures/`).
  The one texture the job and triangle fixtures load, so the texture path is
  exercised through a volume and not only through the disk that used to serve it.
