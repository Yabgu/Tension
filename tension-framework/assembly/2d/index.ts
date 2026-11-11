// tension-framework/assembly/2d/index.ts — the 2D guest SDK, re-exported from
// the framework barrel.
//
// Two layers, in the order a game meets them:
//
//   Canvas          one open handle: the verbs, the errno, `loadTextureFromRes`
//   constants       the wire numbers, each citing its line of tension_2d.h
//
// and two buffers a guest owns:
//
//   RecordBuffer    a frame's records, and the count that describes them
//   Pixels          a `screenshot` destination, and the questions a test asks
//
// three types that turn game state into records:
//
//   Tileset         pixels -> record fields (page + src rect)
//   Composite       a character -> N records sharing a sort key and group
//   IsometricWorld  tall art -> sliced records sorted by their bottom edge
//
// plus `types.ts`, which is the record layout all of them write.
//
// **No verb takes an address from a guest.** `Canvas.pipelineGraph`,
// `loadTexture`, `submit` and `screenshot` take `Bytes`, `RecordBuffer` or
// `Pixels`, and each of those holds the only `usize` involved. That is not
// tidiness: a buffer addressed with `changetype<usize>(typedArray)` is the
// *object*, 32 bytes before its data, so records written through it corrupt the
// object that owns them and the collector traps on the next mark phase
// (`bytes.ts` has the backtrace, `tests/guest-buffers.ts` keeps it buried).
//
// **`verbs.ts` is not exported.** Its nine `@external` declarations are the
// wire, not the API: a guest calls `Canvas`, and the one verb that is not a
// method (`set_texture`, which `Tileset.bind` calls) is imported privately by
// the module that needs it. Exporting `openRaw`/`submitRaw` would put two ways
// to call every verb in front of a game author, one of which loses the handle
// bookkeeping and the errno record. `ogre/wire.ts` sits behind `ogre/index.ts`
// for the same reason.
//
// **The verbs moved here in this pass.** They were declared per example, three
// times, and the copies had drifted. `tension_2d.h` has no `schema/` entry, so
// `tools/codegen` cannot emit them; the SDK is the one hand-written home.
// `examples/2d/isometric` keeps its own copy permanently, as the wire oracle:
// it is the control that makes a lie in this wrapper a diff rather than an
// opinion.

export * from "./types";
export * from "./buffers";
export * from "./constants";
export * from "./canvas";
export * from "./tileset";
export * from "./composite";
export * from "./isometric-world";
