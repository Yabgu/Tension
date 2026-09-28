# The no-skeleton fixture volume (chunk 19, round 19e-b)

`meshes/characterMedium.mesh` is the same asset as
`../resources/meshes/characterMedium.mesh` (credited in
`../resources/CREDITS.md`), byte for byte — and the one thing this tree is
missing is deliberate: there is **no `characterMedium.skeleton` beside it**.

That is the fixture's whole point. The mesh links `characterMedium.skeleton`
in its own chunks, so it loads rigged with no sibling to resolve: it realises
with `hasSkeleton=true` and a null skeleton def, carrying blend data from its
own bone assignments. The loader used to refuse exactly this state; 19e-b
accepts it, `apply_renderables` routes it to `HlmsTensionSkinDatablock` (the
only fill that can draw it — the base's takes its skeleton branch off the
blend map and dereferences the null `SkeletonInstance`), and
`guest-skin-noskel.ts` is its acceptance test.

`../pack.sh` packs this tree into `build/fixtures-noskel.tns`; nothing else
loads from it.
