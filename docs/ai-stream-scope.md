# AI stream async scope — coalesced completion per session

**Status:** scoped **and ruled**. No code written; the work is `0.6.0a` (the
bump) then `0.6.0b` (the feature).
**Tree:** Tension `ee5ece6`, TensionScript 0.5.1.
**Question:** can the guest `await` AI chunks with zero polls, riding the path
OGRE proved in 4c?

**Headline: it can, and the design is settled — but it is a 0.6.0 feature, not a
patch.** The class table cannot grow without moving the frozen layout, and the
tag word does not rescue it: the tag is not a transport. Both were dispatch
"STOP and report" conditions, both were measured, and §Ruling records the
answers.

---

## Ruling (Phase 0 outcome)

The two stops were measured, not argued. What follows is the decided state;
the measurements it rests on are §M1b, §M2, §M5 and §M6.

**1. The bump is forced.** Not because the tag is load-bearing — the opposite.
`rt.deliver` reads five words off the wire record and hands them to
`__taskDeliver` (`rt.ts:136-148`, `task-rt.ts:264`); `tag` (offset 24) is not
among them, nothing writes it, and the plan's own §3.1 (`:577`) names it as the
discriminator for repeats that do not exist yet. `__taskPark` registers on
`keyOf(family, key)` alone (`task-rt.ts:151`, `:193-249`), so there is no place
to thread one even if it arrived. And no AI wire class exists at all:
`PostingSide::post` refuses an unknown class (`posting.rs:432-434`), because
`queues` is `CLASS_COUNT` long. **A new class is required regardless of how
the completion is classified** — so the tag sub-family buys nothing and costs a
std ABI change on top.

**2. Option A: three classes, appended.** `AI_READY = 10`, `AI_DONE = 11`,
`AI_ERROR = 12`, after `FRAME` — appending keeps every existing id stable, and
a class id is a wire value (`arena.rs:198-200`). Capacity **16** each (see 4),
`MODE_BATCHED`, one family (the family key is `AI_DONE`'s id, mirroring
`FAMILY_JOBS = CLASS_JOB_DONE`).

The two rejected options, recorded so they are not re-litigated:

- **B — one class plus a tag discriminator.** Still bumps the layout, *and*
  grows `__taskDeliver` to a sixth parameter in `std/assembly/task-rt.ts` — a
  compiler release and a 16-consumer transition — to deliver a discriminator
  the class already carries. Strictly more expensive, strictly less clean.
- **C — borrow `LOG` (8) or `FRAME` (9).** Both are posted by nothing in-tree
  and `flags` is free guest-side (`rt.deliver` ignores it), so it *would* work
  without a bump. Rejected: `arena.rs:198` makes a class id a subscription key
  and a wire value, so `CLASSES`, `class_info` and every transcript would call
  AI events `LOG`, and a real LOG producer would later collide. That is the
  workaround this project's philosophy forbids.

**3. The ERROR code is `-EIO` (-5), minted.** There is no errno anywhere in the
AI backend: `generate_text` returns `Err(String)` and `run_completion` appends
`[tension:ai] error: {message}` into the reply buffer (`llama.rs:150-160`). The
failure signal therefore carries `-EIO` and the human-readable reason stays
where it is today — in the buffer the guest already drains. Adding an errno
vocabulary to the AI backend is a separate, larger change and is not needed to
make failure observable without a throw.

**4. The ring invariant holds, proved — capacity 16.**

1. `push_text` posts only when `signaled` is clear, and `read_consume` clears it
   when `pos == reply.len()` (`llama.rs:116-123`, `:494-503`) → at most **one**
   un-drained READY per session.
2. `generate` refuses while `generating` (`llama.rs:465-470`, `stub.rs:84-86`),
   so there is at most **one** terminal completion per session; DONE and ERROR
   post unconditionally.
3. `MAX_SESSIONS = 4` (`ai/mod.rs:114`) → at most **8** outstanding records.

Capacity 16 is 2× the ceiling, so `QueueFull` (`posting.rs:177-179`) and the
sub-ring's full case (`subring.rs:293`) are unreachable, and `-EIO` cannot fire
on a healthy stream. **This is a capacity argument, not a proof about the
future**: it assumes the coalescing above is implemented as stated, and the
`0.6.0b` tests must assert it rather than assume it.

**5. `reportDrops` must learn the AI family.** It watches `CLASS_JOB_DONE` only
(`rt.ts:61`, `:101-118`). A second awaitable family without its own counter read
means a dropped AI signal hangs its stream silently. The change mirrors the
existing jobs block (~10 lines) and is part of `0.6.0b`, not an optional
extension. The drop counter is mirrored into the arena every epoch
(`epoch.rs:161-164`), so the signal exists — the framework simply is not reading
it.

**6. `story.ts` does not open a session, so its rewrite is structural.** The
example imports only the io and ai services; there is no `RuntimeSession.open`,
hence no arena, no callbacks and nowhere for a completion to arrive. The rewrite
needs `ConfigBuilder.forThisBuild(rt.callbacks())` + `RuntimeSession.open`
(the bouncing-bodies shape, `game.ts:228`), and a pump between `generate` and
the prompt — `RuntimeSession.wait(10); rt.runReady();`, i.e. `settleTask`'s body
(`game.ts:128-131`) without a fixed guard. This is not a loop rewrite and must
not be scoped as one.

**7. Two sub-phases, each verified on its own.**

- **`0.6.0a` — the bump.** `CLASS_COUNT` 10→13, three classes in `arena.rs`, the
  three capacities, `session.json` + regenerated `layout.ts`, the framework's
  class ids and family, `tension-core/tests/framework_layout.rs` green, every
  consumer rebuilt. No AI behaviour changes: this phase only moves the shape,
  and the whole stack must still behave identically.
- **`0.6.0b` — the feature on top.** The sink, the `signaled` flag, the drain
  clear, `rt.stream`, the `reportDrops` extension, the example rewrite, the four
  negative controls.

Splitting them is not ceremony: a layout bump that fails to compile has one
cause, and a stream that hangs has another. Mixing them makes the second
diagnosis guesswork.

**8. The bump's exact cost.** `CLASS_COUNT` 10→13, `SESSION_INFO_OPEN_NONCE`
88→100 (`48 + 13×4`), `SESSION_INFO_SIZE` 128→140. **No region moves:**
`0x100 + 0x8C = 0x18C < 0x200`, so the region table stays at `0x200` and every
arena offset is unchanged. The hash moves because `CLASS_COUNT` and
`SESSION_INFO_SIZE` are both folded into it (`arena.rs:1014`, `:1056`) — the
guard doing exactly its job. Files: `tension-core/src/session/arena.rs`
(`CLASSES`, `DEFAULT_RING_CAPACITIES`, `DEFAULT_CLASS_MODES`, the size asserts
at `:1326`), `tension-framework/session.json` and the regenerated
`assembly/runtime/layout.ts`, `build.sh:95`'s hardcoded "this chunk has 10
classes", `assembly/runtime/wire.ts` (the three ids), `assembly/runtime/rt.ts`
(the family). `tension-core/tests/framework_layout.rs` is the cross-check that
catches a half-done bump.

---

## Phase 0 — measurements

### M1 — the produce path, and why `post_event` is not reachable from it

Tokens are produced on a **worker thread per session** (`llama.rs:427`):

```rust
.spawn(move || worker_loop(model, shared, cfg))
```

That thread holds exactly `Arc<LlamaModel>`, `Arc<Shared>`, `AiConfig`
(`worker_loop`, `llama.rs:127-141`). It appends text via `push_text`
(`:116-123`), which takes `Shared::inner`, extends `reply`, and notifies the
**in-guest** condvar.

**The AI adapter has no posting sink at all.** `grep -E "sink|post_event|Poster"`
over `tension-core/src/ai/*.rs` returns nothing. The session verbs are
`func_wrap` closures each taking `Caller<'_, HostState>` (`ai/mod.rs:661-700`),
which exist only on the guest-call path — the worker never sees a `Caller`.

`post_event` **is** any-thread by contract:

> `post_event` — any thread, per `tension_adapter.h`'s rule 7
> — `tension-core/src/session/posting.rs:5`

and there is a test that calls it from another thread
(`session/mod.rs:3037-3044`, "called exactly as an adapter's render thread
would"). So the *mechanism* allows the produce thread; the *wiring* does not
exist. **This is a plumbing change** — give the AI session a handle carrying
`post_event` + its user pointer (the same pair OGRE's `LoaderSink` holds), store
it beside `Arc<Shared>`, call it from `push_text`/`run_completion`.

It is small — two fields and a constructor argument — but it is a host change,
and this dispatch forbids one. **Ruling: approved as `0.6.0b`'s first commit.**
The site: build `HostState.posting` before the store literal (`main.rs:622`) and
clone the `Arc` into `AiSession::new`; the adapter stores it beside
`Arc<Shared>`; `push_text` and `run_completion` post. `post_event` takes `&self`
and is any-thread by contract (`posting.rs:421-447`) — the same path OGRE proved
in 4c, no new primitive.

**Is the AI even built here?** Yes: `tension-core/Cargo.toml:8` has
`default = ["audio", "ai"]`, and `default_ai_adapter()` selects the llama
backend (`main.rs:90`). Measured in this container: the debug binary carries
8,447 `llama` strings and the 2.39 GB Phi-3 GGUF is present at
`examples/ai/models/Phi-3-mini-4k-instruct-q4.gguf`, so the **real** backend can
run here. The stub (`stub.rs:80-100`) completes inside `generate` and streams
nothing, so it cannot exercise coalescing — the stream controls need the llama
build.

### M1b — the tag (offset 24) is not a transport

This was the dispatch's first question, and the answer reshapes the class
decision.

**The dispatch ignores it.** `rt.deliver` reads five words and hands them on
(`rt.ts:136-148`):

```ts
__taskDeliver(<i32>record.class_, <i32>record.a, <i32>record.b,
              reinterpret<i32>(record.f0), reinterpret<i32>(record.f1));
```

`__taskDeliver(class_, a, b, f0, f1)` (`task-rt.ts:264`) has no tag parameter.
`tag` is declared on `TaskRecord` (`task.ts:53`) with the comment "the await tag
(§3.1's limitation); 0 today" — **nothing writes it and nothing reads it.**

**The park registration has no room for one.** `__taskPark` keys on
`keyOf(familyOf(awaited.class_), awaited.key)` (`task-rt.ts:151`, `:193-249`) —
64 bits of `(family, a)`. `rt.job` stamps `class_` and `key` and nothing else
(`rt.ts:179-187`). A wrapper could set `record.tag`, but no delivery path would
carry it back.

**The plan anticipated the need and not the mechanism.** §3.1 (`:577`) says a
capability that completes one key more than once "would need a discriminator,
and — because `flags` and the payload words are producer-owned — the
discriminator belongs *guest-side*, in the task record's await tag (§3.2)". That
is the right instinct for a **repeat** discriminator, but it presumes the class
is already correct. It cannot create a class, and here no AI class exists.

**So the tag neither helps nor hurts:** the bump is forced by the missing class
(§M2, §Ruling 1), and once three classes exist the delivered class is the
discriminator — STEP 7's rule — so a tag would be a second, redundant channel
threaded through a std ABI change.

### M2 — the class table cannot grow without moving the frozen layout

```rust
pub const SESSION_INFO_CLASS_COUNT: usize = 44;
pub const SESSION_INFO_CLASS_CAPACITY: usize = 48;   // arena.rs:95-96
pub const CLASS_COUNT: usize = 10;                   // arena.rs:116
```

and the layout assertion (`arena.rs:1326`):

```rust
assert_eq!(SESSION_INFO_CLASS_CAPACITY + CLASS_COUNT * 4, SESSION_INFO_OPEN_NONCE);
```

`48 + 10 × 4 = 88`. An eleventh class makes it **92**, so
`SESSION_INFO_OPEN_NONCE` moves and every field after it shifts. Classes 0-9 are
all occupied (`arena.rs:202-213`): `DEVICE_LOST, JOB_FAILED, RESOURCE_FAILED,
SUBMISSION_REJECTED, JOB_DONE, RESOURCE_READY, INPUT_KEY, INPUT_MOUSE, LOG,
FRAME`.

The existing capacity (48 slots) is not the constraint — **the offset is**. Three
options:

- **(a) Add classes deliberately** and accept an ABI bump: host and guest ship
  together, so a version-locked pair is fine, but a guest built against 0.5.x
  must not run on the new host, and the change belongs in a release note.
- **(b) Reuse one class for all AI signals** and correlate by `a` (the session
  id). This works — but the class is what the *framework* binds to a family, so
  reusing `CLASS_JOB_DONE` puts AI sessions in the job family, where keys are
  job ids and could collide (session 1 and job 1 share a key). Reusing an
  unrelated class (`LOG`, `FRAME`) is a lie in the transcript and in `CLASSES`.
- **(c) No new class: signal through a class the host already has, with a
  disjoint key space.** Only (b)'s correlation trick, and it needs the key
  disjointness proved.

**Recommendation: (a), one class.** Coalescing means one class carries three
meanings (data-ready / done / error), and the payload cannot distinguish them —
but a **single** class plus a *tag in the payload* would repeat STEP 7's defect.
So the cleanest is three classes (AI_READY / AI_DONE / AI_ERROR, 10-12), all
bound to one family, with the delivered class deciding the outcome exactly as
`ogre/async.ts` now does. That moves the layout once, deliberately.

**Ruled: (a), as three classes appended after `FRAME`.** See §Ruling 2 for the
ids, capacities and the two rejected alternatives. The tag route (option B) was
measured and rejected in §M1b — it still bumps the layout *and* needs a std ABI
change.

### M3 — where the per-session signaled state lives

`Shared` already has the right shape (`llama.rs:103-106`):

```rust
struct Shared { inner: Mutex<Inner>, cv: Condvar }
```

The mutex is the guard the produce thread and the guest already contend on:
`push_text` takes it, `read_consume` takes it, `generate` takes it. A
`signaled: bool` on `Inner` — set-if-not-set before posting, cleared by the drain
— is guarded by the same lock with no new synchronization.

**The drain already has the right hook.** `read_consume` (`llama.rs:494-503`)
takes the lock and advances `inner.pos`; that is where the flag clears. No
companion call is needed.

### M4 — today's semantics, and why payload cannot classify

- `state()` → `i32::from(inner.generating)` (`llama.rs:480-485`): **1** while
  generating, **0** idle, **-1** unknown session.
- `read(pending)` → `reply.len() - pos` (`:487-492`): unread bytes.
- `read(consume)` → up to `cap` bytes, advancing `pos` (`:494-503`).

**A zero-length consume returns 0** — and so does "no data yet". The return value
of `session_read` therefore cannot distinguish:

- a chunk that has not arrived (ring empty),
- an empty chunk (nothing new), and
- **done** (generation finished, buffer drained).

That is STEP 7's lesson in its exact form: **the class must decide**, not the
payload. `CLASS_JOB_DONE` with payload 0 meant "no resource"; here an AI-ready
signal with payload 0 must not read as "done".

Nothing is posted today on any AI transition — `grep post_event` over `ai/`
finds none, so the guest is expected to poll (`story.ts:77`,
`while (session.state() == 1)`). The magic number `1` appears in the example and
in two doc comments (`ai.ts:24`, `:219`); naming it is free and independent of
this work.

### M5 — ring capacity, and the `-EIO` policy's blind spot

Coalescing means **at most one un-drained READY per session**, and
`MAX_SESSIONS = 4` (`ai/mod.rs:114`). **Correction (measured):** the sharper
count is one READY *plus one terminal* per session — DONE and ERROR post
unconditionally — so the ceiling is **8**, not 4. Ruled capacity: **16**, 2× the
ceiling. The per-class defaults are `[1, 256, 256, 64, 4096, 4096, 256, 64,
1024, 256]` (`arena.rs:241-242`); `EVENT_TABLE_SIZE` is 384 KiB (`:343`) and the
current ten classes use 332,128 B, so three classes at 16 cost 1,632 B against
~61 KiB of headroom.

**The `-EIO` policy does not cover a new family.** `rt.reportDrops()` reads the
**job** class's drop counter and calls `__taskReportDrops(FAMILY_JOBS, delta)`
(`rt.ts:61`, `:101-118`). An AI family would have its own counter and its own
silence: **a dropped AI signal would hang the awaiting task forever**. Either the
framework extends `reportDrops` to a second family, or the design must argue that
coalescing makes a drop impossible. It cannot: the ring can still overflow if the
guest never drains, and then a signal is lost. **This is a finding, not a
detail** — the negative control must include it.

**Ruled: extend `reportDrops`.** The counter is already mirrored into the class
header every epoch (`epoch.rs:161-164`), so the signal exists; only the
framework's read is missing. §Ruling 5.

### M6 — the example's shape

`_start_game` is `() -> ()`; the host binds `get_typed_func::<(), ()>`
(`tension-core/src/main.rs:1226`). The stream loop must therefore live in a
spawned task, exactly as `bouncing-bodies` spawns its loader. The target shape:

```ts
while (true) {
  const n: i32 = await rt.stream(session);
  if (n == 0) break;              // done
  if (n < 0) { report(n); break; } // error
  write(session.read());           // data is there
}
```

`story.ts:77-81` becomes that loop; `state()` disappears from it.

**Correction (measured): this is structural, not a loop rewrite.** `story.ts`
never opens a session — it imports only the io and ai services and calls
`Session.create` directly. With no `RuntimeSession.open` there is no arena, no
`Callbacks` record and therefore nowhere for a completion to land: an await in
that file would park forever. The rewrite must add
`ConfigBuilder.forThisBuild(rt.callbacks())` + `RuntimeSession.open` (the
bouncing-bodies shape, `game.ts:228`) and a pump between `generate` and the
prompt — `RuntimeSession.wait(10); rt.runReady();`, i.e. `settleTask`'s body
(`game.ts:128-131`) with no fixed guard, since a generation lasts as long as it
lasts. The REPL's blocking `readLine()` is fine: it sits outside the stream loop
and the pump runs after it.

**Container availability, measured:** the debug binary carries the llama backend
and the 2.39 GB GGUF is present, so the example can be run here for real. The
stub streams nothing and cannot exercise the stream at all.

---

## Phase 1 — design

### 1. The return protocol: three classes, one family, sign decides

`rt.stream(session: i32): Task<i32>` — the caller awaits an `i32` whose **sign**
carries the outcome, with the *class* deciding how to read it:

| delivered class | meaning | returns |
|---|---|---|
| `CLASS_AI_READY` | bytes are available | `> 0`: unread byte count (a **count**, never 0 — see below) |
| `CLASS_AI_DONE` | generation finished | `0` |
| `CLASS_AI_ERROR` | generation failed | `< 0`: the errno from the payload |

A READY signal with zero unread bytes would be meaningless — the host only
signals when `push_text` actually appended — so `> 0` is always true for READY
and the sign is unambiguous. That is the property STEP 7's fix established:
**class first, payload second**, and the payload never decides between done and
data.

### 2. The host-side signal

Per session, inside the existing `Shared::inner`:

```
push_text:      append; if (!signaled) { signaled = true; post_event(CLASS_AI_READY, session_id, unread) }
run_completion: ... on success: if (!signaled) { signaled = true; post_event(CLASS_AI_DONE, session_id, 0) }
                        on error:   post_event(CLASS_AI_ERROR, session_id, -errno)
read_consume:   advance pos; if (pos == reply.len()) signaled = false
```

Set-if-not-set is the coalescing: N tokens produce one ring record until the
guest drains. Done/error always post (they are terminal and idempotent to
observe).

### 3. The class decision

**Ruled: (a) — three classes, appended after `FRAME`.** `AI_READY = 10`,
`AI_DONE = 11`, `AI_ERROR = 12`; capacity 16 each; `MODE_BATCHED`; one family
keyed on `AI_DONE`'s id. §Ruling 2 has the ids and the two rejected
alternatives; §M1b has why the tag route does not avoid the bump. This is
`0.6.0a`'s content, landing before any of the stream code.

### 4. The example

`story.ts`'s poll loop → the task loop above, with `_start_game` spawning it.
Reported separately: whether a model is available in this container at run time.

### 5. Commit plan

Two phases, because a layout bump that fails to compile and a stream that hangs
have different causes (§Ruling 7).

**`0.6.0a` — the bump, no behaviour change.**

1. **`ast: three AI classes (0.6.0a — the layout bump)`** — `arena.rs`
   (`CLASSES`, capacities, modes, the `OPEN_NONCE`/`SIZE` assertions),
   `session.json`, regenerated `layout.ts`, `build.sh:95`'s class count,
   `wire.ts` ids. Gate: `framework_layout` green, `cargo test` green, every
   consumer rebuilt, all existing example output byte-identical.

**`0.6.0b` — the feature.**

2. **`ai: coalesced completion posts`** (host) — the sink beside `Arc<Shared>`,
   the `signaled` flag, the drain clear, DONE/ERROR from `run_completion`.
   Gate: the shell verbs answer exactly as before; a scratch guest awaits and
   receives a chunk; three appends before a drain produce one post.
3. **`framework: rt.stream`** — the wrapper, class-classified, family bound in
   `rt.start()`, `reportDrops` extended to the AI family. Gate: chunks with no
   poll; a dropped signal wakes with `-EIO`.
4. **`engine: story.ts awaits`** — the session open, the pump, the stream loop.
   Gate: the example produces the same output as today on the llama backend.
5. **`test: the stream's negative controls`** — see below.

### 6. Negative controls

- **stalled stream wakes on error** — force a generate failure; the await returns
  a negative code and does not hang.
- **no per-token ring pressure** — N tokens, one READY record; assert the class-4
  `dropped` counter is 0 and the record count is ≪ N.
- **done is distinguishable from an empty chunk** — the terminal signal returns
  `0` by class, where a READY with 0 bytes is impossible by construction.
- **a dropped signal is fatal, and must be reported as such** — this is the
  `-EIO` blind spot (M5). **Ruled: `reportDrops` grows the AI family** (~10
  lines, §Ruling 5), and the control proves a lost AI signal wakes its stream
  with `-EIO` rather than hanging. The capacity argument (§Ruling 4) explains
  why a *healthy* stream never drops; it does not excuse the missing reader.
