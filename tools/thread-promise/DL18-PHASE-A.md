# DL18 — Phase A: what a park table costs, and why the renumber stops here

Phase A only. Phase B follows in the same round (A1 does not stop); the renumber
line stops on A3/A4 and is reported, not done.

## 0. Phase 0, verbatim

```
$ cd ~/work/Tension
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
integration/dwarf-debug
2c786b0
$ cd ~/work/TensionScript-a2
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
main
3f59ec08
$ sha256sum dist/assemblyscript.js ~/work/Tension/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js
aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d  /home/acakar/work/TensionScript-a2/dist/assemblyscript.js
aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d  …/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js
```

**`std/` is current** (I46): `std/assembly/thread.ts` in the package and in the
tree are byte-identical (`1905948486…`), and `dist/asc.js` matches too
(`da283bcd`). DL17B's install fixed I46.

**The binary was stale, and rebuilding it was not optional.** Before:

```
binary   33594528  2026-11-23 00:25:55
find src -newer <binary> -name '*.rs'   →  src/thread.rs, src/main.rs   (both 00:43:04)
```

After `cargo build --release --bin tension-core`:

```
binary   33594416  2026-11-23 01:21:08
find src -newer <binary> -name '*.rs'   →  (empty)
```

(16 bytes smaller despite `thread.rs` growing: the I39 host edit was a comment
and the release profile re-inlined. Size is not a leak signal here; the mtime
gate is.)

## A1 — where a park table can live, and what a library type would need to name

### The seven types/functions involved

| item | location | module | binary-only today |
|---|---|---|---|
| `Scheduler` | `scheduler.rs:99` | `mod scheduler` (`main.rs:81`) | **yes** |
| `ParkTable` | `scheduler.rs:114` | same | **yes** |
| `RecentCompletions` | `scheduler.rs` | same | **yes** |
| `family_of` / `key_capacity` | `scheduler.rs:443` / `:100` | same | **yes** |
| `WorkerState` | `thread.rs:97` | `pub mod thread` (`lib.rs:40`) | no |
| `WorkerPark` | `thread.rs:103` | same | no |
| `ExecutorPool` | `thread.rs` | same | no |

### What `Scheduler` holds

```rust
pub struct Scheduler {
    tables: HashMap<u32, ParkTable>,
    high_water: u32,
    parked: u32,
    class_refusals: u64,
    scheduler_refusals: u64,
    pending_refusals: Vec<(u64, i32)>,
    recent: RecentCompletions,
}
```

The per-family tables are `tables`. Everything else is counters, the refusal
queue, and the early-completion buffer — none of which a worker needs.

### What it depends on from `session::arena` — **the 13 constants only**

`scheduler.rs:50-54` is the whole of it:

```rust
use crate::session::arena::{
    CLASS_AI_DONE, CLASS_AI_ERROR, CLASS_AI_READY, CLASS_COUNT, CLASS_DEVICE_LOST, CLASS_FRAME,
    CLASS_INPUT_KEY, CLASS_INPUT_MOUSE, CLASS_JOB_DONE, CLASS_JOB_FAILED, CLASS_LOG,
    CLASS_RESOURCE_FAILED, CLASS_RESOURCE_READY, CLASS_SUBMISSION_REJECTED,
};
```

No type, no function, no `arena::` path anywhere else in the file (grepped).
**Fourteen names, all `u32`/`usize` scalars.** That is the answer to "the 13
constants only or something larger": *the 13 constants plus `CLASS_COUNT`*, and
nothing larger.

### Can `WorkerState` be named in the library without naming `session`?

It already is, and it already holds a park storage:

```rust
pub struct WorkerState {
    pool: Arc<ExecutorPool>,
    parks: Mutex<Vec<WorkerPark>>,
}
```

It names `ExecutorPool`, `WorkerPark`, `Arc`, `Mutex`. Nothing from `session`.

### The 240, split

The brief's 240 is DL13's measurement of class-identifier references. Measured
now, whole repo, excluding `node_modules` and `third_party/`:

| where | count | share |
|---|---|---|
| Rust, total | **156** | 63 % |
| — `scheduler.rs` | 36 | 15 % |
| — `session/` | 97 | 39 % |
| — `ai/` | 13 | 5 % |
| — `main.rs`, `adapter/`, `solver/`, `tests/` | 10 | 4 % |
| guest TS (framework + guest tests) | **91** | 37 % |
| **total** | **247** | |

**The split the brief asked for:** of the 247, **247 are class constants** —
every one is a reference to one of the 13 names or `CLASS_COUNT`. There are **no
scheduler internals in the count at all**, because the count is defined as
references to the class identifiers. What matters for the round is the
complementary number:

> **What a library park type must name: 14 scalars. Not one type, not one
> function.**

And it need not even name those. The table needs a **bound per family**, which
today is `key_capacity`'s `match` — a policy table (jobs 768, resources 1024, ai
4, …) that is a *producer* fact, not a session fact. Passing `bound_of: fn(u32)
-> Option<u32>` into the library type keeps the policy in the binary and lets the
library own only the shape. That is the smallest honest seam, and it is what
Phase B does.

## A2 — who binds the guest's family map

`__taskBindFamily` has **seven** callers, all in one function, all guest-side:

```ts
// tension-framework/assembly/runtime/rt.ts:70-81
static start(): void {
  __taskBindFamily(CLASS_JOB_DONE, FAMILY_JOBS);
  __taskBindFamily(CLASS_JOB_FAILED, FAMILY_JOBS);
  __taskBindFamily(CLASS_RESOURCE_READY, FAMILY_RESOURCES);
  __taskBindFamily(CLASS_RESOURCE_FAILED, FAMILY_RESOURCES);
  __taskBindFamily(CLASS_AI_READY, FAMILY_AI);
  __taskBindFamily(CLASS_AI_DONE, FAMILY_AI);
  __taskBindFamily(CLASS_AI_ERROR, FAMILY_AI);
}
```

The host does not bind it, and `std/assembly/task-rt.ts` does not call it — it is
a plain export whose `families` map is `null` until a framework calls `start()`,
and `familyOf` answers `class_` for an unbound class (`task-rt.ts:373-378`).

**So the brief's condition is met**: the binding is framework-driven, so
`family = class >> 4` *could* be adopted on the host side alone and the binding
would become optional. Renumbering does **not** require a lockstep host/binding
change.

It does, however, touch the framework's *restated* class ids
(`rt.ts:52-55`: `CLASS_JOB_FAILED = 1`, `CLASS_RESOURCE_FAILED = 2`,
`CLASS_JOB_DONE = 4`, `CLASS_RESOURCE_READY = 5`) and the families derived from
them (`FAMILY_AI = CLASS_AI_DONE`). That is guest source, not a host binding —
but it is still two-sided.

## A3 — what the renumber would cost, and where it stops

Today's families, from `family_of` (`scheduler.rs:443`):

| class | id | family today |
|---|---|---|
| DEVICE_LOST | 0 | 0 |
| JOB_FAILED | 1 | **4** |
| RESOURCE_FAILED | 2 | **5** |
| SUBMISSION_REJECTED | 3 | 3 |
| JOB_DONE | 4 | 4 |
| RESOURCE_READY | 5 | 5 |
| INPUT_KEY | 6 | 6 |
| INPUT_MOUSE | 7 | 7 |
| LOG | 8 | 8 |
| FRAME | 9 | 9 |
| AI_READY | 10 | **11** |
| AI_DONE | 11 | 11 |
| AI_ERROR | 12 | **11** |

A `tag << 4 | ordinal` encoding reproduces all of it — e.g. jobs at 16/17,
resources at 32/33, ai at 64/65/66, log 128, frame 144 — and `class >> 4` then
yields the same nine distinct families the `match` does.

**Stop. The encoding is incompatible with how class ids are used.** `CLASS_COUNT
= 13` sizes arrays *indexed by the raw class id*, in the host and in the guest:

```
main.rs:2314            data.drop_seen[class as usize]              // [u64; CLASS_COUNT]
session/config.rs:292   ring_capacities[class as usize] = value
session/subring.rs:132  capacities[class as usize] as usize
session/epoch.rs:74     fn slot_address(capacities: &[u32; CLASS_COUNT], class, slot)
scheduler.rs:252        capacities: [u32; CLASS_COUNT]
adapter/mod.rs:1315     drop_seen: [0; CLASS_COUNT]
```

and in the guest:

```ts
// rt.ts:42-46 — a class's ring header is found by walking every class below it
function ringHeaderOffset(class_: u32): u32 {
  let at = regionOffset(REGION_EVENT_TABLE);
  for (let i: u32 = 0; i < class_; ++i) { at += …effectiveRingCapacities[i]…; }
```

A sparse renumber (values to 144) turns every one of those into an out-of-bounds
index or a 144-iteration walk. Making them work needs a `class → dense ordinal`
map on *both* sides — which reintroduces exactly the "two halves must agree"
duplication the encoding was meant to delete. **The change would cost more
agreement, not less**, at nine host sites, two guest sites, the ABI doc and the
guest tests that subscribe by number.

Renumbering is therefore **not in this round**; it is its own two-repo round with
a dense-ordinal mapping as its first decision.

## A4 — what else keys on the raw class value

Everything above, plus:

- **`session/arena.rs:212-217`** — the ids are a *wire value*: *"a class id is a
  subscription key and what a compiled guest's `CLASS_*` constant means. … Moving
  one is an SDK bump, not a local edit."*
- **guest tests that subscribe by number** — `tension-framework/tests/guest-ogre.ts`,
  `guest-drop.ts`, `guest-ai-stream.ts` (named in that same comment).
- **`CLASSES: [(u32, &str); CLASS_COUNT]`** (`arena.rs`), the catalogue behind
  every log line that prints a class name.
- **`docs/abi/guest.md`** and `docs/session.md` §3.
- **`ai/`** (13 refs), `solver/`, `adapter/` — all by name, not by arithmetic,
  so a renumber reaches them as a rename.

## Stop verdict

- **A2: safe in principle** — the family map is guest-bound, so the host could
  adopt the encoding alone.
- **A3/A4: not safe in this round** — the encoding is incompatible with dense
  indexing by class id at 9 host sites and 2 guest sites, and it is a wire/sdk
  value. Reported; it becomes its own round.
- **A1 does not stop** — Phase B proceeds with the table.

---

# Phase B — the table, in the library

Design, in one paragraph: **`ParkTable` moves to the library** (one type, both
sides), the library gains a small `ParkLedger` that owns `family → ParkTable`, and
**`ExecutorPool` holds one** — so a worker's park is recorded into a table that
`Arc<ExecutorPool>` makes reachable from main. The pool is given the
family→bound policy as a function at birth, so the library never names a class
constant.

_(diff and measurements in DL18-REPORT.md)_
