# DL24 — the fiber spike: yes to suspend and resume, and the ceiling is a thread

**The answer: the host can suspend a guest call on a fiber and resume it later, frame
and locals intact. But only one parked stackful task per OS thread, and the binding
constraint is wasmtime's trap handler, not the store.**

`~/work/Tension` `integration/dwarf-debug`, from **`c4dcb0d`**. `~/work/TensionScript-a2`
untouched at **`3f59ec08`**, bundle **`aa74d6a1`**, `std` byte-identical. **No
`tension-core/src` change, no ABI change, no compiler change, no std change.**

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`c4dcb0d`**, nothing unpushed |
| working tree | **one pre-existing change**: `package-lock.json` lost the devDependency's `integrity` line |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `std/assembly/thread.ts` | identical (`cmp` exit 0) |
| binary | `33 643 504` bytes, mtime **2026-11-23 14:11:11** |
| newest source | `src/thread.rs` **2026-11-23 14:07:07** |
| sources newer than the binary | **0** |

The dirty file is an npm artifact from an earlier round's install (a lockfile
`integrity` field), not this round's work. It is **left alone and not committed**; it
is listed in §6 as an undeclared-looking delta so nobody mistakes it for mine.

The rebuild was a no-op — cargo finished in seconds and the mtime stayed at 14:11:11,
later than every source file. DL23 changed no `.rs`, so the engine measured here is
byte-identical to the one DL22 measured.

## 1. Crate and target, declared before the first run

- **Crate: `wasmtime-internal-fiber = "=50.0.2"`** as a **dev-dependency**, no features.
- **Target: `tension-core/tests/fiber.rs`**, a new integration-test target, **not wired
  into CI**. Auto-discovered (only the eight `harness = false` targets need `[[test]]`
  entries), so no manifest block was added.
- **Declared counts:** `--bin` 307 unchanged, census 71/11 unchanged, `test:compiler`
  0 skips unchanged, thread suite 7 unchanged, bundle and std unchanged. New target
  `--test fiber` = **6 tests**. `Cargo.lock` gains exactly one line.
- **Measured:** every one of those, exactly. See §5.

Why the internal crate and not the public `wasmtime-fiber-24.0.13`:

1. **Version-locked to the engine in use** (`wasmtime = "=50.0.2"`), so the answer
   transfers. A spike whose result does not describe the shipped engine is a wasted
   round.
2. **Already in `Cargo.lock`** at exactly `50.0.2` as a transitive dependency, so the
   dev-dependency adds no crate to the graph — confirmed: the lockfile diff is one line,
   `"wasmtime-internal-fiber",` in tension-core's dependency list.
3. If a host fiber path ever ships, it must be this crate. Measuring 26 major versions
   back would answer a question about code the project will never call.

The crate's own header warns it is internal, "not intended for general use", and that
"usage outside of Wasmtime may have bugs". That warning is **accurate and material** —
§3 and §4 both hit it. Nothing outside `tests/fiber.rs` may depend on it.

**Which implementation is active**, because the citations below depend on it: with no
features, `cfg_select!`'s *first* arm matches — `not(feature = "std")` — so the code in
use is `src/nostd.rs` over `src/stackswitch.rs` (per-arch inline assembly), **not**
`src/unix.rs` (mmap + guard pages). That is also how `wasmtime` itself depends on it.

## 2. Q1 and Q2 — suspend from a host import, resume later, frame survives

The guest is inline WAT: `run` stores `42` in a local, calls the imported `__yield`,
then prints the local and returns it. The host's `__yield` gets the `Suspend` handle
from a thread-local published for exactly the duration of the wasm call, and suspends.

Verbatim, from `q1_q2_a_host_import_suspends_the_calling_fiber_and_the_local_survives`:

```
guest: BEFORE (set before the suspension) keep=42
guest: inside __yield — about to suspend the fiber
host loop: resume returned Err(yield); the guest is suspended inside __yield
guest: __yield returned — the fiber was resumed, back into wasm
guest: AFTER  (after the resume) keep=42
```

The four clauses, each asserted by position in the log, not merely by presence:

- **suspension** — line 3 is written by the *host loop*, after `Fiber::resume` returned
  `Err("guest parked in __yield")`, while the guest's `__yield` frame is still on the
  fiber;
- **the API** — `Suspend::suspend(&mut self, value: Yield) -> Resume`, doc: *"This
  function will switch control back to the original caller of `Fiber::resume`. This
  function will then return once the `Fiber::resume` function is called again."*;
- **frames preserved** — line 4 is the `__yield` import returning, i.e. execution
  continued at the guest instruction after the host call;
- **locals unchanged** — `keep=42` on both sides, and `run` returns 42.

The run completes in milliseconds with no sleeping anywhere in the probe.

### The handle, and why a thread-local is the sound choice

`Suspend` is obtainable **only** as `&mut Suspend` inside the fiber's closure. There is
no ambient "current fiber" lookup in this crate: `Fiber` is a zero-sized struct
(`nostd.rs:123`) and `Suspend` is a per-resume struct built on the fiber's own stack.
So the probe publishes the address for exactly one wasm call:

```rust
install(suspend as *mut _ as *mut ());   // before
let result = run.call(&mut store, ());    // the call that may suspend
install(previous);                        // after
```

It is a raw pointer and dereferencing it is `unsafe`; the safety argument is bounded and
written at the deref site: the address is published immediately before one call and
cleared immediately after it returns, and the `Suspend` it names lives on that fiber's
stack for the whole of that call.

## 3. Q3 — the ceiling is **one parked fiber per thread**, not per store

The brief predicted H1 as "one parked fiber per *store*", on the grounds that a suspended
fiber sits inside a host call holding `&mut Store`. That is true and measurable (below),
**but it is not the binding constraint.** Two things were measured, and the second is
the one that matters.

### 3a. The store is exclusive while a fiber is parked — true, and satisfiable

`q3_two_fibers_cannot_both_be_inside_one_store`: A suspends inside its call holding the
store (as an `Arc<Mutex<Store<()>>>`, which is what `&mut Store` means expressed so a
run can observe the exclusion); B's `try_lock` returns `WouldBlock`; A finishes and
releases; B then takes it and repeats. Verbatim:

```
host loop: A is suspended inside its call, still holding the store
host loop: B's try_lock on the store -> WouldBlock (H1: one parked task per store)
```

The exclusion is **temporal, not permanent** — the cost "a parked task holds its store"
is real, but one store is enough for any number of parked tasks taken one at a time.

### 3b. The real ceiling: wasmtime's trap handler is a per-thread LIFO list

`q3_two_parked_fibers_on_one_thread_are_refused`: **two stores**, one each, both fibers
parked inside wasm at the same time, on one thread. Resuming A then panics **inside
wasmtime**:

```
thread 'q3_two_parked_fibers_on_one_thread_are_refused' panicked at
wasmtime-50.0.2/src/runtime/vm/traphandlers.rs:627:13:
assertion failed: core::ptr::eq(head, self)
resume A with B parked -> assertion failed: core::ptr::eq(head, self)
```

The guard, quoted from `wasmtime-50.0.2/src/runtime/vm/traphandlers.rs:625-629`:

```rust
/// Pops this `CallThreadState` from the linked list stored in TLS.
///
/// # Panics
///
/// Panics if this activation isn't the head of the list.
#[inline]
pub(crate) unsafe fn pop(&self) {
    let prev = self.prev.replace(ptr::null());
    let head = tls::raw::replace(prev);
    assert!(core::ptr::eq(head, self));
}
```

Every `Store` call pushes a `CallThreadState` onto a **thread-local** linked list
(`push` does `tls::raw::replace(self)`) and pops it on exit, LIFO. Suspend A (A is the
head), suspend B (B becomes the head), resume A → A pops and finds B. The list is not
per store, so a second store buys nothing.

**Verdict: H1, and narrower than the brief's wording — one parked stackful task per OS
thread.**

### 3c. What it takes to have N — measured

`q3_two_parked_tasks_work_when_each_has_its_own_thread`: two OS threads, each with its
own store and fiber, both parked inside wasm simultaneously (joined by a `Barrier`, so
the suspensions genuinely overlap), both resumed and both complete:

```
thread 2: parked inside wasm
thread 1: parked inside wasm
thread 1: both parked, resuming
guest: AFTER  (after the resume) keep=42
thread 2: both parked, resuming
guest: AFTER  (after the resume) keep=42
```

So the cost model is **stackful task = store + fiber + thread**, not "store + fiber".
N is available, at an OS thread per concurrently-parked task. The other two routes the
brief lists:

- **`ReleaseStore`-style API**: does not exist for embedders. `StoreFiber`,
  `StoreFiberYield`, `CallThreadState::swap` and `StoreFiber::suspend` are all
  `pub(crate)`/`pub(super)` inside `wasmtime` (`src/runtime/fiber.rs:317`, `:403`), and
  `ReleaseStore` is further gated on `feature = "component-model-async"` and is for
  component-model async-lowered imports. `wasmtime`'s `async` feature *is* on by default
  and the machinery *is* compiled — it is simply not reachable.
- **Nothing available**: not the answer; per-thread is.

**Correction I had to make, recorded because it is the round's most useful mistake:** my
first version of 3c asserted that two parked tasks work "when each has its own store".
It **failed** with the same `core::ptr::eq` assertion. The test now says what the
measurement says. That failure is why the ceiling is stated as per-*thread*.

## 4. Q4 — thread affinity: the type permits it, the engine does not

### The bounds, asked of the compiler

`Fiber<'static, (), &'static str, i32>` **is** `Send` — this line is in the test and the
target would not build otherwise:

```rust
fn _fiber_is_send() {
    require_send(&None::<Fiber<'static, Resume, Yield, i32>>);
}
```

`Suspend` is **not**, and the compiler names the reason:

```
error[E0277]: `*mut u8` cannot be sent between threads safely
   |
   = help: within `Suspend<(), &str, i32>`, the trait `Send` is not implemented
           for `*mut u8`
```

That is `pub struct Suspend { top_of_stack: *mut u8 }` (`nostd.rs:125`).

### The runtime answer, and it is a refusal

`q4_thread_affinity`: suspend on thread 1, move the `Fiber` to thread 2, resume there.
The guest **does** continue — and then wasmtime aborts the pop:

```
guest: BEFORE (set before the suspension) keep=42
guest: inside __yield — about to suspend the fiber
host loop (thread 1): the fiber is suspended here
guest: __yield returned — the fiber was resumed, back into wasm
guest: AFTER  (after the resume) keep=42
host loop (thread 2): resume returned panicked: assertion failed: core::ptr::eq(head, self)
```

Read it precisely: the fiber mechanics work across threads (the guest printed its AFTER
line on thread 2), and the **activation bookkeeping** does not, because the
`CallThreadState` was pushed on thread 1's TLS and thread 2 has an empty list.

The crate's own words on why this is not merely an oversight, quoted from
`traphandlers.rs:1137-1145`:

```
// Wasmtime's async support employs stack switching which can resume execution on
// different OS threads. This means that borrows of our TLS pointer must never live
// across accesses because otherwise the access may be split across two threads and
// cause unsafety.
//
// This also means that extra care is taken by the runtime to save/restore these TLS
// values when the runtime may have crossed threads.
```

There is machinery for exactly this — `CallThreadState::swap` — and it is
`#[cfg(feature = "async")] pub(super)`. The `async` feature is on; the function is not
reachable.

**Answer: a suspended fiber is not resumable from another OS thread by an embedder, even
though `Fiber: Send`.** A pool may not hand a parked stackful task to another executor.
The policy must pin a parked task to the thread that parked it. Two further costs that
fall out and belong in the table: `Suspend` is `!Send`, so the handle travels as a bare
address (the probe carries a `usize` and re-installs it), and that unsafe step would have
to be owned by whoever implements the pool.

## 5. Declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| `--bin` count | 307 | **307** | unchanged |
| census `--workers 8`, alone | 71 pass / 11 no-source | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** capability skips | unchanged |
| thread suite | 7 | **7 passed** (+ `async_main_promise` 2) | unchanged |
| bundle / std | unchanged | `aa74d6a1`, `cmp` exit 0 | ✓ |
| new target | `--test fiber`, not in CI | **6 tests, all pass** | as declared |
| `Cargo.lock` | one line | exactly one: `"wasmtime-internal-fiber",` | as declared |
| `tension-core/src` | untouched | `git status` shows no `src/` file | ✓ |

### Files touched

| file | why |
|---|---|
| `tension-core/tests/fiber.rs` (new) | the probe: 6 tests, Q1–Q4 + both controls |
| `tension-core/Cargo.toml` | the dev-dependency, with the three reasons in a comment |
| `tension-core/Cargo.lock` | one line, no new crate |
| `tools/thread-promise/DL24-REPORT.md` | this report |

**Not touched, and therefore undeclared-looking:** `package-lock.json` (pre-existing,
§0). It is not part of this round and is not in any commit.

## 6. The negative control

`negative_control_without_the_second_resume_the_guest_stays_suspended`. **What was
changed to break it:** `fiber.resume(())` is called **once** instead of twice. Module,
imports, store, stack size and every guest-side assertion are identical, so the resume
count is the only difference. Verbatim:

```
guest: BEFORE (set before the suspension) keep=42
guest: inside __yield — about to suspend the fiber
host loop: the guest is still suspended; nothing resumed it
```

No `AFTER`, `fiber.done() == false`, and the host loop reports it — the guest is stuck
inside the host call, which is exactly what a missing resume means.

It also produced a second finding that is a property of the mechanism, not of the probe:

```rust
impl<A, B, C> Drop for Fiber<'_, A, B, C> {
    fn drop(&mut self) {
        debug_assert!(self.done.get(), "fiber dropped without finishing");
```

(`wasmtime-internal-fiber-50.0.2/src/lib.rs:304-306`.) **A suspended fiber cannot be
dropped** — the test leaks it with `std::mem::forget`. Abandoning a parked stackful task
therefore leaks its stack unless it is resumed; a pool must not rely on `Drop`.

## 7. Bugs I made, and what caught each

1. **My `Send`-probe was broken and I nearly reported its answer as a fact.** The
   autoref trick I wrote returned `false` for *everything* — including `u32` and
   `Arc<u8>`. `Fiber: Send = false` was therefore meaningless, and I had already
   asserted it in the Q4 test (which failed). **Caught by calibrating the instrument**
   against known-`Send` and known-`!Send` types in a scratch file. Replaced by asking
   the compiler directly: `require_send(&None::<Fiber<…>>)` compiles (so `Send` holds),
   and the `Suspend` case produces `E0277 … not implemented for *mut u8`.
2. **I asserted a claim the measurement disproves.** `q3_two_parked_tasks_work_when_
   each_has_its_own_store` asserted two parked tasks work with one store each. They do
   not — the process aborted with the trap-handler assertion, then aborted *again*
   during unwind because a suspended `Fiber` was dropped in the destructor ("panic in a
   destructor during cleanup", SIGABRT). Fixed by measuring the true shape (one thread
   each) and explaining in the test why the first version was wrong.
3. **A process-global handle was a soundness hazard in my own probe.** I first published
   the `Suspend` address both thread-locally and in a `static AtomicPtr`. With tests
   running in parallel, any test could overwrite the global while Q4's thread-2 resume
   was about to read it — a wrong-handle dereference. Caught by reasoning about
   `cargo test`'s parallel execution, not by a failure. Removed the global; Q4 now
   carries the address explicitly as a `usize` and installs it on the resuming thread.
4. **I cited the wrong implementation file.** My first draft attributed `Suspend` to
   `unix.rs`; with no features, `cfg_select!`'s `not(feature = "std")` arm wins and the
   code is `nostd.rs`. Caught by reading the `cfg_select!` block while checking the line
   number for the report. Both citations corrected.
5. **A helper named `log` shadowed every local named `log`** (six `E0618`s). Renamed to
   `note`.

## 8. What I did not verify

- **Windows.** Excluded by the brief. The crate ships `windows.rs`, so the technique is
  testable later on the same contract — not tested here.
- **Release-mode behaviour.** All runs are the `test` profile (debug), which is where
  `debug_assert!` is live — so the "cannot drop a suspended fiber" finding is a
  **debug** assertion. In release the drop proceeds to `self.inner.drop::<A, B, C>()`
  with `done == false`, and I did not test what that does to a live stack. That is a
  follow-up, and it is why I say the leak is *observed in debug* rather than *guaranteed
  in release*.
- **A pool**, i.e. N threads with a work queue handing parked tasks between them. The
  probe shows the *constraint* (pin to the parking thread) but does not build the pinning
  policy; that is the round that would follow.
- **Whether `wasmtime` would do better if we used its own async machinery** (`Instance`'s
  async calls, `func.call_async`, `epoch_deadline_async_yield`). Out of scope by the
  brief (no engine change), and it is a different mechanism — but it is the obvious next
  question if a fiber path is ever wanted, because the store-release machinery is there
  and simply not exposed.
- **I57 and I58** (the async worker entry, the abandoned continuation) as the brief
  excludes them; note that §3's finding is adjacent to I57 — an async worker entry never
  running may well be the same per-thread activation constraint, which would make it one
  defect rather than two. Not tested; recorded as a hypothesis for the round that fixes
  them.
- **Cost in memory.** A 512 KiB stack per fiber was chosen, not measured. The real
  footprint and whether smaller works is a cost-model question the brief excludes.

## 9. Commits

| SHA | what |
|---|---|
| `d187337` | `probe(fiber): a host import can suspend and resume a guest call — one parked task per thread (DL24)` — the six tests, the dev-dependency, the one-line lockfile delta |
| *this file* | `docs: DL24 — …` |

CI: run **`45203920152`** on `222831a`, **success** — `Wake path guard` ran `2 tests`,
both ok in 1.07 s. The new target is **not** wired into the workflow this round, as
declared, and nothing about it reaches that job.

One check worth recording, because it is the question a later round will ask: the probe
also passes under the flags CI uses —

```
cargo test --test fiber --no-default-features   → 6 passed
```

— so it is not accidentally dependent on a default feature `tension-core` turns off in
CI, and wiring it in later would be a one-line change to a working target rather than a
porting exercise.
