# @yabgu_gm/tension-ogre

The OGRE capability adapter, `lib/libtension_ogre.so`. `tension-core` dlopens it
for `--capability`.

## Why a package

The adapter is the thing that was failing to load. It lived at
`tension-ogre/build/libtension_ogre.so` with no `RPATH`, so it only resolved if
the caller had `LD_LIBRARY_PATH` set — which the shell runners did and
`npm start` (a Node process) did not.

## How it finds its libraries

The link sets `DT_RPATH` (not `DT_RUNPATH`, via `--disable-new-dtags`) to:

    $ORIGIN
    $ORIGIN/../../tension-ogre-next/lib
    $ORIGIN/../../tension-freeimage/lib

The second and third are npm's flat layout: with `file:` dependencies, the
packages land as siblings under `node_modules/@yabgu_gm/`, so
`tension-ogre/lib` → `../../tension-ogre-next/lib` resolves. `$ORIGIN` alone
covers the self-contained case, where the libraries are copied in beside it.

`DT_RPATH` rather than `DT_RUNPATH` is deliberate: RPATH is searched *before*
`LD_LIBRARY_PATH`, RUNPATH after. The sonames (`libOgreNextMain.so.4.0`) are
identical to a distro package's, so search order decides which one a process
gets — `third_party/README.md` requires the in-tree build to win.

## Runtime directories

The adapter also needs to know where the render-system plugins and the Hlms
media are. `build.sh` bakes an absolute path, which is wrong for a relocated
package, so both have environment overrides that a launcher sets instead:

    TENSION_OGRE_PLUGIN_DIR   <this prefix>/lib/OGRE-Next
    TENSION_OGRE_MEDIA_DIR    <tension-ogre-next>/Media

`scripts/run-example.mjs` computes both from the resolved packages, so
`npm start` needs no environment set by hand.

## Built, not committed

`lib/` is gitignored; `npm run build:native` builds the adapter against
`@yabgu_gm/tension-ogre-next` and copies it here.
