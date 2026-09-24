//! The `session_open` configuration wire.
//!
//! The host as **strict reader**, the same layering the solver's config uses
//! (`solver/config.rs`): the guest's SDK is the writer and owns the format; this
//! module validates what it reads and refuses — never guessing, never
//! half-reading — anything that does not match. Every refusal is `-EINVAL` with
//! a reason that names the failed check, because the wasm boundary has no error
//! channel and the only diagnostic is the `[tension:session]` line the session
//! prints from the returned [`ConfigError`].
//!
//! # The wire
//!
//! A flat little-endian key/value stream:
//!
//! ```text
//! argmap := u32 entry_count
//! entry  := u32 key, u8 tag, payload
//! tag 2  := i64 LE — the carrier for every u32 field; the upper four bytes
//!           must be zero, so a value that does not fit a u32 is refused
//!           rather than truncated.
//! ```
//!
//! Keys are `u32`s: 1-6 are the fixed keys below, `0x0100 + n` is
//! `ring_capacity_<n>` for class `n` (the whole `0x0100..=0x01FF` range is the
//! ring namespace, so `ring_capacity_12` is a *named* refusal rather than an
//! ignored key), and every other key is unknown and ignored — the argmap
//! precedent. A key that appears twice takes its last value.
//!
//! The first entry in the byte stream must be `abi_version`: a future version's
//! stream must be refused before its remaining shape is interpreted at all.
//!
//! **The key form.** `tension-ogre/DESIGN.md` §6.1 now documents this stream
//! with `u32` keys (amended in A1 round 2a), which is what this module
//! implements: keys 1-6 for the seven required entries and `0x0100 + class` for
//! the optional ring capacities. This module is authoritative for the decoder's
//! behaviour; the note describes it.

use super::arena::{
    CLASS_COUNT, DEFAULT_RING_CAPACITIES, EVENT_TABLE_SIZE, LAYOUT_FLOOR, REGION_COUNT,
};
use super::arena::{CALLBACKS_SIZE, EVENT_RECORD_SIZE};

// The errno every refusal in this module reports: the session's table, which the
// parent declares (`super::EINVAL`).
use super::EINVAL;

// ── the key table ─────────────────────────────────────────────────────────

pub const KEY_ABI_VERSION: u32 = 1;
pub const KEY_LAYOUT_HASH: u32 = 2;
pub const KEY_ARENA_SIZE: u32 = 3;
pub const KEY_MAX_ARENA_SIZE: u32 = 4;
pub const KEY_CALLBACKS_PTR: u32 = 5;
pub const KEY_CALLBACKS_LEN: u32 = 6;
/// `0x0100 + class` — one key per event class.
pub const KEY_RING_CAPACITY_BASE: u32 = 0x0100;
/// One past the ring namespace: `0x0100..0x0200`.
pub const KEY_RING_CAPACITY_END: u32 = 0x0200;

/// The only value tag this build reads.
const TAG_I64: u8 = 2;

/// One entry's fixed overhead: the key (4) plus the tag (1) plus the payload
/// (8). Used to refuse a lying `entry_count` before allocating anything.
const MIN_ENTRY_LEN: usize = 4 + 1 + 8;

/// The guest's configuration, decoded and defaulted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionConfig {
    pub abi_version: u32,
    pub layout_hash: u32,
    pub arena_size: u32,
    pub max_arena_size: u32,
    pub callbacks_ptr: u32,
    pub callbacks_len: u32,
    /// One entry per class, in class-id order: the stated value where the guest
    /// supplied one, the default otherwise.
    pub ring_capacities: [u32; CLASS_COUNT],
    /// Which capacities the guest actually stated. The session reports these in
    /// `SessionInfo`; a game that meant 4096 and typo'd a key can see the
    /// difference between "stated" and "defaulted".
    pub ring_stated: [bool; CLASS_COUNT],
}

/// One capability's declared need for a region kind: an adapter asked
/// `region_lookup` about `kind` during `link`, so the registry recorded it and
/// `session_open` must find that region inside the arena the config declares
/// (`DESIGN.md` §7.2).
///
/// The adapter's name travels with the kind because the refusal names both: an
/// operator who loaded one capability reads a different message from one who
/// loaded five.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegionNeed {
    pub kind: u32,
    pub adapter: String,
}

/// A refusal, with the numbers needed to say *why* on the session's channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// The byte stream is not the wire format described above.
    Malformed(&'static str),
    /// The stream ended inside an entry.
    Truncated,
    /// A required key was absent.
    MissingKey(&'static str),
    /// `abi_version` was not the first entry.
    AbiVersionNotFirst,
    /// The guest's ABI version is not the session's.
    AbiVersion { guest: u32, session: u32 },
    /// The guest's compiled-in layout hash is not the session's.
    LayoutHash { guest: u32, session: u32 },
    /// A field did not fit the u32 the wire carries it in.
    ValueOutOfRange(&'static str),
    /// C1: the arena's declared sizes are inconsistent.
    ArenaRelation(&'static str),
    /// C4: the frozen layout does not fit the declared live arena.
    LayoutFit { need: u64, have: u32 },
    /// A ring capacity is zero, or names a class outside the ten.
    RingCapacity { class: u32 },
    /// The capacities together do not fit `EVENT_TABLE`.
    RingTableFit { need: u64, have: u64 },
    /// A callbacks field is out of range.
    Callbacks(&'static str),
    /// A loaded capability asked about a region kind this layout does not
    /// define: `region_lookup` answered `-ENOENT`, so it has no offset to write
    /// to and no `arena_size` could ever have satisfied it.
    UnknownRegion { kind: u32, adapter: String },
    /// The live arena ends before a region a loaded capability needs does.
    RegionTruncated {
        kind: u32,
        adapter: String,
        /// One past the required region's last byte.
        need: u64,
        have: u32,
    },
}

impl ConfigError {
    /// Every refusal at this boundary is `-EINVAL`; the reason is the message.
    pub fn errno(&self) -> i32 {
        EINVAL
    }
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Malformed(what) => write!(f, "malformed config: {what}"),
            ConfigError::Truncated => write!(f, "malformed config: the stream ends inside an entry"),
            ConfigError::MissingKey(key) => write!(f, "missing required key `{key}`"),
            ConfigError::AbiVersionNotFirst => {
                write!(f, "`abi_version` must be the first entry in the stream")
            }
            ConfigError::AbiVersion { guest, session } => write!(
                f,
                "abi_version {guest} does not match this session's {session}"
            ),
            ConfigError::LayoutHash { guest, session } => write!(
                f,
                "layout_hash {guest:#010x} does not match this session's {session:#010x}: \
                 the guest was built against a different arena shape"
            ),
            ConfigError::ValueOutOfRange(key) => {
                write!(f, "`{key}` does not fit the u32 it is carried in")
            }
            ConfigError::ArenaRelation(what) => write!(f, "arena sizes refused: {what}"),
            ConfigError::LayoutFit { need, have } => write!(
                f,
                "arena_size {have} is below the frozen layout's {need} bytes"
            ),
            ConfigError::RingCapacity { class } => write!(
                f,
                "ring_capacity_{class} is refused: this chunk has classes 0-{}",
                CLASS_COUNT - 1
            ),
            ConfigError::RingTableFit { need, have } => write!(
                f,
                "ring capacities need {need} bytes; EVENT_TABLE holds {have}"
            ),
            ConfigError::Callbacks(what) => write!(f, "callbacks refused: {what}"),
            ConfigError::UnknownRegion { kind, adapter } => write!(
                f,
                "the capability `{adapter}` asked for region kind {kind}, which this layout \
                 does not define (0-{}); no arena_size can satisfy it",
                REGION_COUNT - 1
            ),
            ConfigError::RegionTruncated {
                kind,
                adapter,
                need,
                have,
            } => write!(
                f,
                "the capability `{adapter}` needs the {} region (kind {kind}), which ends at \
                 {need} ({need:#x}); arena_size is {have} ({have:#x})",
                super::arena::region_name(*kind)
            ),
        }
    }
}

// ── reading ───────────────────────────────────────────────────────────────

/// A cursor over the stream that never indexes past its end.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Option<u32> {
        let end = self.at + 4;
        if end > self.bytes.len() {
            return None;
        }
        let value = u32::from_le_bytes(self.bytes[self.at..end].try_into().expect("four bytes"));
        self.at = end;
        Some(value)
    }

    fn u8(&mut self) -> Option<u8> {
        if self.at >= self.bytes.len() {
            return None;
        }
        let value = self.bytes[self.at];
        self.at += 1;
        Some(value)
    }

    fn i64(&mut self) -> Option<i64> {
        let end = self.at + 8;
        if end > self.bytes.len() {
            return None;
        }
        let value = i64::from_le_bytes(self.bytes[self.at..end].try_into().expect("eight bytes"));
        self.at = end;
        Some(value)
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }
}

/// Decode the `session_open` argument stream. See the module docs for the
/// format; see [`ConfigError`] for every way it can be refused.
pub fn decode(bytes: &[u8]) -> Result<SessionConfig, ConfigError> {
    let mut reader = Reader { bytes, at: 0 };
    let count = reader.u32().ok_or(ConfigError::Truncated)? as usize;

    // A lying count must fail before anything is sized from it.
    if count.saturating_mul(MIN_ENTRY_LEN) > reader.remaining() {
        return Err(ConfigError::Malformed(
            "entry_count exceeds the bytes that follow",
        ));
    }

    let mut abi_version = None;
    let mut layout_hash = None;
    let mut arena_size = None;
    let mut max_arena_size = None;
    let mut callbacks_ptr = None;
    let mut callbacks_len = None;
    let mut ring_capacities = DEFAULT_RING_CAPACITIES;
    let mut ring_stated = [false; CLASS_COUNT];

    for index in 0..count {
        let key = reader.u32().ok_or(ConfigError::Truncated)?;
        if index == 0 && key != KEY_ABI_VERSION {
            return Err(ConfigError::AbiVersionNotFirst);
        }
        let tag = reader.u8().ok_or(ConfigError::Truncated)?;
        if tag != TAG_I64 {
            return Err(ConfigError::Malformed("unknown value tag; this build reads tag 2"));
        }
        let raw = reader.i64().ok_or(ConfigError::Truncated)?;
        let value = u32::try_from(raw).map_err(|_| value_out_of_range(key))?;

        match key {
            KEY_ABI_VERSION => abi_version = Some(value),
            KEY_LAYOUT_HASH => layout_hash = Some(value),
            KEY_ARENA_SIZE => arena_size = Some(value),
            KEY_MAX_ARENA_SIZE => max_arena_size = Some(value),
            KEY_CALLBACKS_PTR => callbacks_ptr = Some(value),
            KEY_CALLBACKS_LEN => callbacks_len = Some(value),
            k if (KEY_RING_CAPACITY_BASE..KEY_RING_CAPACITY_END).contains(&k) => {
                let class = k - KEY_RING_CAPACITY_BASE;
                if class as usize >= CLASS_COUNT {
                    return Err(ConfigError::RingCapacity { class });
                }
                ring_capacities[class as usize] = value;
                ring_stated[class as usize] = true;
            }
            // An unknown key is ignored — the argmap precedent — but its
            // payload has already been read and validated above, so a typo in
            // an unknown key cannot desynchronise the stream.
            _ => {}
        }
    }

    if reader.remaining() != 0 {
        return Err(ConfigError::Malformed("trailing bytes after the last entry"));
    }

    Ok(SessionConfig {
        abi_version: abi_version.ok_or(ConfigError::MissingKey("abi_version"))?,
        layout_hash: layout_hash.ok_or(ConfigError::MissingKey("layout_hash"))?,
        arena_size: arena_size.ok_or(ConfigError::MissingKey("arena_size"))?,
        max_arena_size: max_arena_size.ok_or(ConfigError::MissingKey("max_arena_size"))?,
        callbacks_ptr: callbacks_ptr.ok_or(ConfigError::MissingKey("callbacks_ptr"))?,
        callbacks_len: callbacks_len.ok_or(ConfigError::MissingKey("callbacks_len"))?,
        ring_capacities,
        ring_stated,
    })
}

fn value_out_of_range(key: u32) -> ConfigError {
    // The key is only ever formatted; keep the message stable and cheap.
    match key {
        KEY_ABI_VERSION => ConfigError::ValueOutOfRange("abi_version"),
        KEY_LAYOUT_HASH => ConfigError::ValueOutOfRange("layout_hash"),
        KEY_ARENA_SIZE => ConfigError::ValueOutOfRange("arena_size"),
        KEY_MAX_ARENA_SIZE => ConfigError::ValueOutOfRange("max_arena_size"),
        KEY_CALLBACKS_PTR => ConfigError::ValueOutOfRange("callbacks_ptr"),
        KEY_CALLBACKS_LEN => ConfigError::ValueOutOfRange("callbacks_len"),
        _ => ConfigError::ValueOutOfRange("ring_capacity"),
    }
}

// ── the checks ────────────────────────────────────────────────────────────

/// `abi_version` matches. First check in the design's order.
pub fn check_abi(config: &SessionConfig, session_abi: u32) -> Result<(), ConfigError> {
    if config.abi_version != session_abi {
        return Err(ConfigError::AbiVersion {
            guest: config.abi_version,
            session: session_abi,
        });
    }
    Ok(())
}

/// `layout_hash` matches the session's compiled-in shape.
pub fn check_layout_hash(config: &SessionConfig, session_hash: u32) -> Result<(), ConfigError> {
    if config.layout_hash != session_hash {
        return Err(ConfigError::LayoutHash {
            guest: config.layout_hash,
            session: session_hash,
        });
    }
    Ok(())
}

/// C1: the two sizes are sane relative to each other and to the layout.
pub fn check_arena_relation(config: &SessionConfig) -> Result<(), ConfigError> {
    if config.arena_size == 0 {
        return Err(ConfigError::ArenaRelation("arena_size is zero"));
    }
    if config.max_arena_size == 0 {
        return Err(ConfigError::ArenaRelation("max_arena_size is zero"));
    }
    if config.arena_size % 16 != 0 {
        return Err(ConfigError::ArenaRelation("arena_size is not 16-byte aligned"));
    }
    if config.max_arena_size % 16 != 0 {
        return Err(ConfigError::ArenaRelation(
            "max_arena_size is not 16-byte aligned",
        ));
    }
    if config.arena_size > config.max_arena_size {
        return Err(ConfigError::ArenaRelation(
            "arena_size exceeds max_arena_size",
        ));
    }
    Ok(())
}

/// C4: the frozen layout fits the declared live arena. Region sizes are
/// constants this chunk, so this is one comparison — and it is the check that
/// keeps `region_lookup`'s link-time promise honest.
pub fn check_layout_fit(config: &SessionConfig) -> Result<(), ConfigError> {
    if (config.arena_size as u64) < LAYOUT_FLOOR as u64 {
        return Err(ConfigError::LayoutFit {
            need: LAYOUT_FLOOR as u64,
            have: config.arena_size,
        });
    }
    Ok(())
}

/// The ring capacities: every class gets at least one record, and the ten
/// sub-rings fit inside the fixed `EVENT_TABLE`.
pub fn check_ring_capacities(config: &SessionConfig) -> Result<(), ConfigError> {
    for (class, capacity) in config.ring_capacities.iter().enumerate() {
        if *capacity == 0 {
            return Err(ConfigError::RingCapacity { class: class as u32 });
        }
    }
    let need = super::arena::ring_bytes(&config.ring_capacities);
    if need > EVENT_TABLE_SIZE as u64 {
        return Err(ConfigError::RingTableFit {
            need,
            have: EVENT_TABLE_SIZE as u64,
        });
    }
    Ok(())
}

/// The callbacks record: absent, or the right size, 4-byte aligned, and in the
/// guest's own heap rather than inside the reserved band.
pub fn check_callbacks(config: &SessionConfig) -> Result<(), ConfigError> {
    // An absent record is the limit case of "every slot is absent" (§8): a
    // pointer with no length is a half-stated record, and this boundary refuses
    // a disagreement between the writer and the reader rather than guessing
    // which half was meant.
    if config.callbacks_len == 0 {
        if config.callbacks_ptr != 0 {
            return Err(ConfigError::Callbacks(
                "callbacks_len is zero but callbacks_ptr is not: an absent record has no \
                 address, so both must be zero",
            ));
        }
        return Ok(());
    }
    if config.callbacks_len as usize != CALLBACKS_SIZE {
        return Err(ConfigError::Callbacks(
            "callbacks_len is neither zero (no record) nor the manifest's Callbacks size",
        ));
    }
    if config.callbacks_ptr % 4 != 0 {
        return Err(ConfigError::Callbacks("callbacks_ptr is not 4-byte aligned"));
    }
    if config.callbacks_ptr < config.max_arena_size {
        return Err(ConfigError::Callbacks(
            "callbacks_ptr is below max_arena_size: it must live in the guest's heap, \
             not in the reserved band",
        ));
    }
    Ok(())
}

/// §7.2: every region a loaded capability declared must lie inside the live
/// arena. Two refusals, both `-EINVAL`:
///
/// - a kind this layout does not define. `region_lookup` answered `-ENOENT` for
///   it at link time, so the adapter has no offset to write to, and no
///   `arena_size` could have made the region exist;
/// - a region whose end lies past `arena_size`, which is what a capability that
///   cached its offsets at link time cannot survive.
///
/// With no adapters loaded the slice is empty and this is a no-op — which is
/// every A1 test that does not load one, and every run of `tension-core` without
/// `--capability`.
pub fn check_required_regions(
    config: &SessionConfig,
    required: &[RegionNeed],
) -> Result<(), ConfigError> {
    for need in required {
        let Some(region) = super::arena::REGIONS.get(need.kind as usize) else {
            return Err(ConfigError::UnknownRegion {
                kind: need.kind,
                adapter: need.adapter.clone(),
            });
        };
        let end = region.offset as u64 + region.size as u64;
        if end > config.arena_size as u64 {
            return Err(ConfigError::RegionTruncated {
                kind: need.kind,
                adapter: need.adapter.clone(),
                need: end,
                have: config.arena_size,
            });
        }
    }
    Ok(())
}

/// Every check this module can perform alone, in the design's order:
/// `abi_version` → `layout_hash` → C1 → C3 → required regions (§7.2) → C4 →
/// ring capacities → callbacks. The first failure is returned; later checks are
/// not attempted.
///
/// The required-region check sits *before* C4 (§6.2): it is the more specific
/// statement of the same guarantee and it can name the capability and the
/// region, where C4 can only name two numbers. It refuses a strict subset of
/// what C4 refuses — every frozen region ends at or below `LAYOUT_FLOOR` — so
/// nothing is accepted here that the floor would have caught.
///
/// One step of `DESIGN.md` §6.2 is deliberately *not* here: the memory import
/// match (C2/C3), which needs the module's declared page counts and therefore
/// belongs to the session. A caller that needs the design's exact interleaving
/// calls the staged functions instead.
pub fn validate_with_regions(
    config: &SessionConfig,
    session_abi: u32,
    session_hash: u32,
    required: &[RegionNeed],
) -> Result<(), ConfigError> {
    check_abi(config, session_abi)?;
    check_layout_hash(config, session_hash)?;
    check_arena_relation(config)?;
    check_required_regions(config, required)?;
    check_layout_fit(config)?;
    check_ring_capacities(config)?;
    check_callbacks(config)?;
    Ok(())
}

/// [`validate_with_regions`] with nothing loaded: the shape every caller that
/// has no adapter registry asks for. The run path itself uses
/// `validate_with_regions`, because a session always has a set to hand over —
/// possibly the empty one — so this form is the tests' and the next caller's.
#[cfg_attr(not(test), allow(dead_code))]
pub fn validate(
    config: &SessionConfig,
    session_abi: u32,
    session_hash: u32,
) -> Result<(), ConfigError> {
    validate_with_regions(config, session_abi, session_hash, &[])
}

/// The event-record stride, re-exported so the session does not reach into
/// [`super::arena`] for a number this module's ring arithmetic depends on.
#[cfg_attr(not(test), allow(dead_code))] // tests pin this alias to `EVENT_RECORD_SIZE`; the capacity helpers use the latter
pub const RING_RECORD_STRIDE: usize = EVENT_RECORD_SIZE;

/// Encode a `session_open` stream. A test utility: the guest SDK is the real
/// writer (A3), and this exists so the decoder's tests and the session's can
/// build a stream without a guest.
#[cfg(test)]
pub(crate) fn encode(entries: &[(u32, i64)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + entries.len() * MIN_ENTRY_LEN);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (key, value) in entries {
        out.extend_from_slice(&key.to_le_bytes());
        out.push(TAG_I64);
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::arena::{layout_hash, LAYOUT_FLOOR as FLOOR};

    /// Encode one entry: key, the i64 tag, the value.
    fn entry(key: u32, value: i64) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&key.to_le_bytes());
        out.push(TAG_I64);
        out.extend_from_slice(&value.to_le_bytes());
        out
    }

    /// Encode a whole stream — the shared helper, so a stream built here is the
    /// same encoding the session's tests build.
    use super::encode as enc;

    /// A complete, valid stream: the smallest legal arena, the default
    /// callbacks record in the guest's heap.
    fn good() -> Vec<(u32, i64)> {
        let floor = FLOOR as i64;
        let ceiling = 8 * 1024 * 1024i64;
        vec![
            (KEY_ABI_VERSION, 1),
            (KEY_LAYOUT_HASH, layout_hash() as i64),
            (KEY_ARENA_SIZE, floor),
            (KEY_MAX_ARENA_SIZE, ceiling),
            (KEY_CALLBACKS_PTR, ceiling),
            (KEY_CALLBACKS_LEN, CALLBACKS_SIZE as i64),
        ]
    }

    fn decode_good() -> SessionConfig {
        decode(&enc(&good())).expect("a valid stream decodes")
    }

    #[test]
    fn every_key_decodes() {
        let mut entries = good();
        entries.push((KEY_RING_CAPACITY_BASE + 4, 512));
        let config = decode(&enc(&entries)).expect("decodes");

        assert_eq!(config.abi_version, 1);
        assert_eq!(config.layout_hash, layout_hash());
        assert_eq!(config.arena_size, FLOOR as u32);
        assert_eq!(config.max_arena_size, 8 * 1024 * 1024);
        assert_eq!(config.callbacks_ptr, 8 * 1024 * 1024);
        assert_eq!(config.callbacks_len, CALLBACKS_SIZE as u32);
        // The stated class takes its value; the rest default.
        assert_eq!(config.ring_capacities[4], 512);
        assert!(config.ring_stated[4]);
        for class in 0..CLASS_COUNT {
            if class != 4 {
                assert_eq!(config.ring_capacities[class], DEFAULT_RING_CAPACITIES[class]);
                assert!(!config.ring_stated[class]);
            }
        }
    }

    #[test]
    fn a_valid_stream_passes_every_check() {
        let config = decode_good();
        assert_eq!(validate(&config, 1, layout_hash()), Ok(()));
    }

    #[test]
    fn missing_required_keys_are_named() {
        for missing in [
            KEY_ABI_VERSION,
            KEY_LAYOUT_HASH,
            KEY_ARENA_SIZE,
            KEY_MAX_ARENA_SIZE,
            KEY_CALLBACKS_PTR,
            KEY_CALLBACKS_LEN,
        ] {
            let entries: Vec<(u32, i64)> = good()
                .into_iter()
                .filter(|(key, _)| *key != missing)
                .collect();
            let error = decode(&enc(&entries)).expect_err("refused");
            if missing == KEY_ABI_VERSION {
                // Dropping the first entry leaves another key at the head, so
                // the stream is refused for the ordering rule rather than for
                // an absence — the first thing a reader checks.
                assert_eq!(error, ConfigError::AbiVersionNotFirst);
            } else {
                assert!(
                    matches!(error, ConfigError::MissingKey(_)),
                    "key {missing}: {error:?}"
                );
            }
            assert_eq!(error.errno(), EINVAL);
        }
    }

    #[test]
    fn abi_version_must_be_first() {
        let mut entries = good();
        entries.swap(0, 1); // layout_hash first
        assert_eq!(decode(&enc(&entries)), Err(ConfigError::AbiVersionNotFirst));
        assert_eq!(
            decode(&enc(&entries)).expect_err("refused").errno(),
            EINVAL
        );

        // A stream with no entries at all has no `abi_version`, which is a
        // missing required key rather than a malformed stream.
        assert_eq!(decode(&enc(&[])), Err(ConfigError::MissingKey("abi_version")));
    }

    #[test]
    fn an_unknown_key_is_ignored() {
        let mut entries = good();
        entries.push((0x0BAD, 1234)); // not a key this build knows
        let config = decode(&enc(&entries)).expect("an unknown key does not refuse");
        assert_eq!(config, decode_good());
    }

    #[test]
    fn an_unknown_ring_class_is_refused() {
        let mut entries = good();
        entries.push((KEY_RING_CAPACITY_BASE + 12, 16));
        let error = decode(&enc(&entries)).expect_err("ring_capacity_12 is refused");
        assert_eq!(error, ConfigError::RingCapacity { class: 12 });
        assert_eq!(error.errno(), EINVAL);

        // The last valid class is accepted.
        let mut entries = good();
        entries.push((KEY_RING_CAPACITY_BASE + (CLASS_COUNT as u32 - 1), 16));
        assert!(decode(&enc(&entries)).is_ok());
    }

    #[test]
    fn malformed_streams_are_refused() {
        // A lying entry count with nothing behind it.
        let mut lying = u32::MAX.to_le_bytes().to_vec();
        lying.extend_from_slice(&entry(KEY_ABI_VERSION, 1));
        assert!(matches!(decode(&lying), Err(ConfigError::Malformed(_))));

        // An unknown tag.
        let mut bad_tag = Vec::new();
        bad_tag.extend_from_slice(&1u32.to_le_bytes());
        bad_tag.extend_from_slice(&KEY_ABI_VERSION.to_le_bytes());
        bad_tag.push(9);
        bad_tag.extend_from_slice(&1i64.to_le_bytes());
        assert!(matches!(decode(&bad_tag), Err(ConfigError::Malformed(_))));

        // A value that does not fit its u32 carrier.
        let bad_value = enc(&[(KEY_ABI_VERSION, 1i64 << 32)]);
        assert!(matches!(decode(&bad_value), Err(ConfigError::ValueOutOfRange(_))));

        // Trailing bytes.
        let mut trailing = enc(&good());
        trailing.push(0xAB);
        assert!(matches!(decode(&trailing), Err(ConfigError::Malformed(_))));

        // A stream cut mid-entry.
        let full = enc(&good());
        for cut in [0, 1, 4, 5, 9, full.len() - 1] {
            assert!(decode(&full[..cut]).is_err(), "cut at {cut} must refuse");
        }
    }

    #[test]
    fn a_duplicate_key_takes_its_last_value() {
        let mut entries = good();
        entries.push((KEY_ARENA_SIZE, FLOOR as i64 + 4096));
        let config = decode(&enc(&entries)).expect("decodes");
        assert_eq!(config.arena_size, FLOOR as u32 + 4096);
    }

    #[test]
    fn abi_version_mismatch_is_named_with_both_numbers() {
        let config = decode_good();
        assert_eq!(
            validate(&config, 2, layout_hash()),
            Err(ConfigError::AbiVersion { guest: 1, session: 2 })
        );
    }

    #[test]
    fn layout_hash_mismatch_is_named_with_both_numbers() {
        let config = decode_good();
        assert_eq!(
            validate(&config, 1, 0xDEAD_BEEF),
            Err(ConfigError::LayoutHash {
                guest: layout_hash(),
                session: 0xDEAD_BEEF
            })
        );
    }

    #[test]
    fn c1_refuses_the_arena_relation() {
        let mut config = decode_good();
        config.arena_size = 0;
        assert!(matches!(check_arena_relation(&config), Err(ConfigError::ArenaRelation(_))));

        let mut config = decode_good();
        config.arena_size = config.max_arena_size + 16;
        assert!(matches!(check_arena_relation(&config), Err(ConfigError::ArenaRelation(_))));

        let mut config = decode_good();
        config.arena_size = FLOOR as u32 + 1; // not 16-aligned
        assert!(matches!(check_arena_relation(&config), Err(ConfigError::ArenaRelation(_))));
    }

    #[test]
    fn c4_refuses_an_arena_below_the_frozen_layout() {
        let mut config = decode_good();
        config.arena_size = (FLOOR as u32) - 16;
        assert_eq!(
            check_layout_fit(&config),
            Err(ConfigError::LayoutFit { need: FLOOR as u64, have: FLOOR as u32 - 16 })
        );
    }

    #[test]
    fn ring_capacities_must_be_nonzero_and_fit() {
        let mut config = decode_good();
        config.ring_capacities[3] = 0;
        assert_eq!(
            check_ring_capacities(&config),
            Err(ConfigError::RingCapacity { class: 3 })
        );

        // Capacities that cannot fit the fixed region.
        let mut config = decode_good();
        for capacity in config.ring_capacities.iter_mut() {
            *capacity = 100_000;
        }
        assert!(matches!(
            check_ring_capacities(&config),
            Err(ConfigError::RingTableFit { .. })
        ));
    }

    #[test]
    fn the_callback_range_check_rejects_a_pointer_below_the_band() {
        let mut config = decode_good();
        config.callbacks_ptr = config.max_arena_size - 4;
        assert!(matches!(check_callbacks(&config), Err(ConfigError::Callbacks(_))));

        // Alignment.
        let mut config = decode_good();
        config.callbacks_ptr += 2;
        assert!(matches!(check_callbacks(&config), Err(ConfigError::Callbacks(_))));

        // Length.
        let mut config = decode_good();
        config.callbacks_len = CALLBACKS_SIZE as u32 - 1;
        assert!(matches!(check_callbacks(&config), Err(ConfigError::Callbacks(_))));
    }

    #[test]
    fn the_first_failure_wins_and_later_checks_do_not_run() {
        let mut config = decode_good();
        // Everything is wrong at once: a mismatched ABI, a mismatched hash, an
        // impossible arena and callbacks.
        config.arena_size = 0;
        config.callbacks_ptr = 0;
        assert!(matches!(
            validate(&config, 2, 0xDEAD_BEEF),
            Err(ConfigError::AbiVersion { .. })
        ));

        // With the ABI right, the hash is next.
        config.abi_version = 2;
        assert!(matches!(
            validate(&config, 2, 0xDEAD_BEEF),
            Err(ConfigError::LayoutHash { .. })
        ));

        // With the hash right, C1 fires before C4 and the callbacks.
        config.layout_hash = layout_hash();
        assert!(matches!(
            validate(&config, 2, layout_hash()),
            Err(ConfigError::ArenaRelation(_))
        ));

        // With the sizes sane, C4 fires before the callbacks.
        config.arena_size = 16;
        config.max_arena_size = 16;
        assert!(matches!(
            validate(&config, 2, layout_hash()),
            Err(ConfigError::LayoutFit { .. })
        ));

        // With the layout fitting, the callbacks are the last word.
        config.arena_size = FLOOR as u32;
        config.max_arena_size = FLOOR as u32;
        config.callbacks_ptr = 0;
        assert!(matches!(
            validate(&config, 2, layout_hash()),
            Err(ConfigError::Callbacks(_))
        ));
    }

    #[test]
    fn the_ring_stride_is_the_event_record_size() {
        assert_eq!(RING_RECORD_STRIDE, super::super::arena::EVENT_RECORD_SIZE);
    }

    // ── §7.2: the regions the loaded capabilities declared ────────────────

    use super::super::arena::{JOB_OFFSET, JOB_SIZE, REGION_COUNT, REGION_JOB};

    /// One capability ("echo") declaring one region kind.
    fn need(kind: u32) -> RegionNeed {
        RegionNeed {
            kind,
            adapter: "echo".to_string(),
        }
    }

    #[test]
    fn an_empty_required_set_is_the_plain_validate() {
        let config = decode_good();
        assert_eq!(
            validate_with_regions(&config, 1, layout_hash(), &[]),
            Ok(())
        );
    }

    #[test]
    fn a_required_region_past_the_arena_is_refused_with_its_name() {
        let mut config = decode_good();
        // The live arena ends one alignment unit before JOB does: the region an
        // adapter cached at link time would be half-writable.
        config.arena_size = (JOB_OFFSET + JOB_SIZE - 16) as u32;
        let error = validate_with_regions(&config, 1, layout_hash(), &[need(REGION_JOB)])
            .expect_err("a truncated region is refused");
        assert_eq!(
            error,
            ConfigError::RegionTruncated {
                kind: REGION_JOB,
                adapter: "echo".to_string(),
                need: (JOB_OFFSET + JOB_SIZE) as u64,
                have: (JOB_OFFSET + JOB_SIZE - 16) as u32,
            }
        );
        let text = error.to_string();
        assert!(text.contains("JOB"), "names the region: {text}");
        assert!(text.contains("echo"), "names the adapter: {text}");
    }

    #[test]
    fn a_required_region_is_checked_before_the_layout_floor() {
        // The same arena is below the floor too, so this pins the *order*: the
        // capability-shaped refusal is the one the guest hears.
        let mut config = decode_good();
        config.arena_size = 4096;
        assert!(config.arena_size < FLOOR as u32, "the case needs both faults");
        assert!(matches!(
            validate_with_regions(&config, 1, layout_hash(), &[need(REGION_JOB)]),
            Err(ConfigError::RegionTruncated { .. })
        ));
        assert!(matches!(
            validate_with_regions(&config, 1, layout_hash(), &[]),
            Err(ConfigError::LayoutFit { .. })
        ));
    }

    #[test]
    fn a_region_kind_this_layout_does_not_define_is_refused() {
        let config = decode_good();
        let error = validate_with_regions(&config, 1, layout_hash(), &[need(REGION_COUNT as u32)])
            .expect_err("an unknown kind is refused");
        assert_eq!(
            error,
            ConfigError::UnknownRegion {
                kind: REGION_COUNT as u32,
                adapter: "echo".to_string(),
            }
        );
        assert!(error.to_string().contains("12"));
    }

    #[test]
    fn a_region_a_later_capability_declares_is_still_from_this_table() {
        // Every kind the check accepts has an offset the adapter was handed at
        // link time; kinds it refuses were refused there too (`-ENOENT`).
        let config = decode_good();
        for kind in 0..REGION_COUNT as u32 {
            assert_eq!(
                validate_with_regions(&config, 1, layout_hash(), &[need(kind)]),
                Ok(()),
                "kind {kind} fits the smallest legal arena"
            );
        }
    }

    // ── §6.1: the callbacks record may be absent ───────────────────────────

    #[test]
    fn an_absent_callbacks_record_is_legal() {
        let mut config = decode_good();
        config.callbacks_ptr = 0;
        config.callbacks_len = 0;
        assert_eq!(validate(&config, 1, layout_hash()), Ok(()));
    }

    #[test]
    fn a_pointer_without_a_length_is_refused() {
        let mut config = decode_good();
        config.callbacks_len = 0;
        // The pointer says a record is there; the length says it is not.
        assert!(matches!(
            validate(&config, 1, layout_hash()),
            Err(ConfigError::Callbacks(_))
        ));
    }

    #[test]
    fn a_length_without_a_pointer_is_refused() {
        let mut config = decode_good();
        config.callbacks_ptr = 0;
        assert!(matches!(
            validate(&config, 1, layout_hash()),
            Err(ConfigError::Callbacks(_))
        ));
    }

    #[test]
    fn a_callbacks_length_that_is_neither_absent_nor_the_record_is_refused() {
        let mut config = decode_good();
        config.callbacks_len = 8;
        assert!(matches!(
            validate(&config, 1, layout_hash()),
            Err(ConfigError::Callbacks(_))
        ));
    }
}
