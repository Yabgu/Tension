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
  the OGRE-media `Stickman` in chunk 12.
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
