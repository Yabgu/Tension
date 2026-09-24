# Asset credits

The files under `resources/` are this example's own copy of what it loads, so
`pack.sh` builds the volume from the repository rather than from an OGRE
install. `run.sh` packs them, the guest mounts the volume under `resources/`,
and every load path starts with that prefix.

- `models/Barrel.mesh` — the OGRE-Next media set (`ogre-next`'s `Media/models/`),
  redistributed here under that set's licence. **Temporary:** the media set's
  licensing is under review and this file moves when its successor does — the
  same decision `walking-stickman/resources/` records, pending the Kenney
  Animated Characters 3 (CC0) replacement.
