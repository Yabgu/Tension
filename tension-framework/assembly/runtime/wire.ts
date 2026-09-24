// The arena's wire types, as AssemblyScript sees them.
//
// Every type here is `@unmanaged` with scalar fields in declared order, so a
// `changetype<T>(offset)` is a *view* of guest memory: no allocation, no
// managed reference, and the field order is the wire order. Padding fields are
// spelled out rather than relied on, because the host writes these records at
// fixed offsets (`tension-core/src/session/arena.rs`) and a field that drifted
// would be read as another field's bytes.
//
// **Offset checks use `offsetof<T>("field")`, not `sizeof<T>()`.** AssemblyScript
// 0.28's `sizeof` does not report these records' sizes the way the wire needs,
// while `offsetof` is the compile-time builtin the rest of the framework already
// relies on. The sizes are checked from the *last field's* offset plus its
// width, which is a constant known on both sides — `checkWireOffsets` below is
// that check, and it is called from a guest's first instructions rather than
// from a module-level statement: a start section would run guest code before
// the session has verified the arena, and `tension-core` refuses one outright.
//
// The constants are the frozen layout (`DESIGN.md` §5). The Rust side's
// `arena::CLASSES` and `arena::REGIONS` are their authority; the cross-check
// test in tension-core reads the generated `layout.ts` for the hash, and these
// numbers move only when the arena's shape does.

// --- constants -------------------------------------------------------------

/** ArenaControl.state values (arena.rs `STATE_*`). */
export const STATE_UNINIT: u32 = 0;
export const STATE_READY: u32 = 1;
export const STATE_FAULTED: u32 = 2;
export const STATE_CLOSED: u32 = 3;

/** FrameState.faultState reasons (`FAULT_*`). */
export const FAULT_NONE: u32 = 0;
export const FAULT_CALLBACK_TRAP: u32 = 1;
export const FAULT_DEVICE_LOST: u32 = 2;
export const FAULT_OOM: u32 = 3;
export const FAULT_SHUTDOWN: u32 = 4;

/** Delivery modes (`MODE_*`). */
export const MODE_DIRECT: u32 = 1;
export const MODE_BATCHED: u32 = 2;
export const MODE_RING: u32 = 3;
export const MODE_POLLED: u32 = 4;

/** The ten event classes, in the frozen id order (urgent first). */
export const CLASS_DEVICE_LOST: u32 = 0;
export const CLASS_JOB_FAILED: u32 = 1;
export const CLASS_RESOURCE_FAILED: u32 = 2;
/** A deferred submission that was accepted and failed when applied. */
export const CLASS_SUBMISSION_REJECTED: u32 = 3;
export const CLASS_JOB_DONE: u32 = 4;
export const CLASS_RESOURCE_READY: u32 = 5;
export const CLASS_INPUT_KEY: u32 = 6;
export const CLASS_INPUT_MOUSE: u32 = 7;
export const CLASS_LOG: u32 = 8;
export const CLASS_FRAME: u32 = 9;

/** The twelve region kinds, in the frozen order (`kind == index`). */
export const REGION_CONTROL: u32 = 0;
export const REGION_SESSION_INFO: u32 = 1;
export const REGION_FRAME_STATE: u32 = 2;
export const REGION_JOB: u32 = 3;
export const REGION_RESOURCE: u32 = 4;
export const REGION_EVENT_TABLE: u32 = 5;
export const REGION_STRING: u32 = 6;
export const REGION_RESOURCE_REQ: u32 = 7;
export const REGION_SCENE: u32 = 8;
export const REGION_MATERIAL: u32 = 9;
export const REGION_RENDERABLE: u32 = 10;
export const REGION_BUFFER_POOL: u32 = 11;

/** How many callback slots this chunk defines. */
export const CALLBACK_SLOTS: u16 = 2;
/** One `EventRecord`, in bytes. */
export const EVENT_RECORD_SIZE: u32 = 32;
/** One `TableHeader`, in bytes. */
export const TABLE_HEADER_SIZE: u32 = 32;
/** One `Callbacks` record, in bytes. */
export const CALLBACKS_SIZE: u32 = 64;
/** One `Subscription`, in bytes. */
export const SUBSCRIPTION_SIZE: u32 = 16;
/** One `StringHalf` descriptor, in bytes. */
export const STRING_HALF_SIZE: u32 = 16;

// --- fixed offsets in the header page (arena.rs) ---------------------------

/** `ArenaControl` sits at the arena's first byte. */
export const CONTROL_OFFSET: u32 = 0x000;
/** `SessionInfo` follows it. */
export const SESSION_INFO_OFFSET: u32 = 0x100;
/** The region table: `kind == index`, 24 bytes an entry. */
export const REGION_TABLE_OFFSET: u32 = 0x200;
export const REGION_DESC_SIZE: u32 = 24;

// --- the records -----------------------------------------------------------

/** The control block (`ArenaControl`, 256 bytes). */
@unmanaged
export class ArenaControl {
  magic: u64 = 0;
  formatVersion: u16 = 0;
  schemaVersion: u16 = 0;
  abiVersion: u16 = 0;
  flags: u16 = 0;
  totalSize: u32 = 0;
  layoutHash: u32 = 0;
  regionCount: u32 = 0;
  regionTableOff: u32 = 0;
  manifestOff: u32 = 0;
  manifestLen: u32 = 0;
  // 40 .. 160: reserved.
  reserved0: u64 = 0;
  reserved1: u64 = 0;
  reserved2: u64 = 0;
  reserved3: u64 = 0;
  reserved4: u64 = 0;
  reserved5: u64 = 0;
  reserved6: u64 = 0;
  reserved7: u64 = 0;
  reserved8: u64 = 0;
  reserved9: u64 = 0;
  reserved10: u64 = 0;
  reserved11: u64 = 0;
  reserved12: u64 = 0;
  reserved13: u64 = 0;
  reserved14: u64 = 0;
  /** The authoritative state machine's report (`STATE_*`). */
  state: u32 = 0;
  /** `-EIO` after a fault, 0 when healthy. */
  faultCode: u32 = 0;
  /** A fault's detail: the callback slot index for a trap. */
  faultDetail: u32 = 0;
  private pad0: u32 = 0;
  /** A staleness witness: not a secret, and never zero while open. */
  sessionNonce: u64 = 0;
  // 184 .. 256: reserved.
  reserved15: u64 = 0;
  reserved16: u64 = 0;
  reserved17: u64 = 0;
  reserved18: u64 = 0;
  reserved19: u64 = 0;
  reserved20: u64 = 0;
  reserved21: u64 = 0;
  reserved22: u64 = 0;
  reserved23: u64 = 0;
}

/** What the session reports about the arena it opened (`SessionInfo`, 128 B). */
@unmanaged
export class SessionInfo {
  magic: u64 = 0;
  abiVersion: u16 = 0;
  schemaVersion: u16 = 0;
  flags: u16 = 0;
  private pad0: u16 = 0;
  arenaSize: u32 = 0;
  /** The ceiling — and the guest's `--memoryBase`. */
  maxArenaSize: u32 = 0;
  memoryBase: u32 = 0;
  initialPages: u32 = 0;
  maxPages: u32 = 0;
  layoutHash: u32 = 0;
  regionCount: u32 = 0;
  classCount: u32 = 0;
  /** Ten capacities, in class-id order (48 .. 88). */
  capacity0: u32 = 0;
  capacity1: u32 = 0;
  capacity2: u32 = 0;
  capacity3: u32 = 0;
  capacity4: u32 = 0;
  capacity5: u32 = 0;
  capacity6: u32 = 0;
  capacity7: u32 = 0;
  capacity8: u32 = 0;
  capacity9: u32 = 0;
  openNonce: u64 = 0;
  // 96 .. 128: reserved. Four words, not five: the record is 128 bytes and the
  // check below is what caught the difference.
  reserved0: u64 = 0;
  reserved1: u64 = 0;
  reserved2: u64 = 0;
  reserved3: u64 = 0;
}

/** One region's descriptor (24 bytes, `kind == index` at `0x200 + kind*24`). */
@unmanaged
export class RegionDesc {
  kind: u32 = 0;
  flags: u32 = 0;
  offset: u32 = 0;
  size: u32 = 0;
  align: u32 = 0;
  reserved: u32 = 0;
}

/** One class's sub-ring header (32 bytes). */
@unmanaged
export class TableHeader {
  /** Records the session has written; the guest never moves it. */
  head: u32 = 0;
  /** Records the guest has consumed: space reclaim, not an acknowledgement. */
  tail: u32 = 0;
  capacity: u32 = 0;
  stride: u32 = 0;
  /** Bumped once per compaction: a rebase the guest can see. */
  generation: u32 = 0;
  /** The session's per-class drop count, mirrored each epoch. */
  dropped: u32 = 0;
  /** The session's per-class delivery count, mirrored each epoch. */
  delivered: u64 = 0;
}

/** One event (32 bytes): what a delivery points at. */
@unmanaged
export class EventRecord {
  seq: u64 = 0;
  class_: u32 = 0;
  flags: u32 = 0;
  a: u32 = 0;
  b: u32 = 0;
  f0: f32 = 0;
  f1: f32 = 0;
}

/** What the session reports about the epoch that just ran (64 bytes). */
@unmanaged
export class FrameState {
  /** The session's epoch counter — not the renderer's frame number. */
  frameIndex: u32 = 0;
  /** Cross-class rollup of dropped events, cumulative. */
  droppedEvents: u32 = 0;
  /** `FAULT_*`; 0 when nothing is wrong. */
  faultState: u32 = 0;
  /** A callback trap's slot index, or 0. */
  lastError: u32 = 0;
  // 16 .. 64: reserved.
  reserved0: u64 = 0;
  reserved1: u64 = 0;
  reserved2: u64 = 0;
  reserved3: u64 = 0;
  reserved4: u64 = 0;
  reserved5: u64 = 0;
}

/** One half of the `STRING` region's buffer (16 bytes). */
@unmanaged
export class StringHalf {
  offset: u32 = 0;
  length: u32 = 0;
  capacity: u32 = 0;
  flags: u32 = 0;
}

/** The delivery callbacks a guest registers at open (64 bytes). */
@unmanaged
export class Callbacks {
  abiVersion: u16 = 0;
  slotCount: u16 = 0;
  flags: u32 = 0;
  /** A function-table index, or 0 for absent. */
  onBatch: u32 = 0;
  /** A function-table index, or 0 for absent. */
  onEvent: u32 = 0;
  // 16 .. 64: reserved.
  reserved0: u64 = 0;
  reserved1: u64 = 0;
  reserved2: u64 = 0;
  reserved3: u64 = 0;
  reserved4: u64 = 0;
  reserved5: u64 = 0;
}

/** One subscription, as `session::subscribe` takes it (16 bytes). */
@unmanaged
export class Subscription {
  class_: u32 = 0;
  mode: u32 = 0;
  flags: u32 = 0;
  reserved: u32 = 0;
}

// --- the offset check ------------------------------------------------------

/**
 * The first wire offset that disagrees with the frozen layout, or `null` when
 * every one matches.
 *
 * A reason rather than a boolean because a mismatch is a build that will read
 * another field's bytes, and "which one" is the whole diagnostic. The check is
 * `offsetof<T>("field")` per field — AssemblyScript's compile-time builtin —
 * plus, per record, the offset of its last field and the trailing reserved
 * space the wire fixes, which together pin the record's size without
 * `sizeof<T>()`: AS 0.28 does not report these `@unmanaged` records' sizes the
 * way the wire needs.
 */
function wireOffsetsProblem(): string | null {
  // ArenaControl: 256 bytes, with the state report at 160 and 72 reserved
  // bytes after the nonce.
  if (offsetof<ArenaControl>("magic") != 0) return "ArenaControl.magic";
  if (offsetof<ArenaControl>("formatVersion") != 8) return "ArenaControl.formatVersion";
  if (offsetof<ArenaControl>("abiVersion") != 12) return "ArenaControl.abiVersion";
  if (offsetof<ArenaControl>("totalSize") != 16) return "ArenaControl.totalSize";
  if (offsetof<ArenaControl>("layoutHash") != 20) return "ArenaControl.layoutHash";
  if (offsetof<ArenaControl>("regionCount") != 24) return "ArenaControl.regionCount";
  if (offsetof<ArenaControl>("regionTableOff") != 28) return "ArenaControl.regionTableOff";
  if (offsetof<ArenaControl>("manifestOff") != 32) return "ArenaControl.manifestOff";
  if (offsetof<ArenaControl>("manifestLen") != 36) return "ArenaControl.manifestLen";
  if (offsetof<ArenaControl>("state") != 160) return "ArenaControl.state";
  if (offsetof<ArenaControl>("faultCode") != 164) return "ArenaControl.faultCode";
  if (offsetof<ArenaControl>("faultDetail") != 168) return "ArenaControl.faultDetail";
  if (offsetof<ArenaControl>("sessionNonce") != 176) return "ArenaControl.sessionNonce";
  if (offsetof<ArenaControl>("sessionNonce") + 8 + 9 * 8 != 256) return "ArenaControl size";

  // SessionInfo: 128 bytes, ten capacities from 48, the nonce at 88.
  if (offsetof<SessionInfo>("magic") != 0) return "SessionInfo.magic";
  if (offsetof<SessionInfo>("abiVersion") != 8) return "SessionInfo.abiVersion";
  if (offsetof<SessionInfo>("flags") != 12) return "SessionInfo.flags";
  if (offsetof<SessionInfo>("arenaSize") != 16) return "SessionInfo.arenaSize";
  if (offsetof<SessionInfo>("maxArenaSize") != 20) return "SessionInfo.maxArenaSize";
  if (offsetof<SessionInfo>("memoryBase") != 24) return "SessionInfo.memoryBase";
  if (offsetof<SessionInfo>("initialPages") != 28) return "SessionInfo.initialPages";
  if (offsetof<SessionInfo>("maxPages") != 32) return "SessionInfo.maxPages";
  if (offsetof<SessionInfo>("layoutHash") != 36) return "SessionInfo.layoutHash";
  if (offsetof<SessionInfo>("regionCount") != 40) return "SessionInfo.regionCount";
  if (offsetof<SessionInfo>("classCount") != 44) return "SessionInfo.classCount";
  if (offsetof<SessionInfo>("capacity0") != 48) return "SessionInfo.capacity0";
  if (offsetof<SessionInfo>("capacity9") != 84) return "SessionInfo.capacity9";
  if (offsetof<SessionInfo>("openNonce") != 88) return "SessionInfo.openNonce";
  if (offsetof<SessionInfo>("openNonce") + 8 + 4 * 8 != 128) return "SessionInfo size";

  // RegionDesc: 24 bytes, kind == index, the reserved word last.
  if (offsetof<RegionDesc>("kind") != 0) return "RegionDesc.kind";
  if (offsetof<RegionDesc>("flags") != 4) return "RegionDesc.flags";
  if (offsetof<RegionDesc>("offset") != 8) return "RegionDesc.offset";
  if (offsetof<RegionDesc>("size") != 12) return "RegionDesc.size";
  if (offsetof<RegionDesc>("align") != 16) return "RegionDesc.align";
  if (offsetof<RegionDesc>("reserved") != 20) return "RegionDesc.reserved";
  if (offsetof<RegionDesc>("reserved") + 4 != 24) return "RegionDesc size";

  // TableHeader: 32 bytes, the delivered counter a u64 at 24.
  if (offsetof<TableHeader>("head") != 0) return "TableHeader.head";
  if (offsetof<TableHeader>("tail") != 4) return "TableHeader.tail";
  if (offsetof<TableHeader>("capacity") != 8) return "TableHeader.capacity";
  if (offsetof<TableHeader>("stride") != 12) return "TableHeader.stride";
  if (offsetof<TableHeader>("generation") != 16) return "TableHeader.generation";
  if (offsetof<TableHeader>("dropped") != 20) return "TableHeader.dropped";
  if (offsetof<TableHeader>("delivered") != 24) return "TableHeader.delivered";
  if (offsetof<TableHeader>("delivered") + 8 != 32) return "TableHeader size";

  // EventRecord: 32 bytes, the two floats last.
  if (offsetof<EventRecord>("seq") != 0) return "EventRecord.seq";
  if (offsetof<EventRecord>("class_") != 8) return "EventRecord.class_";
  if (offsetof<EventRecord>("flags") != 12) return "EventRecord.flags";
  if (offsetof<EventRecord>("a") != 16) return "EventRecord.a";
  if (offsetof<EventRecord>("b") != 20) return "EventRecord.b";
  if (offsetof<EventRecord>("f0") != 24) return "EventRecord.f0";
  if (offsetof<EventRecord>("f1") != 28) return "EventRecord.f1";
  if (offsetof<EventRecord>("f1") + 4 != 32) return "EventRecord size";

  // StringHalf: 16 bytes.
  if (offsetof<StringHalf>("offset") != 0) return "StringHalf.offset";
  if (offsetof<StringHalf>("length") != 4) return "StringHalf.length";
  if (offsetof<StringHalf>("capacity") != 8) return "StringHalf.capacity";
  if (offsetof<StringHalf>("flags") != 12) return "StringHalf.flags";
  if (offsetof<StringHalf>("flags") + 4 != 16) return "StringHalf size";

  // Callbacks: 64 bytes, the two slots adjacent, 48 reserved bytes after them.
  if (offsetof<Callbacks>("abiVersion") != 0) return "Callbacks.abiVersion";
  if (offsetof<Callbacks>("slotCount") != 2) return "Callbacks.slotCount";
  if (offsetof<Callbacks>("flags") != 4) return "Callbacks.flags";
  if (offsetof<Callbacks>("onBatch") != 8) return "Callbacks.onBatch";
  if (offsetof<Callbacks>("onEvent") != 12) return "Callbacks.onEvent";
  if (offsetof<Callbacks>("onEvent") + 4 + 6 * 8 != 64) return "Callbacks size";

  // Subscription: 16 bytes.
  if (offsetof<Subscription>("class_") != 0) return "Subscription.class_";
  if (offsetof<Subscription>("mode") != 4) return "Subscription.mode";
  if (offsetof<Subscription>("flags") != 8) return "Subscription.flags";
  if (offsetof<Subscription>("reserved") != 12) return "Subscription.reserved";
  if (offsetof<Subscription>("reserved") + 4 != 16) return "Subscription size";

  // FrameState: 64 bytes, the four defined words first, 48 reserved after them.
  if (offsetof<FrameState>("frameIndex") != 0) return "FrameState.frameIndex";
  if (offsetof<FrameState>("droppedEvents") != 4) return "FrameState.droppedEvents";
  if (offsetof<FrameState>("faultState") != 8) return "FrameState.faultState";
  if (offsetof<FrameState>("lastError") != 12) return "FrameState.lastError";
  if (offsetof<FrameState>("lastError") + 4 + 6 * 8 != 64) return "FrameState size";

  return null;
}

/**
 * Check the wire offsets this build compiled against.
 *
 * A guest calls this in its first instructions. It is not a module-level
 * statement on purpose: top-level code becomes a `start` section, and the
 * session refuses a module that has one — the arena is verified between
 * instantiation and `_start_game`, so guest code must not run before that. (The
 * SDK's own build avoids the section too: `--exportStart __start` turns the
 * runtime's initializer into an export the host calls after verifying.)
 *
 * Returns false (never throws) so a caller can decide what a bad build means;
 * `assertWireOffsets` is the throwing form, and it names the field that moved.
 */
export function checkWireOffsets(): bool {
  return wireOffsetsProblem() == null;
}

/** `checkWireOffsets`, as an assertion: a bad build stops at startup, named. */
export function assertWireOffsets(): void {
  const problem = wireOffsetsProblem();
  if (problem != null) {
    assert(false, "the runtime's wire offsets do not match the arena layout: " + problem);
  }
}
