//! The arena's layout: offsets, region table, manifest, and the shape hash.
//!
//! Pure arithmetic over a byte slice. Nothing here knows what wasmtime is, what
//! a guest is, or what OGRE is — the module exists so that the layout can be
//! tested, and pinned, without a store (`tension-ogre/DESIGN.md` §5).
//!
//! The layout is **frozen**: the twelve region kinds are `kind == index`, every
//! region's offset is a compile-time constant, and `arena_size` only selects how
//! much of the band is live. That is what lets an adapter call `region_lookup`
//! at link time and cache the answers (`DESIGN.md` §5.2, §7.2).
//!
//! The header page, and the region band's arithmetic (default sizes from
//! `DESIGN.md` §5.2):
//!
//! ```text
//! 0x000  ArenaControl          256 B
//! 0x100  SessionInfo           128 B
//! 0x180  reserved               128 B
//! 0x200  RegionDesc[12]        288 B   (24 B each, kind == index)
//! 0x320  manifest               72 B   (9 types × 8 B; grows only with a schema bump)
//! ...
//! 0x1000 FRAME_STATE          4 KiB
//! 0x2000 JOB                 48 KiB
//! 0xE000 RESOURCE            48 KiB
//! 0x1A000 EVENT_TABLE       384 KiB
//! 0x7A000 STRING            1 MiB + 32 B
//! 0x17A020 RESOURCE_REQ      48 KiB
//! 0x186020 SCENE            256 KiB
//! 0x1C6020 MATERIAL          64 KiB
//! 0x1D6020 RENDERABLE       128 KiB
//! 0x1F6020 BUFFER_POOL        4 MiB
//! 0x5F6020 end of the frozen layout (`LAYOUT_FLOOR`)
//! ```

/// ASCII `TNSARENA`, little-endian in one `u64` — the same idea as the solver
/// wire's `TNSCONF1`: a byte dump reads the name in order.
pub const MAGIC: u64 = 0x414E_4552_4153_4E54;

/// The arena's own layout version. A shape change bumps this.
pub const FORMAT_VERSION: u16 = 1;

/// The wire catalogue's version. A *meaning* change with identical offsets
/// bumps this and leaves [`layout_hash`] alone (`DESIGN.md` §13).
pub const SCHEMA_VERSION: u16 = 1;

/// The adapter ABI version the arena was written for.
pub const ABI_VERSION: u16 = 1;

// ── the header page ───────────────────────────────────────────────────────

pub const CONTROL_OFFSET: usize = 0x000;
pub const CONTROL_SIZE: usize = 256;
pub const SESSION_INFO_OFFSET: usize = 0x100;
pub const SESSION_INFO_SIZE: usize = 128;
pub const REGION_TABLE_OFFSET: usize = 0x200;
pub const REGION_DESC_SIZE: usize = 24;
pub const REGION_COUNT: usize = 12;
pub const MANIFEST_OFFSET: usize = REGION_TABLE_OFFSET + REGION_COUNT * REGION_DESC_SIZE;
pub const MANIFEST_ENTRY_SIZE: usize = 8;
pub const HEADER_PAGE_SIZE: usize = 0x1000;

// ── ArenaControl fields ───────────────────────────────────────────────────

pub const CONTROL_MAGIC: usize = 0;
pub const CONTROL_FORMAT_VERSION: usize = 8;
pub const CONTROL_SCHEMA_VERSION: usize = 10;
pub const CONTROL_ABI_VERSION: usize = 12;
pub const CONTROL_FLAGS: usize = 14;
pub const CONTROL_TOTAL_SIZE: usize = 16;
pub const CONTROL_LAYOUT_HASH: usize = 20;
pub const CONTROL_REGION_COUNT: usize = 24;
pub const CONTROL_REGION_TABLE_OFF: usize = 28;
pub const CONTROL_MANIFEST_OFF: usize = 32;
pub const CONTROL_MANIFEST_LEN: usize = 36;
/// The session-owned tail begins here. Everything below is written once, before
/// instantiation; everything from here on belongs to the session.
pub const CONTROL_STATE: usize = 160;
pub const CONTROL_FAULT_CODE: usize = 164;
pub const CONTROL_FAULT_DETAIL: usize = 168;
pub const CONTROL_SESSION_NONCE: usize = 176;

// ── SessionInfo fields ────────────────────────────────────────────────────

pub const SESSION_INFO_MAGIC: usize = 0;
pub const SESSION_INFO_ABI_VERSION: usize = 8;
pub const SESSION_INFO_SCHEMA_VERSION: usize = 10;
pub const SESSION_INFO_FLAGS: usize = 12;
pub const SESSION_INFO_ARENA_SIZE: usize = 16;
pub const SESSION_INFO_MAX_ARENA_SIZE: usize = 20;
pub const SESSION_INFO_MEMORY_BASE: usize = 24;
pub const SESSION_INFO_INITIAL_PAGES: usize = 28;
pub const SESSION_INFO_MAX_PAGES: usize = 32;
pub const SESSION_INFO_LAYOUT_HASH: usize = 36;
pub const SESSION_INFO_REGION_COUNT: usize = 40;
pub const SESSION_INFO_CLASS_COUNT: usize = 44;
pub const SESSION_INFO_CLASS_CAPACITY: usize = 48;
pub const SESSION_INFO_OPEN_NONCE: usize = 88;

// ── the session state machine's values (the control block's report) ───────

pub const STATE_UNINIT: u32 = 0;
pub const STATE_READY: u32 = 1;
pub const STATE_FAULTED: u32 = 2;
pub const STATE_CLOSED: u32 = 3;

/// `FrameState.faultState` reasons.
pub const FAULT_CALLBACK_TRAP: u32 = 1;
pub const FAULT_DEVICE_LOST: u32 = 2;
pub const FAULT_OOM: u32 = 3;
pub const FAULT_SHUTDOWN: u32 = 4;

// ── event classes and delivery modes ──────────────────────────────────────

/// The ten classes of `DESIGN.md` §3.2, in the frozen id order (urgent first:
/// delivery follows class id within an epoch).
pub const CLASS_COUNT: usize = 10;

pub const MODE_DIRECT: u32 = 1;
pub const MODE_BATCHED: u32 = 2;
pub const MODE_RING: u32 = 3;
pub const MODE_POLLED: u32 = 4;

/// One `EventRecord`, in bytes — the stride of every class sub-ring.
pub const EVENT_RECORD_SIZE: usize = 32;

/// One sub-ring's header (`TableHeader`), in bytes.
pub const RING_HEADER_SIZE: usize = 32;

/// `TableHeader` fields.
pub const TABLE_HEAD: usize = 0;
pub const TABLE_TAIL: usize = 4;
pub const TABLE_CAPACITY: usize = 8;
pub const TABLE_STRIDE: usize = 12;
pub const TABLE_GENERATION: usize = 16;
pub const TABLE_DROPPED: usize = 20;
pub const TABLE_DELIVERED: usize = 24;

/// `EventRecord` fields — the 32-byte record a sub-ring holds.
///
/// These offsets **are** part of [`layout_hash`] (`DESIGN.md` §5.1): a record's
/// size alone would let a reorder slip through, and a guest reads these fields by
/// number. Folding them in moved the hash once, when this round did it; from
/// here on a reorder breaks the hash, which is the point.
pub const EVENT_SEQ: usize = 0;
pub const EVENT_CLASS: usize = 8;
pub const EVENT_FLAGS: usize = 12;
pub const EVENT_A: usize = 16;
pub const EVENT_B: usize = 20;
pub const EVENT_F0: usize = 24;
pub const EVENT_F1: usize = 28;

/// `RegionDesc` fields — one entry of the region table at `0x200 + kind * 24`.
pub const REGION_DESC_KIND: usize = 0;
pub const REGION_DESC_FLAGS: usize = 4;
pub const REGION_DESC_OFFSET: usize = 8;
pub const REGION_DESC_SIZE_FIELD: usize = 12;
pub const REGION_DESC_ALIGN: usize = 16;
pub const REGION_DESC_RESERVED: usize = 20;

/// `StringHalf` fields — one half of the `STRING` region's double buffer: where
/// the half starts inside the region, how much of it is written, how much it
/// holds, and its flags.
pub const STRING_HALF_OFFSET: usize = 0;
pub const STRING_HALF_LENGTH: usize = 4;
pub const STRING_HALF_CAPACITY: usize = 8;
pub const STRING_HALF_FLAGS: usize = 12;

/// `Subscription` fields — the transient 16-byte record `session_subscribe`
/// takes (`DESIGN.md` §9). It may live anywhere in guest memory.
pub const SUBSCRIPTION_CLASS: usize = 0;
pub const SUBSCRIPTION_MODE: usize = 4;
pub const SUBSCRIPTION_FLAGS: usize = 8;
pub const SUBSCRIPTION_RESERVED: usize = 12;

/// `FrameState` fields — what the guest reads about the epoch that just ran.
/// The region is 4 KiB; these four words are the part this chunk defines, and
/// the rest is zeroed and reserved.
pub const FRAME_INDEX: usize = 0;
pub const FRAME_DROPPED_EVENTS: usize = 4;
pub const FRAME_FAULT_STATE: usize = 8;
pub const FRAME_LAST_ERROR: usize = 12;
/// Where the defined part of `FrameState` ends.
pub const FRAME_STATE_HEADER: usize = 64;

/// `Callbacks` fields — the two-slot record a guest registers at open. The
/// record's size is in the manifest (`CALLBACKS_SIZE`); these are its field
/// offsets. They are deliberately not part of [`layout_hash`], which covers the
/// field offsets of the control block, `SessionInfo` and the ring header only.
pub const CALLBACKS_ABI_VERSION: usize = 0;
pub const CALLBACKS_SLOT_COUNT: usize = 2;
pub const CALLBACKS_FLAGS: usize = 4;
pub const CALLBACKS_ON_BATCH: usize = 8;
pub const CALLBACKS_ON_EVENT: usize = 12;

/// The slots this chunk defines. A record claiming more is refused: a host that
/// cannot validate a signature must not accept it.
pub const CALLBACKS_SLOTS: u16 = 2;

/// The ten class ids, by name (`DESIGN.md` §3.2). The order is the delivery
/// priority — urgent first — and it is frozen: a class id is a subscription key
/// and a wire value.
pub const CLASS_DEVICE_LOST: u32 = 0;
pub const CLASS_JOB_FAILED: u32 = 1;
pub const CLASS_RESOURCE_FAILED: u32 = 2;
/// A deferred submission that was accepted in a callback and failed when it was
/// applied. Always delivered, never opt-in.
pub const CLASS_SUBMISSION_REJECTED: u32 = 3;
pub const CLASS_JOB_DONE: u32 = 4;
pub const CLASS_RESOURCE_READY: u32 = 5;
pub const CLASS_INPUT_KEY: u32 = 6;
pub const CLASS_INPUT_MOUSE: u32 = 7;
pub const CLASS_LOG: u32 = 8;
pub const CLASS_FRAME: u32 = 9;

/// The ten classes as `(id, name)`, in the frozen order — the catalogue the ids
/// above name, in one place. `DESIGN.md` §3.2 is the prose; this is what code
/// reads when it has to print which class a record belongs to.
pub const CLASSES: [(u32, &str); CLASS_COUNT] = [
    (CLASS_DEVICE_LOST, "DEVICE_LOST"),
    (CLASS_JOB_FAILED, "JOB_FAILED"),
    (CLASS_RESOURCE_FAILED, "RESOURCE_FAILED"),
    (CLASS_SUBMISSION_REJECTED, "SUBMISSION_REJECTED"),
    (CLASS_JOB_DONE, "JOB_DONE"),
    (CLASS_RESOURCE_READY, "RESOURCE_READY"),
    (CLASS_INPUT_KEY, "INPUT_KEY"),
    (CLASS_INPUT_MOUSE, "INPUT_MOUSE"),
    (CLASS_LOG, "LOG"),
    (CLASS_FRAME, "FRAME"),
];

/// A class's name, or `"<unknown>"` for an id this chunk does not define.
pub fn class_name(id: u32) -> &'static str {
    CLASSES
        .iter()
        .find(|(class, _)| *class == id)
        .map(|(_, name)| *name)
        .unwrap_or("<unknown>")
}

/// The default ring capacity per class, in class-id order (`DESIGN.md` §3.2).
pub const DEFAULT_RING_CAPACITIES: [u32; CLASS_COUNT] =
    [1, 256, 256, 64, 4096, 4096, 256, 64, 1024, 256];

/// The default delivery mode per class, in class-id order (`DESIGN.md` §3.2).
///
/// Deliberately **not** part of [`layout_hash`]: the mode is policy that crosses
/// the ABI as `class_info`'s answer and as a `Subscription`'s field, whose
/// *values* (1–4) are already hashed. A class may be re-moded without the arena
/// changing shape — the same reasoning as `DEFAULT_MAX_ARENA_SIZE`.
pub const DEFAULT_CLASS_MODES: [u32; CLASS_COUNT] = [
    MODE_DIRECT,   // 0 DEVICE_LOST
    MODE_DIRECT,   // 1 JOB_FAILED
    MODE_DIRECT,   // 2 RESOURCE_FAILED
    MODE_DIRECT,   // 3 SUBMISSION_REJECTED — always delivered
    MODE_BATCHED,  // 4 JOB_DONE
    MODE_BATCHED,  // 5 RESOURCE_READY
    MODE_BATCHED,  // 6 INPUT_KEY
    MODE_BATCHED,  // 7 INPUT_MOUSE
    MODE_BATCHED,  // 8 LOG
    MODE_POLLED,   // 9 FRAME — off unless subscribed
];

/// `class_info`'s `flags` word: the class is subscribed, so a producer that can
/// skip work nobody asked for should keep producing.
///
/// The frozen header documents the parameter ("so a producer can skip
/// generating events nobody subscribed to") but names no constant for it —
/// which is why this bit is defined here and reported rather than assumed to be
/// in the ABI. A v2 header adding `TENSION_CLASS_SUBSCRIBED` would name the same
/// bit; nothing in the wire depends on the number beyond this byte.
pub const CLASS_FLAG_SUBSCRIBED: u32 = 1 << 0;

// ── region kinds ──────────────────────────────────────────────────────────

/// Region descriptor `flags` bits.
pub const RD_GUEST_WRITES: u32 = 1 << 0;pub const RD_SESSION_WRITES: u32 = 1 << 1;
pub const RD_WRITES_ONCE: u32 = 1 << 2;
pub const RD_BYTES: u32 = 1 << 3;

/// The twelve region kinds, in the frozen order (`kind == index`). These are the
/// values `tension_adapter.h`'s `TENSION_REGION_*` constants carry, and the ones
/// `region_lookup` answers for.
///
/// The bin build reads kinds as numbers (the required-region check), and names
/// them through [`region_name`], so nothing but the tests reads these constants
/// today. They carry the A2a-style annotation rather than being deleted: they
/// are the frozen ABI's naming, and the layout test pins them to this order.
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_CONTROL: u32 = 0;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_SESSION_INFO: u32 = 1;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_FRAME_STATE: u32 = 2;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_JOB: u32 = 3;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_RESOURCE: u32 = 4;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_EVENT_TABLE: u32 = 5;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_STRING: u32 = 6;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_RESOURCE_REQ: u32 = 7;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_SCENE: u32 = 8;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_MATERIAL: u32 = 9;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_RENDERABLE: u32 = 10;
#[cfg_attr(not(test), allow(dead_code))]
pub const REGION_BUFFER_POOL: u32 = 11;

/// The kind's name, for diagnostics only — it is not part of the wire, not in
/// the manifest, and not an input to [`layout_hash`]. A refusal that names `JOB`
/// is worth more than one that names `3`; nothing else reads this table.
pub const REGION_NAMES: [&str; REGION_COUNT] = [
    "CONTROL",
    "SESSION_INFO",
    "FRAME_STATE",
    "JOB",
    "RESOURCE",
    "EVENT_TABLE",
    "STRING",
    "RESOURCE_REQ",
    "SCENE",
    "MATERIAL",
    "RENDERABLE",
    "BUFFER_POOL",
];

/// The name of a region kind, or `"<unknown>"` for a kind this layout does not
/// define. The unknown arm is the only caller that can see it: `region_lookup`
/// answers `-ENOENT` for such a kind, and the required-region check refuses it.
pub fn region_name(kind: u32) -> &'static str {
    REGION_NAMES.get(kind as usize).copied().unwrap_or("<unknown>")
}

/// Region sizes. Every one is a multiple of 16, which is what keeps the band's
/// offsets aligned without per-region padding arithmetic.
pub const FRAME_STATE_SIZE: usize = 4 * 1024;
pub const JOB_SIZE: usize = 48 * 1024;
pub const RESOURCE_SIZE: usize = 48 * 1024;
pub const EVENT_TABLE_SIZE: usize = 384 * 1024;
pub const STRING_HALF_SIZE: usize = 16;
pub const STRING_SIZE: usize = 1024 * 1024 + 2 * STRING_HALF_SIZE;
pub const RESOURCE_REQ_SIZE: usize = 48 * 1024;
pub const SCENE_SIZE: usize = 256 * 1024;
pub const MATERIAL_SIZE: usize = 64 * 1024;
pub const RENDERABLE_SIZE: usize = 128 * 1024;
pub const BUFFER_POOL_SIZE: usize = 4 * 1024 * 1024;

// The band, in kind order, from the frozen sizes above.
pub const FRAME_STATE_OFFSET: usize = HEADER_PAGE_SIZE;
pub const JOB_OFFSET: usize = FRAME_STATE_OFFSET + FRAME_STATE_SIZE;
pub const RESOURCE_OFFSET: usize = JOB_OFFSET + JOB_SIZE;
pub const EVENT_TABLE_OFFSET: usize = RESOURCE_OFFSET + RESOURCE_SIZE;
pub const STRING_OFFSET: usize = EVENT_TABLE_OFFSET + EVENT_TABLE_SIZE;
pub const RESOURCE_REQ_OFFSET: usize = STRING_OFFSET + STRING_SIZE;
pub const SCENE_OFFSET: usize = RESOURCE_REQ_OFFSET + RESOURCE_REQ_SIZE;
pub const MATERIAL_OFFSET: usize = SCENE_OFFSET + SCENE_SIZE;
pub const RENDERABLE_OFFSET: usize = MATERIAL_OFFSET + MATERIAL_SIZE;
pub const BUFFER_POOL_OFFSET: usize = RENDERABLE_OFFSET + RENDERABLE_SIZE;

/// One past the last byte the frozen layout uses: an `arena_size` below this is
/// refused (C4), and the reserved gap runs from here to `max_arena_size`.
pub const LAYOUT_FLOOR: usize = BUFFER_POOL_OFFSET + BUFFER_POOL_SIZE;

/// The default reserved ceiling, and therefore the default `memoryBase`:
/// `DESIGN.md` §5.2 sizes the frozen layout at ~5.96 MiB *inside* an 8 MiB
/// ceiling. This is a configuration default, not a shape fact, so it is
/// deliberately not part of [`layout_hash`] — a session may run with a
/// different ceiling and the same layout.
pub const DEFAULT_MAX_ARENA_SIZE: usize = 8 * 1024 * 1024;

/// One region's descriptor: exactly the 24 bytes the guest reads at
/// `0x200 + kind * 24`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct RegionDesc {
    pub kind: u32,
    pub flags: u32,
    pub offset: u32,
    pub size: u32,
    pub align: u32,
}

/// The frozen region table, in kind order. `kind == index` is the lookup.
pub const REGIONS: [RegionDesc; REGION_COUNT] = [
    RegionDesc { kind: 0, flags: RD_SESSION_WRITES | RD_WRITES_ONCE, offset: CONTROL_OFFSET as u32, size: CONTROL_SIZE as u32, align: 64 },
    RegionDesc { kind: 1, flags: RD_SESSION_WRITES | RD_WRITES_ONCE, offset: SESSION_INFO_OFFSET as u32, size: SESSION_INFO_SIZE as u32, align: 16 },
    RegionDesc { kind: 2, flags: RD_SESSION_WRITES, offset: FRAME_STATE_OFFSET as u32, size: FRAME_STATE_SIZE as u32, align: 16 },
    RegionDesc { kind: 3, flags: RD_SESSION_WRITES, offset: JOB_OFFSET as u32, size: JOB_SIZE as u32, align: 16 },
    RegionDesc { kind: 4, flags: RD_SESSION_WRITES, offset: RESOURCE_OFFSET as u32, size: RESOURCE_SIZE as u32, align: 16 },
    RegionDesc { kind: 5, flags: RD_SESSION_WRITES, offset: EVENT_TABLE_OFFSET as u32, size: EVENT_TABLE_SIZE as u32, align: 16 },
    RegionDesc { kind: 6, flags: RD_GUEST_WRITES | RD_SESSION_WRITES, offset: STRING_OFFSET as u32, size: STRING_SIZE as u32, align: 16 },
    RegionDesc { kind: 7, flags: RD_GUEST_WRITES, offset: RESOURCE_REQ_OFFSET as u32, size: RESOURCE_REQ_SIZE as u32, align: 16 },
    RegionDesc { kind: 8, flags: RD_GUEST_WRITES, offset: SCENE_OFFSET as u32, size: SCENE_SIZE as u32, align: 16 },
    RegionDesc { kind: 9, flags: RD_GUEST_WRITES, offset: MATERIAL_OFFSET as u32, size: MATERIAL_SIZE as u32, align: 16 },
    RegionDesc { kind: 10, flags: RD_GUEST_WRITES, offset: RENDERABLE_OFFSET as u32, size: RENDERABLE_SIZE as u32, align: 16 },
    RegionDesc { kind: 11, flags: RD_GUEST_WRITES | RD_BYTES, offset: BUFFER_POOL_OFFSET as u32, size: BUFFER_POOL_SIZE as u32, align: 16 },
];

// ── the manifest: the protocol type catalogue ─────────────────────────────
/// One manifest entry: `{ typeId: u16, size: u16, align: u16, pad: u16 }`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct TypeEntry {
    pub id: u16,
    pub size: u16,
    pub align: u16,
}

/// The protocol types whose sizes and alignments this chunk fixes. Capability
/// records (the OGRE catalogue) join this table only when their shapes are
/// pinned; adding an entry is a schema change, because it moves the hash.
pub const TYPES: [TypeEntry; 9] = [
    TypeEntry { id: 1, size: CONTROL_SIZE as u16, align: 8 },
    TypeEntry { id: 2, size: SESSION_INFO_SIZE as u16, align: 8 },
    TypeEntry { id: 3, size: REGION_DESC_SIZE as u16, align: 4 },
    TypeEntry { id: 4, size: MANIFEST_ENTRY_SIZE as u16, align: 2 },
    TypeEntry { id: 5, size: RING_HEADER_SIZE as u16, align: 8 },
    TypeEntry { id: 6, size: STRING_HALF_SIZE as u16, align: 4 },
    TypeEntry { id: 7, size: 64, align: 4 },
    TypeEntry { id: 8, size: 16, align: 4 },
    TypeEntry { id: 9, size: EVENT_RECORD_SIZE as u16, align: 4 },
];

pub const TYPE_COUNT: usize = TYPES.len();
pub const MANIFEST_LEN: usize = TYPE_COUNT * MANIFEST_ENTRY_SIZE;

/// The `Callbacks` record's size, as the manifest pins it. `callbacks_len` in
/// the open TLV must equal this.
pub const CALLBACKS_SIZE: usize = 64;

// ── the canary lattice ────────────────────────────────────────────────────

/// The stride between canary blocks.
pub const CANARY_STRIDE: usize = 4 * 1024;
/// The bytes each block occupies: a value and its complement.
pub const CANARY_BLOCK: usize = 16;
/// The constant a block's value is folded with, so a shifted write is not
/// accidentally correct.
pub const CANARY_MAGIC: u64 = 0x9E37_79B9_7F4A_7C15;

// ── errors ────────────────────────────────────────────────────────────────

/// A layout write that cannot be performed. Every variant names the numbers, so
/// a failure is diagnosable without a debugger.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum LayoutError {
    /// The arena slice is smaller than the write needs.
    BufferTooSmall { need: usize, have: usize },
    /// A write would land at an offset that is not a multiple of its alignment.
    Misaligned { offset: usize, align: usize },
}

// ── primitive writes ──────────────────────────────────────────────────────

/// The whole-structure bounds check every writer starts with: a structure is
/// written whole or not at all, so a short buffer is refused before any field
/// lands in it.
fn require(arena: &[u8], need: usize) -> Result<(), LayoutError> {
    if arena.len() < need {
        return Err(LayoutError::BufferTooSmall { need, have: arena.len() });
    }
    Ok(())
}

fn put_u16(arena: &mut [u8], at: usize, value: u16) -> Result<(), LayoutError> {
    let end = at + 2;
    if end > arena.len() {
        return Err(LayoutError::BufferTooSmall { need: end, have: arena.len() });
    }
    arena[at..end].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn put_u32(arena: &mut [u8], at: usize, value: u32) -> Result<(), LayoutError> {
    let end = at + 4;
    if end > arena.len() {
        return Err(LayoutError::BufferTooSmall { need: end, have: arena.len() });
    }
    if at % 4 != 0 {
        return Err(LayoutError::Misaligned { offset: at, align: 4 });
    }
    arena[at..end].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn put_u64(arena: &mut [u8], at: usize, value: u64) -> Result<(), LayoutError> {
    let end = at + 8;
    if end > arena.len() {
        return Err(LayoutError::BufferTooSmall { need: end, have: arena.len() });
    }
    if at % 8 != 0 {
        return Err(LayoutError::Misaligned { offset: at, align: 8 });
    }
    arena[at..end].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn u32_at(arena: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(arena[at..at + 4].try_into().expect("four bytes"))
}

// ── writers ───────────────────────────────────────────────────────────────

/// Write the arena control block. `total_size` is the reserved band
/// (`max_arena_size`); the session writes it provisionally before instantiation
/// and finalizes it at `session_open`, once the TLV has been read. The
/// session-owned tail (state, fault code, nonce) is left zeroed — `UNINIT` is
/// the correct report until an open succeeds.
pub fn write_control_block(arena: &mut [u8], total_size: u32) -> Result<(), LayoutError> {
    require(arena, CONTROL_OFFSET + CONTROL_SIZE)?;
    put_u64(arena, CONTROL_OFFSET + CONTROL_MAGIC, MAGIC)?;
    put_u16(arena, CONTROL_OFFSET + CONTROL_FORMAT_VERSION, FORMAT_VERSION)?;
    put_u16(arena, CONTROL_OFFSET + CONTROL_SCHEMA_VERSION, SCHEMA_VERSION)?;
    put_u16(arena, CONTROL_OFFSET + CONTROL_ABI_VERSION, ABI_VERSION)?;
    put_u16(arena, CONTROL_OFFSET + CONTROL_FLAGS, 0)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_TOTAL_SIZE, total_size)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_LAYOUT_HASH, layout_hash())?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_REGION_COUNT, REGION_COUNT as u32)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_REGION_TABLE_OFF, REGION_TABLE_OFFSET as u32)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_MANIFEST_OFF, MANIFEST_OFFSET as u32)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_MANIFEST_LEN, MANIFEST_LEN as u32)?;
    Ok(())
}

/// Everything `session_open` knows and the guest may want to cross-check. The
/// page counts are the memory's, the sizes are the arena's.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct SessionInfoValues {
    pub arena_size: u32,
    pub max_arena_size: u32,
    pub memory_base: u32,
    pub initial_pages: u32,
    pub max_pages: u32,
    pub open_nonce: u64,
    pub class_capacities: [u32; CLASS_COUNT],
}

/// Write `SessionInfo`. The session echoes its constants here so a guest can
/// assert its own build against them — the cheapest drift detector there is.
pub fn write_session_info(
    arena: &mut [u8],
    values: &SessionInfoValues,
) -> Result<(), LayoutError> {
    require(arena, SESSION_INFO_OFFSET + SESSION_INFO_SIZE)?;
    put_u64(arena, SESSION_INFO_OFFSET + SESSION_INFO_MAGIC, MAGIC)?;
    put_u16(arena, SESSION_INFO_OFFSET + SESSION_INFO_ABI_VERSION, ABI_VERSION)?;
    put_u16(arena, SESSION_INFO_OFFSET + SESSION_INFO_SCHEMA_VERSION, SCHEMA_VERSION)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_FLAGS, 0)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_ARENA_SIZE, values.arena_size)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_MAX_ARENA_SIZE, values.max_arena_size)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_MEMORY_BASE, values.memory_base)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_INITIAL_PAGES, values.initial_pages)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_MAX_PAGES, values.max_pages)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_LAYOUT_HASH, layout_hash())?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_REGION_COUNT, REGION_COUNT as u32)?;
    put_u32(arena, SESSION_INFO_OFFSET + SESSION_INFO_CLASS_COUNT, CLASS_COUNT as u32)?;
    for (index, capacity) in values.class_capacities.iter().enumerate() {
        put_u32(
            arena,
            SESSION_INFO_OFFSET + SESSION_INFO_CLASS_CAPACITY + index * 4,
            *capacity,
        )?;
    }
    put_u64(arena, SESSION_INFO_OFFSET + SESSION_INFO_OPEN_NONCE, values.open_nonce)?;
    Ok(())
}

/// Write the region table — the guest reads it at `0x200 + kind * 24`, and the
/// `kind` field is written equal to its index so the SDK can assert the
/// arithmetic once at startup.
pub fn write_region_table(arena: &mut [u8]) -> Result<(), LayoutError> {
    require(arena, REGION_TABLE_OFFSET + REGION_COUNT * REGION_DESC_SIZE)?;
    for (index, region) in REGIONS.iter().enumerate() {
        let at = REGION_TABLE_OFFSET + index * REGION_DESC_SIZE;
        debug_assert_eq!(region.kind as usize, index);
        // The same constants `REGION_DESC_FIELDS` hashes, so the writer and the
        // fingerprint cannot disagree about where a field is.
        put_u32(arena, at + REGION_DESC_KIND, region.kind)?;
        put_u32(arena, at + REGION_DESC_FLAGS, region.flags)?;
        put_u32(arena, at + REGION_DESC_OFFSET, region.offset)?;
        put_u32(arena, at + REGION_DESC_SIZE_FIELD, region.size)?;
        put_u32(arena, at + REGION_DESC_ALIGN, region.align)?;
        put_u32(arena, at + REGION_DESC_RESERVED, 0)?;
    }
    Ok(())
}

/// Write the manifest. `pad` stays zero: the format is fixed and the reader is
/// strict, so a future field earns a new entry rather than a repurposed one.
pub fn write_manifest(arena: &mut [u8]) -> Result<(), LayoutError> {
    require(arena, MANIFEST_OFFSET + MANIFEST_LEN)?;
    for (index, entry) in TYPES.iter().enumerate() {
        let at = MANIFEST_OFFSET + index * MANIFEST_ENTRY_SIZE;
        put_u16(arena, at, entry.id)?;
        put_u16(arena, at + 2, entry.size)?;
        put_u16(arena, at + 4, entry.align)?;
        put_u16(arena, at + 6, 0)?;
    }
    Ok(())
}

/// One sub-ring's header, as the session writes it at open and reads it back
/// during delivery.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct RingHeader {
    pub head: u32,
    pub tail: u32,
    pub capacity: u32,
    pub stride: u32,
    pub generation: u32,
    pub dropped: u32,
    pub delivered: u64,
}

/// Write one class's ring header: empty, with the class's capacity and the
/// record stride. `head` and `tail` are the producer's and the consumer's
/// monotonic counters (`DESIGN.md` §3.3); a session that opens again rewrites
/// the header rather than carrying counters over, because an open is a fresh
/// session.
///
/// A zero capacity is refused by the config layer before this is reached
/// (`config::check_ring_capacities`); this function does not re-litigate it.
pub fn write_ring_header(
    arena: &mut [u8],
    ring_offset: usize,
    capacity: u32,
) -> Result<(), LayoutError> {
    require(arena, ring_offset + RING_HEADER_SIZE)?;
    put_u32(arena, ring_offset + TABLE_HEAD, 0)?;
    put_u32(arena, ring_offset + TABLE_TAIL, 0)?;
    put_u32(arena, ring_offset + TABLE_CAPACITY, capacity)?;
    put_u32(arena, ring_offset + TABLE_STRIDE, EVENT_RECORD_SIZE as u32)?;
    put_u32(arena, ring_offset + TABLE_GENERATION, 0)?;
    put_u32(arena, ring_offset + TABLE_DROPPED, 0)?;
    put_u64(arena, ring_offset + TABLE_DELIVERED, 0)?;
    Ok(())
}

/// Set a sub-ring's `head` — how many records it holds. The session owns this
/// one; it moves it by one per append and rebases it on compaction.
pub fn set_ring_head(arena: &mut [u8], ring_offset: usize, value: u32) -> Result<(), LayoutError> {
    put_u32(arena, ring_offset + TABLE_HEAD, value)
}

/// Set a sub-ring's `tail` — the guest's reclaim counter.
///
/// Called by `subring::compact_subring` and nowhere else: the tail is the
/// guest's to advance, and the only reason the session ever writes it is to
/// zero it when it has just consumed the reclaim by sliding records down.
/// A guest learns that happened from `generation`.
pub fn set_ring_tail(arena: &mut [u8], ring_offset: usize, value: u32) -> Result<(), LayoutError> {
    put_u32(arena, ring_offset + TABLE_TAIL, value)
}

/// Set a sub-ring's `dropped` counter — the mirror the publish phase writes
/// (`DESIGN.md` §3.4). The authoritative value is the host-side queue's.
pub fn set_ring_dropped(arena: &mut [u8], ring_offset: usize, value: u32) -> Result<(), LayoutError> {
    put_u32(arena, ring_offset + TABLE_DROPPED, value)
}

/// Set a sub-ring's `delivered` counter — the other half of the same mirror.
pub fn set_ring_delivered(arena: &mut [u8], ring_offset: usize, value: u32) -> Result<(), LayoutError> {
    put_u32(arena, ring_offset + TABLE_DELIVERED, value)
}

/// The `Subscription` record's size, as the manifest pins it (type 8).
pub const SUBSCRIPTION_SIZE: usize = 16;

/// Set a sub-ring's `generation` — bumped once per compaction, so a guest can
/// tell a rebase from a steady state.
pub fn set_ring_generation(
    arena: &mut [u8],
    ring_offset: usize,
    value: u32,
) -> Result<(), LayoutError> {
    put_u32(arena, ring_offset + TABLE_GENERATION, value)
}

/// Set a sub-ring's `capacity`. Only `session_open` does this legitimately; it
/// exists as a named write so a test can forge a mismatch and prove the session
/// refuses an arena it did not write.
#[cfg_attr(not(test), allow(dead_code))] // test-facing readers and writers: the sub-ring and epoch tests build arenas by hand and read them back with these
pub fn set_ring_capacity(
    arena: &mut [u8],
    ring_offset: usize,
    value: u32,
) -> Result<(), LayoutError> {
    put_u32(arena, ring_offset + TABLE_CAPACITY, value)
}

/// Read one class's ring header.
pub fn ring_header(arena: &[u8], ring_offset: usize) -> RingHeader {
    let word = |offset: usize| {
        u32::from_le_bytes(
            arena[ring_offset + offset..ring_offset + offset + 4]
                .try_into()
                .expect("four bytes"),
        )
    };
    RingHeader {
        head: word(TABLE_HEAD),
        tail: word(TABLE_TAIL),
        capacity: word(TABLE_CAPACITY),
        stride: word(TABLE_STRIDE),
        generation: word(TABLE_GENERATION),
        dropped: word(TABLE_DROPPED),
        delivered: u64::from_le_bytes(
            arena[ring_offset + TABLE_DELIVERED..ring_offset + TABLE_DELIVERED + 8]
                .try_into()
                .expect("eight bytes"),
        ),
    }
}

/// The `Callbacks` record as the guest writes it into its own heap.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct CallbacksRecord {
    pub abi_version: u16,
    pub slot_count: u16,
    pub flags: u32,
    pub on_batch: u32,
    pub on_event: u32,
}

impl CallbacksRecord {
    /// The record a guest that registers nothing is not obliged to write: every
    /// slot absent, at this build's ABI version. `callbacks_len = 0` in the
    /// config means exactly this record (`DESIGN.md` §6.1, §8) — the limit case
    /// of "every slot is optional", which is why the open's validation and
    /// resolution paths need no special case beyond not reading anything.
    pub const fn absent() -> CallbacksRecord {
        CallbacksRecord {
            abi_version: ABI_VERSION,
            slot_count: 0,
            flags: 0,
            on_batch: 0,
            on_event: 0,
        }
    }
}

/// A `Subscription` record as the guest writes it (`DESIGN.md` §9).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub class: u32,
    pub mode: u32,
    pub flags: u32,
    pub reserved: u32,
}

/// Read a `Subscription` at `at` — an absolute arena or guest-memory offset,
/// whose bounds the caller has already checked (the record is transient: it may
/// live anywhere the guest chose).
pub fn read_subscription(arena: &[u8], at: usize) -> Subscription {
    let word = |offset: usize| {
        u32::from_le_bytes(
            arena[at + offset..at + offset + 4].try_into().expect("four bytes"),
        )
    };
    Subscription {
        class: word(SUBSCRIPTION_CLASS),
        mode: word(SUBSCRIPTION_MODE),
        flags: word(SUBSCRIPTION_FLAGS),
        reserved: word(SUBSCRIPTION_RESERVED),
    }
}

/// The `FrameState` words this chunk defines.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct FrameStateValues {
    /// The session's own epoch counter — not the renderer's frame counter.
    pub frame_index: u32,
    /// The cross-class rollup of dropped events, cumulative.
    pub dropped_events: u32,
    /// `FAULT_*`, or 0 when nothing is wrong.
    pub fault_state: u32,
    /// The slot index a callback trap came from, or 0.
    pub last_error: u32,
}

/// Write the defined part of `FrameState`, zeroing the rest of its header.
pub fn write_frame_state(
    arena: &mut [u8],
    values: &FrameStateValues,
) -> Result<(), LayoutError> {
    require(arena, FRAME_STATE_OFFSET + FRAME_STATE_HEADER)?;
    put_u32(arena, FRAME_STATE_OFFSET + FRAME_INDEX, values.frame_index)?;
    put_u32(
        arena,
        FRAME_STATE_OFFSET + FRAME_DROPPED_EVENTS,
        values.dropped_events,
    )?;
    put_u32(
        arena,
        FRAME_STATE_OFFSET + FRAME_FAULT_STATE,
        values.fault_state,
    )?;
    put_u32(arena, FRAME_STATE_OFFSET + FRAME_LAST_ERROR, values.last_error)?;
    for offset in (16..FRAME_STATE_HEADER).step_by(4) {
        put_u32(arena, FRAME_STATE_OFFSET + offset, 0)?;
    }
    Ok(())
}

/// Read the defined part of `FrameState` back.
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_frame_state(arena: &[u8]) -> FrameStateValues {
    let word = |offset: usize| {
        let at = FRAME_STATE_OFFSET + offset;
        u32::from_le_bytes(arena[at..at + 4].try_into().expect("four bytes"))
    };
    FrameStateValues {
        frame_index: word(FRAME_INDEX),
        dropped_events: word(FRAME_DROPPED_EVENTS),
        fault_state: word(FRAME_FAULT_STATE),
        last_error: word(FRAME_LAST_ERROR),
    }
}

/// One `EventRecord` as it sits in a sub-ring: 32 bytes, the stride every
/// `TableHeader` states. The session writes these; the guest reads them by
/// field offset (`EVENT_SEQ` … `EVENT_F1`).
///
/// `class` is written from the sub-ring the record landed in — the queue it
/// came from — rather than carried through the post, so a record can never
/// claim a class its storage does not agree with.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct EventRecord {
    pub seq: u64,
    pub class: u32,
    pub flags: u32,
    pub a: u32,
    pub b: u32,
    pub f0: f32,
    pub f1: f32,
}

/// Write one `EventRecord` at `at` (an absolute arena offset).
pub fn write_event_record(
    arena: &mut [u8],
    at: usize,
    record: &EventRecord,
) -> Result<(), LayoutError> {
    require(arena, at + EVENT_RECORD_SIZE)?;
    put_u64(arena, at + EVENT_SEQ, record.seq)?;
    put_u32(arena, at + EVENT_CLASS, record.class)?;
    put_u32(arena, at + EVENT_FLAGS, record.flags)?;
    put_u32(arena, at + EVENT_A, record.a)?;
    put_u32(arena, at + EVENT_B, record.b)?;
    put_u32(arena, at + EVENT_F0, record.f0.to_bits())?;
    put_u32(arena, at + EVENT_F1, record.f1.to_bits())?;
    Ok(())
}

/// Read one `EventRecord` at `at` (an absolute arena offset).
///
/// The floats come back as the bits that were written: a NaN payload is not
/// canonicalised on its way through, which is what makes a round-trip a
/// comparison rather than a tolerance.
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_event_record(arena: &[u8], at: usize) -> EventRecord {
    let word = |offset: usize| {
        u32::from_le_bytes(
            arena[at + offset..at + offset + 4].try_into().expect("four bytes"),
        )
    };
    EventRecord {
        seq: u64::from_le_bytes(
            arena[at + EVENT_SEQ..at + EVENT_SEQ + 8]
                .try_into()
                .expect("eight bytes"),
        ),
        class: word(EVENT_CLASS),
        flags: word(EVENT_FLAGS),
        a: word(EVENT_A),
        b: word(EVENT_B),
        f0: f32::from_bits(word(EVENT_F0)),
        f1: f32::from_bits(word(EVENT_F1)),
    }
}

/// Read a `Callbacks` record at `at` — an offset in the memory, whose bounds
/// the caller has already checked.
pub fn read_callbacks(arena: &[u8], at: usize) -> CallbacksRecord {
    let word = |offset: usize| {
        u32::from_le_bytes(
            arena[at + offset..at + offset + 4].try_into().expect("four bytes"),
        )
    };
    CallbacksRecord {
        abi_version: u16::from_le_bytes(
            arena[at + CALLBACKS_ABI_VERSION..at + CALLBACKS_ABI_VERSION + 2]
                .try_into()
                .expect("two bytes"),
        ),
        slot_count: u16::from_le_bytes(
            arena[at + CALLBACKS_SLOT_COUNT..at + CALLBACKS_SLOT_COUNT + 2]
                .try_into()
                .expect("two bytes"),
        ),
        flags: word(CALLBACKS_FLAGS),
        on_batch: word(CALLBACKS_ON_BATCH),
        on_event: word(CALLBACKS_ON_EVENT),
    }
}

// ── the reserved gap's belt and braces ────────────────────────────────────

/// The value a canary block carries for a given offset.
fn canary_word(offset: usize) -> u64 {
    (offset as u64) ^ CANARY_MAGIC
}

/// The two 8-byte words a canary block at `offset` must hold, so a caller can
/// report what it expected beside what it found. The offsets are exactly the
/// ones [`verify_canary_lattice`] reports on a mismatch.
pub fn canary_expected(offset: usize) -> (u64, u64) {
    let word = canary_word(offset);
    (word, !word)
}

/// Write the canary lattice over `[start, end)`: one 16-byte block every
/// [`CANARY_STRIDE`], each carrying `(offset ^ CANARY_MAGIC)` and its
/// complement.
///
/// The range is a parameter because the lattice is only valid over memory
/// nobody writes legitimately — the reserved gap between the layout's end and
/// `memory_base`. It must **not** cover the header page or the region band: the
/// session writes those itself, and a lattice there would report the session's
/// own work as corruption.
pub fn write_canary_lattice(
    arena: &mut [u8],
    start: usize,
    end: usize,
) -> Result<(), LayoutError> {
    if end > arena.len() {
        return Err(LayoutError::BufferTooSmall { need: end, have: arena.len() });
    }
    let mut at = start;
    while at + CANARY_BLOCK <= end {
        let word = canary_word(at);
        put_u64(arena, at, word)?;
        put_u64(arena, at + 8, !word)?;
        at += CANARY_STRIDE;
    }
    Ok(())
}

/// Verify the lattice over `[start, end)`. `Err(offset)` names the first block
/// whose bytes are not what [`write_canary_lattice`] wrote.
pub fn verify_canary_lattice(arena: &[u8], start: usize, end: usize) -> Result<(), usize> {
    let end = end.min(arena.len());
    let mut at = start;
    while at + CANARY_BLOCK <= end {
        let word = canary_word(at);
        let found = u64::from_le_bytes(arena[at..at + 8].try_into().expect("eight bytes"));
        let complement =
            u64::from_le_bytes(arena[at + 8..at + 16].try_into().expect("eight bytes"));
        if found != word || complement != !word {
            return Err(at);
        }
        at += CANARY_STRIDE;
    }
    Ok(())
}

/// Zero `[start, end)`. The session zeroes the whole band the module claims
/// before instantiation, which is what turns "is the band still zero" into a
/// complete test for a guest data segment landing in the arena.
pub fn zero_band(arena: &mut [u8], start: usize, end: usize) -> Result<(), LayoutError> {
    if end > arena.len() {
        return Err(LayoutError::BufferTooSmall { need: end, have: arena.len() });
    }
    arena[start..end].fill(0);
    Ok(())
}

/// Verify `[start, end)` is all zero. `Err(offset)` names the first byte that
/// is not.
pub fn verify_band_is_zero(arena: &[u8], start: usize, end: usize) -> Result<(), usize> {
    let end = end.min(arena.len());
    match arena[start..end].iter().position(|byte| *byte != 0) {
        Some(index) => Err(start + index),
        None => Ok(()),
    }
}

// ── the shape hash ────────────────────────────────────────────────────────

/// The layout hash: FNV-1a over a canonical byte stream covering everything
/// whose change would silently corrupt a guest — the region table (kind, flags,
/// size, alignment, and the derived offsets), the type catalogue (id, size,
/// alignment), the field offsets of the control block, `SessionInfo` and the
/// ring header, and the scalar constants that decide how a word is read.
///
/// It deliberately does **not** cover the guest's chosen `arena_size`, the
/// region offsets as such, or anything else that varies per run: those are
/// validated structurally at open (`DESIGN.md` §5.3). Hashing shape only means
/// a legitimate configuration cannot be refused for looking different.
pub fn layout_hash() -> u32 {
    let mut h = Fnv(0x811C_9DC5);

    // Header geometry.
    h.u32(REGION_COUNT as u32);
    h.u32(REGION_DESC_SIZE as u32);
    h.u32(MANIFEST_ENTRY_SIZE as u32);
    h.u32(TYPE_COUNT as u32);
    h.u32(HEADER_PAGE_SIZE as u32);
    h.u32(CONTROL_OFFSET as u32);
    h.u32(CONTROL_SIZE as u32);
    h.u32(SESSION_INFO_OFFSET as u32);
    h.u32(SESSION_INFO_SIZE as u32);
    h.u32(REGION_TABLE_OFFSET as u32);
    h.u32(MANIFEST_OFFSET as u32);
    h.u32(LAYOUT_FLOOR as u32);

    // The region table, in kind order.
    for region in REGIONS.iter() {
        h.u32(region.kind);
        h.u32(region.flags);
        h.u32(region.size);
        h.u32(region.align);
    }

    // The type catalogue, in id order.
    for entry in TYPES.iter() {
        h.u32(entry.id as u32);
        h.u32(entry.size as u32);
        h.u32(entry.align as u32);
    }

    // Field offsets that both sides compute against — every record a guest
    // reads by offset (`DESIGN.md` §5.1). The *name* is hashed beside the
    // offset, so a rename moves the hash as well as a move does: both change
    // what a compiled guest's constant means.
    for fields in [
        &CONTROL_FIELDS[..],
        &SESSION_INFO_FIELDS[..],
        &TABLE_FIELDS[..],
        &REGION_DESC_FIELDS[..],
        &CALLBACKS_FIELDS[..],
        &EVENT_FIELDS[..],
        &STRING_HALF_FIELDS[..],
        &SUBSCRIPTION_FIELDS[..],
        &FRAME_STATE_FIELDS[..],
    ] {
        for (name, offset) in fields {
            h.bytes(name.as_bytes());
            h.u32(*offset as u32);
        }
    }

    // Scalar constants that decide how a word is read.
    h.u32(CLASS_COUNT as u32);
    h.u32(MODE_DIRECT);
    h.u32(MODE_BATCHED);
    h.u32(MODE_RING);
    h.u32(MODE_POLLED);
    h.u32(STATE_UNINIT);
    h.u32(STATE_READY);
    h.u32(STATE_FAULTED);
    h.u32(STATE_CLOSED);
    h.u32(FAULT_CALLBACK_TRAP);
    h.u32(FAULT_DEVICE_LOST);
    h.u32(FAULT_OOM);
    h.u32(FAULT_SHUTDOWN);
    h.u32(EVENT_RECORD_SIZE as u32);
    h.u32(RING_HEADER_SIZE as u32);
    for capacity in DEFAULT_RING_CAPACITIES.iter() {
        h.u32(*capacity);
    }

    h.0
}

/// The remaining record layouts, name and offset, as the hash sees them. Each
/// pair is the definition of a protocol record this chunk writes and the guest
/// reads; the writers above use the same constants, so a record cannot drift
/// from the hash without one of the two moving.
const REGION_DESC_FIELDS: [(&str, usize); 6] = [
    ("kind", REGION_DESC_KIND),
    ("flags", REGION_DESC_FLAGS),
    ("offset", REGION_DESC_OFFSET),
    ("size", REGION_DESC_SIZE_FIELD),
    ("align", REGION_DESC_ALIGN),
    ("reserved", REGION_DESC_RESERVED),
];

const CALLBACKS_FIELDS: [(&str, usize); 5] = [
    ("abi_version", CALLBACKS_ABI_VERSION),
    ("slot_count", CALLBACKS_SLOT_COUNT),
    ("flags", CALLBACKS_FLAGS),
    ("on_batch", CALLBACKS_ON_BATCH),
    ("on_event", CALLBACKS_ON_EVENT),
];

const EVENT_FIELDS: [(&str, usize); 7] = [
    ("seq", EVENT_SEQ),
    ("class", EVENT_CLASS),
    ("flags", EVENT_FLAGS),
    ("a", EVENT_A),
    ("b", EVENT_B),
    ("f0", EVENT_F0),
    ("f1", EVENT_F1),
];

const STRING_HALF_FIELDS: [(&str, usize); 4] = [
    ("offset", STRING_HALF_OFFSET),
    ("length", STRING_HALF_LENGTH),
    ("capacity", STRING_HALF_CAPACITY),
    ("flags", STRING_HALF_FLAGS),
];

const SUBSCRIPTION_FIELDS: [(&str, usize); 4] = [
    ("class", SUBSCRIPTION_CLASS),
    ("mode", SUBSCRIPTION_MODE),
    ("flags", SUBSCRIPTION_FLAGS),
    ("reserved", SUBSCRIPTION_RESERVED),
];

const FRAME_STATE_FIELDS: [(&str, usize); 4] = [
    ("frame_index", FRAME_INDEX),
    ("dropped_events", FRAME_DROPPED_EVENTS),
    ("fault_state", FRAME_FAULT_STATE),
    ("last_error", FRAME_LAST_ERROR),
];

/// The control block's field offsets, name and offset, as the hash sees them.
const CONTROL_FIELDS: [(&str, usize); 15] = [
    ("magic", CONTROL_MAGIC),
    ("format_version", CONTROL_FORMAT_VERSION),
    ("schema_version", CONTROL_SCHEMA_VERSION),
    ("abi_version", CONTROL_ABI_VERSION),
    ("flags", CONTROL_FLAGS),
    ("total_size", CONTROL_TOTAL_SIZE),
    ("layout_hash", CONTROL_LAYOUT_HASH),
    ("region_count", CONTROL_REGION_COUNT),
    ("region_table_off", CONTROL_REGION_TABLE_OFF),
    ("manifest_off", CONTROL_MANIFEST_OFF),
    ("manifest_len", CONTROL_MANIFEST_LEN),
    ("state", CONTROL_STATE),
    ("fault_code", CONTROL_FAULT_CODE),
    ("fault_detail", CONTROL_FAULT_DETAIL),
    ("session_nonce", CONTROL_SESSION_NONCE),
];

const SESSION_INFO_FIELDS: [(&str, usize); 14] = [
    ("magic", SESSION_INFO_MAGIC),
    ("abi_version", SESSION_INFO_ABI_VERSION),
    ("schema_version", SESSION_INFO_SCHEMA_VERSION),
    ("flags", SESSION_INFO_FLAGS),
    ("arena_size", SESSION_INFO_ARENA_SIZE),
    ("max_arena_size", SESSION_INFO_MAX_ARENA_SIZE),
    ("memory_base", SESSION_INFO_MEMORY_BASE),
    ("initial_pages", SESSION_INFO_INITIAL_PAGES),
    ("max_pages", SESSION_INFO_MAX_PAGES),
    ("layout_hash", SESSION_INFO_LAYOUT_HASH),
    ("region_count", SESSION_INFO_REGION_COUNT),
    ("class_count", SESSION_INFO_CLASS_COUNT),
    ("class_capacity", SESSION_INFO_CLASS_CAPACITY),
    ("open_nonce", SESSION_INFO_OPEN_NONCE),
];

const TABLE_FIELDS: [(&str, usize); 7] = [
    ("head", TABLE_HEAD),
    ("tail", TABLE_TAIL),
    ("capacity", TABLE_CAPACITY),
    ("stride", TABLE_STRIDE),
    ("generation", TABLE_GENERATION),
    ("dropped", TABLE_DROPPED),
    ("delivered", TABLE_DELIVERED),
];

/// FNV-1a, 32-bit.
struct Fnv(u32);

impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= *byte as u32;
            self.0 = self.0.wrapping_mul(0x0100_0193);
        }
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }
}

// ── the EVENT_TABLE's sub-ring arithmetic ─────────────────────────────────

/// The byte offset of class `class`'s sub-ring inside `EVENT_TABLE`, given the
/// per-class capacities: each class contributes a 32-byte header plus
/// `capacity × 32` bytes of records, in class-id order.
pub fn ring_offset(capacities: &[u32; CLASS_COUNT], class: usize) -> usize {
    let mut at = EVENT_TABLE_OFFSET;
    for (index, capacity) in capacities.iter().enumerate() {
        if index == class {
            return at;
        }
        at += RING_HEADER_SIZE + (*capacity as usize) * EVENT_RECORD_SIZE;
    }
    EVENT_TABLE_OFFSET + EVENT_TABLE_SIZE
}

/// How many bytes the ten sub-rings need. C4 requires this to fit
/// [`EVENT_TABLE_SIZE`].
pub fn ring_bytes(capacities: &[u32; CLASS_COUNT]) -> u64 {
    let mut total: u64 = 0;
    for capacity in capacities.iter() {
        total += RING_HEADER_SIZE as u64 + (*capacity as u64) * EVENT_RECORD_SIZE as u64;
    }
    total
}

/// Read the control block's own report of a field this module writes; the
/// session's per-entry triple check uses these (`DESIGN.md` §5.3).
pub fn control_magic(arena: &[u8]) -> u64 {
    u64::from_le_bytes(
        arena[CONTROL_OFFSET + CONTROL_MAGIC..CONTROL_OFFSET + CONTROL_MAGIC + 8]
            .try_into()
            .expect("eight bytes"),
    )
}

pub fn control_layout_hash(arena: &[u8]) -> u32 {
    u32_at(arena, CONTROL_OFFSET + CONTROL_LAYOUT_HASH)
}

pub fn control_region_count(arena: &[u8]) -> u32 {
    u32_at(arena, CONTROL_OFFSET + CONTROL_REGION_COUNT)
}

/// The control block's own report of the session's state (`DESIGN.md` §6.3).
pub fn control_state(arena: &[u8]) -> u32 {
    u32_at(arena, CONTROL_OFFSET + CONTROL_STATE)
}

/// Write the session-owned tail. These are the fields `session_open` and
/// `session_close` move; the guest's header (offsets 0..160) is written once by
/// `write_control_block` and never touched again.
pub fn set_control_state(arena: &mut [u8], state: u32) -> Result<(), LayoutError> {
    require(arena, CONTROL_OFFSET + CONTROL_SIZE)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_STATE, state)
}

pub fn set_control_fault_code(arena: &mut [u8], code: i32) -> Result<(), LayoutError> {
    require(arena, CONTROL_OFFSET + CONTROL_SIZE)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_FAULT_CODE, code as u32)?;
    put_u32(arena, CONTROL_OFFSET + CONTROL_FAULT_DETAIL, 0)
}

pub fn set_control_nonce(arena: &mut [u8], nonce: u64) -> Result<(), LayoutError> {
    require(arena, CONTROL_OFFSET + CONTROL_SIZE)?;
    put_u64(arena, CONTROL_OFFSET + CONTROL_SESSION_NONCE, nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An arena the size of the frozen layout, which is the smallest legal one.
    fn arena() -> Vec<u8> {
        vec![0u8; LAYOUT_FLOOR]
    }

    #[test]
    fn header_page_offsets_match_the_design_note() {
        assert_eq!(CONTROL_OFFSET, 0x000);
        assert_eq!(CONTROL_SIZE, 256);
        assert_eq!(SESSION_INFO_OFFSET, 0x100);
        assert_eq!(SESSION_INFO_SIZE, 128);
        assert_eq!(REGION_TABLE_OFFSET, 0x200);
        assert_eq!(REGION_DESC_SIZE, 24);
        assert_eq!(MANIFEST_ENTRY_SIZE, 8);
        assert_eq!(HEADER_PAGE_SIZE, 0x1000);
        assert_eq!(MANIFEST_OFFSET, 0x320);
        assert_eq!(MANIFEST_LEN, 72);
        // The whole header page fits inside the reserved first page, with room
        // for the descriptor table to grow before a region has to move.
        assert!(MANIFEST_OFFSET + MANIFEST_LEN < HEADER_PAGE_SIZE);
    }

    #[test]
    fn control_block_field_offsets_match_the_design_note() {
        assert_eq!(CONTROL_MAGIC, 0);
        assert_eq!(CONTROL_FORMAT_VERSION, 8);
        assert_eq!(CONTROL_SCHEMA_VERSION, 10);
        assert_eq!(CONTROL_ABI_VERSION, 12);
        assert_eq!(CONTROL_FLAGS, 14);
        assert_eq!(CONTROL_TOTAL_SIZE, 16);
        assert_eq!(CONTROL_LAYOUT_HASH, 20);
        assert_eq!(CONTROL_REGION_COUNT, 24);
        assert_eq!(CONTROL_REGION_TABLE_OFF, 28);
        assert_eq!(CONTROL_MANIFEST_OFF, 32);
        assert_eq!(CONTROL_MANIFEST_LEN, 36);
        assert_eq!(CONTROL_STATE, 160);
        assert_eq!(CONTROL_FAULT_CODE, 164);
        assert_eq!(CONTROL_FAULT_DETAIL, 168);
        assert_eq!(CONTROL_SESSION_NONCE, 176);
        // The guest-owned header ends where the session-owned tail begins.
        assert!(CONTROL_MANIFEST_LEN + 4 <= CONTROL_STATE);
        assert_eq!(CONTROL_SESSION_NONCE + 8, 184);
        assert!(184 <= CONTROL_SIZE - 8);
    }

    #[test]
    fn session_info_field_offsets_match_the_design_note() {
        assert_eq!(SESSION_INFO_MAGIC, 0);
        assert_eq!(SESSION_INFO_ABI_VERSION, 8);
        assert_eq!(SESSION_INFO_SCHEMA_VERSION, 10);
        assert_eq!(SESSION_INFO_FLAGS, 12);
        assert_eq!(SESSION_INFO_ARENA_SIZE, 16);
        assert_eq!(SESSION_INFO_MAX_ARENA_SIZE, 20);
        assert_eq!(SESSION_INFO_MEMORY_BASE, 24);
        assert_eq!(SESSION_INFO_INITIAL_PAGES, 28);
        assert_eq!(SESSION_INFO_MAX_PAGES, 32);
        assert_eq!(SESSION_INFO_LAYOUT_HASH, 36);
        assert_eq!(SESSION_INFO_REGION_COUNT, 40);
        assert_eq!(SESSION_INFO_CLASS_COUNT, 44);
        assert_eq!(SESSION_INFO_CLASS_CAPACITY, 48);
        assert_eq!(SESSION_INFO_OPEN_NONCE, 88);
        // The ten capacities and the nonce fit, with eight reserved words.
        assert_eq!(SESSION_INFO_CLASS_CAPACITY + CLASS_COUNT * 4, SESSION_INFO_OPEN_NONCE);
        assert_eq!(SESSION_INFO_OPEN_NONCE + 8 + 8 * 4, SESSION_INFO_SIZE);
    }

    #[test]
    fn region_band_offsets_and_floor_match_the_design_note() {
        assert_eq!(FRAME_STATE_OFFSET, 0x1000);
        assert_eq!(JOB_OFFSET, 0x2000);
        assert_eq!(RESOURCE_OFFSET, 0xE000);
        assert_eq!(EVENT_TABLE_OFFSET, 0x1A000);
        assert_eq!(STRING_OFFSET, 0x7A000);
        assert_eq!(RESOURCE_REQ_OFFSET, 0x17A020);
        assert_eq!(SCENE_OFFSET, 0x186020);
        assert_eq!(MATERIAL_OFFSET, 0x1C6020);
        assert_eq!(RENDERABLE_OFFSET, 0x1D6020);
        assert_eq!(BUFFER_POOL_OFFSET, 0x1F6020);
        assert_eq!(LAYOUT_FLOOR, 0x5F6020);
        assert_eq!(LAYOUT_FLOOR, 6_250_528);
        // §5.2's arithmetic: ~5.96 MiB of frozen layout inside an 8 MiB ceiling.
        assert!(LAYOUT_FLOOR < 8 * 1024 * 1024);
        assert_eq!(8 * 1024 * 1024 - LAYOUT_FLOOR, 2_138_080);
    }

    #[test]
    fn every_region_is_aligned_and_in_order() {
        for (index, region) in REGIONS.iter().enumerate() {
            assert_eq!(region.kind as usize, index, "kind == index");
            assert_eq!(
                region.offset as usize % region.align as usize,
                0,
                "region {index} is aligned to {}",
                region.align
            );
            assert!(region.size > 0);
            assert_eq!(region.size as usize % 16, 0, "sizes pad to 16");
        }
        // The band is contiguous, in kind order, from the header page up.
        assert_eq!(REGIONS[2].offset as usize, HEADER_PAGE_SIZE);
        for index in 3..REGION_COUNT {
            let previous = &REGIONS[index - 1];
            assert_eq!(
                REGIONS[index].offset as usize,
                previous.offset as usize + previous.size as usize,
                "region {index} follows {}",
                index - 1
            );
        }
        assert_eq!(
            REGIONS[REGION_COUNT - 1].offset as usize + REGIONS[REGION_COUNT - 1].size as usize,
            LAYOUT_FLOOR
        );
    }

    #[test]
    fn the_region_kind_constants_match_the_table() {
        // The names the adapter header and `region_lookup` use, pinned against
        // the table's own `kind` fields so the two can never drift.
        let kinds = [
            REGION_CONTROL,
            REGION_SESSION_INFO,
            REGION_FRAME_STATE,
            REGION_JOB,
            REGION_RESOURCE,
            REGION_EVENT_TABLE,
            REGION_STRING,
            REGION_RESOURCE_REQ,
            REGION_SCENE,
            REGION_MATERIAL,
            REGION_RENDERABLE,
            REGION_BUFFER_POOL,
        ];
        assert_eq!(kinds.len(), REGION_COUNT);
        for (index, kind) in kinds.iter().enumerate() {
            assert_eq!(*kind, index as u32, "kind {index} is its own index");
            assert_eq!(REGIONS[index].kind, *kind, "the table agrees at {index}");
        }
    }

    #[test]
    fn region_directions_are_the_frozen_ones() {
        assert_eq!(
            REGIONS[0].flags,
            RD_SESSION_WRITES | RD_WRITES_ONCE,
            "CONTROL"
        );
        assert_eq!(
            REGIONS[1].flags,
            RD_SESSION_WRITES | RD_WRITES_ONCE,
            "SESSION_INFO"
        );
        for kind in [2, 3, 4, 5] {
            assert_eq!(REGIONS[kind].flags, RD_SESSION_WRITES, "session-written");
        }
        assert_eq!(
            REGIONS[6].flags,
            RD_GUEST_WRITES | RD_SESSION_WRITES,
            "STRING has two disjoint halves"
        );
        for kind in [7, 8, 9, 10] {
            assert_eq!(REGIONS[kind].flags, RD_GUEST_WRITES, "guest-written");
        }
        assert_eq!(
            REGIONS[11].flags,
            RD_GUEST_WRITES | RD_BYTES,
            "BUFFER_POOL is bytes, not records"
        );
    }

    #[test]
    fn region_table_is_written_at_a_24_byte_stride() {
        let mut arena = arena();
        write_region_table(&mut arena).expect("region table");

        for (index, region) in REGIONS.iter().enumerate() {
            let at = REGION_TABLE_OFFSET + index * REGION_DESC_SIZE;
            assert_eq!(u32_at(&arena, at), region.kind, "entry {index} kind");
            assert_eq!(u32_at(&arena, at + 4), region.flags, "entry {index} flags");
            assert_eq!(u32_at(&arena, at + 8), region.offset, "entry {index} offset");
            assert_eq!(u32_at(&arena, at + 12), region.size, "entry {index} size");
            assert_eq!(u32_at(&arena, at + 16), region.align, "entry {index} align");
            assert_eq!(u32_at(&arena, at + 20), 0, "entry {index} reserved is zero");
        }
        // The table ends exactly where the manifest begins.
        assert_eq!(REGION_TABLE_OFFSET + REGION_COUNT * REGION_DESC_SIZE, MANIFEST_OFFSET);
    }

    #[test]
    fn control_block_round_trips() {
        let mut arena = arena();
        write_control_block(&mut arena, 8 * 1024 * 1024).expect("control block");

        assert_eq!(control_magic(&arena), MAGIC);
        assert_eq!(control_layout_hash(&arena), layout_hash());
        assert_eq!(control_region_count(&arena), REGION_COUNT as u32);
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_TOTAL_SIZE), 8 * 1024 * 1024);
        assert_eq!(
            u32_at(&arena, CONTROL_OFFSET + CONTROL_REGION_TABLE_OFF),
            REGION_TABLE_OFFSET as u32
        );
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_MANIFEST_OFF), MANIFEST_OFFSET as u32);
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_MANIFEST_LEN), MANIFEST_LEN as u32);
        // UNINIT until an open succeeds; the tail is the session's.
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_STATE), STATE_UNINIT);
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_FAULT_CODE), 0);
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_SESSION_NONCE), 0);

        let small = write_control_block(&mut arena[..64], 4096);
        assert!(matches!(small, Err(LayoutError::BufferTooSmall { .. })));
    }

    #[test]
    fn session_info_round_trips() {
        let mut arena = arena();
        let values = SessionInfoValues {
            arena_size: LAYOUT_FLOOR as u32,
            max_arena_size: 8 * 1024 * 1024,
            memory_base: 8 * 1024 * 1024,
            initial_pages: 130,
            max_pages: 256,
            open_nonce: 0x1234_5678_9ABC_DEF1,
            class_capacities: DEFAULT_RING_CAPACITIES,
        };
        write_session_info(&mut arena, &values).expect("session info");

        assert_eq!(u32_at(&arena, SESSION_INFO_OFFSET + SESSION_INFO_ARENA_SIZE), values.arena_size);
        assert_eq!(
            u32_at(&arena, SESSION_INFO_OFFSET + SESSION_INFO_MAX_ARENA_SIZE),
            values.max_arena_size
        );
        assert_eq!(
            u32_at(&arena, SESSION_INFO_OFFSET + SESSION_INFO_MEMORY_BASE),
            values.memory_base
        );
        assert_eq!(
            u32_at(&arena, SESSION_INFO_OFFSET + SESSION_INFO_LAYOUT_HASH),
            layout_hash()
        );
        assert_eq!(
            u32_at(&arena, SESSION_INFO_OFFSET + SESSION_INFO_CLASS_COUNT),
            CLASS_COUNT as u32
        );
        for (index, capacity) in DEFAULT_RING_CAPACITIES.iter().enumerate() {
            assert_eq!(
                u32_at(&arena, SESSION_INFO_OFFSET + SESSION_INFO_CLASS_CAPACITY + index * 4),
                *capacity,
                "class {index} capacity"
            );
        }
        // The open nonce is what a re-open changes, so a stale arena is
        // distinguishable from a live one.
        assert_eq!(
            u64::from_le_bytes(
                arena[SESSION_INFO_OFFSET + SESSION_INFO_OPEN_NONCE
                    ..SESSION_INFO_OFFSET + SESSION_INFO_OPEN_NONCE + 8]
                    .try_into()
                    .expect("eight bytes")
            ),
            values.open_nonce
        );
    }

    #[test]
    fn ring_headers_round_trip() {
        let mut arena = arena();
        let capacities = DEFAULT_RING_CAPACITIES;
        for class in 0..CLASS_COUNT {
            write_ring_header(&mut arena, ring_offset(&capacities, class), capacities[class])
                .expect("ring header");
        }
        for class in 0..CLASS_COUNT {
            let header = ring_header(&arena, ring_offset(&capacities, class));
            assert_eq!(header.head, 0, "class {class}");
            assert_eq!(header.tail, 0, "class {class}");
            assert_eq!(header.capacity, capacities[class], "class {class}");
            assert_eq!(header.stride, EVENT_RECORD_SIZE as u32, "class {class}");
            assert_eq!(header.generation, 0, "class {class}");
            assert_eq!(header.dropped, 0, "class {class}");
            assert_eq!(header.delivered, 0, "class {class}");
        }
        // A short slice is refused rather than half-written.
        assert!(matches!(
            write_ring_header(&mut arena[..RING_HEADER_SIZE - 8], EVENT_TABLE_OFFSET, 16),
            Err(LayoutError::BufferTooSmall { .. })
        ));
    }

    #[test]
    fn callbacks_records_round_trip() {
        let mut arena = arena();
        let at = LAYOUT_FLOOR - 64; // a scratch spot, not a real place a guest uses
        arena[at + CALLBACKS_ABI_VERSION..at + CALLBACKS_ABI_VERSION + 2]
            .copy_from_slice(&1u16.to_le_bytes());
        arena[at + CALLBACKS_SLOT_COUNT..at + CALLBACKS_SLOT_COUNT + 2]
            .copy_from_slice(&CALLBACKS_SLOTS.to_le_bytes());
        arena[at + CALLBACKS_ON_BATCH..at + CALLBACKS_ON_BATCH + 4]
            .copy_from_slice(&7u32.to_le_bytes());
        arena[at + CALLBACKS_ON_EVENT..at + CALLBACKS_ON_EVENT + 4]
            .copy_from_slice(&9u32.to_le_bytes());

        let record = read_callbacks(&arena, at);
        assert_eq!(record.abi_version, 1);
        assert_eq!(record.slot_count, CALLBACKS_SLOTS);
        assert_eq!(record.flags, 0);
        assert_eq!(record.on_batch, 7);
        assert_eq!(record.on_event, 9);
    }

    #[test]
    fn control_state_is_writable_and_readable() {
        let mut arena = arena();
        write_control_block(&mut arena, 8 * 1024 * 1024).expect("control block");
        assert_eq!(control_state(&arena), STATE_UNINIT);

        set_control_state(&mut arena, STATE_READY).expect("state");
        set_control_fault_code(&mut arena, -5).expect("fault code");
        set_control_nonce(&mut arena, 0xDEAD_BEEF_0000_0001).expect("nonce");

        assert_eq!(control_state(&arena), STATE_READY);
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_FAULT_CODE), (-5i32) as u32);
        assert_eq!(u32_at(&arena, CONTROL_OFFSET + CONTROL_FAULT_DETAIL), 0);
        assert_eq!(
            u64::from_le_bytes(
                arena[CONTROL_OFFSET + CONTROL_SESSION_NONCE
                    ..CONTROL_OFFSET + CONTROL_SESSION_NONCE + 8]
                    .try_into()
                    .expect("eight bytes")
            ),
            0xDEAD_BEEF_0000_0001
        );
        // The guest-owned header is untouched by a tail write.
        assert_eq!(control_magic(&arena), MAGIC);
    }

    #[test]
    fn manifest_round_trips() {
        let mut arena = arena();
        write_manifest(&mut arena).expect("manifest");
        for (index, entry) in TYPES.iter().enumerate() {
            let at = MANIFEST_OFFSET + index * MANIFEST_ENTRY_SIZE;
            assert_eq!(u16::from_le_bytes(arena[at..at + 2].try_into().unwrap()), entry.id);
            assert_eq!(
                u16::from_le_bytes(arena[at + 2..at + 4].try_into().unwrap()),
                entry.size
            );
            assert_eq!(
                u16::from_le_bytes(arena[at + 4..at + 6].try_into().unwrap()),
                entry.align
            );
            assert_eq!(u16::from_le_bytes(arena[at + 6..at + 8].try_into().unwrap()), 0);
        }
        // The `Callbacks` entry is the one `callbacks_len` is checked against.
        let callbacks = TYPES.iter().find(|entry| entry.id == 7).expect("Callbacks entry");
        assert_eq!(callbacks.size as usize, CALLBACKS_SIZE);
    }

    #[test]
    fn layout_hash_is_deterministic_and_stable() {
        assert_eq!(layout_hash(), layout_hash());
        assert_eq!(
            layout_hash(),
            RECORDED_LAYOUT_HASH,
            "the arena's shape, or what its fingerprint covers, changed: bump \
             FORMAT_VERSION and the SDK together, then re-record this value"
        );
    }

    /// The recorded hash. Re-record only with a deliberate change to the shape
    /// *or* to what the fingerprint covers (`DESIGN.md` §5.1).
    ///
    /// `303_487_325` was the value before field offsets were folded in; a
    /// reordering or renaming of any field a guest reads now moves it.
    const RECORDED_LAYOUT_HASH: u32 = 3_451_714_980;

    #[test]
    fn canary_lattice_verifies_and_detects_one_byte() {
        let mut arena = arena();
        let (start, end) = (LAYOUT_FLOOR - CANARY_STRIDE * 4, LAYOUT_FLOOR);
        write_canary_lattice(&mut arena, start, end).expect("lattice");
        assert_eq!(verify_canary_lattice(&arena, start, end), Ok(()));

        // A single flipped byte, inside a block.
        arena[start + 3] ^= 0x01;
        assert_eq!(verify_canary_lattice(&arena, start, end), Err(start));

        // A single flipped byte in the second block is reported at that block.
        arena[start + 3] ^= 0x01;
        arena[start + CANARY_STRIDE + 8] ^= 0x80;
        assert_eq!(
            verify_canary_lattice(&arena, start, end),
            Err(start + CANARY_STRIDE)
        );
    }

    #[test]
    fn canary_blocks_are_offset_specific() {
        let mut arena = arena();
        let (start, end) = (LAYOUT_FLOOR - CANARY_STRIDE * 2, LAYOUT_FLOOR);
        write_canary_lattice(&mut arena, start, end).expect("lattice");
        // Copying one block over another must not verify: the value depends on
        // where it lives.
        let first = arena[start..start + CANARY_BLOCK].to_vec();
        arena[start + CANARY_STRIDE..start + CANARY_STRIDE + CANARY_BLOCK]
            .copy_from_slice(&first);
        assert_eq!(
            verify_canary_lattice(&arena, start, end),
            Err(start + CANARY_STRIDE)
        );
    }

    #[test]
    fn zero_band_and_verify_band_is_zero_round_trip() {
        let mut arena = arena();
        let (start, end) = (LAYOUT_FLOOR - 4096, LAYOUT_FLOOR);
        arena[start..end].fill(0xAB);
        assert_eq!(verify_band_is_zero(&arena, start, end), Err(start));

        zero_band(&mut arena, start, end).expect("zero");
        assert_eq!(verify_band_is_zero(&arena, start, end), Ok(()));

        arena[start + 100] = 1;
        assert_eq!(verify_band_is_zero(&arena, start, end), Err(start + 100));

        let too_far = arena.len() + 1;
        assert!(matches!(
            zero_band(&mut arena, start, too_far),
            Err(LayoutError::BufferTooSmall { .. })
        ));
    }

    #[test]
    fn ring_arithmetic_matches_the_defaults() {
        let capacities = DEFAULT_RING_CAPACITIES;
        assert_eq!(ring_offset(&capacities, 0), EVENT_TABLE_OFFSET);
        // Class 1 follows class 0's header plus its one record.
        assert_eq!(
            ring_offset(&capacities, 1),
            EVENT_TABLE_OFFSET + RING_HEADER_SIZE + EVENT_RECORD_SIZE
        );
        // The default capacities fit the region with room to spare.
        let used = ring_bytes(&capacities);
        assert!(used <= EVENT_TABLE_SIZE as u64);
        assert_eq!(
            EVENT_TABLE_SIZE as u64 - used,
            61_088,
            "the defaults leave 61 088 bytes of EVENT_TABLE unused"
        );
        assert_eq!(
            DEFAULT_RING_CAPACITIES.iter().map(|c| *c as u64).sum::<u64>(),
            10_369
        );
    }

    #[test]
    fn the_region_names_line_up_with_the_kinds() {
        // The names are diagnostics only — nothing on the wire reads them — but
        // a name that drifts from its kind turns a refusal into a lie, so the
        // order is pinned the way the kind constants are.
        assert_eq!(REGION_NAMES.len(), REGION_COUNT);
        for (kind, region) in REGIONS.iter().enumerate() {
            assert_eq!(region.kind as usize, kind, "kind == index");
            assert_eq!(region_name(kind as u32), REGION_NAMES[kind]);
        }
        assert_eq!(region_name(REGION_JOB), "JOB");
        assert_eq!(region_name(REGION_BUFFER_POOL), "BUFFER_POOL");
        // A kind this layout does not define has no name, and says so rather
        // than indexing out of the table.
        assert_eq!(region_name(REGION_COUNT as u32), "<unknown>");
        assert_eq!(region_name(u32::MAX), "<unknown>");
    }

    #[test]
    fn the_names_are_not_part_of_the_shape() {
        // Renaming a region must not move the hash the guest was built against;
        // this pins that the table is outside it. (If a later round ever folds
        // names in, this test is the one that should fail first.)
        assert_eq!(layout_hash(), RECORDED_LAYOUT_HASH);
        assert_eq!(REGION_NAMES.len(), REGION_COUNT);
    }

    #[test]
    fn an_absent_callbacks_record_is_all_slots_absent() {
        let absent = CallbacksRecord::absent();
        assert_eq!(absent.abi_version, ABI_VERSION);
        assert_eq!(absent.slot_count, 0);
        assert_eq!(absent.on_batch, 0);
        assert_eq!(absent.on_event, 0);
        // The size the config states when it means "absent" is zero, not this
        // record's size: nothing is written anywhere.
        assert_ne!(CALLBACKS_SIZE, 0);
    }
}
