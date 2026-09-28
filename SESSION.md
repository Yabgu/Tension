# SESSION.md — singletons and sessions in Tension

What a capability is allowed to assume about how many of it exist.

**This is a design statement, not a description of the code.** Where the two
differ the aspect table (§3) says so and §11 records the gap. The current
code's singularity is an implementation limit, not a decision this design
makes: where it made that choice knowingly it said so out loud, and where it
did not the limit is implicit in a field.

**Two senses of one word, and the doc says which it means every time.** *The
session (coprocessor)* is the core-owned component that owns the arena, the
event ring, the epoch and the seven verbs — one per guest, and one at a time
(`session_open` refuses a second open while a session is `READY`; `close` then
`open` is allowed) — and it is Tension's existing word for that component.
*A capability session* is one instance of a capability, scoped to and mediated
by the session (coprocessor). When this doc writes "session" without
qualification in a sentence about a capability, it means the second; when it
means the first it writes "the session (coprocessor)".

## 1. The philosophy

**Nothing is baked in by design.** Every capability is an option. The host does
not know what a capability *is* — it knows the shape (this adapter registers
these imports, declares these regions, posts events on these classes) and never
the meaning (OGRE, audio, AI). That is what makes Tension extensible without
rewriting the host each time, and it is why `tension-core` can gain a renderer,
a physics backend or a network stack without gaining a single line that names
one.

**Sessions are the consequence.** When a capability can exist more than once,
the thing that exists more than once is a *capability session*, and the thing
that holds it is the session (coprocessor). Plurality is not a feature bolted
onto a capability; it is what the host's neutrality buys, and it is available to
any capability that declares it.

**The test.** Two questions, and the answers must agree:

1. Whose identity is this?
   - the process's → singleton, reached by name
   - the caller's → a capability session, reached by handle
2. What should a failure do?
   - kill the process → singleton
   - be recoverable → a capability session

A process-scoped thing that fails recoverably is a lie: it claims a durability
it does not have. A caller-scoped thing that kills the process is a leak: it
spends the process's life on one caller's mistake.

## 2. The unit of analysis is the aspect

A capability is not "a singleton" or "a session" — it has *aspects*, and the
test is applied to each one. TNS is the example that makes this unavoidable: it
has a singular aspect (the mount table, a namespace one path resolves in, one
per process, like environment variables) and a plural aspect (an archive reader
— ten volumes, ten handles, each with its own file descriptor table and readdir
cursor). Calling TNS "a singleton" erases the interesting half; calling it
"instanceable" erases the other half. Both sentences are true of a different
part of it, which is why this doc has a row per aspect and not a row per
capability.

## 3. The aspect table

The table states the design's answer. Where the current code disagrees, the note
says **migration** and §11 has the item.

| Capability | Aspect | Identity | Failure | Kind | Note |
| --- | --- | --- | --- | --- | --- |
| IO | the terminal: stdin and stdout | process | fatal | singleton | non-goal — design confirms current shape |
| IO | the argument vector (`arg_count`, `arg`) | process | fatal | singleton | non-goal — fixed at start, read-only after |
| TNS | the mount table: the namespace a path resolves in | process | fatal | singleton | non-goal — design confirms current shape |
| TNS | the archive reader: one handle over one volume | caller | recoverable | session | non-goal — already the shape: the handle owns its fd table and readdir cursor |
| Audio | the PCM sink: device handle, stream, mixer, voices | caller | recoverable | session | migration (A3) — voices carry handles already; the device and its table do not |
| AI | a chat session: its own loaded model, cache and worker | caller | recoverable | session | already the shape: handle-keyed per engine session, capped at `MAX_SESSIONS` (A1) |
| AI | the inference backend (llama.cpp's process init) | process | fatal | singleton | one per process by llama.cpp's own construction |
| Solver | a solver handle: one bound system and its state | caller | recoverable | session | migration (A2) — keyed by id already, in a per-engine-session map |
| Solver | the core's module globals (gravity, sleep mask, layout mode) | caller | recoverable | session | migration (A2) — two live worlds share them today; the seam is the core's |
| Ogre | the renderer: Root, SceneManager, window, workspace, render thread, its tables | caller | recoverable | session | migration (A4) — one per process today; the two-Root question is open |
| Ogre | OGRE-Next's own process managers (LogManager, ResourceGroupManager, MeshManager, …) | process | fatal | singleton | not Tension's to re-key; the ground under A4 (§11) |

Two notes the table cannot carry:

**Registration is not an aspect.** What an adapter declares during `link` —
imports, event sources, region kinds — is per-*instance* state with no identity
of its own and no failure mode: it travels with whichever instance declared it.
The table lists aspects whose identity is the process's or the caller's, and
that is the whole reason `link` is not a row.

**One detail in IO is per-caller and is still not an aspect.** `read_line` parks
a probed line in `HostState.pending_line`; `main.rs`'s own header names it as
something a multi-guest design must account for. It is a buffer with no identity
and no failure mode, so no row — recorded here so the non-goal below is not
mistaken for an oversight.

## 4. What a session provides

The session (coprocessor) is a first-class component owned by `tension-core`,
not a per-capability helper. It owns (`tension-ogre/DESIGN.md` §3.1):

- the shared memory and the arena's protocol-level layout — control block,
  region table, manifest, canary lattice;
- one host-side MPSC queue per event class;
- subscriptions (per-class delivery mode), with class defaults;
- the scheduler that decides when delivery happens — the **epoch**;
- deferred submission: the pending list, and the copied records it holds.

Its primitives are the **seven verbs**: `open`, `close`, `wait`, `drain`,
`subscribe`, `unsubscribe`, `pending`. They are reserved to `tension-core`: the
wasm module name `session` is the ABI's one reserved namespace, and an adapter
that registers an import there is refused when it links (`tension_adapter.h`
rule 9).

**A session is not a capability.** A session *has* capabilities. When this doc
says "audio session" it means an instance of the audio capability scoped to and
mediated by the session — the session is the container, the capability instance
is what the container holds. The job table and the resource table that
`README.md`'s diagram lists under the session are the adapter's today
(`tension-ogre/src/loader.h`); what the session owns is the *vocabulary* those
tables agree on — the region table at `0x200`, the manifest, and the
`layout_hash` that pins both. Read that README line as "the session owns the
agreed vocabulary", which is exactly what `region_lookup` hands an adapter at
`link` time. If a job table or a resource table ever moves into the host, this
is the paragraph to amend.

**The design permits N engine sessions per host, and the current code has one —
because it has one store.** §5 separates the two levels of the word; §11 is the
work, and its Phase A needs none of that plurality.

## 5. Two levels: engine session and capability session

This doc has been using one word for two things, and the two differ in identity,
in who owns them, and in what a failure costs. Naming them separately is what
makes the rest of the doc readable.

**The engine session is the coprocessor** that §4 describes. In the code it is
`session::Session`, held at `HostState.session`, and it is **one per store**:
created from the module's memory import, for a guest that imports the `session`
namespace, and installed before instantiation. Its arena *is* the guest's linear
memory — the control block the guest reads with `ctrl()` sits at offset 0 — so
one guest has one arena and therefore one engine session. It is reached **by
name**: the reserved `session` module's seven verbs, none of which takes a
handle, because inside one engine session there is nothing to distinguish.

**A capability session is one instance of one capability**, scoped to and
mediated by an engine session. It is reached **by handle**: the guest holds the
handle and passes it in that capability's own verbs — the capability's module,
never `session`. The engine session is the container; a capability session is
what a container holds, and it does not exist outside one.

**AI is already the model.** Its chat sessions have exactly this shape today:
`session_create` returns a handle, every later verb takes it as the first
argument (`session_add(session, role, …)`, `session_generate(session)`,
`session_read(session, …)`), and the table keying them is per engine session.
Its cap is the capability's own declaration — `MAX_SESSIONS = 4`, a count of
chat sessions, unrelated to the engine session that shares its name. Nothing
about the pattern has to be invented; three other capabilities have to adopt it.

**Audio and the solver are proto-capability-sessions: the handle exists, the
capability does not yet key by it.** `audio_play` returns a voice handle and
`audio_stop(voice)` takes one, but the device, the stream and the voice table
are one per engine session, so two callers share one mixer and one parameter
set. The solver is the same shape with less distance to travel: `SolverHost` is
already `HashMap<i32, …>` keyed by the shim's solver id; what is still shared is
the *core's* module state, one level below the host.

**IO and TNS have no capability-session aspect** and never will. They are the
process's — a terminal, a mount namespace — and §10 keeps them that way. That is
what the two-level distinction is for: not "sessions everywhere", but a place
for each identity.

## 6. What the host knows about a capability

Nothing. It knows the shape: these imports, these regions, these event classes,
these declared region needs. No capability's *meaning* reaches the host's
adapter path — the ten occurrences of the word "ogre" in `tension-core/src/` are
all doc-comment references to `tension-ogre/DESIGN.md`, not one of them code.
The built-in capabilities are the honest exception, and it is worth stating
plainly because it is the price of being built in: they are compiled into the
host, so the host names them (`HostState.audio`, `.ai`, `.solver`, `.res`) and
their verbs are `func_wrap` calls in `main.rs`. A DSO's name is not in the host
anywhere; it arrives from the vtable the adapter returns. The host's job is to
run sessions: create them, give them capabilities, run the epoch, destroy them.

## 7. Capacity

The host permits N engine sessions, and N capability sessions inside each. Each
capability **declares** its own capacity. OGRE-Next may declare 1 — there is one
process and OGRE-Next has process-wide managers in it — and a future renderer
may declare 16. The declaration is *data*, not architecture: the host enforces
what an adapter declares, and does not know why the number is what it is.

This is also where a limit that is not a failure lives. The solver's core keeps
gravity, the sleep mask and the state-layout mode in module globals, so one
process runs one world at a time; that is a declared capacity of 1 with the
upgrade path named in the core (`tension-ogre/DESIGN.md` §12), not a defect in
the host. Change the declaration and the behaviour changes.

## 8. The failure contract

**Singleton failure is fatal.** The process's namespace is gone, so the
process's state is invalid; a big blue screen is the honest report, not a
crash. This is why IO's terminal and TNS's mount table are singletons: nothing
can hand a process a second `stdout` or a second argv.

**Capability-session failure is recoverable.** Drop it, create another; other
sessions are unaffected. This is why a graphics-failed game can recover at all:
the renderer session died, not the game. A capability declares which of its
aspects are fatal and which are recoverable, and the test in §1 is what keeps
the declaration honest.

The device case shows the test doing work. A sound card is one per process, so
it looks like a singleton — but it is *re-acquirable*, and the code already
treats it that way: `audio_init` returns `-1` when there is no device, and
`audio_shutdown` re-arms it so a later init can try again. A device that is
process-scoped and fails recoverably is the one combination the test forbids, so
the device *handle* belongs to the caller and the hardware belongs to nobody.
The OS owns the card; the capability acquires it.

## 9. The server/client future

**Permitted, not promised.** A session is a *value* — it can be sent,
replicated, compared, snapshotted. A singleton cannot be sent; it can only be
referenced, and only inside one process. That is the property that makes a
server/client architecture expressible in this design rather than bolted onto
it: two sessions in conversation, the seven verbs as the conversation's
primitives, and the host as the postal service — it delivers messages and does
not read them.

Nothing in this doc commits anyone to building that. The claim is only that
nothing here forbids it, which is a claim worth making because a design that
baked singletons into its capability model would have forbidden it by accident.

## 10. Non-goals

- **IO is not a capability session.** It is the process's stdin and stdout: one
  per process, fatal if broken, not an instance of anything. Do not convert it.
- **The TNS mount table is not a capability session.** It is a process-scoped
  namespace — `--res` merges its volumes into one tree rooted at `/`, and the
  adapter's mount table is append-only and never removes a mount. Fatal if
  broken. Do not convert it. The archive reader *is* instanceable and lives in
  `tension-res`; that is a different aspect of the same capability, and it is
  fine as it is.
- **Not every capability must have a session aspect.** IO and TNS are the
  proof: two capabilities, unchanged, in a design that permits plurality.
- **The design is not "sessions everywhere."** It is sessions where the identity
  is the caller's, and singletons where the identity is the process's.

## 11. Migration

The target and the order. There are two phases, and they pluralise different
things: **Phase A** makes capabilities plural inside one engine session;
**Phase B** makes engine sessions plural. Phase A is first. No implementation
here; each item states what has to become true.

**Where the collection of engine sessions belongs.** One engine session is one
store: the guest's `ctrl()` is at offset 0 of its own memory, so a second engine
session means a second store. `HostState.session` therefore *stays*
`Option<Session>` — one session per store is the correct shape, not the
limitation — and the collection belongs a level up, wherever the bundle is
owned. The M1 probe's target:

> the smallest change that lets the host hold N sessions is to lift everything
> from the store onward into a per-session bundle (store + linker + instance +
> session + adapter host + one owner thread), keep the engine and the module
> shared above it (both are `Send + Sync` and the module is `Arc`-backed), give
> each bundle a host-level `SessionId`, and hold the bundles in a collection
> beside the engine.

**Phase A — capability sessions within one engine session.** Each capability
that should be plural gains a session-open verb. The guest calls
`audio_open_session` / `ogre_open_session` / `solver_open_session` — or today's
AI `session_create`, which is the model — receives a handle, and passes it on
every subsequent verb of that capability. The adapter, or the built-in's host
shim, keys its per-instance state by that handle. IO and TNS gain no session
verbs: the non-goal above stands.

This is the phase that carries what is wanted now — tabs, multiwindow, WebGPU
content, and a renderer that can fail and be re-created without taking the game
with it. It asks nothing of the host's architecture.

**A1. AI — already the model; verify it and cite it.** The Phase A shape is
there today: a handle from `session_create`, carried by every later verb, keyed
per engine session, capped by the capability itself. The deliverable is the
reference the other three are changed to match — verification and citation, not
code.

**A2. Solver — handle-keyed already; the module globals are the seam.** The host
side is `HashMap<i32, …>` keyed by the shim's solver id, so the handle pattern
exists. What has to become true is that two live handles stop sharing the core's
module state: gravity, the sleep mask and the state-layout mode travel through
the Fortran core's globals, and the second world created wins
(`tension-ogre/DESIGN.md` §12). The seam is the core's, not the host's — a
context pointer in the shim's callback, or a second callback entry point.

**A3. Audio — the device is one per engine session; become handle-scoped.** The
voice handle exists; the device, the stream and the voice table behind it do
not — they are one per engine session, with the parameters fixed first-wins, so
two callers share one mixer. Becoming handle-scoped means those move behind the
capability-session handle. The seam differs from a DSO's: a built-in capability
is an `&mut` field of `HostState`, so it has no context channel to be handed and
keys on the handle in its own verbs.

**A4. Ogre — the renderer is one per process; become handle-scoped.** The
adapter's state is a function-local static and the host fills `ctx` with `NULL`
on every vtable call, so the renderer is one per *process* — the one capability
whose plurality is not purely a host-side matter. At the verb level it is
`ogre_open_session`; at the adapter level it is per-handle state. **Dependent on
an open question** — the OGRE-Next managers, below.

**Phase B — engine session plurality.** The host grows the ability to hold N
bundles. Each bundle is one store + one linker + one instance + one engine
session + one owner thread; the engine and the module are shared above them all.
This is the phase that carries server/client, process-level isolation, and the
true crash-recovery story — dropping a bundle drops everything in it, every
capability session it held, with no per-capability teardown to get right.

**The ABI's context channel (M2) is needed for both phases**, and it is
additive under ABI rule 11. In Phase A it is what lets an adapter know *which
engine session* is calling it once there is more than one — one adapter image
serving several. In Phase B the same requirement appears one level up. Two
candidate shapes, named and deliberately not chosen here: a
`void *(*context)(void)` accessor slot, or an init-time handle threaded through
`init`. The carrying itself needs no new ABI field: every vtable slot already
takes `ctx`, and the host is the one that fills it.

**The adapter keys its state by that context (M3) — Phase B work.** In Phase A
it is optional: if the capability-session handle alone distinguishes instances,
the adapter has enough. Phase A is what exercises that handle-passing
discipline, which is why Phase B is cheaper once Phase A has landed.

**M3's precondition: per-instance state needs per-instance death.** The host
today calls `init` and `link` and never calls the vtable's `shutdown` or
`destroy`, so an adapter has no per-instance teardown hook to hang keyed state's
destruction on. That is fixed on `polish/loader-sibling-quiet` — commit
`1d86f40`, "make the adapter's destructor safe without shutdown" — and not yet
on `main`. Once it lands, the precondition is met.

**The OGRE-Next question — pending verification.** Whether OGRE-Next can host two
live `Root`s in one process is not yet established, and A4 depends on it. The
adapter reaches `LogManager`, `ArchiveManager`, `ResourceGroupManager`,
`MeshManager`, `v1::MeshManager`, `v1::OldSkeletonManager` and
`v1::HardwareBufferManager` through `getSingleton()` inside
`libOgreNextMain.so`. If those are process-global in a way that two `Root`s
contend for, then two live Roots contend regardless of how A4 keys sessions, and
the honest declaration stays capacity 1 until the question is answered. This is
a pending verification, not an assumption: the probe that answers it has not
been run.

**IO and TNS are non-goals, and migration does not touch them.** Restated here,
in the list a future reader is most likely to read, so that nobody "cleans them
up" into capability sessions. They are the two rows of §3 that exist to prove
the design does not require plurality where plurality is not real.
