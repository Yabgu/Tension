# STEP 2 — the shape report

**Status:** report only. No code written.
**Base:** Tension `next` @ `a9652fe` (PR #25, 13 commits); TensionScript `next` @
`54584f88` (0.6.0, PR #4, 5 commits).
**Scope:** the `Ctx` enum, the Store-based epoch core, the coexistence matrix,
the FRAME mechanism.

Every claim below is sited. Where a measurement contradicts the dispatch, the
measurement wins and the contradiction is stated.

---

## PART 1 — the `Ctx` enum's safety argument

### 1.1 The variants

```rust
pub(crate) enum Ctx {
    /// A host call is in flight: the guest's own stack is under this one.
    Caller(*mut Caller<'static, HostState>),
    /// A host-owned loop is driving: there is no guest call to borrow.
    Store(*mut Store<HostState>),
}
```

Stored in `AdapterHost` in place of today's single `caller: Mutex<usize>`
(`adapter/mod.rs:281`), tagged by a new `AtomicU8` beside it.

`enter_caller` / `enter_store` replace `enter`; `leave` is **unchanged** in
behaviour (clear the thread id first, then the slot — `mod.rs:457-463`).

### 1.2 The invariant, written out

The argument today, and why it still holds with one more variant:

1. **Live only inside a hook's guard.** The slot is written by
   `CallerGuard::install` (`ffi.rs:529-540`) and cleared by its `Drop`
   (`:542-548`), which runs however `body` ends — return or unwind. Both entry
   points already go through it: `with_caller_installed` (`:557-566`) and
   `with_publish_caller` (`mod.rs:574-586`). A `Store` variant is installed by
   the same guard with the same `Drop`, so the window is identical by
   construction, not by a new argument.

2. **Cleared before the frame ends.** `Drop` runs at the end of the hook's
   scope, which is inside `run_epoch`'s publish or apply phase — before the
   epoch returns and long before the loop iterates. No `Ctx` outlives the hook
   that installed it.

3. **The same-thread check extends — measured, not assumed.**
   `caller_is_this_thread` (`mod.rs:429-432`) reads a **stored token**:

   ```rust
   let tid = self.caller_thread.load(Ordering::Relaxed);
   tid != 0 && tid == current_thread_id()
   ```

   It does not inspect the pointer's provenance, its type, or its validity — it
   compares the installing thread's token (`current_thread_id`,
   `mod.rs:333-335`) against the calling thread's. That works identically for a
   `Store` pointer: **whoever installed the guard** is recorded, and any other
   thread is refused with `-EBUSY` before the pointer is dereferenced
   (`ffi.rs:832-839`). The check is a property of the *installer*, not of the
   pointer's type, which is exactly why the extension is mechanical.

   This is the case the dispatch named as potentially fatal. It isn't: the
   check was never type-dependent.

4. **Every shim that reads the slot, named.** Three readers exist, and all three
   need the dispatch:

   | site | shim | what it does with the pointer |
   |---|---|---|
   | `ffi.rs:772-800` (`caller` read at `:790`) | `guest_read_into` (behind `guest_read`, `guest_read_checked`) | `caller.data().arena` → `memory.data(&*caller)` |
   | `ffi.rs:823-861` (`caller` read at `:836`) | `guest_write` | `caller.data().arena` → `memory.data_mut(&mut *caller)`, plus the publish budget |
   | `epoch.rs:1368-1376` | a **test-only** probe (`#[cfg(test)] mod` from `:320`) | reads `(*caller).data().depth` |

   The third is inside the test module and reads `.data()`, not guest memory; it
   is unaffected and needs no change. So the dispatch's "name any second shim"
   resolves to: **there are exactly two production readers, `guest_read_into`
   and `guest_write`**, both in `ffi.rs`.

   `guest_size` (`ffi.rs:866-870`) reads `host.memory_size()`, a cached `u32`
   refreshed at `enter` (`mod.rs:440-447`) — no pointer, no dispatch. It needs
   its refresh on the store path too (`enter_store` sets it the same way).

5. **Every hook that needs a `Ctx`, named — and there are two, not one.**
   The vtable (`tension_adapter.h:344-382`) declares six entry points:
   `init`, `link`, `publish`, `apply`, `shutdown`, `destroy`. Of those, the two
   that run *inside an epoch* are `publish` and `apply`:

   - `publish` — already wrapped (`mod.rs:622`, via `with_caller_installed`).
   - `apply` — wrapped too, through `with_publish_caller`
     (`apply.rs:205-218` → `mod.rs:574-586`), because **an apply hook may write
     guest memory**: the callback path copies the record out, but the hook
     itself runs with the caller installed so a verb it calls behaves normally.

   `init` / `link` run before the session exists, `shutdown` / `destroy` must
   not touch guest memory (header rule 6), so neither needs a `Ctx`.

   **This is where the dispatch's four-touchpoint list is incomplete:** it names
   `publish` as the one hook forcing the enum. `apply` forces it identically,
   and `run_epoch` calls `apply_pending` at `:263`. The enum serves both; the
   report records that the count of forced touchpoints is **two hooks**, not
   one.

### 1.3 What would force a different shape

- **If `caller_is_this_thread` compared pointer provenance** (e.g. "was this
  address below the caller's stack?"), the store variant would fail the check
  and the enum would be wrong. Measured: it compares thread tokens. **Does not
  trigger.**
- **If a third production shim read the slot.** Measured: two
  (`guest_read_into`, `guest_write`), plus one test probe. **Does not trigger**
  beyond the two named.
- **If a hook other than publish/apply needed guest memory.** Measured: none
  (init/link/shutdown/destroy by contract). **Does not trigger.**
- **If `Ctx::Store` could be installed on a thread that does not own the
  store.** It cannot by construction — the host loop *is* the store's owner —
  and `caller_is_this_thread` refuses any other thread at the shim, which is
  the same defence the caller path already relies on.

**Verdict: the safety argument holds.** It is the existing argument with one
more variant, and the mechanism that makes it safe (installer-thread token +
RAII clear) is variant-independent.

---

## PART 2 — the epoch core's four touchpoints

`run_epoch` is `epoch.rs:80-273`. Enumerating **every** `caller` use in it, not
just the four named:

| # | line | today | store-based | kind |
|---|---|---|---|---|
| 1 | `:95` | `caller.data().depth != 0` | `store.data().depth` | mechanical |
| 2 | `:99-100` | `caller.data().posting` / `.adapters` (clones) | `store.data()` | mechanical |
| 3 | `:119` | `run_publish_hooks(caller, &adapters)` | `run_publish_hooks_with_store(store, …)` | **forces `Ctx`** |
| 4 | `:127-129` | fault sweep: `caller.data().arena` → `memory.data_mut(&mut *caller)` | `store.data().arena` → `memory.data_mut(&mut store)` | mechanical |
| 5 | `:142-145` | arena writes: `memory.data_mut(&mut *caller)` | `memory.data_mut(&mut store)` | mechanical |
| 6 | `:210-212`, `:236-238` | `callback.call(&mut *caller, …)` | `callback.call(&mut store, …)` | mechanical — **already proven**: `main.rs:1233` does `func.call(&mut store, ())` |
| 7 | `:263` | `apply::apply_pending(session, caller, &adapters)` | `apply_pending_store(session, store, …)` | **forces `Ctx`** (the second hook) |
| 8 | `:216`, `:244` | `fault_from_trap(session, caller, …)` | `fault_from_trap_store(session, store, …)` — error path, arena writes only | mechanical |

So: **six mechanical sites and two `Ctx` sites.** The dispatch's four are a
subset; rows 4, 7 and 8 are the ones its list omitted. Row 7 is the material
one — it is a second hook, which is why §1.2.5 matters.

### 2.1 `with_store_installed` — the shape

```rust
pub(crate) fn with_store_installed<R>(
    api: &TensionCoreApi,
    store: &mut Store<HostState>,
    body: impl FnOnce() -> R,
) -> R
```

- **Wraps:** one adapter hook invocation, exactly as `with_publish_caller`
  wraps one today (`mod.rs:574-586`).
- **Installs:** `Ctx::Store(store as *mut Store<HostState>)`, the cached memory
  size (`enter_store` sets it from `store.data().arena`, mirroring
  `mod.rs:440-447`), and the installing thread's token — in that order, so a
  shim that sees a non-zero tid sees a matching slot (`mod.rs:448-455`).
- **Clears:** on `Drop`, thread id first then the slot — `leave` unchanged.
- **Does not:** take a `&mut` borrow of the store for longer than the call; the
  hook signature is `(ctx, api)` and the store is reached only through the slot,
  so the hook cannot hold a Rust borrow of it.

### 2.2 The Caller wrapper

```rust
pub fn run_epoch(session, caller: &mut Caller<'_, HostState>, mode) -> Result<EpochResult, SessionError>
```

becomes a thin shim:

- **keeps** the two guards it owns today — `require_ready` (`:86-91`) and the
  depth refusal (`:95-97`) — so the verb path's refusal ordering is unchanged;
- **keeps** the session-out-of-the-store dance (`run_epoch_verb`, `mod.rs:1321-1336`);
- **delegates** everything else to `run_epoch_with_store(session, store, mode)`,
  which is the same body with `caller` replaced by `store`.

`run_epoch_with_store` must also take the session out of the store and put it
back — the host loop calls it with the session installed — using the same
take/restore shape. The `Caller` given to `run_epoch` is derived from a store, so
`run_epoch` can call the core with `caller.as_context_mut()`; there is no second
store.

**Verification that the wrapper is unchanged:** the whole suite (519 tests, 37
suites) runs through `run_epoch` before the loop exists. Any behavioural drift in
the refactor shows there, with no new code in the path.

---

## PART 3 — the coexistence matrix

The host resolves both exports right after instantiation (landed in pre0,
`main.rs` — `task_wake` and `game_running` are `Option`s). The matrix follows
from that one fact.

| # | exports | `_start_game` | host | verification |
|---|---|---|---|---|
| 1 | neither | blocks (its own loop), returns at exit | no loop; teardown as today | all 15 examples — today's behaviour, unchanged |
| 2 | both | returns after setup | loop: wait → match → add FRAME if `_game_running()==1` → `wake(ids)` | a new fixture (below) |
| 3 | exactly one | — | **refuse at load**, naming both | a fixture that aborts with the named error |
| 4 | both, but `_start_game` blocks anyway | returns at exit with `_game_running()==0` | loop is not entered | benign; assert exit code and transcript |

### 3.1 Case 3 — the mixed case, decided

**Detected at load, refused at load.** The check sits where the two exports are
resolved (post-instantiation, before `_start_game`), and the rule is:

```
(__taskWake.is_some()) != (_game_running.is_some())
    -> refuse: "a host-driven guest must export both __taskWake and _game_running"
```

**Why at load rather than at first wake.** The failure is a *static* property of
the binary, so it can be diagnosed before a single guest instruction runs.
Deferring it produces two silent failures:

- **`__taskWake` without `_game_running`:** `_start_game` returns, the host has
  no reason to loop, no wake is ever sent, and the guest's parked tasks never
  resume. The process exits 0 having done nothing — the worst kind of failure,
  because it looks like success.
- **`_game_running` without `__taskWake`:** the host loops, adds FRAME ids, and
  has no way to dispatch them. Either it spins (a poll — forbidden by §4.4) or
  it must detect the uselessness anyway.

So the refusal is not defensive politeness; it is the only outcome that is
honest. It also costs nothing: both `Option`s are already resolved in one place.

### 3.2 Case 4 — opted in, doesn't adopt

Benign **if** the loop's entry condition is `game_running()` *and* something is
parked. Concretely:

```
loop {
    if game_running() == 0 && scheduler.parked() == 0 { break; }
    wait(...); match(...); add FRAME; wake(ids);
}
```

A guest that returns from `_start_game` with `_game_running() == 0` and nothing
parked exits immediately. One that says `1` but has nothing parked is
inconsistent — the loop would wake nobody — so it is reported as an error rather
than spun on. That check is `parked() == 0 && batch.is_empty() && game_running()
== 1` after one iteration: a named error, not a timeout.

---

## PART 4 — the FRAME mechanism

**Choice: (a) — the loop adds FRAME's parked task id directly. Measured, not
preferred.**

The measurement, from this tree:

| fact | value | source |
|---|---|---|
| class 9 (FRAME) ring capacity | **256** | `arena.rs:266-267` |
| FRAME's delivery mode | `MODE_POLLED` | `arena.rs:275-289` |
| what the epoch does with a POLLED class | publishes to the ring, **invokes no callback** | `epoch.rs:249-252` |
| records a POLLED class retains until reclaimed | all of them | compaction preserves `[tail, head)` (`subring.rs:217-235`) |
| who advances `tail` in production | **only compaction** (`subring.rs:233`) | grep: no guest writes a tail anywhere in `tension-framework/assembly/` |

Put together: with option (b), a FRAME record is appended each frame, no guest
ever reclaims it, and at 120 Hz the 256-slot ring fills in **2.13 s**. After
that every append returns `Full`, which the flush counts as a **drop**
(`subring.rs:292-293`) — and `FrameState.droppedEvents` (`arena.rs:179`) then
reports a nonzero drop count forever, for a stream that is working perfectly.

That is not a preference between two workable options. **(b) would corrupt the
drop signal within two seconds of a normal 120 Hz run**, and the drop signal is
what `-EIO` attribution rests on (contract §4.7). **(a) is required.**

What (a) costs: the loop calls `scheduler.take(CLASS_FRAME, 0)` each iteration
(the FRAME family's table is one slot, `scheduler.rs`) and puts the id in the
batch. If no task is parked on FRAME — the guest is between frames, or has not
reached its first `await rt.frame()` — the take answers `None` and the frame is
simply not delivered to anyone. No ring entry, no drop counter, no capacity
question.

**The frame clock.** The loop must block on a real primitive (contract §3.2).
The CLI's is the session condvar with a timeout:
`posting.wait_for_events(remaining_frame_time)` — a `Condvar::wait_timeout`
(`posting.rs:320-350`), which returns early on an event and on timeout at the
frame boundary. That names the primitive: **condition variable, bounded by the
frame period**. OGRE keeps its own clock (the render thread's vsync /
`cv.wait_for(period)`, `adapter.cpp:395`) and signals the owner; the owner's
wait is the same condvar.

Frame period: `frame_hz` is a **guest** config key today
(`ogre/index.ts:122`, `KEY_FRAME_HZ = 5`), not a session key, and
`session.json` has no frame entry. So the loop needs a host-side default; 60 Hz
is the only number already in the tree (`adapter.cpp:342`: `frame_hz == 0 ? 60`).
Flagged as a decision: a host flag or a session config key, not a silent
constant.

---

## PART 5 — what a "no" looks like

1. **The `Ctx` argument fails** if `caller_is_this_thread` cannot extend. It
   can — it compares installer-thread tokens, not pointer provenance
   (`mod.rs:429-432`). It also fails if a third production shim reads the slot:
   there are two (`guest_read_into`, `guest_write`), plus one test probe that
   reads `.data()` only.
2. **A touchpoint is not Store-reachable** if any of rows 1-8 above needs a
   `Caller`-only capability. None does; two need the `Ctx`, which exists for
   exactly that reason. **The dispatch's four touchpoints are six mechanical
   plus two `Ctx` — the count changes, the conclusion doesn't.**
3. **The coexistence matrix needs a different design** if the mixed case cannot
   be refused at load. It can: both exports are resolved in one place, before
   the guest runs, and the rule is a one-line inequality. It would also need
   rethinking if case 4 could spin — it can't, given the entry condition in
   §3.2.

**Nothing in this report forces a reshape.** The two corrections are: the epoch
has **two** `Ctx` hooks (publish and apply), and the FRAME choice is forced by
measurement rather than preference.

---

## Appendix — what STEP 2 will touch, in order

1. `adapter/mod.rs`: `Ctx`, `enter_caller`/`enter_store`, `leave` unchanged.
2. `adapter/ffi.rs`: `CallerGuard::install_*`, `with_store_installed`,
   `guest_read_into`/`guest_write` dispatch.
3. `session/epoch.rs`: `run_epoch_with_store` (the body), `run_epoch` (the
   shim), `fault_from_trap_store`, `run_publish_hooks`/`apply_pending` store
   variants.
4. `scheduler.rs`: `peek`/`take` for FRAME; the completion→id match the loop
   calls.
5. `main.rs`: the load-time coexistence check, the loop, the frame clock.

No transform change, no std change, no contract change.
