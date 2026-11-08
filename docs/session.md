# The session

The session is the coprocessor between a guest and the capability adapters
loaded beside it: it owns the memory the guest imports, decides when an
adapter's event reaches the guest, and holds every deferred submission until the
guest is out of its callback. This page is the contract between the two sides of
that — what a guest may call, what the arena it reads actually is, and in what
order the session says yes or no.

It sits between two other documents and repeats neither. `docs/abi/guest.md` is
the generated list of imports; `docs/architecture.md` §4 is the host loop that
drives the epoch and §7 the ownership boundary. What is left, and what this page
covers, is the execution contract: the epoch's phases, the state machine, the
deferred-submission rules, and the arena's shape.

It is derived from code. Every claim carries a `file:line`; a bare filename means
a file under `tension-core/src/session/` (`mod.rs`, `epoch.rs`, `posting.rs`,
`subring.rs`, `arena.rs`, `config.rs`, `apply.rs`).

**Session has more design content than any other host subsystem.** Some claims
in §3–8 are **[I]** — the rationale lives in `tension-ogre/DESIGN.md` or in a code
comment rather than in code that enforces it, and the design note is quoted here
rather than lost in its deletion. Every [I] names the source it rests on; every [V]
cites code that does the work. Do not read this page as stronger than its
markers.

> **Citations to design notes.** `tension-ogre/DESIGN.md` and
> `tension-2d/DESIGN.md` were deleted in pass 7. Every claim these pages
> drew from them is preserved here; a `DESIGN.md:` citation below is a
> historical reference to a file no longer in the tree, kept so the
> provenance of a sentence stays legible.

## 1. What a session is

One session, one process. `HostState.session` is an `Option<Session>`
(`main.rs:204`), created once from the module's declared memory import before
instantiation (`Session::create_from_module`, `mod.rs:378`) and installed before
the guest runs. A verb takes the session *out* of the store for its duration and
puts it back on every path, including a refusal (`session_open`, `mod.rs:1158-1165`)
— which is why the arena memory handle is also kept apart in `HostState`
(`main.rs:130-135`).

**It is not plural.** `SESSION.md` argues for more than one session in a
process; the code has one. `docs/architecture.md` §7 records that as design
intent, and this page does not revisit it.

**What it owns, and what it only borrows.** It owns the memory, the arena's
shape, the per-class host queues, the subscriptions and their modes, the epoch,
and the pending list. It owns none of the window, the Vulkan instance or the
surface — those are the host's (`docs/architecture.md` §2), and Ogre does not own
them either: the renderer creates its `VkDevice` and swapchain *from* the host's
handles and destroys them on its own thread (`docs/modules/ogre.md` §6).

The session runs no thread of its own. Every epoch happens on the thread that
entered the guest — a `session::*` call, or the host's loop
(`main.rs:2070` → `epoch.rs:107`). That is what lets it call the guest's own
callbacks at all: it is already inside a host call on the guest's stack, so
`onBatch` is a nested wasm call, never a second thread (`epoch.rs:4-9`).

## 2. The seven verbs

Registered in one place, `link_session` (`mod.rs:1497-1540`). The wasm-side
signatures and the guest SDK's wrappers are `docs/abi/guest.md`; this table
records what each verb *does* and how it refuses.

| verb | signature | what it does | thread / phase | refusals |
|---|---|---|---|---|
| `open` | `(cfg_ptr: u32, cfg_len: u32) -> i32` | decode the config, run the fixed check order, resolve callbacks, write the rings and `SessionInfo`, move to READY | guest thread; takes the session out of the store | `-EINVAL` config/structure, `-EBUSY` not `UNINIT`/`CLOSED` (`mod.rs:1158`, `:1168`) |
| `close` | `() -> i32` | write `STATE_CLOSED` and drop the resolved callbacks; wake a blocked `wait`. Nothing else in the arena is touched — a re-open rewrites what it needs (`mod.rs:1065-1076`) | guest thread | none — returns 0 from any state, and a second close is a no-op (`mod.rs:1293`) |
| `wait` | `(timeout_ms: i32) -> i32` | block, then run an epoch over every class; `timeout_ms < 0` blocks forever, `0` never blocks | guest thread | `-EBADF` not READY, `-EBUSY` re-entrant, `-EIO` callback trap (`mod.rs:1381`) |
| `drain` | `(class: u32) -> i32` | one epoch restricted to one class, never blocking | guest thread | `-EBADF`, `-EBUSY`, `-EIO`, `-EINVAL` unknown class (`mod.rs:1393`, `epoch.rs:180`) |
| `subscribe` | `(sub_ptr: u32) -> i32` | read a 16-byte `Subscription` and set that class's mode | guest thread; **no epoch** (so no session take) | `-EINVAL` bad class or mode, `-EBADF` (`mod.rs:1404`) |
| `unsubscribe` | `(class: u32) -> i32` | back to the class's default mode, off | guest thread; no epoch | `-EINVAL` unknown class, `-EBADF` (`mod.rs:1458`) |
| `pending` | `() -> i32` | how many deferred submissions are waiting | guest thread | `-EBADF`, `-EBUSY` (`mod.rs:1485`) |

Three properties of the set are load-bearing:

- **`open` and `close` are the only verbs that do not require READY**
  (`state_refusal`, `mod.rs:1361-1379`; `require_ready`, `mod.rs:821-826`).
  Everything else answers `-EBADF` outside READY.
- **A verb called from inside a callback is `-EBUSY`** (`depth_refusal`,
  `mod.rs:1352-1359`). The depth counter is the session's, set around every
  callback invocation; nothing else in the process sets it.
- **`close` does not tear down the adapters** (`mod.rs:1280-1293`). An adapter
  is process-scoped — `init`/`link` once — while a session may close and re-open
  (`test_open_after_close_succeeds`, `mod.rs:2453`). Adapter teardown belongs to
  the run's end, in `main.rs`.

## 3. The epoch

An epoch is one pass of three phases over the classes a verb names. It runs only
inside a `session::*` call or the host loop, never on an adapter thread
(`epoch.rs:4-9`).

**Before anything: two gates.** READY, or `-EBADF` (`epoch.rs:117-122`); depth
zero, or `-EBUSY` (`epoch.rs:124-128`). A callback that waited would run an epoch
inside an epoch on the same guest stack.

**1. Publish.** The adapters' `publish` hooks run first, in registration order
(`epoch.rs:154`), then each class queue is drained into its sub-ring and the
counters mirrored (`epoch.rs:180-195`), then `FrameState` is written
(`epoch.rs:229-240`). Publishing completes for the whole epoch *before* the first
callback fires — that is what makes an exempt accessor called from inside a
callback see a consistent arena (`epoch.rs:13-17`).

A pending fatal-adapter fault is swept during publish, not before it: the job
sweep is the publish phase's work (`epoch.rs:156-166`). The sweep itself is still
a stub (`apply::sweep_jobs_to_failed`, `apply.rs:266`), and no adapter signals
the flag yet.

**2. Invoke.** Class by class in ascending id (`epoch.rs:288-352`). `BATCHED`
gets one `onBatch(class, ptr, count)`; `DIRECT` gets one `onEvent(class, ptr)`
per record; every other mode — `POLLED`, and `RING`, which is accepted but
delivered like `POLLED` (`known-limitations.md`) — invokes nothing and simply
counts the deliveries (`epoch.rs:347-350`). A class with no registered callback
still has its records published into the ring and still counts as delivered,
which is what lets a guest read them itself (`epoch.rs:295-303`).

The callback's return value is **advisory**: a negative status is logged and the
batch is consumed anyway (`epoch.rs:305-311`).

**A trap** is not advisory. `fault_from_trap` (`epoch.rs:381-414`) disables the
slot (`epoch.rs:397`) and moves the session to FAULTED, writes `FrameState` with
`faultState = FAULT_CALLBACK_TRAP` and `lastError = slot index`, sets the control
block to FAULTED with `-EIO`, and returns `CallbackTrap`. The verb that pumped
returns `-EIO` even though the epoch got as far as it did. The disabled slot is a
`[bool; 2]` on the session (`mod.rs:355`, `:1087-1096`) and is not reset by a
re-open — permanent for the `Session` object's lifetime, which is the process's.

**3. Apply.** Deferred submissions, at depth 0, after every callback has returned
(`epoch.rs:356-370`, `apply.rs:164`). §6 has the rules.

**The frame counter.** The epoch bumps `Session::frame_index` once per pass
(`epoch.rs:228-229`, `mod.rs:1109-1112`), and that number is what
`FrameState.frameIndex` carries. It is the session's epoch counter, not the
renderer's frame number
(`tension-framework/assembly/runtime/wire.ts:301-302`); it is also not a clock
(`docs/architecture.md` §4).

**Why the three phases in that order** is design rationale, not something the
code states: publish-before-invoke exists so a callback sees a fully published
arena, and apply-last exists because a callback must not mutate the store it is
running inside **[I]** (`tension-ogre/DESIGN.md:166-213`, `:2030-2075`).

## 4. The arena

The session creates the memory, zeroes the whole band the module claims, and
writes the arena *before* the guest exists (`prepare_arena`, `mod.rs:500-541`).
The zeroing comes first because it is the baseline that makes the later
"is the band still zero?" check complete (`mod.rs:509-514`).

**The header page is fixed.** `ArenaControl` at `0x000` (256 B), `SessionInfo`
at `0x100` (144 B), the region table at `0x200` (12 descriptors × 24 B), the
manifest after it (`arena.rs:51-58`). Regions follow at `0x1000`. A guest finds
a region by arithmetic, not by a verb: `kind == index`, and no
`session_get_region` exists (`arena.rs:414-427`, `tension-framework/assembly/runtime/arena.ts:5-12`).

**The region table** is twelve entries of `{kind, flags, offset, size, align,
reserved}` (`arena.rs:404-427`), written once (`write_region_table`,
`arena.rs:601-616`). Direction bits in `flags` are `RD_GUEST_WRITES` (1),
`RD_SESSION_WRITES` (2), `RD_WRITES_ONCE` (4), `RD_BYTES` (8)
(`arena.rs:303-307`). The ogre-specific sizes and what each adapter does with
them are `docs/modules/ogre.md` §4.1; this table is the session-general one.

**`layout_hash`** is FNV-1a over a canonical stream: the header geometry, the
region table (`kind`, `flags`, `size`, `align` — not the runtime offsets), the
type catalogue, the field offsets of every record a guest reads by number, and
the scalar constants that decide how a word is read (`arena.rs:1026-1080`). It
deliberately excludes the guest's chosen `arena_size` and anything else that
varies per run, so a legitimate configuration cannot be refused for looking
different (`arena.rs:1029-1034`). The *name* of each field is hashed beside its
offset, so a rename moves the hash as surely as a move does (`arena.rs:1063-1080`).
A guest's config carries the hash it was built with and `open` compares
(`config::check_layout_hash`, `config.rs:346-354`).

**Class ids are thirteen, not ten.** `CLASS_COUNT = 13` (`arena.rs:124`), with
`DEVICE_LOST` 0 through `FRAME` 9 and the AI family 10–12 appended after it
(`arena.rs:210-229`); the defaults are 13 capacities and 13 modes
(`arena.rs:266`, `:275`). Appending, never inserting, is the rule: a class id is
a subscription key and a wire value (`arena.rs:118-122`). The design note's
ten-row table (`tension-ogre/DESIGN.md:123-134`) is superseded by the code —
this is the correction pass 3 found, closed here.

**Per-entry checksums: there are none, and the design note says otherwise.**
`DESIGN.md:1788-1796` claims every session verb re-reads `magic`, `layoutHash`
and `regionCount` **and re-checksums the region table against the copy in
`SessionInfo`**. No checksum of the region table exists anywhere in
`tension-core/src` (`rg 'crc|checksum' session/` returns nothing), and the
region table is written once and never re-read (`write_region_table`,
`arena.rs:601`; the only reader is a test, `mod.rs:1972`). What *is* re-checked
is the control-block **triple** — magic, layout hash, region count — at exactly
two points: `verify_post_instantiate` (`mod.rs:556-598`) and
`verify_open_preconditions` (`mod.rs:859-905`). Not at every verb. Recorded as
contradiction 23.

**What guards what.** The always-arena range `[0, layout_end)` has the triple as
its runtime detector and the pre-`start` zero sweep as its complete startup
test; the reserved gap `[layout_end, memory_base)` has the canary lattice
(`arena.rs:981-1005`, `mod.rs:535`). The lattice's honest limit — it
detects, it does not prevent — is `known-limitations.md`.

Everything in this section is **[V]** — each claim cites the code that writes or
reads the thing described — with one exception already labelled: the design
note's checksum claim is false, and what replaces it is the two-check statement
above, not a third mechanism.

## 5. Sub-rings

Each class has one sub-ring inside `EVENT_TABLE`: a 32-byte `TableHeader`
followed by `capacity × 32` bytes of `EventRecord`, 16-byte aligned
(`subring.rs:1-20`; the geometry helpers are
`subring::event_subring_offset`, `:111`, and `event_subring_slice`, `:126`).

Two counters, and the split between them is the contract:

- **`head`** — records the session has written and not yet compacted away. The
  buffer is kept dense from slot 0, which is what lets `onBatch` hand the guest
  one contiguous run (`subring.rs:8-11`).
- **`tail`** — records the guest has consumed. The guest writes it; it is space
  reclaim, not an acknowledgement, and only `compact_subring` writes it
  (`subring.rs:12-14`, `arena.rs:677`).

**Full is a drop, never an overwrite.** When the ring is full and the guest has
reclaimed, `compact_subring` slides the live records to the front, zeroes the
tail and bumps the generation (`subring.rs:200-248`). When it is full and the
guest has reclaimed nothing, the append is refused and the caller counts a drop
(`subring.rs:16-20`, `:290-296`). Room is made **once, before appending**, not
mid-run: compacting halfway would slide records out from under the pointer a
callback is about to be handed (`subring.rs:265-270`).

**Counters live host-side and are mirrored.** `ClassQueue` owns `dropped` and
`delivered` (`posting.rs:95-110`); the epoch copies them into the class's
header at offsets 20 and 24 of `TableHeader` (`arena.rs:144-145`), and rolls the
drop total into `FrameState.droppedEvents` (`epoch.rs:192-194`, `:231`). The arena copy is a
*report*: a guest that writes it changes nothing the session believes, and the
next publish overwrites it (`epoch.rs:190-191`, `posting.rs:95-99`).

**Capacities are per class and settable at open.** Defaults are
`DEFAULT_RING_CAPACITIES` (`arena.rs:266`); a guest may override any of them in
its open config, and the posting face — an `Arc` an adapter thread may already
hold — adopts the live numbers at open (`mod.rs:1261-1267`,
`posting.rs:483-487`). A capacity of zero is refused at decode
(`config.rs:395-401`); the queue clamps to one anyway (`posting.rs:113`,
`:144`).

**Why sub-rings rather than one shared ring** is design rationale **[I]**: a
shared ring with class tags cannot hand `onBatch` a contiguous run of one class
without a per-class compaction copy, and a guest-visible single tail is correct
only if delivery is exactly-once per tail advance (`tension-ogre/DESIGN.md:213-230`).
The code matches the conclusion; the comparison is the note's.

Everything above the closing comparison is **[V]**: the geometry, the two
counters, the compaction-before-append rule, the drop accounting and the
host-side counters are all in `subring.rs`, `arena.rs`, `epoch.rs` and
`posting.rs` at the cited lines.

## 6. Deferred submission

A `queue_*` verb called **inside a callback** cannot do its work there: the
callback runs mid-epoch, the store is mid-borrow, and a verb writing guest memory
at that moment would mutate what the guest is still reading
(`apply.rs:3-10`).

So the session copies. `encode_slots` copies the arguments out of the guest at
the moment of the call, and the submission goes into a bounded FIFO
(`apply.rs:34-47`, `:123`). The copy is the load-bearing detail: a
`(verb, guest_ptr)` pair would be re-read after arbitrary guest code had run
(`apply.rs:7-9`) **[V]** — and the same decision is what makes the list survive a
trap, because the bytes belong to the session, not the callback
(`apply.rs:16-19`).

**Two flags, three behaviours**, decided at the import boundary
(`ffi.rs:741-789`):

- `DEFERRABLE` and depth > 0 → copy and queue; the guest's wasm result is `0`,
  "accepted"; a full queue is `-ENOSPC` synchronously (`ffi.rs:746-779`).
- `REENTRANT_READONLY` and depth > 0 → run normally; no pump, no block
  (`ffi.rs:788-789`).
- neither → `-EBUSY` (`ffi.rs:780-787`).

Deferring is checked **before** the read-only flag: an import declaring both is
deferred, because deferring is always safe and running eagerly is not
(`ffi.rs:746-749`). A `DEFERRABLE` import is refused at registration unless the
adapter has an `apply` slot and an `i32` return, because `-ENOSPC` is what a full
queue answers (`adapter/mod.rs:1171-1184`).

**Bounds.** The pending queue holds 256 entries by default
(`apply.rs:66-70`), not configurable. A push past that answers `-ENOSPC` to the
wasm caller, inside the callback (`apply.rs:84-90`, `ffi.rs:770-779`).

**Apply.** At depth 0, after every callback has returned, `apply_pending` walks
the queue in order and calls each adapter's `apply` with the copied bytes
(`apply.rs:164`). A submission the adapter refuses is not lost: it becomes a
`SUBMISSION_REJECTED` (class 3) delivery in the next epoch
(`apply.rs:157-160`, `:233-250`). This class exists for exactly that reason —
a submission accepted inside a callback can fail later, when the guest is no
longer in a call that could receive an errno (`arena.rs:203-206`).

**A trap does not clear the queue** (`epoch.rs:356-362`, `apply.rs:16-19`) — the
trap path returns before the apply phase, the entries stay, and they are applied
at the guest's next epoch, which after a fault is the first epoch of a
close-and-reopen. Pinned by `test_pending_survives_trap` (`epoch.rs:1415`) and
`test_deferred_submissions_survive_a_trap` (`tension-core/tests/session_smoke.rs:397`).

Two claims here are rationale rather than code: *why* copy instead of re-read
(a guest could rewrite the record after the callback returned) and *why* the
list is session-owned across a trap — both are stated in `apply.rs:3-19` and
`tension-ogre/DESIGN.md:243-259` **[I]**; that they hold is [V], by the two
tests above.

## 7. Check order and the state machine

**`open` runs a fixed order**, and the first failure is the one reported:
`abi_version` → `layout_hash` → C1 → required regions → C4 → ring capacities →
callbacks (`config::validate_with_regions`, `config.rs:495-512`; the comment at
`:487-505` states the order).

C1 is the arena's internal consistency — non-zero, 16-byte aligned,
`arena_size ≤ max_arena_size` (`config.rs:357-378`). C4 is the floor check: the
fixed layout must fit the declared live arena (`config.rs:380-390`). The
required-region check sits **before** C4 because it is the more specific
statement of the same guarantee and can name the adapter and the region, where C4
can only name two numbers; it refuses a subset of what C4 refuses, because every
region in the fixed table ends at or below `LAYOUT_FLOOR` (`config.rs:487-494`,
`:456-484`).

**C2/C3 are not in that order, and the design note is wrong about where they
run.** `DESIGN.md:1893-1899` puts "memory import match (C2/C3)" between C1 and
the required-region check. In code, the memory import is examined when the
`Session` is *constructed* — `create_from_module` reads the module's declared
memory imports, refuses none/multiple/unknown-name/shared, and derives the page
counts and `memoryBase` from them (`mod.rs:378-445`). That is before
`session_open` exists as a call, so the open-time order has no C2/C3 step at all
(`config.rs:505-509` says so explicitly). The ordering claim is a description of
a version that never shipped. Recorded as contradiction 22.

**The state machine** is four states (`mod.rs:113-122`):

```
0 UNINIT   memory exists; structural arena written; nothing validated
1 READY    session_open succeeded
2 FAULTED  terminal until closed: callback trap, adapter fault, or tamper
3 CLOSED   session_close completed
```

Transitions, as the code implements them:

- `UNINIT → READY` and `CLOSED → READY` (`open_state_check` accepts both,
  `mod.rs:811-816`); a re-open rewrites the arena (`apply_open`,
  `mod.rs:926-1000`). [V]
- `READY → CLOSED`, `FAULTED → CLOSED`, `UNINIT → CLOSED`, `CLOSED → CLOSED`:
  `close` is idempotent from every state and returns 0 (`mod.rs:1293-1325`). [V]
- `READY → FAULTED`: only the session does this, on a callback trap
  (`Session::fault`, `mod.rs:1115-1117`, called from `epoch.rs:398`). [V]
- `FAULTED → READY` is refused with `-EBUSY`: `open_state_check` accepts only
  `Uninit | Closed` and `NotUninit` maps to `-EBUSY` (`mod.rs:811-816`, `:293-303`;
  `test_open_refuses_faulted`, `mod.rs:2442`). Close first. [V]
- **A second `open` while READY is always `-EBUSY`** — whatever the parameters.
  The design note says "a second `session_open` with identical parameters returns
  0" (`DESIGN.md:1899-1900`); the code has no parameter comparison, and
  `test_open_requires_uninit_state` pins the refusal (`mod.rs:2425`). Recorded as
  contradiction 22. [V]

**Instantiation order**, as the host actually does it (`main.rs:1548-1733`):
`linker.instantiate` → `verify_post_instantiate` (triple, band still zero, gap
lattice) → `__start` if the module exports one → the host-side open when
`--session-open` was passed → `_start_game` (or `_start`). `__start` runs guest
code, so it must sit after the verification and before the game
(`main.rs:1611-1619`). A guest that opens the session itself does so at the top
of `_start_game`; `--session-open` exists only so a fixture without a guest SDK
can reach READY, and a guest that then called `open` would get `-EBUSY`
(`main.rs:1620-1626`).

**Every verb but open/close answers `-EBADF` outside READY**, and a callback trap
makes the pumping verb answer `-EIO` (`mod.rs:293-303`, `:1361-1379`). The
arena's `state` field is the guest's *report*; the authoritative machine is
host-side and never guest-writable (`mod.rs:344-356`). [V]

One design claim in this area is unimplemented: `DESIGN.md:1937-1938` says a
verb that detects a fault *during its own entry* returns `-EIO` and moves to
FAULTED. The only fault source the code has is a callback trap; there is no
entry-time detector to move the machine. [I] for the intent, and no code to
verify it against.

## 8. A wrong `memoryBase`

`memoryBase` is `max_arena_size` (`mod.rs:447`), the top of the reserved band and
the address where the guest's heap begins. Three ways it can be wrong, and the
code's answer to each:

**1. The generated constants and the build flags disagree.** Prevented by
generation: `scripts/gen-session.mjs` derives the `asc` flags
(`--memoryBase`, `--initialMemory`, `--maximumMemory`) from
`tension-framework/session.json`, so a hand edit is the only way in. The guest
can still catch it: `SessionInfo.maxArenaSize` is the session's own number, and
the SDK asserts against it. [V] for the generation and the field
(`arena.rs:89`, `:580`); [I] for the guest-side assertion as the backstop,
since it lives in the SDK rather than the host.

**2. The build used a smaller `memoryBase` than the session's
`max_arena_size`.** The module's declared *minimum* pages encode the build's
`memoryBase`, so a mismatch shows up as a page-count problem at
`create_from_module` (`mod.rs:406-434`, `C3` in the design's vocabulary). The
refusal is `CapBelowMinimum` when the host's cap cannot meet the declared
minimum — `-EINVAL` (`mod.rs:428-434`, `:293-303`). [V]

**3. A hand-built module that overlaps anyway.** This is the silent case, and
three mechanisms stand between it and corruption:

- **Before instantiation**, the whole declared band is zeroed and then the
  header page, region table, manifest and gap lattice are written
  (`prepare_arena`, `mod.rs:500-541`). Order is load-bearing: zeroing after the
  writes would erase them, and the zero baseline is what makes the next check
  meaningful (`mod.rs:509-514`). [V]
- **After instantiation, before `_start_game`**, three checks, cheapest first:
  the triple; the region band `[header_page, layout_end)` **still all zero** —
  a complete test for a data segment landing in the live arena; and the gap
  lattice, which names the first overwritten block
  (`verify_post_instantiate`, `mod.rs:556-598`). [V]
- **At `open`**, the triple and the lattice are re-checked, but *not* the band's
  zero sweep: a guest is allowed to stage records into the region band before it
  opens (`verify_open_preconditions`, `mod.rs:852-905`). [V]

**Three load-time refusals** guard the same failure from the other side
(`check_guest_module`, `main.rs:2241-2298`): a module importing `session::*`
without any memory import; a module importing a memory without re-exporting one
named `memory` (every built-in service reaches guest memory through
`get_export("memory")`, so the alternative is a panic inside `print`); and a
module with a wasm `start` section *and* a session import, because a start
section runs guest code during instantiation, inside the window the
verification exists to protect. The start-section check is scoped to session
guests on purpose — the pre-session examples build with plain `asc` and emit a
start section (`main.rs:2283-2298`). [V]

**The design note says these three "are not implemented yet"**
(`DESIGN.md:2200`). They are, at the lines above. That half of §11 is stale
in the *safe* direction. [V]

**What is still not caught**, and is the honest limit: a hand-built module whose
data segment lands in the gap *and* happens to miss every canary block is
undetected until it hits one. The lattice samples; it does not prove
(`known-limitations.md`). [V] for the mechanism, [I] for the residual risk.

## 9. Where this sits

- **`docs/architecture.md`** owns the host loop: `HOST_LOOP_SLICE_MS`, the pump
  cadence, resize and close latency, and the non-yielding-guest risk (§4). This
  page owns what happens *inside* the epoch that loop calls.
- **`docs/abi/guest.md`** is the generated import list — names, signatures,
  modules. This page is what those imports do and how they refuse.
- **`docs/abi/adapter.md`** is the host-to-adapter vtable. The session calls
  `publish` and `apply` through it; the rules there are the adapter's, not the
  session's.
- **`docs/modules/ogre.md`** §4.1 has the ogre-specific region sizes and who
  touches each. This page has the twelve-region table as a session concern.

## 10. Tests

**Unit tests inside the session modules** (`cargo test --bin tension-core`, filtering
`session::` — 139 of them; `--lib` does not see them, because `session` is declared
in `main.rs`):

- `mod.rs` — the state machine and open path: `test_open_requires_uninit_state`
  (`:2425`), `test_open_refuses_faulted` (`:2442`),
  `test_open_after_close_succeeds` (`:2453`), bad abi / bad hash / C1 /
  callbacks placement / callbacks resolution / slot shape / ring headers /
  capacity override / required regions, both refusal and acceptance
  (`:2496-3266`). Load-bearing for §7 and §4.
- `epoch.rs` — `test_callback_trap_faults_session` (`:1221`),
  `test_deferrable_verb_from_callback_queued` (`:1293`),
  `test_non_deferrable_verb_from_callback_refused` (`:1319`),
  `test_pending_survives_trap` (`:1415`), `test_apply_at_depth_zero` (`:1457`).
  Load-bearing for §3 and §6.
- `subring.rs` — geometry, wrap, compaction, drop accounting.
- `posting.rs` — queue caps, drop counters, `wait_for_events` outcomes.
- `apply.rs` — `the_default_capacity_is_256` (`:304`), `the_queue_is_fifo_and_bounded`,
  rejection.
- `config.rs` — the decoder and every named refusal.
- `arena.rs` — the offset table, the layout hash's stability, the lattice.

**Integration** (`tension-core/tests/session_smoke.rs`, 496 lines): the happy
path (`:70`), the `--session-open` flag (`:104`), the memory-import refusals
(`:125`, `:145`, `:162`), bad adapter ABI (`:205`), duplicate import (`:229`),
`region_lookup` before the arena exists (`:246`), the epoch fixture delivering a
batch (`:266`), a trapping callback (`:310`), deferred submissions applied after
the batch (`:354`) and surviving a trap (`:397`), and a rejected submission
delivered (`:432`).

**Cross-cutting:** `ogre_surface.rs` exercises the adapter side of the same
contract (sixteen imports, declared regions, `publish` no-op while clean);
`ogre_host_surface.rs` runs a real guest through open, epochs, resize and close.

## 11. Non-goals

- The wasm import surface itself — names, signatures, modules:
  `docs/abi/guest.md` (generated).
- The host loop's timing and the freeze risk: `docs/architecture.md` §4.
- The adapter vtable, including what `publish` and `apply` must not do:
  `docs/abi/adapter.md` (generated) and `tension-core/include/tension_adapter.h`.
- The ogre region sizes and per-region ownership: `docs/modules/ogre.md` §4.1.
- The canary lattice's limits, `RING` behaving like `POLLED`, and the fixed
  region count: `docs/known-limitations.md`.
- Plural sessions: design intent in `SESSION.md`, not a property of the code
  (`docs/architecture.md` §7).
- The scheduler's park/wake path (`scheduler::park`, `__taskWake`): a separate
  contract with its own table; the epoch only buffers completions for it
  (`epoch.rs:238-286`).

## 12. Source index

**Citations are point-in-time.** They go stale when a cited file changes
above them, and no drift gate exists for this page — only the generated
`docs/abi/*.md` are drift-checked. Re-verify a citation before acting on
it. The real fix (generated citations, or slot names without line
numbers) is a future project.

- `session/mod.rs` — the verbs, the state machine, open's staged path, the arena
  preparation and its two verification points.
- `session/epoch.rs` — the three phases, the invoke rules, the trap path.
- `session/posting.rs` — the per-class queues, the authoritative counters,
  `wait_for_events`.
- `session/subring.rs` — the arena-side geometry, compaction, drop accounting.
- `session/arena.rs` — the layout, the table, the manifest, the hash, the
  lattice.
- `session/config.rs` — the TLV decoder and the ordered checks.
- `session/apply.rs` — the pending queue and the apply phase.
- `docs/session-findings.md` — the record-writer and codegen findings; nothing
  in it is a contract, and this page absorbs none of it (see the pass report).
- `main.rs` — the instantiation order (`:1548-1733`) and the load-time refusals
  (`:2241-2298`).
- `tension-framework/assembly/runtime/{wire,arena,session}.ts` — the guest's
  view of the same constants and verbs.
