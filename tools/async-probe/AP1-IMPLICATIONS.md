# Phase E — what the four answers imply

No recommendation. Each row states what an answer makes possible and what it
forbids, using only what AP1 measured. The decisions are the user's.

---

## A — the backend is chosen by a runtime probe, per process, two values

**Measured:** one `match` on `Engine::new` accepting `wasm_stack_switching(true)`
(`async_backend.rs:60-75`); one engine per process (`host/config.rs:37-48`);
exactly two backends.

**Makes possible:** a third backend is an additive arm — a new `AsyncBackend`
variant, one new branch in `build`, one new `label()`, one new startup line. The
`HostConfig` field, the startup report, `supports_continuations()` and every test
that reads `current()` already exist and already discriminate on the value rather
than the prose.

**Forbids:** a backend chosen *per guest* or *per task*. The engine owns the
compiled-code cache and is shared for the life of the process; two guests on one
process cannot get two engines without giving up the cache. Any design that wants
"the continuity guest uses X and the promise guest uses Y in one run" is a
redesign of `HostConfig`, not a new arm.

**Also forbids:** deciding a new backend's availability the same way. The only
input the current probe has is "did wasmtime accept this feature", which cannot
say anything about a parking backend. A parking backend needs its own decidable
predicate, and "wasmtime said yes" is not it.

---

## B — the continuation refusal is wasmtime's target gate, not reversible by us

**Measured:** `wasmtime-50.0.2/src/config.rs:2497-2513` marks `STACK_SWITCHING`
unsupported on everything except x86-64 Linux/macOS/Darwin; `Config::validate()`
bails (`:2686-2697`) before `Engine::new` returns; identical in
`51.0.0-rc.1`. Cranelift does have a Windows model (`update_windows_tib`,
`cranelift-codegen-meta-0.137.2/src/shared/settings.rs:131-141`) that the gate
never lets you reach.

**If the refusal is ours and reversible** (it is not): continuations on Windows
would be a build flag, and the debugger arc's CPU-by-CPU parity would extend to
the stackful backend for free.

**What is actually available is narrower, and splits into two very different
costs:**

- **A vendored one-condition patch to wasmtime's gate** + trusting
  `update_windows_tib`. Makes possible: continuations on Windows *if* the runtime
  works there. Forbids: nothing by construction, but buys an obligation — a
  forked wasmtime re-applied on every bump, the same class of decision as the
  DWARF-transform memo (`dl6/PHASE-E-DL6.md`). **Untested**: no measurement
  anywhere says continuations *run* on Windows once enabled. So this option is
  "months, with a real chance of failing late".
- **Waiting upstream** (wasmtime adds Windows to that match arm). Forbids:
  everything stackful on Windows until then. Costs nothing now. Given the list is
  unchanged in 51.0.0-rc.1, this is "indefinite".

There is no third option where the cost is small: the gate is one condition, but
what it unlocks is untested.

---

## C — threads work on Linux; Windows untested

**Measured on Linux:** a hand-written shared-memory guest loads, runs two atomic
RMWs, spawns a real OS thread that RMWs the same memory, and `__executorCount()`
answers N+1 (`transcript-linux.txt`). The in-crate pool test passes.

**If C says threads work on Windows too** (inferred — no gate in our tree, and
wasmtime only refuses `THREADS` for Pulley and Aarch64-Winch): a parking backend
is viable on both platforms. What that makes possible: async on Windows without
continuations — the frame stays synchronous between parks, and the concurrency
model becomes "N executors over one shared memory", which already exists in
`thread.rs` and already has an ABI (`docs/thread-abi.md`). What it forbids: any
design that assumes a task's local stack survives a park without being copied —
parking is not continuations; a parked task's frames live wherever the runtime
put them, not on a continuation stack.

**What it also names:** the concurrency ceiling becomes the 32-executor limit
(already recorded as I8), not the number of OS threads, because the ABI's id
space is bounded.

**If C says threads do not work on Windows**: Windows async is CPS-only — every
suspension is a state-machine transformation, the frame shape is permanently
different from Linux, and the two platforms can never share a task representation.
That is a design constraint, not a bug to fix.

---

## D — the Promise build does not start `main`, on Linux as well as Windows

**Measured:** `game.ts` built without `--enable stack-switching` exits 0 printing
nothing on Linux; `main` has **zero call sites** in the emitted module;
`_start_game` is `nop` by design. One `await` in an imported library file
(`tension-framework/assembly/2d/scene.ts:1036`), in code never called, is enough
to disable the A1 shell, and without `--enable stack-switching` the suspending
shell is disabled too — so no shell is emitted at all.

**If D is a small bug** — and the mechanism is now small enough to be one: the
missing piece is a shell for "Promise build, `hasAwait`, exported `main`" — then
the user can watch async on Windows this week, because the Windows blocker stops
being "async does not run" and becomes "11 debugger cases remain", which is a
much smaller thing. What that makes possible: `game.ts:77` on Windows with the
same verdict as Linux.

**What it forbids:** nothing, but it does not remove the B constraint. A Promise
build that runs `main` still cannot suspend-and-resume the way the stackful one
does; it runs the await graph through the Promise seam. Anything built on "the
frame looks the same after an await" stays Linux-only.

**And it reorders the work:** until D is fixed, no Windows design can be
evaluated, because every Windows measurement of an async program currently
measures a program that never started.

**One caution that is a measurement, not a guess:** the A1 shell's own comment
says "A1 is the shell without suspension; a program with an `await` belongs to
Backend A". Whether A1 can run a `main` that does await, or whether a Promise
build needs a different root, is the open design question D surfaces — it was not
settled here, and it is not answered by the fact that the module is silent.

---

## The ordering the four answers suggest, without choosing

- **D** is the only one whose cost is plausibly small and whose payoff is "the
  user can run their own example on their own platform". It is also a
  prerequisite for evaluating anything else on Windows.
- **C on Windows** is one probe away, and it decides whether a parking backend is
  a possibility at all. It cannot be done from this machine.
- **B** is the expensive one in both directions: a vendored fork with an untested
  runtime behind it, or an indefinite wait. It is the only item whose cost does
  not shrink with more measurement here.
- **A** is the cheapest to extend and the least valuable on its own: a third arm
  is trivial, but its predicate is the hard part and belongs with C.
