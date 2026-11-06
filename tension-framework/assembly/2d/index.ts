// tension-framework/assembly/2d/index.ts — the 2D scene layer, re-exported
// from the SDK barrel.
//
// Three types, in the order a scene is built:
//
//   Tileset         pixels -> record fields (page + src rect)
//   Composite       a character -> N records sharing a sort key and group
//   IsometricWorld  tall art -> sliced records sorted by their bottom edge
//
// plus `types.ts`, which is the record layout they all write.
//
// Nothing here imports the adapter's verbs except `Tileset.bind`, which calls
// `set_texture`: a tileset already knows its pages, so making every example
// write that loop again would be the same bug in every example.

export * from "./types";
export * from "./tileset";
export * from "./composite";
export * from "./isometric-world";
