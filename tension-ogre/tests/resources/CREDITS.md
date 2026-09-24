# Fixture asset credits

The fixtures share one resource tree, unlike the examples (which carry their
own next to the guest a reader studies). They are tests: the assets exist to be
loaded, and every fixture that loads anything mounts the same volume.

The skeletons sit **in `meshes/`, beside the meshes that link them**, not in a
`skeletons/` directory: the loader derives a rigged mesh's skeleton from the
mesh's own path (`.../meshes/Stickman.mesh` → `.../meshes/Stickman.skeleton`)
and reads it as a sibling (chunk 11). A skeleton in another directory is a
skeleton the importer never finds.

- `meshes/Barrel.mesh` — the OGRE-Next media set (`ogre-next`, `Media/models/`),
  redistributed under that set's licence.
- `meshes/cube.mesh` — the OGRE-Next media set, same terms.
- `meshes/Stickman.mesh`, `meshes/Stickman.skeleton` — the OGRE-Next media set.
  **Temporary:** this rig's licensing in the media set is uncertain; it stays
  only until the CC0 replacement (Kenney Animated Characters 3) lands — the same
  note `examples/ogre/walking-stickman/resources/CREDITS.md` carries.
- `meshes/Smiley.mesh`, `meshes/Smiley.skeleton` — the OGRE-Next media set.
  Rigged, and used by the angular fixture; the mesh and its skeleton ship as a
  pair for the same reason as Stickman's.
- `textures/ASCII.dds` — the OGRE-Next media set (`Media/materials/textures/`).
  The one texture the job and triangle fixtures load, so the texture path is
  exercised through a volume and not only through the disk that used to serve it.
