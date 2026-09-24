# Asset credits

The files under `resources/` are this example's own copy of what it loads, so
`pack.sh` builds the volume from the repository rather than from an OGRE
install. `run.sh` packs them, the guest mounts the volume under `resources/`,
and every load path starts with that prefix.

- `models/Stickman.mesh`, `models/Stickman.skeleton` — the OGRE-Next media set
  (`ogre-next`'s `Media/models/`). **Temporary:** this rig's licensing in the
  media set is uncertain, so it is redistributed here only until its CC0
  replacement (Kenney Animated Characters 3, already fetched as
  `examples/kenney_animated-characters-3.zip`) takes its place — a separate
  round. The mesh and its skeleton ship as a pair: the mesh's own bytes name
  the skeleton, and the loader resolves that name out of the same volume.
