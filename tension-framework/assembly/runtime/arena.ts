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
  Callbacks,
  EventRecord,
  ManifestEntry,
  RegionDesc,
  SessionInfo,
  StringHalf,
  Subscription,
  TableHeader,
  CONTROL_OFFSET,
  REGION_DESC_SIZE,
  REGION_TABLE_OFFSET,
  SESSION_INFO_OFFSET,
} from "./wire";
import {
  MANIFEST_ENTRY_COUNT,
  MANIFEST_ENTRY_SIZE,
  MANIFEST_TYPE_NAMES,
} from "./manifest";
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

/**
 * The first manifest entry that disagrees with this guest's declarations, or
 * `null` when every one matches.
 *
 * **What the manifest is.** Before the guest exists, `prepare_arena` writes
 * nine `{typeId, size, align, pad}` entries at `ArenaControl.manifestOff`
 * (`tension-core/src/session/arena.rs`, `TYPES` and `write_manifest`): the
 * sizes and alignments the host's own writers were built against. It is the
 * only schema the host ever sends, and until this check existed nothing in the
 * guest read it.
 *
 * **What this proves that `assertWireOffsets` cannot.** The offset checks
 * compare a declaration against a literal copied from the host by hand, so they
 * prove *declaration == hand-copy*. `SessionInfo` drifted for a day with every
 * check passing, because the hand-copy was stale too: the guest declared 128
 * bytes / 10 capacities / the nonce at 88, the host wrote 144 / 13 / 104, and
 * the check agreed with the guest. This one compares against what the host
 * actually wrote into the arena at open. It would have named that drift on the
 * first open.
 *
 * **Type level, not field level.** The manifest carries no per-field offsets, so
 * this catches a record whose size or alignment changed, not a reorder inside
 * one. The per-field half stays with `assertWireOffsets`; the two checks are
 * complementary, neither subsumes the other.
 *
 * **Sizes only — alignment is a consistency relation, not a comparison.**
 * `entry.size % entry.align` is checked because a manifest whose size is not a
 * multiple of its align is malformed whatever the guest declares. The entry's
 * `align` is deliberately *not* compared against `alignof<T>()`: under the
 * pinned TensionScript 0.8.1, `alignof` of an `@unmanaged struct` returns the
 * `usize` base's alignment (2 in log2 terms, measured: every record reports the
 * same value regardless of its widest field), the same `type.byteSize` /
 * `type.alignLog2` collapse that made `sizeof` report 4 for every class before
 * 0.8.0 fixed it for `sizeof` only. Comparing against it today would fail on
 * the first record with an 8-byte field for a reason that is not drift. When
 * `alignof` reports a record's own alignment, this function gains the
 * comparison; until then the size check carries the drift detection on its own,
 * and a size change is what `SessionInfo` did.
 *
 * Returns a reason rather than asserting, so the caller decides: `
 * RuntimeSession.open` aborts, and a fixture can print the same reason and
 * continue.
 */
export function manifestProblem(): string | null {
  const block = ctrl();
  const off = block.manifestOff;
  const len = block.manifestLen;
  const expectedLen = MANIFEST_ENTRY_COUNT * MANIFEST_ENTRY_SIZE;
  if (len != expectedLen) {
    return "manifest length " + len.toString() + " != " + expectedLen.toString() +
      "; the host and this guest disagree on the manifest's shape";
  }
  for (let index: u32 = 0; index < MANIFEST_ENTRY_COUNT; index++) {
    const entry = changetype<ManifestEntry>(off + index * MANIFEST_ENTRY_SIZE);
    const id = <u32>entry.typeId;
    // An id outside 1..N is a host type this guest has no declaration for. The
    // generated table is dense in that range, so there is no other lookup to
    // miss.
    if (id == 0 || id > MANIFEST_ENTRY_COUNT) {
      return "manifest entry " + index.toString() + " states type id " + id.toString() +
        "; this guest knows ids 1.." + MANIFEST_ENTRY_COUNT.toString();
    }
    const name = MANIFEST_TYPE_NAMES[id - 1];
    const hostSize = <u32>entry.size;
    const hostAlign = <u32>entry.align;
    if (hostAlign == 0 || hostSize % hostAlign != 0) {
      return name + ": size " + hostSize.toString() + " is not a multiple of align " +
        hostAlign.toString() + "; the manifest is malformed";
    }
    const guestSize = guestTypeSize(id);
    if (guestSize != hostSize) {
      return name + ": guest " + guestSize.toString() + " != host " + hostSize.toString();
    }
  }
  return null;
}

/**
 * This guest's `sizeof` for one manifest id, folded at compile time.
 *
 * `sizeof` on an `@unmanaged struct` is the record's layout extent, which is
 * what the host's `size` is too: both are 8-byte-field records, and every one
 * of the nine ends on a field whose end coincides with the aligned size. A
 * record ending in a `u8`/`u16` would need trailing padding the compiler does
 * not add, and would report smaller than C — that is a `sizeof` semantic, not a
 * drift this check can see, and no manifest type is shaped that way.
 */
function guestTypeSize(id: u32): u32 {
  switch (id) {
    case 1: return sizeof<ArenaControl>();
    case 2: return sizeof<SessionInfo>();
    case 3: return sizeof<RegionDesc>();
    case 4: return sizeof<ManifestEntry>();
    case 5: return sizeof<TableHeader>();
    case 6: return sizeof<StringHalf>();
    case 7: return sizeof<Callbacks>();
    case 8: return sizeof<Subscription>();
    case 9: return sizeof<EventRecord>();
  }
  return 0;
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
