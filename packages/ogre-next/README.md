# @yabgu_gm/tension-ogre-next

Ogre-Next, built from the pinned submodule by `npm run bootstrap`, laid
out as an npm package: `lib/`, `include/`, `Media/`.

## Why a package

The adapter (`@yabgu_gm/tension-ogre`) links these libraries and loads the Hlms
shaders out of `Media/`. Before this they lived in `third_party/ogre-next-install`
and everything found them through `LD_LIBRARY_PATH` set by a shell script — which
meant `npm start` did not work, because it is a Node process, not a shell.

## Sample assets are pruned

`Media/` ships **1.3 MB**, not the 144 MB the Ogre install contains. Removed:

    volumeTerrain  56M    materials  53M    models  19M    packs  13M    2.0  5.3M

These are Ogre's own sample content — a terrain demo, its sample meshes,
textures and material scripts. Nothing in Tension reads them: the loader hands
mesh bytes to Ogre directly and the Hlms compiles from `Media/Hlms/*`. Measured
before removing them: all 18 `--ogre-guest` cases pass and the
animated-character example runs, with the media tree reduced to `Hlms`,
`Compute`, `VCT`, `particle` and the cfgs.

Kept because they are code, not content: `Hlms/{Common,Pbs,Terra,Unlit}` (shader
templates the Hlms compiles from), `Compute/`, `VCT/`, `particle/`, and
`plugins.cfg` / `resources.cfg`.

## Built, not committed

`lib/`, `include/` and `Media/` are gitignored. `npm run build:native` at the
repository root copies them out of `third_party/ogre-next-install`, pruning the
sample content on the way. `npm run build` bootstraps that install first when it
does not exist (scripts/ensure-ogre.mjs); `npm run bootstrap` remains the
manual way to run or force that step.
