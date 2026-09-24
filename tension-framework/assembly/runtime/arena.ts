// The arena, as the guest sees it.
//
// The session owns the memory and writes the layout into it before the guest
// exists (`tension-ogre/DESIGN.md` §5); this module is the read-only view. Two
// things are worth knowing before using it:
//
//   * The arena is at address 0. The header page is fixed
//     (`ArenaControl` @0, `SessionInfo` @0x100, the region table @0x200), and
//     the regions follow at the offsets their descriptors state. There is no
//     `session_get_region` verb: the guest reads the descriptor table directly,
//     and `regionOffset`/`regionSize` below are that read with the arithmetic
//     done for it.
//   * Nothing here allocates. `changetype<T>(offset)` is a view: it costs
//     nothing and it holds no reference, which is why these are functions and
//     not a memoized global — a cached view would be a cached pointer into
//     memory the guest may write.
//   * **A `usize` is not a TypedArray's bytes.** `changetype<usize>(x)`
//     reinterprets `x`, and what `x` *is* decides what comes out: for an
//     `ArrayBuffer` it is the data (an ArrayBuffer's object pointer is its
//     buffer), while for a **TypedArray** it is the *object* — its header,
//     buffer field and length — so copying from there writes a runtime header
//     where you meant your numbers. A TypedArray's data pointer is
//     `typedArray.dataStart`. This costs guests an afternoon the first time,
//     because the symptom is not a crash but bytes that are quietly someone
//     else's: chunk 5.5's `create_mesh` reported "index 0 names vertex 9248"
//     for an array the guest had written as `{0, 1, 2}`.

import {
  ArenaControl,
  RegionDesc,
  SessionInfo,
  CONTROL_OFFSET,
  REGION_DESC_SIZE,
  REGION_TABLE_OFFSET,
  SESSION_INFO_OFFSET,
} from "./wire";
import { LAYOUT_HASH, MAX_ARENA_SIZE } from "./layout";

/** The control block: state, fault report, and the layout's own triple. */
export function ctrl(): ArenaControl {
  return changetype<ArenaControl>(CONTROL_OFFSET);
}

/** What the session reported about the arena it opened. */
export function sessionInfo(): SessionInfo {
  return changetype<SessionInfo>(SESSION_INFO_OFFSET);
}

/**
 * One region's descriptor. The table is `kind == index`, so this is arithmetic
 * rather than a search.
 *
 * A descriptor whose `kind` field does not match the index is a build that
 * disagrees with the session about the layout; `assertLayout` (and the
 * `checkLayout` it wraps) is what turns that into a refusal rather than a wrong
 * offset.
 */
export function regionDesc(kind: u32): RegionDesc {
  return changetype<RegionDesc>(REGION_TABLE_OFFSET + kind * REGION_DESC_SIZE);
}

/** A region's start address in guest memory. */
export function regionOffset(kind: u32): u32 {
  return regionDesc(kind).offset;
}

/** A region's size in bytes. */
export function regionSize(kind: u32): u32 {
  return regionDesc(kind).size;
}

/**
 * Whether the arena is the one this guest was compiled against.
 *
 * Checks the control block's magic (the session writes it before instantiation,
 * so a wrong value means the guest is reading something that is not its arena)
 * and the layout hash (which is what catches a guest built against an older
 * shape). Returns false rather than throwing: a caller decides whether a
 * mismatched arena is fatal, and it always is.
 */
export function checkLayout(): bool {
  const block = ctrl();
  if (block.magic != MAGIC) return false;
  const info = sessionInfo();
  return info.layoutHash == LAYOUT_HASH && <u32>block.layoutHash == LAYOUT_HASH;
}

/** `checkLayout`, as an assertion. */
export function assertLayout(): void {
  assert(checkLayout(), "the arena is not the layout this guest was built against");
}

/** `ArenaControl.magic`: "TNSARENA" as eight little-endian bytes. */
export const MAGIC: u64 = 0x414e455241534e54;

/** `CANARY_MAGIC`, the constant the gap lattice folds each offset with. */
const CANARY_MAGIC: u64 = 0x9e3779b97f4a7c15;
/** One lattice block every this many bytes. */
const CANARY_STRIDE: u32 = 4096;
/** How many bytes a block occupies: a word and its complement. */
const CANARY_BLOCK: u32 = 16;

/**
 * Verify one canary block of the reserved gap, at an offset the lattice covers
 * — the session's own claim, checkable by the guest.
 *
 * The gap is `[layout_end, memory_base)` and the lattice puts a block at each
 * multiple of `CANARY_STRIDE` in it, carrying `offset ^ CANARY_MAGIC` and its
 * complement. A guest does not need this to run; it needs it to *check*, which
 * is a different thing, and cheap.
 */
export function verifyCanary(offset: u32): bool {
  if (offset % CANARY_STRIDE != 0) return false;
  const word = <u64>offset ^ CANARY_MAGIC;
  const at = <usize>offset;
  return load<u64>(at) == word && load<u64>(at + 8) == ~word;
}

/** The reserved gap's bounds, as `SessionInfo` states them. */
export function gapStart(): u32 {
  // The layout's end is not a field the guest is given; the largest region end
  // is what bounds it, and the guest can compute it from the descriptors.
  let end: u32 = 0;
  const count = sessionInfo().regionCount;
  for (let kind: u32 = 0; kind < count; kind++) {
    const region = regionDesc(kind);
    const regionEnd = region.offset + region.size;
    if (regionEnd > end) end = regionEnd;
  }
  return end;
}

/** The gap's end: the ceiling, and therefore the guest's `--memoryBase`. */
export function gapEnd(): u32 {
  return MAX_ARENA_SIZE;
}
