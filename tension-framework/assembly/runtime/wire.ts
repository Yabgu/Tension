// The arena's wire types, as AssemblyScript sees them.
//
// Every type here is `@unmanaged` with scalar fields in declared order, so a
// `changetype<T>(offset)` is a *view* of guest memory: no allocation, no
// managed reference, and the field order is the wire order. Padding fields are
// spelled out rather than relied on, because the host writes these records at
// fixed offsets (`tension-core/src/session/arena.rs`) and a field that drifted
// would be read as another field's bytes.
//
// **What checks the layout now.** The per-field `offsetof`/`sizeof` table this
// file used to carry was deleted on 2026-10-30 — it compared each declaration
// against a literal copied from the host by hand, so it proved *declaration ==
// hand-copy* and passed while `SessionInfo` drifted for a day (the hand-copy was
// stale too). Two checks remain, and they compare against what the host actually
// published:
//
//   - `arena.ts`'s `checkLayout` / `assertLayout`: the guest's `LAYOUT_HASH`
//     literal against the hash the host wrote into the arena at open;
//   - `arena.ts`'s `manifestProblem()`, called at open from `runtime/index.ts`:
//     the host's own `{typeId, size, align, pad}` entries against this build's
//     `sizeof<T>()`.
//
// Both are **type level**: the manifest carries no per-field offsets, so a field
// reorder inside a record that leaves the size unchanged is now unverified on
// the guest side. The mechanical fix is one source emitting both sides, scoped
// in `docs/engine-adoption-plan.md`.
//
// Measured 2026-10-30 on TensionScript 0.11.0: `sizeof` reports all ten records
// exactly (256, 144, 24, 8, 32, 16, 64, 16, 32, 64), which is what makes the
// manifest comparison meaningful. Neither check is a module-level statement on
// purpose: a start section would run guest code before the session has verified
// the arena, and `tension-core` refuses one outright.
//
// The constants are the frozen layout (`DESIGN.md` §5). The Rust side's
// `arena::CLASSES` and `arena::REGIONS` are their authority; the cross-check
// test in tension-core reads the generated `layout.ts` for the hash, and these
// numbers move only when the arena's shape does.

// The managed struct's alias fixture is not a wire record (it has no host
// declaration), but it is asserted by the same function, so the compiler's two
// kinds are checked in one place. See `managed-alias.ts` for why it is separate.
import { assertManagedAliases } from "./managed-alias";

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

/** The thirteen event classes, in the frozen id order (urgent first). */
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
/**
 * The AI family (0.6.0a): appended after `FRAME` so every id 0-9 kept its
 * value. The **delivered class** distinguishes data from done from failure —
 * never the payload, because a zero payload must not read as either (`0.6.0b`
 * builds `rt.stream` on this).
 */
export const CLASS_AI_READY: u32 = 10;
export const CLASS_AI_DONE: u32 = 11;
export const CLASS_AI_ERROR: u32 = 12;

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
export struct ArenaControl {
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

/**
 * What the session reports about the arena it opened (`SessionInfo`, 144 B).
 *
 * The shape is `tension-core/src/session/arena.rs:51-101`: thirteen classes, so
 * thirteen capacities at 48..100, padded to 104, then the nonce at 104..112 and
 * four reserved words to 144. The 100..104 word is **implicit** — the compiler
 * aligns the `u64` nonce to 104, and the host's `SESSION_INFO_OPEN_NONCE` is 104
 * for the same reason (its `put_u64` refuses an unaligned offset). No field is
 * declared for it; `manifestProblem()` compares this record's `sizeof` against
 * the host's published entry, which is the check that survives.
 */
@unmanaged
export struct SessionInfo {
  magic: u64 = 0;
  abiVersion: u16 = 0;
  schemaVersion: u16 = 0;
  flags: u16 = 0;
  /// 4 bytes of implicit padding here: `arenaSize` is a `u32` and the compiler
  /// aligns it to 16. The explicit word that used to sit here was a no-op.
  arenaSize: u32 = 0;
  /** The ceiling — and the guest's `--memoryBase`. */
  maxArenaSize: u32 = 0;
  memoryBase: u32 = 0;
  initialPages: u32 = 0;
  maxPages: u32 = 0;
  layoutHash: u32 = 0;
  regionCount: u32 = 0;
  classCount: u32 = 0;
  /** Thirteen capacities, in class-id order (48 .. 100). */
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
  capacity10: u32 = 0;
  capacity11: u32 = 0;
  capacity12: u32 = 0;
  /// 100 .. 104 is the `u64` nonce's alignment word (`arena.rs:96-99`). It is
  /// implicit: the compiler aligns `openNonce` to 104, so no field is declared
  /// for it — the assertion below is what pins the boundary.
  openNonce: u64 = 0;
  // 112 .. 144: reserved. Four words: the record is 144 bytes.
  reserved0: u64 = 0;
  reserved1: u64 = 0;
  reserved2: u64 = 0;
  reserved3: u64 = 0;
}

/**
 * One manifest entry (8 bytes), as `arena.rs`'s `TypeEntry` writes it.
 *
 * The catalog is `{typeId: u16, size: u16, align: u16, pad: u16}` at the address
 * `ArenaControl.manifestOff` names (`arena.rs`'s `write_manifest`). It states,
 * for the nine protocol types the host pins, the size and alignment the host
 * built its writers against — which is the only schema the host ever sends the
 * guest. `arena.ts`'s `manifestProblem()` is what compares it to these
 * declarations.
 *
 * The field names are the guest's: the wire carries no names, and the host's
 * entry has no name field either. Only `typeId`, `size` and `align` mean
 * anything; `pad` is the manifest entry's own tail padding (`TYPES` id 4 pins
 * the entry at 8 bytes with alignment 2).
 */
@unmanaged
export struct ManifestEntry {
  typeId: u16 = 0;
  size: u16 = 0;
  align: u16 = 0;
  pad: u16 = 0;
}

/** One region's descriptor (24 bytes, `kind == index` at `0x200 + kind*24`). */
@unmanaged
export struct RegionDesc {
  kind: u32 = 0;
  flags: u32 = 0;
  offset: u32 = 0;
  size: u32 = 0;
  align: u32 = 0;
  reserved: u32 = 0;
}

/** One class's sub-ring header (32 bytes). */
@unmanaged
export struct TableHeader {
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
export struct EventRecord {
  seq: u64 = 0;
  /**
   * The class the record landed in, named `class` on the host side
   * (`arena.rs`'s `EventRecord::class`, `EVENT_CLASS`). This field carries the
   * trailing underscore only because `class` is a reserved word here; the alias
   * is what keeps the ABI name honest, and `abiNameOf` is what reads it.
   */
  class_: u32 @abi.alias("class") = 0;
  flags: u32 = 0;
  a: u32 = 0;
  b: u32 = 0;
  f0: f32 = 0;
  f1: f32 = 0;
}

/** What the session reports about the epoch that just ran (64 bytes). */
@unmanaged
export struct FrameState {
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
export struct StringHalf {
  offset: u32 = 0;
  length: u32 = 0;
  capacity: u32 = 0;
  flags: u32 = 0;
}

/** The delivery callbacks a guest registers at open (64 bytes). */
@unmanaged
export struct Callbacks {
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
export struct Subscription {
  /** `class` on the host side (`Subscription::class`, `SUBSCRIPTION_CLASS`); the
   * underscore is the reserved word, not part of the name. */
  class_: u32 @abi.alias("class") = 0;
  mode: u32 = 0;
  flags: u32 = 0;
  reserved: u32 = 0;
}

// --- the offset check ------------------------------------------------------



/**
 * The ABI names of the fields whose TypeScript name is not their wire name.
 *
 * Two fields differ, both `class_`: `class` is a reserved word in this language,
 * so the declaration must write `class_`, while the host's record (`arena.rs`'s
 * `EventRecord::class` and `Subscription::class`) and the wire's offsets
 * (`EVENT_CLASS`, `SUBSCRIPTION_CLASS`) say `class`. The `@abi.alias` on each
 * field is the only place that difference is recorded.
 *
 * **No other field is aliased, on purpose.** The OGRE records read
 * `positionX`/`rotationW`/`diffuseR` here where `scene.h`'s decoders declare
 * `px`/`rw`/`dr`, but those are local variable names in a decoder that fills its
 * struct from offsets -- the wire bytes carry no field names at all. Aliasing
 * them would record an implementation detail as protocol metadata, and the drift
 * checker this metadata exists for would then compare against names that are not
 * on the wire.
 *
 * Compile-time: `abiNameOf` folds to a constant, so this costs nothing at
 * runtime, but it must be called from code the build actually emits. It is a
 * separate function from `checkLayout` because the two assert different
 * things -- what a field is called, and whether the arena is the shape this
 * build expects -- and a build can get one right while getting the other wrong.
 */
export function assertAbiAliases(): void {
  if (abiNameOf<EventRecord>("class_") != "class") {
    assert(false, "EventRecord.class_ does not carry its ABI alias: class");
  }
  if (abiNameOf<Subscription>("class_") != "class") {
    assert(false, "Subscription.class_ does not carry its ABI alias: class");
  }
  // A field with no alias reports its TypeScript name; if this ever starts
  // returning the alias shape instead, `abiNameOf`'s fallback is broken.
  if (abiNameOf<EventRecord>("seq") != "seq") {
    assert(false, "EventRecord.seq has no alias and must report its TS name");
  }
  // The same two facts on the compiler's other struct kind. TensionScript 0.9.0
  // is the first release that honors `@abi.alias` on an `@managed` struct, so
  // this is the assertion PR 8 could not write.
  assertManagedAliases();
}
