//! `session` — the session component.
//!
//! The session owns the memory the guest imports, prepares the arena the guest
//! reads, and answers the two verbs that open and close it
//! (`tension-ogre/DESIGN.md` §4, §5, §6, §11). Delivery — `session_wait`,
//! `session_drain`, the subscriptions, the epoch, deferred submission — and the
//! adapter loader are later rounds; the ring headers written here are the
//! storage those phases will use, not a delivery mechanism.
//!
//! Why the session owns the memory at all (Model A, §4): the arena lives at
//! address 0, the guest's heap begins at `memoryBase`, and the session writes
//! the region table before the guest exists — so no pointer ever crosses the
//! boundary and the layout has exactly one author.
//!
//! The sequencing that makes the checks meaningful (§11):
//!
//! 1. **Before instantiation** — the session creates the memory, zeroes the
//!    whole band the module claims, writes the header page's structures, and
//!    lays the canary lattice over the reserved gap. The zeroing comes *first*:
//!    it is the baseline that makes "is the band still zero?" a complete test
//!    for a guest data segment landing inside the arena.
//! 2. **After `linker.instantiate`, before `_start_game`** —
//!    [`Session::verify_post_instantiate`] re-reads the control block's triple,
//!    checks the region band is still zero, and verifies the gap's lattice.
//! 3. **`session_open`** — the config is validated in the fixed check order,
//!    the callbacks are resolved and pinned, the ring headers are written, and
//!    the session moves to `READY`. A refusal leaves the state untouched.
//! 4. **`session_close`** — idempotent from every state; the memory is not
//!    freed, because it belongs to the store.
//!
//! The two wasmtime probes from the design round live at the bottom as
//! permanent regression tests: one `Memory` defined under two import names is
//! one memory, and a module's declared import type is readable before
//! instantiation.

// `arena` is crate-visible so the adapter registry can answer `region_lookup`
// from the one frozen layout rather than keeping a second copy of it.
pub(crate) mod arena;
mod config;
/// The posting face: the queues an adapter thread writes into, and the
/// sequence counter they share (`tension-ogre/DESIGN.md` §3.2, §7.2).
pub mod posting;
/// The arena side: the ten per-class sub-rings, and the transfer that moves a
/// class queue into its ring (`DESIGN.md` §3.3, §3.4).
pub mod subring;
/// The epoch: publish, invoke, apply — the only place delivery happens
/// (`DESIGN.md` §3.3).
pub mod epoch;
/// Deferred submission: the pending queue a callback writes into, and the apply
/// phase that drains it (`DESIGN.md` §3.5).
pub mod apply;

/// A capability's declared need for one region kind, re-exported because the
/// run hands the set from the registry to the session (`DESIGN.md` §7.2).
pub use config::RegionNeed;

use wasmtime::{
    AsContextMut, Caller, ExternType, Linker, Memory, MemoryType, Module, Ref, Store, Table,
    TypedFunc, WasmParams, WasmResults,
};
// The test harnesses build engines, modules and instances by hand; nothing in
// the session's own code constructs one (its `create_from_module` is handed
// both), so the import is gated rather than left to be reported as unused.
#[cfg(test)]
use wasmtime::{Config, Engine, Instance};

use crate::HostState;

// The two shapes the session's own fields are stated in: the class count and the
// slot count, both from the frozen layout.
use arena::{CALLBACKS_SLOTS, CLASS_COUNT};

/// The errno table at this boundary (`DESIGN.md` §6.2, §6.3). `EINVAL` is the
/// decoder's too, which is why it is declared here and imported by `config`:
/// the parent owns the ABI surface.
pub const EINVAL: i32 = -22;
/// The verb's state does not allow it.
pub const EBUSY: i32 = -16;
/// No session at all, or no such handle.
pub const EBADF: i32 = -9;
/// A callback trapped: the entry point that pumped returns `-EIO` (`§8`).
pub const EIO: i32 = -5;

/// A wasm page. The design's arithmetic is in 64 KiB units throughout (§4.1).
const WASM_PAGE_BYTES: usize = 64 * 1024;

/// The host's ceiling when a module declares no maximum, in pages (64 MiB).
///
/// `DESIGN.md` §4 leaves this number open; the *policy* is the note's — a
/// module that declares no maximum gets the host's cap rather than an unbounded
/// memory. The value is eight times the default `max_arena_size`: enough for a
/// game's heap beside the arena at the default configuration, small enough that
/// a runaway allocation loop fails instead of eating the host.
///
/// The alternative — refusing a module with no declared maximum — is the
/// stricter reading, and it costs nothing *today* because the build pipeline
/// always emits `--maximumMemory`. It was not chosen because it would refuse a
/// hand-built guest that is otherwise fine, and because the note already points
/// at the cap. A guest that needs more than this must declare `--maximumMemory`,
/// which also lets C2/C3 check it.
pub const HOST_CAP_PAGES: u32 = 1024;

/// The placeholder live arena until `session_open` reads the real value from the
/// config (2b). The layout's floor is the smallest legal arena, so this is the
/// conservative default: a session that never opens still has a coherent arena.
const DEFAULT_ARENA_SIZE: u32 = arena::LAYOUT_FLOOR as u32;

/// The session's state machine (`DESIGN.md` §6.3). The arena's control block
/// carries the same values as its *report*; this enum is the authoritative
/// machine, which lives host-side and is never guest-writable.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum SessionState {
    /// Memory exists; the structural arena is written; nothing validated.
    Uninit = 0,
    /// `session_open` succeeded.
    Ready = 1,
    /// Terminal until closed: a callback trap, an adapter fault, or a tamper.
    Faulted = 2,
    /// `session_close` completed.
    Closed = 3,
}

/// A refusal from the memory lifecycle. Every variant names what failed, so the
/// diagnostic does not need a debugger.
#[derive(Debug)]
pub enum SessionError {
    /// The verb needs a state the session is not in (`DESIGN.md` §6.3).
    NotUninit { state: SessionState },
    /// The `session_open` config was refused, with the decoder's reason.
    Config(config::ConfigError),
    /// The `Callbacks` record's ABI version is not this build's.
    CallbacksAbi { guest: u16, session: u16 },
    /// The `Callbacks` record claims more slots than this chunk defines.
    CallbacksSlots { count: u16 },
    /// A callbacks slot is filled but the guest exports no function table.
    TableMissing { slot: &'static str },
    /// A callbacks slot could not be resolved to a function of its signature.
    CallbackSlot { slot: &'static str, why: &'static str },
    /// The module declares no memory import at all.
    NoMemoryImport,
    /// The module declares more than one memory import; one arena is the model.
    MultipleMemoryImports,
    /// The memory import is under a name the session does not define.
    MemoryImportName { module: String, name: String },
    /// The import is a *shared* memory; the arena is not shared (the guest is
    /// single-stack and adapter threads never touch it).
    SharedMemoryUnsupported,
    /// The module's declared minimum exceeds the host's cap, so no provided
    /// memory could satisfy both the import match and the cap.
    CapBelowMinimum { min: u32, cap: u32 },
    /// A declared page count does not fit the `u32` the ABI uses.
    PageCountOutOfRange { which: &'static str, pages: u64 },
    /// wasmtime refused to create the memory.
    MemoryNew(String),
    /// The memory could not be defined in the linker.
    Link(String),
    /// The arena's frozen layout does not fit the band the module claims.
    ArenaDoesNotFit { need: usize, have: usize },
    /// A structural write failed.
    Layout(arena::LayoutError),
    /// The control block is not what the session wrote before instantiation.
    ControlBlock {
        field: &'static str,
        expected: u64,
        found: u64,
    },
    /// A canary block in the reserved gap was overwritten.
    Canary {
        offset: usize,
        expected: (u64, u64),
        found: (u64, u64),
    },
    /// The region band is not zero: something wrote into the arena before the
    /// guest ran, which is what a wrong `--memoryBase` looks like.
    BandNotZero { offset: usize },
    /// A verb that needs READY found another state (§6.3).
    NotReady { state: SessionState },
    /// A verb that would run an epoch inside an epoch was called from a callback.
    Reentrant,
    /// A delivery callback trapped. The slot is disabled, the session is
    /// FAULTED, and the verb returns `-EIO`.
    CallbackTrap { slot: &'static str },
    /// The sub-ring machinery refused: an arena the session did not write, or a
    /// class this chunk does not define.
    Subring(subring::SubringError),
    /// The arena memory is not installed in `HostState`, so nothing can deliver.
    ArenaLost,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::NotUninit { state } => write!(
                f,
                "session_open is refused in state {state:?}: the guest must close first"
            ),
            SessionError::Config(why) => write!(f, "{why}"),
            SessionError::CallbacksAbi { guest, session } => write!(
                f,
                "the Callbacks record states abiVersion {guest}; this session is {session}"
            ),
            SessionError::CallbacksSlots { count } => write!(
                f,
                "the Callbacks record states {count} slots; this chunk defines {} \
                 (a host cannot validate a signature it does not know)",
                arena::CALLBACKS_SLOTS
            ),
            SessionError::TableMissing { slot } => write!(
                f,
                "the `{slot}` slot is set but the guest exports no `table`; a callback slot is \
                 an index into the module's exported function table (`asc --exportTable`)"
            ),
            SessionError::CallbackSlot { slot, why } => {
                write!(f, "the `{slot}` callback could not be resolved: {why}")
            }
            SessionError::NoMemoryImport => write!(
                f,
                "the module declares no memory import; the session owns the arena, so every \
                 session guest must import it as env::memory or session::memory"
            ),
            SessionError::MultipleMemoryImports => write!(
                f,
                "the module declares more than one memory import; the session provides one arena"
            ),
            SessionError::MemoryImportName { module, name } => write!(
                f,
                "the module imports a memory as `{module}`::`{name}`; the session defines \
                 env::memory and session::memory"
            ),
            SessionError::SharedMemoryUnsupported => write!(
                f,
                "the module imports a shared memory; the session's arena memory is not shared"
            ),
            SessionError::CapBelowMinimum { min, cap } => write!(
                f,
                "the module declares a minimum of {min} pages, above the host's cap of {cap}: \
                 a smaller minimum or a larger HOST_CAP_PAGES is needed"
            ),
            SessionError::PageCountOutOfRange { which, pages } => {
                write!(f, "the declared {which} of {pages} pages does not fit a u32")
            }
            SessionError::MemoryNew(why) => write!(f, "the memory could not be created: {why}"),
            SessionError::Link(why) => {
                write!(f, "the arena memory could not be defined in the linker: {why}")
            }
            SessionError::ArenaDoesNotFit { need, have } => write!(
                f,
                "the arena needs {need} bytes but the memory provides {have}: the guest's \
                 --memoryBase (= max_arena_size) and its declared memory size disagree"
            ),
            SessionError::Layout(why) => write!(f, "the arena layout could not be written: {why:?}"),
            SessionError::ControlBlock { field, expected, found } => write!(
                f,
                "the arena control block's {field} is {found:#x}, not the {expected:#x} the \
                 session wrote before instantiation"
            ),
            SessionError::Canary { offset, expected, found } => write!(
                f,
                "the reserved gap's canary at {offset:#x} was overwritten: expected \
                 {:#018x}/{:#018x}, found {:#018x}/{:#018x}",
                expected.0, expected.1, found.0, found.1
            ),
            SessionError::BandNotZero { offset } => write!(
                f,
                "the region band is not zero at {offset:#x}: something wrote into the arena \
                 before the guest ran (a --memoryBase or data-segment overlap)"
            ),
            SessionError::NotReady { state } => write!(
                f,
                "this verb needs a READY session; the session is {state:?}"
            ),
            SessionError::Reentrant => write!(
                f,
                "this verb cannot run inside a callback: it would start an epoch within one"
            ),
            SessionError::CallbackTrap { slot } => write!(
                f,
                "the `{slot}` callback trapped: the slot is disabled and the session is FAULTED"
            ),
            SessionError::Subring(why) => write!(f, "{why}"),
            SessionError::ArenaLost => write!(
                f,
                "the arena memory is not installed in the host state, so nothing can be delivered"
            ),
        }
    }
}

impl std::error::Error for SessionError {}

impl SessionError {
    /// The errno the guest sees. Every refusal at this boundary is `-EINVAL`
    /// except three: a state the verb cannot run in (`-EBUSY` for `session_open`
    /// on a live session, `-EBADF` for a verb that needs READY), a callback that
    /// would run an epoch inside an epoch (`-EBUSY`), and a callback trap
    /// (`-EIO`).
    pub fn errno(&self) -> i32 {
        match self {
            SessionError::NotUninit { .. } => EBUSY,
            SessionError::NotReady { .. } => EBADF,
            SessionError::Reentrant => EBUSY,
            SessionError::CallbackTrap { .. } => EIO,
            _ => EINVAL,
        }
    }
}

impl From<config::ConfigError> for SessionError {
    fn from(error: config::ConfigError) -> Self {
        SessionError::Config(error)
    }
}

impl From<arena::LayoutError> for SessionError {
    fn from(error: arena::LayoutError) -> Self {
        SessionError::Layout(error)
    }
}

/// The session's memory lifecycle. Everything here is host-side state; the
/// arena is the guest's view of the same facts (`DESIGN.md` §5).
#[derive(Debug)]
pub struct Session {
    /// The arena memory, owned by the session and imported by the guest.
    memory: Memory,
    /// The pages the module declared as its minimum — what the host provides.
    declared_min_pages: u32,
    /// The pages the module declared as its maximum, if it declared one.
#[cfg_attr(not(test), allow(dead_code))] // read by `declared_pages()` below, which the tests call; the run path reads the memory type directly
    declared_max_pages: Option<u32>,
    /// Where the guest's own segments and heap begin: the reserved band's top.
    /// Equal to `max_arena_size` by the §4.1 identity.
    memory_base: u32,
    /// The pages the memory was created with, and the ceiling it was capped to.
    initial_pages: u32,
    max_pages: u32,
    /// The live arena and its reserved ceiling. Placeholders until 2b reads
    /// them from the open config.
    arena_size: u32,
    max_arena_size: u32,
    /// The compiled-in shape hash this session was built against.
    layout_hash: u32,
    /// The region kinds the loaded adapters declared during `link`, in the order
    /// they were first asked about (`DESIGN.md` §7.2). Empty when no adapter is
    /// loaded, which is what makes the check a no-op for a plain run.
    required_regions: Vec<config::RegionNeed>,
    /// The delivery callbacks resolved at open and pinned by signature. `None`
    /// before an open, and cleared by a close: they belong to one session.
    callbacks: Option<ResolvedCallbacks>,
    /// Slots a callback trap has disabled: `[onBatch, onEvent]`. The design's
    /// rule is "permanently, for the adapter's lifetime", and the session is the
    /// longest-lived thing that knows about an adapter, so the flag lives here
    /// and a re-open does not clear it.
    disabled_slots: [bool; CALLBACKS_SLOTS as usize],
    /// The live ring capacities from the open config: the geometry every
    /// sub-ring operation is a function of (a guest may override the defaults).
    ring_capacities: [u32; CLASS_COUNT],
    /// How many deferred submissions have failed to apply. Not guest-visible in
    /// chunk 1 (`FrameState` has no field for it yet): the guest learns about a
    /// failure from the `SUBMISSION_REJECTED` delivery, and this counter is the
    /// operator's line in the log.
    rejections: u32,
    /// The session's own epoch counter, reported as `FrameState.frameIndex`.
    /// Not the renderer's frame number: this counts epochs, and an epoch happens
    /// when the guest waits.
    frame_index: u32,
    state: SessionState,
}

impl Session {
    /// Read the module's declared memory import type and create the memory from
    /// it — the F3 policy: the host mirrors what the guest's build declares and
    /// caps it, rather than choosing page counts.
    ///
    /// Does not touch the linker: definition is [`Session::install`]'s job, so a
    /// session can be inspected before anything is linked.
    pub fn create_from_module(
        store: &mut Store<HostState>,
        module: &Module,
    ) -> Result<Session, SessionError> {
        let mut declarations = Vec::new();
        for import in module.imports() {
            if let ExternType::Memory(ty) = import.ty() {
                declarations.push((import.module().to_string(), import.name().to_string(), ty));
            }
        }

        let (module_name, field, ty) = match declarations.len() {
            0 => return Err(SessionError::NoMemoryImport),
            1 => declarations.pop().expect("one declaration"),
            _ => return Err(SessionError::MultipleMemoryImports),
        };

        // The session defines the memory under both names (F1: the AssemblyScript
        // toolchain emits `env::memory`, Tension documents `session::memory`), so
        // those are the two a guest may use. Any other pair would be an unknown
        // import at instantiation; refusing it here names the fix.
        if !((module_name == "env" || module_name == "session") && field == "memory") {
            return Err(SessionError::MemoryImportName {
                module: module_name,
                name: field,
            });
        }
        if ty.is_shared() {
            return Err(SessionError::SharedMemoryUnsupported);
        }

        let declared_min = ty.minimum();
        let declared_max = ty.maximum();
        let declared_min_pages =
            u32::try_from(declared_min).map_err(|_| SessionError::PageCountOutOfRange {
                which: "minimum",
                pages: declared_min,
            })?;
        let declared_max_pages = match declared_max {
            Some(pages) => Some(u32::try_from(pages).map_err(|_| {
                SessionError::PageCountOutOfRange {
                    which: "maximum",
                    pages,
                }
            })?),
            None => None,
        };

        // The host's ceiling: the declared maximum, or HOST_CAP_PAGES when the
        // module declared none (see that constant for the reasoning). The
        // provided maximum may never exceed the declared one — C3, probe-pinned.
        let max_pages = declared_max_pages
            .map(|pages| pages.min(HOST_CAP_PAGES))
            .unwrap_or(HOST_CAP_PAGES);
        if max_pages < declared_min_pages {
            return Err(SessionError::CapBelowMinimum {
                min: declared_min_pages,
                cap: max_pages,
            });
        }

        let memory = Memory::new(store, MemoryType::new(declared_min_pages, Some(max_pages)))
            .map_err(|error| SessionError::MemoryNew(error.to_string()))?;

        let max_arena_size = arena::DEFAULT_MAX_ARENA_SIZE as u32;
        Ok(Session {
            memory,
            declared_min_pages,
            declared_max_pages,
            memory_base: max_arena_size,
            initial_pages: declared_min_pages,
            max_pages,
            arena_size: DEFAULT_ARENA_SIZE,
            max_arena_size,
            layout_hash: arena::layout_hash(),
            required_regions: Vec::new(),
            callbacks: None,
            disabled_slots: [false; CALLBACKS_SLOTS as usize],
            ring_capacities: arena::DEFAULT_RING_CAPACITIES,
            rejections: 0,
            frame_index: 0,
            state: SessionState::Uninit,
        })
    }

    /// Hand the session the regions the loaded capabilities declared. Called by
    /// the run, after every adapter's `link` and before the guest can call
    /// `session_open`; the check itself is `session_open`'s (§7.2).
    pub fn set_required_regions(&mut self, required: Vec<config::RegionNeed>) {
        self.required_regions = required;
    }

    /// What the capabilities declared, for the log and for the tests.
#[cfg_attr(not(test), allow(dead_code))] // test-facing accessors: the tests read the decoded geometry to pin the four-number memory relation; the epoch is the intended non-test caller
    pub fn required_regions(&self) -> &[config::RegionNeed] {
        &self.required_regions
    }

    /// Define the arena memory in the linker under both import names. Both names
    /// resolve to the same object — probe-pinned, and the reason an
    /// AssemblyScript guest and a hand-written guest see one arena.
    pub fn install(
        &self,
        store: &mut Store<HostState>,
        linker: &mut Linker<HostState>,
    ) -> Result<(), SessionError> {
        linker
            .define(&mut *store, "env", "memory", self.memory)
            .map_err(|error| SessionError::Link(error.to_string()))?;
        linker
            .define(&mut *store, "session", "memory", self.memory)
            .map_err(|error| SessionError::Link(error.to_string()))?;
        Ok(())
    }

    /// Write the structural arena, before instantiation.
    ///
    /// The order is load-bearing: **zero the band first**, then write the
    /// structures, then the lattice. Zeroing afterwards would erase everything
    /// this function exists to write — and zeroing first is what leaves the
    /// region band as a blank sheet that a guest data segment cannot touch
    /// without being noticed.
    pub fn prepare_arena(&mut self, store: &mut Store<HostState>) -> Result<(), SessionError> {
        // What the module claims as its own, and what the layout needs: the
        // larger of the frozen layout's end and the guest's `memoryBase`.
        let declared_band = (self.declared_min_pages as usize) * WASM_PAGE_BYTES;
        let need = arena::LAYOUT_FLOOR.max(self.memory_base as usize);

        let data = self.memory.data_mut(&mut *store);
        let band = declared_band.min(data.len());
        if band < need {
            return Err(SessionError::ArenaDoesNotFit { need, have: band });
        }

        // 1. The baseline: everything the module claims reads as zero, so any
        //    later nonzero byte is evidence of an overlap.
        arena::zero_band(data, 0, band)?;

        // 2. The header page's structures.
        arena::write_control_block(data, self.max_arena_size)?;
        arena::write_session_info(
            data,
            &arena::SessionInfoValues {
                arena_size: self.arena_size,
                max_arena_size: self.max_arena_size,
                memory_base: self.memory_base,
                initial_pages: self.initial_pages,
                max_pages: self.max_pages,
                open_nonce: 0,
                class_capacities: arena::DEFAULT_RING_CAPACITIES,
            },
        )?;
        arena::write_region_table(data)?;
        arena::write_manifest(data)?;

        // 3. The reserved gap's lattice — the runtime detector for the range
        //    nothing legitimately writes (§5.4).
        arena::write_canary_lattice(data, arena::LAYOUT_FLOOR, self.memory_base as usize)?;

        // The state stays UNINIT in this round: `session_open` is what makes it
        // READY, and nothing in 2a can.
        self.state = SessionState::Uninit;
        Ok(())
    }

    /// Verify the arena after `linker.instantiate` has run the module's data
    /// segments, and before `_start_game`. Three checks, cheapest first:
    ///
    /// 1. the control block's triple — magic, layout hash, region count — which
    ///    is what the always-arena range is protected by (§5.4);
    /// 2. the region band is still all zero, which is a *complete* test for a
    ///    data segment landing inside the live arena, because
    ///    [`Session::prepare_arena`] zeroed it and nothing else writes there
    ///    before the guest runs;
    /// 3. the reserved gap's canary lattice, which names the first block that
    ///    was overwritten.
    pub fn verify_post_instantiate(&self, store: &Store<HostState>) -> Result<(), SessionError> {
        let data = self.memory.data(&*store);
        let memory_base = self.memory_base as usize;
        if data.len() < memory_base {
            return Err(SessionError::ArenaDoesNotFit {
                need: memory_base,
                have: data.len(),
            });
        }

        // 1. The triple.
        let magic = arena::control_magic(data);
        if magic != arena::MAGIC {
            return Err(SessionError::ControlBlock {
                field: "magic",
                expected: arena::MAGIC,
                found: magic,
            });
        }
        let hash = arena::control_layout_hash(data) as u64;
        if hash != self.layout_hash as u64 {
            return Err(SessionError::ControlBlock {
                field: "layout_hash",
                expected: self.layout_hash as u64,
                found: hash,
            });
        }
        let regions = arena::control_region_count(data) as u64;
        if regions != arena::REGION_COUNT as u64 {
            return Err(SessionError::ControlBlock {
                field: "region_count",
                expected: arena::REGION_COUNT as u64,
                found: regions,
            });
        }

        // 2. The band the guest's data segments must not reach.
        if let Err(offset) = arena::verify_band_is_zero(data, arena::HEADER_PAGE_SIZE, arena::LAYOUT_FLOOR)
        {
            return Err(SessionError::BandNotZero { offset });
        }

        // 3. The reserved gap's lattice.
        if let Err(offset) = arena::verify_canary_lattice(data, arena::LAYOUT_FLOOR, memory_base) {
            let expected = arena::canary_expected(offset);
            let found = (
                u64::from_le_bytes(data[offset..offset + 8].try_into().expect("eight bytes")),
                u64::from_le_bytes(
                    data[offset + 8..offset + 16].try_into().expect("eight bytes"),
                ),
            );
            return Err(SessionError::Canary {
                offset,
                expected,
                found,
            });
        }

        Ok(())
    }

    /// The authoritative state machine. `UNINIT` until 2b's `session_open`.
    pub fn state(&self) -> SessionState {
        self.state
    }

    /// The arena memory handle, for a caller that needs to define it elsewhere
    /// or inspect it (tests, and `main.rs`'s instantiation path).
    pub fn memory(&self) -> Memory {
        self.memory
    }

    /// The live arena size (a placeholder until 2b).
#[cfg_attr(not(test), allow(dead_code))]
    pub fn arena_size(&self) -> u32 {
        self.arena_size
    }

    /// The reserved ceiling, also the guest's `memoryBase`.
    pub fn max_arena_size(&self) -> u32 {
        self.max_arena_size
    }

    /// Where the guest's own segments and heap begin.
#[cfg_attr(not(test), allow(dead_code))]
    pub fn memory_base(&self) -> u32 {
        self.memory_base
    }

    /// The page counts the memory was created with.
#[cfg_attr(not(test), allow(dead_code))]
    pub fn pages(&self) -> (u32, u32) {
        (self.initial_pages, self.max_pages)
    }

    /// The pages the module declared, for diagnostics and for C2/C3 in 2b.
#[cfg_attr(not(test), allow(dead_code))]
    pub fn declared_pages(&self) -> (u32, Option<u32>) {
        (self.declared_min_pages, self.declared_max_pages)
    }

    /// The shape hash this session was built against.
#[cfg_attr(not(test), allow(dead_code))]
    pub fn layout_hash(&self) -> u32 {
        self.layout_hash
    }
}

// ── the verb surface (A1 2b) ──────────────────────────────────────────────

/// One line per verb call and per refusal on stderr, prefixed the way every
/// service in this repo prefixes its trace (`DESIGN.md` §6.1: the wasm boundary
/// has no error channel, so this is where a refusal is explained).
fn log(message: &str) {
    eprintln!("[tension:session] {message}");
}

/// A fresh nonce for one open. It is a *staleness witness* — it lets the host
/// tell the arena of a previous session apart from the live one — and nothing
/// more: it is not a secret, and no mechanism may treat it as one. It is never
/// zero, because zero is the "unset" value the arena is zeroed to.
fn fresh_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0);
    let mut mixed = nanos ^ sequence.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    mixed ^= mixed >> 33;
    mixed = mixed.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    mixed ^= mixed >> 33;
    mixed | 1
}

/// The guest's delivery callbacks, resolved once at `session_open` and pinned by
/// `TypedFunc` so a mis-shaped table entry fails the open rather than the first
/// delivery (`DESIGN.md` §8).
#[derive(Default)]
pub struct ResolvedCallbacks {
    /// `i32 (class, table_ptr, count)`.
    pub on_batch: Option<TypedFunc<(i32, i32, i32), i32>>,
    /// `i32 (class, ptr)`.
    pub on_event: Option<TypedFunc<(i32, i32), i32>>,
}

/// `TypedFunc` is not `Debug`, so the derived form is replaced by one that says
/// which slots are filled — which is all a diagnostic needs.
impl std::fmt::Debug for ResolvedCallbacks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedCallbacks")
            .field("on_batch", &self.on_batch.is_some())
            .field("on_event", &self.on_event.is_some())
            .finish()
    }
}

impl ResolvedCallbacks {
    /// Whether the guest registered nothing at all.
#[cfg_attr(not(test), allow(dead_code))] // tests assert on the resolved table; the epoch reads the resolved slots directly
    pub fn is_empty(&self) -> bool {
        self.on_batch.is_none() && self.on_event.is_none()
    }

    /// How many slots are filled, for the open's one-line trace.
#[cfg_attr(not(test), allow(dead_code))]
    pub fn count(&self) -> u32 {
        self.on_batch.is_some() as u32 + self.on_event.is_some() as u32
    }
}

impl Session {
    /// Resolve one guest callback slot: a function-table index, pinned to the
    /// signature the design declares. `index == 0` never reaches here — zero is
    /// "absent" in the record.
    pub fn resolve_callback<C, Params, Results>(
        store: &mut C,
        table: &Table,
        index: u32,
        slot: &'static str,
    ) -> Result<TypedFunc<Params, Results>, SessionError>
    where
        C: AsContextMut<Data = HostState>,
        Params: WasmParams,
        Results: WasmResults,
    {
        let Some(entry) = table.get(&mut *store, index) else {
            return Err(SessionError::CallbackSlot {
                slot,
                why: "the index is past the end of the exported table",
            });
        };
        let Ref::Func(Some(func)) = entry else {
            return Err(SessionError::CallbackSlot {
                slot,
                why: "the index holds no function (a null entry)",
            });
        };
        func.typed::<Params, Results>(&*store).map_err(|_| {
            SessionError::CallbackSlot {
                slot,
                why: "the function's signature does not match the declared one",
            }
        })
    }

    /// Resolve the whole `Callbacks` record. A record with both slots zero is
    /// legal and needs no table: a guest that wants polling only is a guest that
    /// registers no callbacks.
    pub fn resolve_callbacks<C>(
        store: &mut C,
        table: Option<&Table>,
        record: &arena::CallbacksRecord,
    ) -> Result<ResolvedCallbacks, SessionError>
    where
        C: AsContextMut<Data = HostState>,
    {
        if record.on_batch == 0 && record.on_event == 0 {
            return Ok(ResolvedCallbacks::default());
        }
        let table = table.ok_or(SessionError::TableMissing {
            slot: if record.on_batch != 0 { "onBatch" } else { "onEvent" },
        })?;
        let on_batch = if record.on_batch == 0 {
            None
        } else {
            Some(Self::resolve_callback::<_, (i32, i32, i32), i32>(
                store,
                table,
                record.on_batch,
                "onBatch",
            )?)
        };
        let on_event = if record.on_event == 0 {
            None
        } else {
            Some(Self::resolve_callback::<_, (i32, i32), i32>(
                store,
                table,
                record.on_event,
                "onEvent",
            )?)
        };
        Ok(ResolvedCallbacks { on_batch, on_event })
    }

    /// The open gate: `UNINIT` and `CLOSED` may open; `READY` and `FAULTED` may
    /// not — a faulted session has half-published state and must be closed
    /// first (`DESIGN.md` §6.3).
    fn open_state_check(&self) -> Result<(), SessionError> {
        match self.state {
            SessionState::Uninit | SessionState::Closed => Ok(()),
            other => Err(SessionError::NotUninit { state: other }),
        }
    }

    /// The gate every later (A2) verb uses: `READY`, or `-EBADF`. `open` and
    /// `close` deliberately do not use it — one may run in `UNINIT`, the other
    /// in every state.
    pub fn require_ready(&self) -> i32 {
        if self.state == SessionState::Ready {
            0
        } else {
            EBADF
        }
    }

    /// The `Callbacks` record's own header, checked before any slot is looked
    /// up: the ABI version it was built against (strict — an unset record is a
    /// mis-built guest, not an old one) and that it does not claim slots this
    /// build cannot validate.
    fn check_callbacks_record(
        &self,
        record: &arena::CallbacksRecord,
    ) -> Result<(), SessionError> {
        if record.abi_version != arena::ABI_VERSION {
            return Err(SessionError::CallbacksAbi {
                guest: record.abi_version,
                session: arena::ABI_VERSION,
            });
        }
        if record.slot_count > arena::CALLBACKS_SLOTS {
            return Err(SessionError::CallbacksSlots {
                count: record.slot_count,
            });
        }
        Ok(())
    }

    /// The design's §11 step 3, re-checked at open: the control block's triple
    /// and the reserved gap's lattice as the session left them. A guest that
    /// scribbled on the arena between instantiation and its first `open` is
    /// caught here rather than trusted.
    ///
    /// The band's zero sweep is deliberately *not* repeated: it belongs to
    /// `verify_post_instantiate`, before the guest's first instruction, and a
    /// guest is allowed to stage records into the region band before it opens.
    fn verify_open_preconditions(
        &self,
        arena_bytes: &[u8],
        memory_base: usize,
    ) -> Result<(), SessionError> {
        let magic = arena::control_magic(arena_bytes);
        if magic != arena::MAGIC {
            return Err(SessionError::ControlBlock {
                field: "magic",
                expected: arena::MAGIC,
                found: magic,
            });
        }
        let hash = arena::control_layout_hash(arena_bytes) as u64;
        if hash != self.layout_hash as u64 {
            return Err(SessionError::ControlBlock {
                field: "layout_hash",
                expected: self.layout_hash as u64,
                found: hash,
            });
        }
        let regions = arena::control_region_count(arena_bytes) as u64;
        if regions != arena::REGION_COUNT as u64 {
            return Err(SessionError::ControlBlock {
                field: "region_count",
                expected: arena::REGION_COUNT as u64,
                found: regions,
            });
        }

        // The lattice was laid over the placeholder's gap; a guest that moved
        // `memoryBase` down gets the smaller of the two extents checked.
        let end = memory_base.min(self.memory_base as usize);
        if end > arena::LAYOUT_FLOOR {
            if let Err(offset) = arena::verify_canary_lattice(arena_bytes, arena::LAYOUT_FLOOR, end)
            {
                let expected = arena::canary_expected(offset);
                let found = (
                    u64::from_le_bytes(
                        arena_bytes[offset..offset + 8].try_into().expect("eight bytes"),
                    ),
                    u64::from_le_bytes(
                        arena_bytes[offset + 8..offset + 16]
                            .try_into()
                            .expect("eight bytes"),
                    ),
                );
                return Err(SessionError::Canary {
                    offset,
                    expected,
                    found,
                });
            }
        }
        Ok(())
    }

    /// The second half of `session_open`: everything after the guest's bytes are
    /// in hand and the callbacks are resolved. Split out so it is testable
    /// without a guest — `arena_bytes` is the memory's own slice.
    pub fn apply_open(
        &mut self,
        arena_bytes: &mut [u8],
        decoded: &config::SessionConfig,
        callbacks_record: &arena::CallbacksRecord,
        resolved: ResolvedCallbacks,
    ) -> Result<(), SessionError> {
        self.open_state_check()?;
        self.check_callbacks_record(callbacks_record)?;
        // The verb validates before it reads the callbacks bytes (it needs a
        // validated pointer to read them at all); this second pass makes
        // `apply_open` self-sufficient, so no caller can reach the writes
        // without the checks.
        config::validate_with_regions(
            decoded,
            arena::ABI_VERSION as u32,
            self.layout_hash,
            &self.required_regions,
        )?;

        // The ceiling the guest states is also its `--memoryBase`, so it must
        // fit the memory the module declared; otherwise the guest's own
        // segments would be asked to start past the end of it.
        let memory_size = arena_bytes.len();
        for (what, size) in [
            ("arena_size", decoded.arena_size),
            ("max_arena_size", decoded.max_arena_size),
        ] {
            if size as usize > memory_size {
                log(&format!(
                    "session::open refused: {what} {size} exceeds the memory's {memory_size} bytes"
                ));
                return Err(SessionError::ArenaDoesNotFit {
                    need: size as usize,
                    have: memory_size,
                });
            }
        }

        // The arena as the session left it, before this open blesses it.
        self.verify_open_preconditions(arena_bytes, decoded.max_arena_size as usize)?;

        let nonce = fresh_nonce();

        // The control block's guest-owned half was written once at prepare; the
        // total size is restated here because the ceiling is only now known.
        arena::write_control_block(arena_bytes, decoded.max_arena_size)?;
        arena::set_control_state(arena_bytes, arena::STATE_READY)?;
        arena::set_control_fault_code(arena_bytes, 0)?;
        arena::set_control_nonce(arena_bytes, nonce)?;

        arena::write_session_info(
            arena_bytes,
            &arena::SessionInfoValues {
                arena_size: decoded.arena_size,
                max_arena_size: decoded.max_arena_size,
                memory_base: decoded.max_arena_size,
                initial_pages: self.initial_pages,
                max_pages: self.max_pages,
                open_nonce: nonce,
                class_capacities: decoded.ring_capacities,
            },
        )?;

        // One ring header per class, at the offsets its capacity implies.
        for (class, capacity) in decoded.ring_capacities.iter().enumerate() {
            arena::write_ring_header(
                arena_bytes,
                arena::ring_offset(&decoded.ring_capacities, class),
                *capacity,
            )?;
        }

        self.arena_size = decoded.arena_size;
        self.max_arena_size = decoded.max_arena_size;
        self.memory_base = decoded.max_arena_size;
        self.ring_capacities = decoded.ring_capacities;
        self.callbacks = Some(resolved);
        self.state = SessionState::Ready;
        Ok(())
    }

    /// The host's own open, for A1's convenience path (`--session-open` in
    /// `main.rs`). It reaches the same `apply_open` the verb does, with the
    /// config built here instead of decoded out of a guest's stream and with no
    /// callbacks record — the two things the verb adds on top.
    ///
    /// It exists because A1 has no guest SDK yet: a fixture cannot carry a
    /// config blob it has no encoder for, and the alternative (a fixture that
    /// hand-writes the TLV) would put a second writer of the wire format in the
    /// tree, which § 6.1 reserves for the SDK. It is **not** the design's
    /// contract — a real guest calls `session_open` itself — which is why the
    /// flag that reaches it is test-only and says so.
    ///
    /// `arena_size` and `max_arena_size` are stated by the caller rather than
    /// defaulted here, so this path exercises the same config checks the verb's
    /// does, including the required-region check.
#[cfg_attr(not(test), allow(dead_code))] // the tests' two-argument door; the run path calls `open_from_host_with_callbacks`
    pub fn open_from_host(
        &mut self,
        arena_bytes: &mut [u8],
        arena_size: u32,
        max_arena_size: u32,
    ) -> Result<(), SessionError> {
        self.open_from_host_with_callbacks(
            arena_bytes,
            arena_size,
            max_arena_size,
            &arena::CallbacksRecord::absent(),
            ResolvedCallbacks::default(),
        )
    }

    /// The host's open with a callbacks record the caller resolved — the case
    /// A2b's fixtures need: a guest whose `onBatch` is registered without the
    /// guest sending a config TLV of its own. `resolved` is what
    /// [`Session::resolve_callbacks`] returned for `record` against the module's
    /// exported table.
    pub fn open_from_host_with_callbacks(
        &mut self,
        arena_bytes: &mut [u8],
        arena_size: u32,
        max_arena_size: u32,
        record: &arena::CallbacksRecord,
        resolved: ResolvedCallbacks,
    ) -> Result<(), SessionError> {
        let decoded = config::SessionConfig {
            abi_version: arena::ABI_VERSION as u32,
            layout_hash: self.layout_hash,
            arena_size,
            max_arena_size,
            // No callbacks record: the whole-record form of "every slot absent"
            // (§6.1), which is what a guest that only reads the arena wants.
            callbacks_ptr: 0,
            callbacks_len: 0,
            ring_capacities: arena::DEFAULT_RING_CAPACITIES,
            ring_stated: [false; arena::CLASS_COUNT],
        };
        self.apply_open(arena_bytes, &decoded, record, resolved)
    }

    /// Close the session. Idempotent from every state. The memory is not freed
    /// and the arena's bytes are left alone apart from the state report: the
    /// memory belongs to the store, and a re-open rewrites what it needs.
    pub fn close(&mut self, arena_bytes: &mut [u8]) -> Result<(), SessionError> {
        if self.state == SessionState::Closed {
            return Ok(());
        }
        arena::set_control_state(arena_bytes, arena::STATE_CLOSED)?;
        self.callbacks = None;
        self.state = SessionState::Closed;
        Ok(())
    }

    /// The callbacks this session resolved at open, for the delivery phase and
    /// for the tests.
    pub fn callbacks(&self) -> Option<&ResolvedCallbacks> {
        self.callbacks.as_ref()
    }

    /// Whether a callback trap has disabled this slot for the session's life.
    pub fn slot_disabled(&self, slot: usize) -> bool {
        self.disabled_slots.get(slot).copied().unwrap_or(true)
    }

    /// Disable a slot. The design's rule: a trapping callback is never entered
    /// again, and the other slot keeps working.
    pub fn disable_slot(&mut self, slot: u32) {
        if let Some(flag) = self.disabled_slots.get_mut(slot as usize) {
            *flag = true;
        }
    }

    /// The live ring capacities this session opened with.
    pub fn ring_capacities(&self) -> &[u32; CLASS_COUNT] {
        &self.ring_capacities
    }

    /// The epoch counter, as `FrameState.frameIndex` reports it.
    pub fn frame_index(&self) -> u32 {
        self.frame_index
    }

    /// Advance it. One epoch, one frame: an epoch happens when the guest waits.
    pub fn bump_frame_index(&mut self) {
        self.frame_index = self.frame_index.wrapping_add(1);
    }

    /// Terminal until closed: a callback trap or an adapter fault.
    pub fn fault(&mut self) {
        self.state = SessionState::Faulted;
    }

    /// One deferred submission failed to apply. Logged, counted, and turned into
    /// a `SUBMISSION_REJECTED` delivery by the caller.
    pub fn note_rejection(&mut self) {
        self.rejections = self.rejections.saturating_add(1);
    }

    /// How many submissions have been rejected this session.
#[cfg_attr(not(test), allow(dead_code))] // tests read the count; the bin build increments it and logs it but never asks
    pub fn rejections(&self) -> u32 {
        self.rejections
    }
}

/// Read `len` bytes at `ptr` out of the session's memory, or `None` when the
/// range does not fit. The memory handle is passed in rather than looked up in
/// `HostState`: the verbs take the session *out* of the store for the duration
/// of the call, so `HostState.session` is empty while they run.
fn read_guest(
    caller: &mut Caller<'_, HostState>,
    memory: Memory,
    ptr: u32,
    len: u32,
) -> Option<Vec<u8>> {
    let data = memory.data(&*caller);
    let start = ptr as usize;
    let end = start.checked_add(len as usize)?;
    if end > data.len() {
        return None;
    }
    Some(data[start..end].to_vec())
}

/// `session::open(cfg_ptr, cfg_len) -> i32`.
///
/// The guest's bytes are read on the guest thread inside this call — the arena's
/// rendezvous (`DESIGN.md` §4). The session is taken out of the store for the
/// duration, because the memory handle it owns is reached through the very store
/// this call borrows; it is put back on every path, including a refusal, so a
/// refused open leaves a live session behind it.
pub fn session_open(caller: &mut Caller<'_, HostState>, cfg_ptr: u32, cfg_len: u32) -> i32 {
    let Some(mut session) = caller.data_mut().session.take() else {
        log("session_open refused: no session is installed");
        return EBADF;
    };
    let outcome = open_with_caller(&mut session, caller, cfg_ptr, cfg_len);
    caller.data_mut().session = Some(session);
    outcome
}

fn open_with_caller(
    session: &mut Session,
    caller: &mut Caller<'_, HostState>,
    cfg_ptr: u32,
    cfg_len: u32,
) -> i32 {
    // 1. State.
    if let Err(error) = session.open_state_check() {
        log(&format!("session_open -> {} ({error})", error.errno()));
        return error.errno();
    }

    // The session's own memory handle: the verbs read and write the arena
    // through it, never through the module's `memory` export (that export is a
    // separate, load-time concern — and at this point the session is out of the
    // store, so there is nothing else to use).
    let memory = session.memory();

    // 2. The config bytes.
    let Some(cfg) = read_guest(caller, memory, cfg_ptr, cfg_len) else {
        log(&format!(
            "session_open -> -EINVAL (the config range ({cfg_ptr:#x}, {cfg_len}) is outside the memory)"
        ));
        return EINVAL;
    };

    // 3. Decode, then the fixed check order — abi_version, layout_hash, C1, the
    //    required regions (§7.2), C4, ring capacities, callbacks range. The
    //    decoder's first failure is the one reported; nothing here reorders it.
    let decoded = match config::decode(&cfg) {
        Ok(config) => config,
        Err(error) => {
            log(&format!("session_open -> -EINVAL ({error})"));
            return error.errno();
        }
    };
    if let Err(error) = config::validate_with_regions(
        &decoded,
        arena::ABI_VERSION as u32,
        arena::layout_hash(),
        &session.required_regions,
    ) {
        log(&format!("session_open -> -EINVAL ({error})"));
        return error.errno();
    }

    // 4. The callbacks record. `callbacks_len == 0` means the guest registered
    //    nothing (§6.1, §8): the record a zeroed one would have been, with no
    //    bytes read and no table needed. Otherwise the bytes are read only now
    //    that the config that names them has been accepted.
    let (record, resolved) = if decoded.callbacks_len == 0 {
        (arena::CallbacksRecord::absent(), ResolvedCallbacks::default())
    } else {
        let Some(bytes) = read_guest(caller, memory, decoded.callbacks_ptr, decoded.callbacks_len)
        else {
            log(&format!(
                "session_open -> -EINVAL (the callbacks range ({:#x}, {}) is outside the memory)",
                decoded.callbacks_ptr, decoded.callbacks_len
            ));
            return EINVAL;
        };
        let record = arena::read_callbacks(&bytes, 0);

        // 5. Resolve the slots eagerly: a mis-shaped entry fails the open, not
        //    the first delivery.
        let table = caller.get_export("table").and_then(|export| export.into_table());
        match Session::resolve_callbacks(&mut *caller, table.as_ref(), &record) {
            Ok(resolved) => (record, resolved),
            Err(error) => {
                log(&format!("session_open -> {} ({error})", error.errno()));
                return error.errno();
            }
        }
    };

    // 6. Apply: verify what the session left, then write the rings, the control
    //    block and SessionInfo, and move to READY.
    let outcome = {
        let arena_bytes = memory.data_mut(&mut *caller);
        session.apply_open(arena_bytes, &decoded, &record, resolved)
    };
    match outcome {
        Ok(()) => {
            // A close sets the wait state's shutdown flag so a blocked wait is
            // woken; a re-open clears it, or the fresh session would answer every
            // wait as if it were closing.
            caller.data().posting.clear_shutdown();
            log(&format!(
                "session_open(cfg_len={cfg_len}, arena={}, ceiling={}) -> 0",
                decoded.arena_size, decoded.max_arena_size
            ));
            0
        }
        Err(error) => {
            log(&format!("session_open -> {} ({error})", error.errno()));
            error.errno()
        }
    }
}

/// `session::close() -> i32`. Idempotent from every state; the only verb that is.
pub fn session_close(caller: &mut Caller<'_, HostState>) -> i32 {
    let Some(mut session) = caller.data_mut().session.take() else {
        log("session_close -> -EBADF (no session is installed)");
        return EBADF;
    };
    let memory = session.memory();
    let outcome = {
        let arena_bytes = memory.data_mut(&mut *caller);
        session.close(arena_bytes)
    };
    // A blocked `session_wait` must not be left holding the guest thread when the
    // session goes away: the wait state is a flag beside the condvar, and this is
    // the one place A2b sets it (A2c adds the fault path).
    caller.data().posting.set_shutdown();
    caller.data_mut().session = Some(session);
    match outcome {
        Ok(()) => {
            log("session_close() -> 0");
            0
        }
        Err(error) => {
            log(&format!("session_close -> {} ({error})", error.errno()));
            error.errno()
        }
    }
}

/// Run one epoch-verb: the session comes out of the store for the duration —
/// it is `&mut Session` inside the store and the epoch needs `&mut Caller` at
/// the same time — and goes back on every path, including a refusal.
///
/// The return value is the guest's: the delivery count, `0` for an epoch that
/// delivered nothing, or a negative errno.
fn run_epoch_verb(
    caller: &mut Caller<'_, HostState>,
    body: impl FnOnce(&mut Session, &mut Caller<'_, HostState>) -> Result<epoch::EpochResult, SessionError>,
) -> i32 {
    let Some(mut session) = caller.data_mut().session.take() else {
        log("session verb refused: no session is installed");
        return EBADF;
    };
    let outcome = body(&mut session, caller);
    caller.data_mut().session = Some(session);
    match outcome {
        Ok(result) => {
            if result.deliveries > 0 {
                log(&format!("epoch delivered {} record(s)", result.deliveries));
            }
            result.deliveries as i32
        }
        Err(error) => {
            log(&format!("epoch -> {} ({error})", error.errno()));
            error.errno()
        }
    }
}

/// The depth guard a verb runs before anything else: a session verb called from
/// inside a callback is refused with `-EBUSY` (`DESIGN.md` §6.3).
fn depth_refusal(caller: &Caller<'_, HostState>) -> Option<i32> {
    if caller.data().depth != 0 {
        log("session verb refused from inside a callback (-EBUSY)");
        return Some(EBUSY);
    }
    None
}

/// The state guard: every verb but `open` and `close` needs READY.
fn state_refusal(caller: &Caller<'_, HostState>) -> Option<i32> {
    let ready = caller
        .data()
        .session
        .as_ref()
        .map(|session| session.require_ready())
        .unwrap_or(EBADF);
    if ready != 0 {
        log("session verb refused: the session is not READY (-EBADF)");
        return Some(EBADF);
    }
    None
}

/// `session::wait(timeout_ms) -> i32`. Blocks, then runs an epoch over every
/// class. `timeout_ms < 0` blocks indefinitely; `0` never blocks.
///
/// A zero timeout is exactly `EpochMode::DrainAll`: "do not wait, publish and
/// invoke everything that is there". Naming it that way keeps the non-blocking
/// drain reachable — there is no verb for it, because `wait(0)` is one.
pub fn session_wait(caller: &mut Caller<'_, HostState>, timeout_ms: i32) -> i32 {
    run_epoch_verb(caller, |session, caller| {
        let mode = if timeout_ms == 0 {
            epoch::EpochMode::DrainAll
        } else {
            epoch::EpochMode::Wait { timeout_ms }
        };
        epoch::run_epoch(session, caller, mode)
    })
}

/// `session::drain(class) -> i32`. One class, no blocking.
pub fn session_drain(caller: &mut Caller<'_, HostState>, class: u32) -> i32 {
    run_epoch_verb(caller, |session, caller| {
        epoch::run_epoch(session, caller, epoch::EpochMode::Drain { class })
    })
}

/// `session::subscribe(sub_ptr) -> i32`. Reads a transient `Subscription` from
/// guest memory and sets the class's delivery mode and subscription.
///
/// No epoch runs here, so the session is not taken out of the store: the
/// subscription belongs to the posting face, which the store reaches directly.
pub fn session_subscribe(caller: &mut Caller<'_, HostState>, sub_ptr: u32) -> i32 {
    if let Some(errno) = depth_refusal(caller) {
        return errno;
    }
    if let Some(errno) = state_refusal(caller) {
        return errno;
    }
    let Some(memory) = caller.data().arena else {
        log("session_subscribe refused: the arena is not installed (-EBADF)");
        return EBADF;
    };
    let Some(bytes) = read_guest(caller, memory, sub_ptr, arena::SUBSCRIPTION_SIZE as u32) else {
        log(&format!(
            "session_subscribe refused: the Subscription range ({sub_ptr:#x}, {}) is outside the memory",
            arena::SUBSCRIPTION_SIZE
        ));
        return EINVAL;
    };
    let subscription = arena::read_subscription(&bytes, 0);
    if subscription.class as usize >= CLASS_COUNT {
        log(&format!(
            "session_subscribe refused: class {} does not exist",
            subscription.class
        ));
        return EINVAL;
    }
    if !matches!(
        subscription.mode,
        arena::MODE_DIRECT | arena::MODE_BATCHED | arena::MODE_RING | arena::MODE_POLLED
    ) {
        log(&format!(
            "session_subscribe refused: mode {} is not a delivery mode",
            subscription.mode
        ));
        return EINVAL;
    }
    let posting = caller.data().posting.clone();
    match posting.set_delivery(subscription.class, subscription.mode, true) {
        Ok(()) => {
            log(&format!(
                "session_subscribe(class={}, mode={}) -> 0",
                subscription.class, subscription.mode
            ));
            0
        }
        Err(error) => {
            log(&format!("session_subscribe -> {} ({error})", error.errno()));
            error.errno()
        }
    }
}

/// `session::unsubscribe(class) -> i32`. Back to the class's default mode, and
/// off.
pub fn session_unsubscribe(caller: &mut Caller<'_, HostState>, class: u32) -> i32 {
    if let Some(errno) = depth_refusal(caller) {
        return errno;
    }
    if let Some(errno) = state_refusal(caller) {
        return errno;
    }
    let Some(default_mode) = arena::DEFAULT_CLASS_MODES.get(class as usize).copied() else {
        log(&format!("session_unsubscribe refused: class {class} does not exist"));
        return EINVAL;
    };
    let posting = caller.data().posting.clone();
    match posting.set_delivery(class, default_mode, false) {
        Ok(()) => {
            log(&format!("session_unsubscribe(class={class}) -> 0"));
            0
        }
        Err(error) => {
            log(&format!("session_unsubscribe -> {} ({error})", error.errno()));
            error.errno()
        }
    }
}

/// `session::pending() -> i32`. How many deferred submissions are waiting to be
/// applied. Zero in A2b: the pending list belongs to A2c, and the verb exists so
/// a guest can ask.
pub fn session_pending(caller: &mut Caller<'_, HostState>) -> i32 {
    if let Some(errno) = depth_refusal(caller) {
        return errno;
    }
    if let Some(errno) = state_refusal(caller) {
        return errno;
    }
    caller.data().pending.len() as i32
}

/// Register the session's seven verbs. This is the only place they are
/// registered; a capability adapter registers its own namespace separately.
pub fn link_session(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    linker.func_wrap(
        "session",
        "open",
        |mut caller: Caller<'_, HostState>, cfg_ptr: u32, cfg_len: u32| -> i32 {
            session_open(&mut caller, cfg_ptr, cfg_len)
        },
    )?;
    linker.func_wrap("session", "close", |mut caller: Caller<'_, HostState>| -> i32 {
        session_close(&mut caller)
    })?;
    linker.func_wrap(
        "session",
        "wait",
        |mut caller: Caller<'_, HostState>, timeout_ms: i32| -> i32 {
            session_wait(&mut caller, timeout_ms)
        },
    )?;
    linker.func_wrap(
        "session",
        "drain",
        |mut caller: Caller<'_, HostState>, class: u32| -> i32 {
            session_drain(&mut caller, class)
        },
    )?;
    linker.func_wrap(
        "session",
        "subscribe",
        |mut caller: Caller<'_, HostState>, sub_ptr: u32| -> i32 {
            session_subscribe(&mut caller, sub_ptr)
        },
    )?;
    linker.func_wrap(
        "session",
        "unsubscribe",
        |mut caller: Caller<'_, HostState>, class: u32| -> i32 {
            session_unsubscribe(&mut caller, class)
        },
    )?;
    linker.func_wrap("session", "pending", |mut caller: Caller<'_, HostState>| -> i32 {
        session_pending(&mut caller)
    })?;
    Ok(())
}

#[cfg(test)]
mod probes {
    use super::*;

    /// A guest that imports the session's arena memory under `env` — the spelling
    /// the pinned AssemblyScript toolchain emits for `--importMemory`.
    const GUEST_ENV_MEMORY: &str = r#"
(module
  (import "env" "memory" (memory 4 256))
  (func (export "poke") (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))
  (func (export "peek") (param i32) (result i32) (i32.load8_u (local.get 0)))
)
"#;

    /// The same guest under `session` — Tension's documented name for the import.
    const GUEST_SESSION_MEMORY: &str = r#"
(module
  (import "session" "memory" (memory 4 256))
  (func (export "poke") (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))
  (func (export "peek") (param i32) (result i32) (i32.load8_u (local.get 0)))
)
"#;

    /// A guest importing the memory under *both* names. Two memories in one
    /// module needs the multi-memory proposal, so this is attempted and reported
    /// rather than asserted: the load-bearing case is the pair above.
    const GUEST_BOTH_NAMES: &str = r#"
(module
  (import "env" "memory" (memory 4 256))
  (import "session" "memory" (memory 4 256))
  (func (export "poke_env") (param i32 i32)
    local.get 0
    local.get 1
    i32.store8)
  (func (export "peek_session") (param i32) (result i32)
    local.get 0
    i32.load8_u 1)
)
"#;

    /// A guest declaring `(memory 4 256)` and nothing else — probe 2's subject.
    const GUEST_DECLARED_MEMORY: &str = r#"
(module
  (import "env" "memory" (memory 4 256))
)
"#;

    /// Instantiate `wat` against `linker`, with the panic-on-failure style the
    /// probe host uses: a probe that cannot build its own fixture has nothing to
    /// report.
    fn link_guest(linker: &Linker<()>, store: &mut Store<()>, wat: &str) -> Instance {
        let engine = store.engine().clone();
        let module = Module::new(&engine, wat).expect("guest module");
        linker.instantiate(store, &module).expect("instantiate")
    }

    /// Probe 2's matching-rule harness: instantiate the `(memory 4 256)` guest
    /// against a provided memory of `(min, max)`. `Ok(())` means the pair matched.
    fn provide(engine: &Engine, min: u32, max: Option<u32>) -> Result<(), String> {
        let module =
            Module::new(engine, GUEST_DECLARED_MEMORY).map_err(|e| format!("module: {e}"))?;
        let mut store = Store::new(engine, ());
        let memory = Memory::new(&mut store, MemoryType::new(min, max))
            .map_err(|e| format!("memory: {e}"))?;
        let mut linker: Linker<()> = Linker::new(engine);
        linker
            .define(&mut store, "env", "memory", memory)
            .map_err(|e| format!("define: {e}"))?;
        linker
            .instantiate(&mut store, &module)
            .map(|_| ())
            .map_err(|e| format!("instantiate: {e}"))
    }

    /// Probe 1 (F1): one `Memory`, two import names, one underlying memory.
    #[test]
    fn test_memory_defined_under_two_import_names() {
        let engine = Engine::default();
        let mut store = Store::new(&engine, ());
        let memory =
            Memory::new(&mut store, MemoryType::new(4, Some(256))).expect("session memory");
        let mut linker: Linker<()> = Linker::new(&engine);

        linker
            .define(&mut store, "env", "memory", memory.clone())
            .expect("define env::memory");
        linker
            .define(&mut store, "session", "memory", memory.clone())
            .expect("define session::memory");

        // The AssemblyScript spelling.
        let env_guest = link_guest(&linker, &mut store, GUEST_ENV_MEMORY);
        let poke_env = env_guest
            .get_typed_func::<(i32, i32), ()>(&mut store, "poke")
            .expect("env poke");
        let peek_env = env_guest
            .get_typed_func::<(i32,), i32>(&mut store, "peek")
            .expect("env peek");

        // Tension's documented spelling.
        let session_guest = link_guest(&linker, &mut store, GUEST_SESSION_MEMORY);
        let poke_session = session_guest
            .get_typed_func::<(i32, i32), ()>(&mut store, "poke")
            .expect("session poke");
        let peek_session = session_guest
            .get_typed_func::<(i32,), i32>(&mut store, "peek")
            .expect("session peek");

        let mut byte = [0u8; 1];

        // Guest -> host, through the `env` spelling.
        poke_env.call(&mut store, (0, 0xAB)).expect("poke env");
        memory.read(&store, 0, &mut byte).expect("host read");
        assert_eq!(
            byte[0], 0xAB,
            "the host sees the env guest's write through its own handle"
        );

        // Host -> guest, through the `session` spelling.
        memory.write(&mut store, 1, &[0xCD]).expect("host write");
        assert_eq!(
            peek_session.call(&mut store, (1,)).expect("peek session"),
            0xCD,
            "the session guest sees the host's write"
        );

        // Two modules, two import names, one memory: a write through one is
        // visible through the other.
        poke_session.call(&mut store, (2, 0x22)).expect("poke session");
        memory.read(&store, 2, &mut byte).expect("host read");
        assert_eq!(byte[0], 0x22);
        assert_eq!(
            peek_env.call(&mut store, (2,)).expect("peek env"),
            0x22,
            "the env guest and the session guest share one underlying memory"
        );

        // Bonus: a single module importing both names. Needs multi-memory, and
        // it is not what the design depends on, so both attempts are reported
        // rather than asserted for success.
        let both_default = Module::new(&engine, GUEST_BOTH_NAMES);
        println!(
            "both-names module, default config: {}",
            match &both_default {
                Ok(_) => "accepted".to_string(),
                Err(e) => format!("rejected: {e}"),
            }
        );

        let multi_engine = {
            let mut config = Config::new();
            config.wasm_multi_memory(true);
            Engine::new(&config).expect("multi-memory engine")
        };
        let both_multi = Module::new(&multi_engine, GUEST_BOTH_NAMES);
        println!(
            "both-names module, wasm_multi_memory(true): {}",
            match &both_multi {
                Ok(_) => "accepted".to_string(),
                Err(e) => format!("rejected: {e}"),
            }
        );

        // If either attempt was accepted, the two names must still be one
        // memory: write through index 0, read through index 1.
        for (label, module) in [("default", &both_default), ("multi-memory", &both_multi)] {
            let Ok(module) = module else { continue };
            let mut store = Store::new(module.engine(), ());
            let memory =
                Memory::new(&mut store, MemoryType::new(4, Some(256))).expect("session memory");
            let mut linker: Linker<()> = Linker::new(module.engine());
            linker
                .define(&mut store, "env", "memory", memory.clone())
                .expect("define env::memory");
            linker
                .define(&mut store, "session", "memory", memory.clone())
                .expect("define session::memory");
            let instance = linker
                .instantiate(&mut store, module)
                .expect("instantiate both-names guest");
            let poke_env = instance
                .get_typed_func::<(i32, i32), ()>(&mut store, "poke_env")
                .expect("poke_env");
            let peek_session = instance
                .get_typed_func::<(i32,), i32>(&mut store, "peek_session")
                .expect("peek_session");
            poke_env.call(&mut store, (3, 0x77)).expect("poke_env");
            assert_eq!(
                peek_session.call(&mut store, (3,)).expect("peek_session"),
                0x77,
                "{label}: the two names resolve to one memory inside one module"
            );
            println!("both-names module ({label}): the two names are one memory");
        }
    }

    /// Probe 2 (F3): read a module's declared memory import type before
    /// instantiation, and pin which way the limits match.
    #[test]
    fn test_declared_memory_import_type() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_DECLARED_MEMORY).expect("declared-memory guest");

        let mut found = None;
        for import in module.imports() {
            if let ExternType::Memory(ty) = import.ty() {
                found = Some((
                    import.module().to_string(),
                    import.name().to_string(),
                    ty.minimum(),
                    ty.maximum(),
                    ty.is_shared(),
                ));
            }
        }
        let (module_name, field, min, max, shared) =
            found.expect("the guest declares a memory import");
        println!(
            "declared memory import: module={module_name:?} name={field:?} \
             min={min} max={max:?} shared={shared}"
        );
        assert_eq!((module_name.as_str(), field.as_str()), ("env", "memory"));
        assert_eq!(min, 4, "declared minimum, in pages");
        assert_eq!(max, Some(256), "declared maximum, in pages");
        assert!(!shared);

        // The matching rules the session's C3 depends on. Declared is (4, 256):
        // the provided memory must have at least the declared minimum and at
        // most the declared maximum.
        let exact = provide(&engine, 4, Some(256));
        let roomy = provide(&engine, 8, Some(128));
        let small_min = provide(&engine, 2, Some(256));
        let large_max = provide(&engine, 4, Some(512));
        let unbounded = provide(&engine, 4, None);

        println!("provided (4, Some(256)): {exact:?}");
        println!("provided (8, Some(128)): {roomy:?}");
        println!("provided (2, Some(256)): {small_min:?}");
        println!("provided (4, Some(512)): {large_max:?}");
        println!("provided (4, None):      {unbounded:?}");

        assert!(exact.is_ok(), "an exact match instantiates: {exact:?}");
        assert!(
            roomy.is_ok(),
            "more initial memory and a smaller maximum still matches: {roomy:?}"
        );
        assert!(
            small_min.is_err(),
            "a provided minimum below the declared minimum is refused: {small_min:?}"
        );
        assert!(
            large_max.is_err(),
            "a provided maximum above the declared maximum is refused: {large_max:?}"
        );
        assert!(
            unbounded.is_err(),
            "an unbounded provider does not match a declared maximum: {unbounded:?}"
        );
    }
}

#[cfg(test)]
mod lifecycle {
    use super::*;
    use crate::session::arena;

    /// A session guest in its default shape: 8 MiB of initial memory (the
    /// `memoryBase` the layout assumes), a declared ceiling for the heap.
    const GUEST_ARENA: &str = r#"
(module
  (import "env" "memory" (memory 128 4096))
  (func (export "_start_game"))
)
"#;

    /// The same guest under Tension's documented import name.
    const GUEST_ARENA_SESSION: &str = r#"
(module
  (import "session" "memory" (memory 128 4096))
  (func (export "_start_game"))
)
"#;

    /// A guest whose data segment starts exactly at `memoryBase` (8 MiB): above
    /// the arena, which is the shape a correct build produces.
    const GUEST_DATA_AT_BASE: &str = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (data (i32.const 8388608) "at-memory-base")
  (func (export "_start_game"))
)
"#;

    /// A guest whose data segment lands *inside* the arena band: what a wrong
    /// `--memoryBase` produces.
    const GUEST_DATA_IN_BAND: &str = r#"
(module
  (import "env" "memory" (memory 128 4096))
  (data (i32.const 2097152) "overlap")
  (func (export "_start_game"))
)
"#;

    /// A guest that declares no memory import at all.
    const GUEST_NO_MEMORY: &str = r#"
(module
  (func (export "_start_game"))
)
"#;

    /// A guest that imports a memory under a name the session does not define.
    const GUEST_WRONG_NAME: &str = r#"
(module
  (import "elsewhere" "memory" (memory 128 4096))
  (func (export "_start_game"))
)
"#;

    /// A guest that declares no maximum, so the host's cap is what applies.
    const GUEST_NO_MAXIMUM: &str = r#"
(module
  (import "env" "memory" (memory 128))
  (func (export "_start_game"))
)
"#;

    /// A guest whose declared minimum is already above the host's cap.
    const GUEST_MIN_ABOVE_CAP: &str = r#"
(module
  (import "env" "memory" (memory 2048))
  (func (export "_start_game"))
)
"#;

    /// A guest declaring two memories. Multi-memory is on by default in this
    /// wasmtime (probe-pinned), so the module is valid and the session refuses
    /// it: one arena is the model.
    const GUEST_TWO_MEMORIES: &str = r#"
(module
  (import "env" "memory" (memory 128 4096))
  (import "env" "scratch" (memory 1 16))
  (func (export "_start_game"))
)
"#;

    /// A `Store` with the interpreter's own state. Building it field by field is
    /// deliberate: if `HostState` grows a field, this stops compiling, which is
    /// the reminder a test harness should give.
    fn test_store(engine: &Engine) -> Store<HostState> {
        Store::new(
            engine,
            HostState {
                args: Vec::new(),
                pending_line: None,
                res: Vec::new(),
                audio: crate::audio::AudioSession::new(crate::default_adapter()),
                ai: crate::ai::AiSession::new(crate::default_ai_adapter()),
                solver: crate::solver::SolverHost::default(),
                posting: std::sync::Arc::new(crate::session::posting::PostingSide::default()),
                arena: None,
                depth: 0,
                pending: crate::session::apply::PendingQueue::new(),
                adapters: Vec::new(),
                session: None,
            },
        )
    }

    /// A store, its module, and a session created from it — the setup every test
    /// below starts from.
    fn setup(wat: &str) -> (Engine, Store<HostState>, Session) {
        let engine = Engine::default();
        let module = Module::new(&engine, wat).expect("module");
        let mut store = test_store(&engine);
        let session = Session::create_from_module(&mut store, &module).expect("session");
        (engine, store, session)
    }

    #[test]
    fn test_prepare_arena_writes_control_block() {
        let (_engine, mut store, mut session) = setup(GUEST_ARENA);
        session.prepare_arena(&mut store).expect("prepare");

        let data = session.memory().data(&store);
        assert_eq!(arena::control_magic(data), arena::MAGIC);
        assert_eq!(arena::control_layout_hash(data), arena::layout_hash());
        assert_eq!(arena::control_region_count(data), arena::REGION_COUNT as u32);
        assert_eq!(session.layout_hash(), arena::layout_hash());
        assert_eq!(session.arena_size(), arena::LAYOUT_FLOOR as u32);

        // The state field reports UNINIT until an open succeeds.
        let state = u32::from_le_bytes(
            data[arena::CONTROL_OFFSET + arena::CONTROL_STATE
                ..arena::CONTROL_OFFSET + arena::CONTROL_STATE + 4]
                .try_into()
                .expect("four bytes"),
        );
        assert_eq!(state, SessionState::Uninit as u32);
        assert_eq!(state, arena::STATE_UNINIT);
        assert_eq!(session.state(), SessionState::Uninit);

        // The session's own report of the fields it wrote.
        assert_eq!(
            u32::from_le_bytes(
                data[arena::CONTROL_OFFSET + arena::CONTROL_TOTAL_SIZE
                    ..arena::CONTROL_OFFSET + arena::CONTROL_TOTAL_SIZE + 4]
                    .try_into()
                    .expect("four bytes")
            ),
            session.max_arena_size()
        );
    }

    #[test]
    fn test_prepare_arena_writes_region_table() {
        let (_engine, mut store, mut session) = setup(GUEST_ARENA);
        session.prepare_arena(&mut store).expect("prepare");

        let data = session.memory().data(&store);
        for (index, region) in arena::REGIONS.iter().enumerate() {
            let at = arena::REGION_TABLE_OFFSET + index * arena::REGION_DESC_SIZE;
            let word = |offset: usize| {
                u32::from_le_bytes(data[at + offset..at + offset + 4].try_into().expect("four bytes"))
            };
            assert_eq!(word(0), index as u32, "entry {index}: kind == index");
            assert_eq!(word(4), region.flags, "entry {index}: direction");
            assert_eq!(word(8), region.offset, "entry {index}: offset");
            assert_eq!(word(12), region.size, "entry {index}: size");
            assert_eq!(word(16), region.align, "entry {index}: alignment");
            assert_eq!(word(20), 0, "entry {index}: reserved");
        }

        // And the manifest the hash is taken over.
        for (index, entry) in arena::TYPES.iter().enumerate() {
            let at = arena::MANIFEST_OFFSET + index * arena::MANIFEST_ENTRY_SIZE;
            assert_eq!(
                u16::from_le_bytes(data[at..at + 2].try_into().expect("two bytes")),
                entry.id
            );
            assert_eq!(
                u16::from_le_bytes(data[at + 2..at + 4].try_into().expect("two bytes")),
                entry.size
            );
            assert_eq!(
                u16::from_le_bytes(data[at + 4..at + 6].try_into().expect("two bytes")),
                entry.align
            );
        }
    }

    #[test]
    fn test_verify_post_instantiate_happy_path() {
        let (_engine, mut store, mut session) = setup(GUEST_ARENA);
        let module = Module::new(store.engine(), GUEST_ARENA).expect("module");
        let mut linker: Linker<HostState> = Linker::new(store.engine());

        session.install(&mut store, &mut linker).expect("install");
        session.prepare_arena(&mut store).expect("prepare");
        linker.instantiate(&mut store, &module).expect("instantiate");

        session
            .verify_post_instantiate(&store)
            .expect("the arena survives instantiation intact");
        assert_eq!(session.state(), SessionState::Uninit);
    }

    #[test]
    fn test_verify_post_instantiate_detects_corruption() {
        let (_engine, mut store, mut session) = setup(GUEST_ARENA);
        session.prepare_arena(&mut store).expect("prepare");

        // One byte inside the first canary block of the reserved gap.
        let offset = arena::LAYOUT_FLOOR + 3;
        session.memory().data_mut(&mut store)[offset] ^= 0x01;

        let error = session
            .verify_post_instantiate(&store)
            .expect_err("corruption must be detected");
        match error {
            SessionError::Canary { offset: named, .. } => {
                assert_eq!(named, arena::LAYOUT_FLOOR, "the block's own offset is named")
            }
            other => panic!("expected a canary refusal, got {other:?}"),
        }
        let message = session.verify_post_instantiate(&store).unwrap_err().to_string();
        assert!(message.contains("canary"), "{message}");
        assert!(message.contains(&format!("{:#x}", arena::LAYOUT_FLOOR)), "{message}");
    }

    #[test]
    fn test_zero_band_clears_module_data() {
        // The correct shape: the guest's data segment sits at `memoryBase`,
        // above the arena the session prepared.
        let (_engine, mut store, mut session) = setup(GUEST_DATA_AT_BASE);
        let module = Module::new(store.engine(), GUEST_DATA_AT_BASE).expect("module");
        let mut linker: Linker<HostState> = Linker::new(store.engine());
        session.install(&mut store, &mut linker).expect("install");
        session.prepare_arena(&mut store).expect("prepare");

        // The band is zero before instantiation, where the design expects zeros.
        let memory_base = session.memory_base() as usize;
        {
            let data = session.memory().data(&store);
            assert_eq!(
                arena::verify_band_is_zero(data, arena::HEADER_PAGE_SIZE, arena::LAYOUT_FLOOR),
                Ok(()),
                "the region band reads as zero after prepare_arena"
            );
        }

        linker.instantiate(&mut store, &module).expect("instantiate");

        // The segment landed, and it landed outside the arena.
        let data = session.memory().data(&store);
        assert_eq!(&data[memory_base..memory_base + 14], b"at-memory-base");
        session
            .verify_post_instantiate(&store)
            .expect("a data segment at memoryBase leaves the arena untouched");
    }

    #[test]
    fn test_data_segment_below_memory_base_is_detected() {
        // The broken shape: a data segment inside the arena band, which is what
        // a wrong `--memoryBase` looks like. The zero baseline makes it loud.
        let (_engine, mut store, mut session) = setup(GUEST_DATA_IN_BAND);
        let module = Module::new(store.engine(), GUEST_DATA_IN_BAND).expect("module");
        let mut linker: Linker<HostState> = Linker::new(store.engine());
        session.install(&mut store, &mut linker).expect("install");
        session.prepare_arena(&mut store).expect("prepare");
        linker.instantiate(&mut store, &module).expect("instantiate");

        let error = session
            .verify_post_instantiate(&store)
            .expect_err("an overlap into the band must be refused");
        match error {
            SessionError::BandNotZero { offset } => assert_eq!(
                offset, 2_097_152,
                "the first non-zero byte of the band is named"
            ),
            other => panic!("expected a band refusal, got {other:?}"),
        }
        assert!(error_message(&session, &store).contains("region band"));
    }

    #[test]
    fn test_create_from_module_refuses_missing_memory_import() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_NO_MEMORY).expect("module");
        let mut store = test_store(&engine);

        let error = Session::create_from_module(&mut store, &module)
            .err()
            .expect("a module with no memory import is refused");
        let message = error.to_string();
        assert!(message.contains("env::memory"), "{message}");
        assert!(message.contains("session::memory"), "{message}");
    }

    #[test]
    fn test_create_from_module_refuses_a_foreign_import_name() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_WRONG_NAME).expect("module");
        let mut store = test_store(&engine);

        match Session::create_from_module(&mut store, &module) {
            Err(SessionError::MemoryImportName { module, name }) => {
                assert_eq!(module, "elsewhere");
                assert_eq!(name, "memory");
            }
            other => panic!("expected a name refusal, got {other:?}"),
        }
    }

    #[test]
    fn test_create_from_module_refuses_a_second_memory() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_TWO_MEMORIES).expect("two-memory module");
        let mut store = test_store(&engine);

        assert!(matches!(
            Session::create_from_module(&mut store, &module),
            Err(SessionError::MultipleMemoryImports)
        ));
    }

    #[test]
    fn test_create_from_module_refuses_a_minimum_above_the_cap() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_MIN_ABOVE_CAP).expect("module");
        let mut store = test_store(&engine);

        match Session::create_from_module(&mut store, &module) {
            Err(SessionError::CapBelowMinimum { min, cap }) => {
                assert_eq!(min, 2048);
                assert_eq!(cap, HOST_CAP_PAGES);
            }
            other => panic!("expected a cap refusal, got {other:?}"),
        }
    }

    #[test]
    fn test_install_defines_the_memory_under_both_names() {
        let (_engine, mut store, mut session) = setup(GUEST_ARENA);
        let env_module = Module::new(store.engine(), GUEST_ARENA).expect("env module");
        let session_module = Module::new(store.engine(), GUEST_ARENA_SESSION).expect("session module");
        let mut linker: Linker<HostState> = Linker::new(store.engine());

        session.install(&mut store, &mut linker).expect("install");
        session.prepare_arena(&mut store).expect("prepare");

        // Both spellings instantiate against the one definition…
        linker
            .instantiate(&mut store, &env_module)
            .expect("env::memory guest");
        linker
            .instantiate(&mut store, &session_module)
            .expect("session::memory guest");

        // …and both see the arena the session wrote.
        let data = session.memory().data(&store);
        assert_eq!(arena::control_magic(data), arena::MAGIC);
    }

    #[test]
    fn test_missing_maximum_pages_uses_the_host_cap() {
        let (_engine, store, session) = setup(GUEST_NO_MAXIMUM);
        assert_eq!(session.declared_pages(), (128, None));
        let (initial, max) = session.pages();
        assert_eq!(initial, 128, "the declared minimum is what the host provides");
        assert_eq!(max, HOST_CAP_PAGES, "a module with no maximum gets the host's cap");
        // And the memory really was created with that ceiling.
        let ty = session.memory().ty(&store);
        assert_eq!(ty.minimum(), 128);
        assert_eq!(ty.maximum(), Some(HOST_CAP_PAGES as u64));
        assert!(!ty.is_shared());
    }

    #[test]
    fn test_state_values_match_the_arena_constants() {
        assert_eq!(SessionState::Uninit as u32, arena::STATE_UNINIT);
        assert_eq!(SessionState::Ready as u32, arena::STATE_READY);
        assert_eq!(SessionState::Faulted as u32, arena::STATE_FAULTED);
        assert_eq!(SessionState::Closed as u32, arena::STATE_CLOSED);
    }

    /// The refusal text for the last verification failure, for assertions that
    /// care about the diagnostic rather than the variant.
    fn error_message(session: &Session, store: &Store<HostState>) -> String {
        session
            .verify_post_instantiate(store)
            .err()
            .map(|error| error.to_string())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod verbs {
    use super::*;

    /// A posting face for a test host: the default capacities, shared by `Arc`
    /// the way `main` shares one with the session.
    fn test_posting() -> std::sync::Arc<posting::PostingSide> {
        std::sync::Arc::new(posting::PostingSide::default())
    }

    /// A session guest in the shape the design assumes: 8 MiB of initial memory
    /// (the `memoryBase` the layout assumes) and a heap above it.
    const GUEST: &str = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (func (export "_start_game"))
)
"#;

    /// The same guest with an exported function table: `$batch` at index 1 and
    /// `$event` at index 2. Index 0 is left null on purpose — zero means
    /// "absent" in the record, so a real slot can never be index 0.
    const GUEST_TABLE: &str = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (type $event_t (func (param i32 i32) (result i32)))
  (func $batch (type $batch_t) i32.const 0)
  (func $event (type $event_t) i32.const 0)
  (table 4 funcref)
  (elem (i32.const 1) $batch $event)
  (export "table" (table 0))
  (func (export "_start_game"))
)
"#;

    /// A table whose `onEvent` slot holds a *null* entry.
    const GUEST_TABLE_HOLE: &str = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (func $batch (type $batch_t) i32.const 0)
  (table 4 funcref)
  (elem (i32.const 1) $batch)
  (export "table" (table 0))
  (func (export "_start_game"))
)
"#;

    /// A table whose `onEvent` slot holds a function of the wrong signature.
    const GUEST_TABLE_WRONG_SIGNATURE: &str = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (type $wrong_t (func (param i32) (result i32)))
  (func $batch (type $batch_t) i32.const 0)
  (func $wrong (type $wrong_t) i32.const 0)
  (table 4 funcref)
  (elem (i32.const 1) $batch $wrong)
  (export "table" (table 0))
  (func (export "_start_game"))
)
"#;

    /// A guest that calls the two verbs itself: the only test here that
    /// exercises the registered path — `caller.data()`, the guest-memory read,
    /// and the take/put-back around the session. It writes the two return codes
    /// at `RESULT`, so the host can read them back.
    const GUEST_CALLS_OPEN: &str = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (import "session" "open" (func $open (param i32 i32) (result i32)))
  (import "session" "close" (func $close (result i32)))
  (func (export "_start_game")
    (i32.store (i32.const 8388608) (call $open (i32.const 8389632) (i32.const 82)))
    (i32.store (i32.const 8388612) (call $close))
  )
)
"#;

    /// Where the guest in [`GUEST_CALLS_OPEN`] leaves its two return codes.
    const RESULT: usize = 8_388_608;
    /// Where the host writes the TLV for that guest.
    const CFG: usize = 8_389_632;
    /// Where the host writes the `Callbacks` record for that guest.
    const CALLBACKS: usize = 8_396_800;

    /// The interpreter's own store state, with no session installed yet.
    /// Building it field by field is deliberate: if `HostState` grows a field,
    /// this stops compiling, which is the reminder a harness should give.
    fn store(engine: &Engine) -> Store<HostState> {
        Store::new(
            engine,
            HostState {
                args: Vec::new(),
                pending_line: None,
                res: Vec::new(),
                audio: crate::audio::AudioSession::new(crate::default_adapter()),
                ai: crate::ai::AiSession::new(crate::default_ai_adapter()),
                solver: crate::solver::SolverHost::default(),
                posting: test_posting(),
                arena: None,
                depth: 0,
                pending: crate::session::apply::PendingQueue::new(),
                adapters: Vec::new(),
                session: None,
            },
        )
    }

    /// A module, a store, and a session whose arena is prepared — the state every
    /// test below starts from. The session stays outside the store: these tests
    /// drive the core directly, which is why the verb wrappers can stay thin.
    fn setup(wat: &str) -> (Engine, Store<HostState>, Session) {
        let engine = Engine::default();
        let module = Module::new(&engine, wat).expect("module");
        let mut store = store(&engine);
        let mut session = Session::create_from_module(&mut store, &module).expect("session");
        session.prepare_arena(&mut store).expect("prepare");
        (engine, store, session)
    }

    /// A legal TLV for this session's shape. `callbacks_ptr` must be at or above
    /// `max_arena_size`: the record lives in the guest's heap, not in the arena.
    fn config_entries(callbacks_ptr: u32) -> Vec<(u32, i64)> {
        vec![
            (config::KEY_ABI_VERSION, arena::ABI_VERSION as i64),
            (config::KEY_LAYOUT_HASH, arena::layout_hash() as i64),
            (config::KEY_ARENA_SIZE, arena::LAYOUT_FLOOR as i64),
            (config::KEY_MAX_ARENA_SIZE, arena::DEFAULT_MAX_ARENA_SIZE as i64),
            (config::KEY_CALLBACKS_PTR, callbacks_ptr as i64),
            (config::KEY_CALLBACKS_LEN, arena::CALLBACKS_SIZE as i64),
        ]
    }

    /// The default stream, whose pointer is a number rather than an address: the
    /// core tests never read the record.
    fn cfg() -> Vec<u8> {
        config::encode(&config_entries(arena::DEFAULT_MAX_ARENA_SIZE as u32))
    }

    /// A record with no slots filled — a guest that polls rather than being told.
    fn no_callbacks() -> arena::CallbacksRecord {
        arena::CallbacksRecord {
            abi_version: arena::ABI_VERSION,
            slot_count: 0,
            flags: 0,
            on_batch: 0,
            on_event: 0,
        }
    }

    /// Decode and apply, exactly as the verb does after reading the bytes.
    fn open_bytes(
        session: &mut Session,
        store: &mut Store<HostState>,
        bytes: &[u8],
        callbacks: &arena::CallbacksRecord,
    ) -> Result<(), SessionError> {
        let decoded = config::decode(bytes)?;
        let memory = session.memory();
        let arena_bytes = memory.data_mut(&mut *store);
        session.apply_open(arena_bytes, &decoded, callbacks, ResolvedCallbacks::default())
    }

    fn open(
        session: &mut Session,
        store: &mut Store<HostState>,
        callbacks: &arena::CallbacksRecord,
    ) -> Result<(), SessionError> {
        open_bytes(session, store, &cfg(), callbacks)
    }

    fn close(session: &mut Session, store: &mut Store<HostState>) -> Result<(), SessionError> {
        let memory = session.memory();
        let arena_bytes = memory.data_mut(&mut *store);
        session.close(arena_bytes)
    }

    fn word(arena_bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(arena_bytes[at..at + 4].try_into().expect("four bytes"))
    }

    fn double_word(arena_bytes: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(arena_bytes[at..at + 8].try_into().expect("eight bytes"))
    }

    #[test]
    fn test_open_requires_uninit_state() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let callbacks = no_callbacks();
        open(&mut session, &mut store, &callbacks).expect("the first open succeeds");
        assert_eq!(session.state(), SessionState::Ready);

        let error = open(&mut session, &mut store, &callbacks).expect_err("a second open is refused");
        assert!(matches!(
            error,
            SessionError::NotUninit {
                state: SessionState::Ready
            }
        ));
        assert_eq!(error.errno(), EBUSY);
    }

    #[test]
    fn test_open_refuses_faulted() {
        let (_engine, mut store, mut session) = setup(GUEST);
        session.state = SessionState::Faulted;

        let error = open(&mut session, &mut store, &no_callbacks()).expect_err("faulted open");
        assert_eq!(error.errno(), EBUSY);
        // A refusal does not move the state.
        assert_eq!(session.state(), SessionState::Faulted);
    }

    #[test]
    fn test_open_after_close_succeeds() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let callbacks = no_callbacks();
        open(&mut session, &mut store, &callbacks).expect("open");
        close(&mut session, &mut store).expect("close");
        assert_eq!(session.state(), SessionState::Closed);
        open(&mut session, &mut store, &callbacks).expect("a closed session opens again");
        assert_eq!(session.state(), SessionState::Ready);
    }

    #[test]
    fn test_open_decodes_config_and_transitions() {
        let (_engine, mut store, mut session) = setup(GUEST);
        open(&mut session, &mut store, &no_callbacks()).expect("open");

        assert_eq!(session.state(), SessionState::Ready);
        assert_eq!(session.arena_size(), arena::LAYOUT_FLOOR as u32);
        assert_eq!(session.max_arena_size(), arena::DEFAULT_MAX_ARENA_SIZE as u32);

        let memory = session.memory();
        let arena_bytes = memory.data(&store);
        assert_eq!(arena::control_state(arena_bytes), arena::STATE_READY);
        assert_eq!(arena::control_region_count(arena_bytes), arena::REGION_COUNT as u32);
        assert_eq!(word(arena_bytes, arena::CONTROL_OFFSET + arena::CONTROL_TOTAL_SIZE), arena::DEFAULT_MAX_ARENA_SIZE as u32);

        // SessionInfo carries the config's values and a fresh, non-zero nonce.
        assert_eq!(
            word(arena_bytes, arena::SESSION_INFO_OFFSET + arena::SESSION_INFO_MAX_ARENA_SIZE),
            arena::DEFAULT_MAX_ARENA_SIZE as u32
        );
        assert_eq!(
            word(arena_bytes, arena::SESSION_INFO_OFFSET + arena::SESSION_INFO_ARENA_SIZE),
            arena::LAYOUT_FLOOR as u32
        );
        assert_ne!(double_word(arena_bytes, arena::SESSION_INFO_OFFSET + arena::SESSION_INFO_OPEN_NONCE), 0);
        assert_eq!(
            double_word(arena_bytes, arena::CONTROL_OFFSET + arena::CONTROL_SESSION_NONCE),
            double_word(arena_bytes, arena::SESSION_INFO_OFFSET + arena::SESSION_INFO_OPEN_NONCE),
            "the two copies of the nonce agree"
        );
    }

    #[test]
    fn test_open_refuses_bad_abi() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let mut entries = config_entries(arena::DEFAULT_MAX_ARENA_SIZE as u32);
        entries[0].1 = 2;

        let error = open_bytes(&mut session, &mut store, &config::encode(&entries), &no_callbacks())
            .expect_err("a wrong ABI version is refused");
        assert!(matches!(
            error,
            SessionError::Config(config::ConfigError::AbiVersion { .. })
        ));
        assert_eq!(error.errno(), EINVAL);
        assert_eq!(session.state(), SessionState::Uninit, "no transition on refusal");
    }

    #[test]
    fn test_open_refuses_bad_layout_hash() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let mut entries = config_entries(arena::DEFAULT_MAX_ARENA_SIZE as u32);
        entries[1].1 = 0xDEAD_BEEF;

        let error = open_bytes(&mut session, &mut store, &config::encode(&entries), &no_callbacks())
            .expect_err("a wrong layout hash is refused");
        match &error {
            SessionError::Config(config::ConfigError::LayoutHash { guest, session }) => {
                assert_eq!(*guest, 0xDEAD_BEEF);
                assert_eq!(*session, arena::layout_hash());
            }
            other => panic!("expected a layout-hash refusal, got {other:?}"),
        }
        assert_eq!(error.errno(), EINVAL);

        // The diagnostic names the field and both hashes. It deliberately does
        // *not* name a type: one shape hash cannot say which entry differs, and
        // the config carries no manifest to compare against (see the round's
        // report on DESIGN.md §6.1's wording).
        let message = error.to_string();
        assert!(message.contains("layout_hash"), "{message}");
        assert!(message.contains("deadbeef"), "{message}");
    }

    #[test]
    fn test_open_refuses_c1_relation() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let mut entries = config_entries(arena::DEFAULT_MAX_ARENA_SIZE as u32);
        entries[2].1 = arena::DEFAULT_MAX_ARENA_SIZE as i64 + 16; // arena > ceiling

        let error = open_bytes(&mut session, &mut store, &config::encode(&entries), &no_callbacks())
            .expect_err("an arena above its ceiling is refused");
        assert!(matches!(
            error,
            SessionError::Config(config::ConfigError::ArenaRelation(_))
        ));
        assert_eq!(error.errno(), EINVAL);
    }

    #[test]
    fn test_open_refuses_callbacks_in_arena() {
        let (_engine, mut store, mut session) = setup(GUEST);
        // A pointer below the ceiling is inside the reserved band.
        let entries = config_entries(0);

        let error = open_bytes(&mut session, &mut store, &config::encode(&entries), &no_callbacks())
            .expect_err("a callbacks pointer inside the arena is refused");
        assert!(matches!(
            error,
            SessionError::Config(config::ConfigError::Callbacks(_))
        ));
        assert_eq!(error.errno(), EINVAL);
    }

    #[test]
    fn test_open_refuses_callbacks_wrong_length() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let mut entries = config_entries(arena::DEFAULT_MAX_ARENA_SIZE as u32);
        entries[5].1 = arena::CALLBACKS_SIZE as i64 - 1;

        let error = open_bytes(&mut session, &mut store, &config::encode(&entries), &no_callbacks())
            .expect_err("a callbacks_len that is not the record's size is refused");
        assert!(matches!(
            error,
            SessionError::Config(config::ConfigError::Callbacks(_))
        ));
    }

    #[test]
    fn test_open_resolves_callbacks() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_TABLE).expect("module");
        let mut store = store(&engine);
        let mut session = Session::create_from_module(&mut store, &module).expect("session");
        session.prepare_arena(&mut store).expect("prepare");
        let mut linker: Linker<HostState> = Linker::new(&engine);
        session.install(&mut store, &mut linker).expect("install");
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        let table = instance
            .get_export(&mut store, "table")
            .and_then(|export| export.into_table())
            .expect("the guest exports its table");

        let record = arena::CallbacksRecord {
            abi_version: arena::ABI_VERSION,
            slot_count: 2,
            flags: 0,
            on_batch: 1,
            on_event: 2,
        };
        let resolved = Session::resolve_callbacks(&mut store, Some(&table), &record)
            .expect("both slots resolve");
        assert_eq!(resolved.count(), 2);
        assert!(!resolved.is_empty());

        let decoded = config::decode(&cfg()).expect("decode");
        let memory = session.memory();
        let arena_bytes = memory.data_mut(&mut store);
        session
            .apply_open(arena_bytes, &decoded, &record, resolved)
            .expect("an open with resolved callbacks");
        assert_eq!(session.state(), SessionState::Ready);
        assert_eq!(session.callbacks().expect("resolved").count(), 2);
    }

    #[test]
    fn test_open_refuses_missing_table() {
        let (_engine, mut store, _session) = setup(GUEST);
        // GUEST exports no table, so a filled slot has nothing to index.
        let record = arena::CallbacksRecord {
            abi_version: arena::ABI_VERSION,
            slot_count: 1,
            flags: 0,
            on_batch: 1,
            on_event: 0,
        };
        let error = Session::resolve_callbacks(&mut store, None, &record)
            .expect_err("a filled slot without a table is refused");
        assert!(matches!(error, SessionError::TableMissing { slot: "onBatch" }));
        assert_eq!(error.errno(), EINVAL);
        assert!(error.to_string().contains("exportTable"), "{error}");
    }

    #[test]
    fn test_open_refuses_out_of_range_slot() {
        let (engine, mut store, mut session, table) = setup_table(GUEST_TABLE);
        let _ = engine;
        let record = arena::CallbacksRecord {
            abi_version: arena::ABI_VERSION,
            slot_count: 1,
            flags: 0,
            on_batch: 99,
            on_event: 0,
        };
        let error = Session::resolve_callbacks(&mut store, Some(&table), &record)
            .expect_err("an index past the table's end is refused");
        assert!(matches!(error, SessionError::CallbackSlot { slot: "onBatch", .. }));

        // And the refusal keeps the session where it was.
        open(&mut session, &mut store, &no_callbacks()).expect("the session still opens");
    }

    #[test]
    fn test_open_refuses_null_slot() {
        let (_engine, mut store, _session, table) = setup_table(GUEST_TABLE_HOLE);
        let record = arena::CallbacksRecord {
            abi_version: arena::ABI_VERSION,
            slot_count: 2,
            flags: 0,
            on_batch: 1,
            on_event: 2,
        };
        let error = Session::resolve_callbacks(&mut store, Some(&table), &record)
            .expect_err("a null table entry is refused");
        assert!(matches!(error, SessionError::CallbackSlot { slot: "onEvent", .. }));
        assert!(error.to_string().contains("null"), "{error}");
    }

    #[test]
    fn test_open_refuses_mis_shaped_slot() {
        let (_engine, mut store, _session, table) = setup_table(GUEST_TABLE_WRONG_SIGNATURE);
        let record = arena::CallbacksRecord {
            abi_version: arena::ABI_VERSION,
            slot_count: 2,
            flags: 0,
            on_batch: 1,
            on_event: 2,
        };
        let error = Session::resolve_callbacks(&mut store, Some(&table), &record)
            .expect_err("a function of the wrong signature is refused");
        assert!(matches!(error, SessionError::CallbackSlot { slot: "onEvent", .. }));
        assert!(error.to_string().contains("signature"), "{error}");
    }

    /// A module with a table, a store, a session, and an instantiated instance.
    fn setup_table(wat: &str) -> (Engine, Store<HostState>, Session, Table) {
        let engine = Engine::default();
        let module = Module::new(&engine, wat).expect("module");
        let mut store = store(&engine);
        let mut session = Session::create_from_module(&mut store, &module).expect("session");
        session.prepare_arena(&mut store).expect("prepare");
        let mut linker: Linker<HostState> = Linker::new(&engine);
        session.install(&mut store, &mut linker).expect("install");
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        let table = instance
            .get_export(&mut store, "table")
            .and_then(|export| export.into_table())
            .expect("table");
        (engine, store, session, table)
    }

    #[test]
    fn test_open_writes_ring_headers() {
        let (_engine, mut store, mut session) = setup(GUEST);
        open(&mut session, &mut store, &no_callbacks()).expect("open");

        let capacities = arena::DEFAULT_RING_CAPACITIES;
        let memory = session.memory();
        let arena_bytes = memory.data(&store);
        for class in 0..arena::CLASS_COUNT {
            let header = arena::ring_header(arena_bytes, arena::ring_offset(&capacities, class));
            assert_eq!(header.capacity, capacities[class], "class {class} capacity");
            assert_eq!(header.stride, arena::EVENT_RECORD_SIZE as u32, "class {class} stride");
            assert_eq!(header.head, 0, "class {class} starts empty");
            assert_eq!(header.tail, 0, "class {class} starts empty");
            assert_eq!(header.generation, 0, "class {class}");
            assert_eq!(header.dropped, 0, "class {class}");
            assert_eq!(header.delivered, 0, "class {class}");
        }
    }

    #[test]
    fn test_open_overrides_ring_capacities() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let mut entries = config_entries(arena::DEFAULT_MAX_ARENA_SIZE as u32);
        entries.push((config::KEY_RING_CAPACITY_BASE + 3, 128));
        let bytes = config::encode(&entries);
        open_bytes(&mut session, &mut store, &bytes, &no_callbacks()).expect("open");

        let decoded = config::decode(&bytes).expect("decode");
        assert_eq!(decoded.ring_capacities[3], 128);
        assert!(decoded.ring_stated[3]);

        let memory = session.memory();
        let arena_bytes = memory.data(&store);
        let overridden = arena::ring_header(
            arena_bytes,
            arena::ring_offset(&decoded.ring_capacities, 3),
        );
        assert_eq!(overridden.capacity, 128, "the stated capacity is the one written");
        // And the classes the guest did not mention keep their defaults.
        let defaulted = arena::ring_header(
            arena_bytes,
            arena::ring_offset(&decoded.ring_capacities, 4),
        );
        assert_eq!(defaulted.capacity, arena::DEFAULT_RING_CAPACITIES[4]);
    }

    #[test]
    fn test_close_idempotent() {
        let (_engine, mut store, mut session) = setup(GUEST);
        open(&mut session, &mut store, &no_callbacks()).expect("open");

        close(&mut session, &mut store).expect("close");
        assert_eq!(session.state(), SessionState::Closed);
        close(&mut session, &mut store).expect("closing twice is not an error");
        assert_eq!(session.state(), SessionState::Closed);

        let memory = session.memory();
        let arena_bytes = memory.data(&store);
        assert_eq!(arena::control_state(arena_bytes), arena::STATE_CLOSED);
        // The control block's guest-owned half is untouched by a close.
        assert_eq!(arena::control_magic(arena_bytes), arena::MAGIC);
    }

    #[test]
    fn test_close_from_uninit() {
        let (_engine, mut store, mut session) = setup(GUEST);
        assert_eq!(session.state(), SessionState::Uninit);
        close(&mut session, &mut store).expect("a close before any open is allowed");
        assert_eq!(session.state(), SessionState::Closed);
    }

    #[test]
    fn test_verb_before_open_returns_ebadf() {
        /// A stand-in for A2's verbs: the whole body is the state gate.
        fn probe_verb(session: &Session) -> i32 {
            session.require_ready()
        }

        let (_engine, mut store, mut session) = setup(GUEST);
        // UNINIT: every verb but open and close is refused.
        assert_eq!(probe_verb(&session), EBADF);
        // close is the one verb that may run here.
        close(&mut session, &mut store).expect("close from UNINIT");
        assert_eq!(probe_verb(&session), EBADF, "CLOSED is not READY");
        // After an open the gate opens, and stays open through a re-open.
        open(&mut session, &mut store, &no_callbacks()).expect("open");
        assert_eq!(probe_verb(&session), 0);
    }

    #[test]
    fn test_verb_path_through_a_guest() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_CALLS_OPEN).expect("module");
        let mut store = store(&engine);
        let mut session = Session::create_from_module(&mut store, &module).expect("session");
        session.prepare_arena(&mut store).expect("prepare");
        let memory = session.memory();
        let mut linker: Linker<HostState> = Linker::new(&engine);
        session.install(&mut store, &mut linker).expect("install");
        link_session(&mut linker).expect("the verbs register");
        // The arena is reachable without the session, because the epoch runs
        // while a verb holds the session.
        store.data_mut().arena = Some(memory);
        store.data_mut().session = Some(session);

        // The config and the callbacks record, written into the guest's heap the
        // way its SDK would write them. The length the guest passes is the
        // config's exact size: 4 + 6 entries of (4 + 1 + 8).
        let bytes = config::encode(&config_entries(CALLBACKS as u32));
        assert_eq!(bytes.len(), 82);
        let memory = store.data().session.as_ref().expect("session").memory();
        memory.write(&mut store, CFG, &bytes).expect("the config lands");
        let mut record = [0u8; arena::CALLBACKS_SIZE];
        record[0..2].copy_from_slice(&arena::ABI_VERSION.to_le_bytes());
        memory
            .write(&mut store, CALLBACKS, &record)
            .expect("the callbacks record lands");

        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        store
            .data()
            .session
            .as_ref()
            .expect("session")
            .verify_post_instantiate(&store)
            .expect("the arena survives instantiation");

        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start_game")
            .expect("_start_game");
        start.call(&mut store, ()).expect("the guest runs");

        let mut out = [0u8; 8];
        memory.read(&store, RESULT, &mut out).expect("read the results");
        let open_rc = i32::from_le_bytes(out[0..4].try_into().expect("four bytes"));
        let close_rc = i32::from_le_bytes(out[4..8].try_into().expect("four bytes"));
        assert_eq!(open_rc, 0, "the guest's session_open succeeded");
        assert_eq!(close_rc, 0, "the guest's session_close succeeded");
        assert_eq!(
            store.data().session.as_ref().expect("session").state(),
            SessionState::Closed
        );
    }

    // ── §7.2: the required regions the loaded capabilities declared ────────

    /// The same TLV as [`config_entries`], with the live arena stated
    /// explicitly so a test can hand over an arena that truncates a region — and
    /// with an **absent** callbacks record (`ptr = 0`, `len = 0`), which is the
    /// shape every test below wants: they drive `apply_open` directly, so there
    /// is no record in memory to point at.
    fn entries_with_arena(arena_size: u32) -> Vec<(u32, i64)> {
        vec![
            (config::KEY_ABI_VERSION, arena::ABI_VERSION as i64),
            (config::KEY_LAYOUT_HASH, arena::layout_hash() as i64),
            (config::KEY_ARENA_SIZE, arena_size as i64),
            (config::KEY_MAX_ARENA_SIZE, arena::DEFAULT_MAX_ARENA_SIZE as i64),
            (config::KEY_CALLBACKS_PTR, 0),
            (config::KEY_CALLBACKS_LEN, 0),
        ]
    }

    /// Load and link the reference adapter through the real registry — the same
    /// path `main` takes, with no run behind it — and hand back a host that
    /// carries the posting face, so a test can call the shims the adapter would.
    fn echo_linked() -> (
        Box<crate::adapter::AdapterHost>,
        [crate::adapter::LoadedAdapter; 1],
    ) {
        let adapter = crate::adapter::load_adapter(std::path::Path::new(env!(
            "TENSION_ECHO_ADAPTER"
        )))
        .expect("the reference adapter loads");
        let host = crate::adapter::AdapterHost::new(test_posting());
        let mut linker: Linker<HostState> = Linker::new(&Engine::default());
        let mut adapters = [adapter];
        crate::adapter::link_adapters(&mut linker, &mut adapters, host.api())
            .expect("the adapter links");
        (host, adapters)
    }

    /// What the reference adapter declared as its required regions — collected
    /// from its own `link`, not fabricated, which is what makes the checks below
    /// end-to-end ones.
    fn echo_required_regions() -> Vec<config::RegionNeed> {
        let (_host, adapters) = echo_linked();
        adapters[0]
            .required_regions()
            .iter()
            .map(|kind| config::RegionNeed {
                kind: *kind,
                adapter: adapters[0].name().to_string(),
            })
            .collect()
    }

    #[test]
    fn test_open_refuses_truncated_required_region() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let required = echo_required_regions();
        assert!(
            required.iter().any(|need| need.kind == arena::REGION_JOB),
            "the reference adapter declares the JOB region: {required:?}"
        );
        session.set_required_regions(required);

        // One alignment unit below JOB's end: the offset the adapter cached at
        // link time would land half outside the live arena.
        let short = (arena::JOB_OFFSET + arena::JOB_SIZE - 16) as u32;
        let entries = entries_with_arena(short);
        let error = open_bytes(
            &mut session,
            &mut store,
            &config::encode(&entries),
            &no_callbacks(),
        )
        .expect_err("a truncated required region is refused");

        assert_eq!(error.errno(), EINVAL);
        let text = error.to_string();
        assert!(text.contains("JOB"), "names the region: {text}");
        assert!(text.contains("echo"), "names the adapter: {text}");
        // A refusal leaves the session where it was.
        assert_eq!(session.state(), SessionState::Uninit);
    }

    #[test]
    fn test_open_succeeds_with_sufficient_arena() {
        let (_engine, mut store, mut session) = setup(GUEST);
        session.set_required_regions(echo_required_regions());
        let entries = entries_with_arena(arena::LAYOUT_FLOOR as u32);
        open_bytes(
            &mut session,
            &mut store,
            &config::encode(&entries),
            &no_callbacks(),
        )
        .expect("the smallest legal arena holds every required region");
        assert_eq!(session.state(), SessionState::Ready);
        assert!(
            !session.required_regions().is_empty(),
            "the set the run handed over is still the set the session checked"
        );
    }

    #[test]
    fn test_open_refuses_a_region_kind_the_layout_does_not_define() {        let (_engine, mut store, mut session) = setup(GUEST);
        session.set_required_regions(vec![config::RegionNeed {
            kind: arena::REGION_COUNT as u32,
            adapter: "ghost".to_string(),
        }]);
        let error = open(&mut session, &mut store, &no_callbacks())
            .expect_err("a region this layout does not define is refused");
        assert_eq!(error.errno(), EINVAL);
        let text = error.to_string();
        assert!(text.contains("ghost"), "names the adapter: {text}");
        assert!(text.contains("12"), "names the kind: {text}");
    }


    // ── A2a: the posting face, end to end ─────────────────────────────────

    /// The whole posting path without a guest: the reference adapter is loaded
    /// and linked, an event is posted **through the core API shim** — from
    /// another thread, because that is the promise `post_event` makes — and the
    /// epoch's future flush moves it into the class's sub-ring inside the real
    /// arena.
    #[test]
    fn test_echo_adapter_post_lands_in_ring() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let (host, adapters) = echo_linked();
        assert_eq!(adapters[0].name(), "echo");
        assert_eq!(host.source_count(), 1, "echo registered one source");

        // The arena the session owns: open it, so the sub-ring headers carry the
        // capacities the posting face was built with.
        let memory = session.memory();
        let capacities = arena::DEFAULT_RING_CAPACITIES;
        {
            let arena_bytes = memory.data_mut(&mut store);
            session
                .open_from_host(arena_bytes, arena::LAYOUT_FLOOR as u32, arena::DEFAULT_MAX_ARENA_SIZE as u32)
                .expect("the session opens");
        }

        // `post_event`, called exactly as an adapter's render thread would: the
        // raw pointer, the shim, and nothing borrowed from the store.
        let api = *host.api();
        // The pointer crosses the thread boundary as an address: a raw pointer
        // is not `Send`, which is a property of the *type*, not of the design —
        // the adapter's own render thread will do exactly this cast.
        let user = api.user as usize;
        let post = api.post_event.expect("the posting shim is installed");
        let (tx, rx) = std::sync::mpsc::channel();
        let poster = std::thread::spawn(move || {
            let user = user as *mut std::ffi::c_void;
            let mut seq = 0u64;
            // LOG is class 8; the payload is arbitrary and is read back below.
            let status = unsafe { post(user, 1, 8, 0x20, 42, 7, 1.5, -0.5, &mut seq) };
            tx.send((status, seq)).expect("the test is listening");
        });
        let (status, seq) = rx.recv().expect("the poster answered");
        poster.join().expect("the poster thread finishes");
        assert_eq!(status, 0, "the post was accepted");
        assert_eq!(seq, 1, "sequence numbers start at 1");

        // The epoch's publish step, in isolation: drain the class queue into the
        // sub-ring.
        let posting = host.posting();
        let queue = posting.queue(8).expect("class 8");
        assert_eq!(queue.len(), 1, "the event is waiting in its class queue");
        let arena_bytes = memory.data_mut(&mut store);
        let flushed = subring::flush_class_to_ring(arena_bytes, &capacities, 8, queue)
            .expect("the flush fits the arena");
        assert_eq!(
            flushed,
            subring::FlushResult { delivered: 1, dropped: 0, first_slot: 0 }
        );
        assert_eq!(queue.delivered(), 1);

        // And the record is in LOG's ring, with the class its storage implies
        // and the payload that was posted.
        let (header, slots) = subring::event_subring_slice(arena_bytes, &capacities, 8)
            .expect("class 8's sub-ring is inside the arena");
        assert_eq!(header.head, 1);
        let record = arena::read_event_record(slots, 0);
        assert_eq!(record.class, 8);
        assert_eq!(record.seq, 1);
        assert_eq!(record.flags, 0x20);
        assert_eq!((record.a, record.b), (42, 7));
        assert_eq!((record.f0, record.f1), (1.5, -0.5));
    }

    #[test]
    fn test_post_event_refuses_an_unregistered_source() {
        let (host, _adapters) = echo_linked();
        let api = *host.api();
        let post = api.post_event.expect("installed");
        for source in [0u32, 2] {
            let mut seq = 0u64;
            // SAFETY: the shim only reads the host and the posting face.
            let status = unsafe { post(api.user, source, 8, 0, 0, 0, 0.0, 0.0, &mut seq) };
            assert_eq!(status, EINVAL, "source {source} was never registered");
            assert_eq!(seq, 0, "a refused post hands back no sequence number");
        }
        // The one registered source is accepted.
        let mut seq = 0u64;
        let status = unsafe { post(api.user, 1, 8, 0, 0, 0, 0.0, 0.0, &mut seq) };
        assert_eq!((status, seq), (0, 1));
    }

    // ── §6.1: an absent callbacks record ──────────────────────────────────

    /// The A1 convenience path (`--session-open`) reaches the same `apply_open`
    /// the verb does — with the config built by the host instead of decoded out
    /// of a guest's stream. What it must not do is *skip* the checks, which is
    /// what this pair of tests pins.
    #[test]
    fn test_open_from_host_reaches_ready() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let memory = session.memory();
        let outcome = {
            let arena_bytes = memory.data_mut(&mut store);
            session.open_from_host(
                arena_bytes,
                arena::LAYOUT_FLOOR as u32,
                arena::DEFAULT_MAX_ARENA_SIZE as u32,
            )
        };
        outcome.expect("the host's own open succeeds");
        assert_eq!(session.state(), SessionState::Ready);
        assert!(
            session.callbacks().expect("resolved").is_empty(),
            "the host's open registers no callbacks"
        );

        // The arena reports what the open wrote: READY, an arena at the layout
        // floor, and the ceiling that is also the guest's `--memoryBase`.
        let memory = session.memory();
        let data = memory.data(&store);
        let field = |offset: usize| {
            let at = arena::SESSION_INFO_OFFSET + offset;
            u32::from_le_bytes(data[at..at + 4].try_into().expect("four bytes"))
        };
        assert_eq!(arena::control_state(data), arena::STATE_READY);
        assert_eq!(
            field(arena::SESSION_INFO_ARENA_SIZE),
            arena::LAYOUT_FLOOR as u32
        );
        assert_eq!(
            field(arena::SESSION_INFO_MAX_ARENA_SIZE),
            arena::DEFAULT_MAX_ARENA_SIZE as u32
        );
    }

    #[test]
    fn test_open_from_host_runs_the_same_checks_as_the_verb() {
        let (_engine, mut store, mut session) = setup(GUEST);
        session.set_required_regions(vec![config::RegionNeed {
            kind: arena::REGION_JOB,
            adapter: "echo".to_string(),
        }]);
        let memory = session.memory();
        let outcome = {
            let arena_bytes = memory.data_mut(&mut store);
            // Below the JOB region's end, so the capability's own check refuses
            // it — before the layout floor is even consulted.
            session.open_from_host(arena_bytes, 4096, arena::DEFAULT_MAX_ARENA_SIZE as u32)
        };
        let error = outcome.expect_err("a truncated required region is refused");
        assert_eq!(error.errno(), EINVAL);
        assert!(error.to_string().contains("JOB"), "{error}");
        assert_eq!(
            session.state(),
            SessionState::Uninit,
            "a refusal leaves the session where it was"
        );
    }

    /// The smoke fixture hardcodes three numbers the arena owns: the control
    /// block's magic, the offset `SessionInfo.maxArenaSize` lives at, and the
    /// default ceiling it expects to read there. The smoke test would catch a
    /// drift as a trap in a subprocess; this catches it by name, before one is
    /// spawned — the fixture and the arena shape move together.
    #[test]
    fn the_smoke_fixture_pins_this_builds_arena_constants() {
        let fixture = include_str!("../../tests/fixtures/session_guest.wat");

        let magic = format!("0x{:016x}", arena::MAGIC);
        assert!(
            fixture.contains(&magic),
            "the fixture's magic assertion must be {magic} (arena::MAGIC)"
        );

        let state_at = format!("(i32.const {:#x})", arena::CONTROL_STATE);
        assert!(
            fixture.contains(&state_at),
            "the fixture reads the control block's state at {state_at} (arena::CONTROL_STATE)"
        );

        let ceiling_at = arena::SESSION_INFO_OFFSET + arena::SESSION_INFO_MAX_ARENA_SIZE;
        let ceiling_at_text = format!("(i32.const {ceiling_at:#x})");
        assert!(
            fixture.contains(&ceiling_at_text),
            "the fixture reads maxArenaSize at {ceiling_at_text} \
             (SESSION_INFO_OFFSET + SESSION_INFO_MAX_ARENA_SIZE)"
        );
        assert!(
            fixture.contains(&format!("(i32.const {})", arena::DEFAULT_MAX_ARENA_SIZE)),
            "the fixture must expect this build's default ceiling ({})",
            arena::DEFAULT_MAX_ARENA_SIZE
        );
    }

    #[test]
    fn test_open_accepts_an_absent_callbacks_record() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let entries = entries_with_arena(arena::LAYOUT_FLOOR as u32);
        open_bytes(
            &mut session,
            &mut store,
            &config::encode(&entries),
            &arena::CallbacksRecord::absent(),
        )
        .expect("a guest that registers nothing opens");
        assert_eq!(session.state(), SessionState::Ready);
        assert!(
            session.callbacks().expect("resolved").is_empty(),
            "no slots were filled"
        );
    }

    #[test]
    fn test_open_refuses_a_pointer_without_a_length() {
        let (_engine, mut store, mut session) = setup(GUEST);
        let mut entries = entries_with_arena(arena::LAYOUT_FLOOR as u32);
        for (key, value) in entries.iter_mut() {
            if *key == config::KEY_CALLBACKS_PTR {
                *value = arena::DEFAULT_MAX_ARENA_SIZE as i64;
            }
        }
        let error = open_bytes(
            &mut session,
            &mut store,
            &config::encode(&entries),
            &no_callbacks(),
        )
        .expect_err("a pointer with no length is a half-stated record");
        assert_eq!(error.errno(), EINVAL);
        assert!(error.to_string().contains("callbacks"), "{error}");
    }
}
