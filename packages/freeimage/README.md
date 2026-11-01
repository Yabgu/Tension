# @yabgu_gm/tension-freeimage

FreeImage 3.19, built by `third_party/bootstrap.sh` and laid out as `lib/` and
`include/`.

## Why a package

`libOgreNextMain.so` links FreeImage for texture decoding, and on Linux the Ogre
libraries record it as a `DT_RUNPATH` — so it resolves without help *when it is
where Ogre was built to find it*. Relocating Ogre into a package moves that
ground: the adapter now carries its own rpath listing this package's `lib/`,
which is why this exists as a separate package rather than travelling inside
`tension-ogre-next`.

Kept separate because Ogre's own `find_package(FreeImage)` treats it as a
dependency, and because a future non-Ogre consumer of FreeImage would otherwise
have to depend on all of Ogre.

## Built, not committed

`lib/` and `include/` are gitignored; `npm run build:native` copies them from
`third_party/freeimage-install`.
