# Tension solver — design note

Status: **phase 7 complete — see §11.**
Siblings: **tension-solver/schema.yaml** (configuration vocabulary) and
**tension-solver/include/tension_solver.h** (the C ABI, committed at
cd88b85, extended at fd8e4bd). This note records what those two artifacts
deliberately do not carry: what the solver is for, how it is built, and
where its determinism comes from.

Tension project — MIT. See LICENSE at repo root.

---

## 1. Scope

tension-solver is the engine's numerical-integration coprocessor: the guest
configures a solver (a `method:` from schema.yaml, a `source:` for f), the
host integrates, the guest reads results. The configuration vocabulary is
schema.yaml's; the ABI is tension_solver.h's; the built-in numerics are
Fortran, here. Phase 1 delivers the euler primitive and the shape the rest
of the family fills in — nothing in the engine calls the solver yet, and
nothing will until a guest asks for it (services are opt-in; nothing
default).

## 2. Build facts (phase 1)

Found while making the first archive, so they are written down the way
tension-res/DESIGN.md §9.2 writes its Zig facts:

1. The core is built by **`tension-solver/build.sh`**, invoked from
   `tension-core/build.rs` exactly as `zig build` is invoked for
   tension-res — one command, one archive. The result is
   **`tension-solver/build/libtension_solver.a`**; the Rust side emits
   `rustc-link-search` plus `static=tension_solver`, `gfortran`, `m`.
2. The recipe **pins `-O2 -fno-fast-math -fPIC`** in the script itself.
   `-fno-fast-math` is the determinism load-bearing one: fast-math permits
   reassociation and reciprocal contraction, which change results
   bit-for-bit. The flags live in the recipe, not in the caller's
   environment, because an environment the build cannot see must not
   change the numerical contract.
3. `-fPIC` is carried explicitly rather than left to a distribution
   default: the Rust host links a PIE, and the failure mode — an absolute
   32-bit relocation that the final `cc` cannot place — is real
   (tension-res/DESIGN.md §9.2, fact 1). On the machine P1 was built on,
   gfortran's default already emits PIE-compatible relocations (probe:
   only `R_X86_64_PC32` / `R_X86_64_PLT32`, no `R_X86_64_32S`), so the
   flag is belt-and-braces for toolchains whose default differs — a pin,
   not a patch.
4. **gfortran is pinned to the 16 series** in `build.rs`
   (`check_gfortran_version`, warn-on-mismatch, mirroring the Zig check);
   the machine P1 was built on reports `GNU Fortran (GCC) 16.2.1
   20260810`. A different compiler is a different codegen contract
   (§5's ambient assumptions).
5. The archive carries the two `bind(C)` symbols
   (`tension_solver_euler_workspace_size`, `tension_solver_euler_step`)
   plus gfortran's usual module-internal symbols
   (`__tension_solver_erk_MOD_*`) and an undefined `__stack_chk_fail`
   from the toolchain's default stack protector, resolved against libc at
   the final link.
6. gfortran writes the module interface file
   (`tension_solver_erk.mod`) into the current working directory unless
   `-J` names somewhere else; the recipe pins it (`-J build/`) next to
   the archive, because "current working directory" is whatever the
   caller happened to be — cargo's, when `build.rs` runs it. Build
   output that follows the caller is a leak, not a feature.

## 3. Module structure

One module per family, not per backend and not one mega-module: the
phase-1 methods share one stage loop and (for the adaptive pair, phase 3)
one error estimator, so per-backend modules would fork the numerics into
copies that drift; a single module would mix shapes that share nothing
(verlet has no stages, spook no order). The stage loop lives once
(`erk_step`, private), the per-method code is its Butcher-table PARAMETER
data plus a thin wrapper, and the `bind(C)` wrappers are module
procedures — which, unlike contained procedures, may carry
`bind(C, name=...)`. `tension_solver_erk.f90` is that module for the
explicit-RK family.

## 4. Workspace

The workspace is **host-owned and passed in**, never Fortran module state.
Three reasons, recorded because they are easy to get wrong later: one
process hosts many solver instances (the id table), and module SAVE state
would let them contaminate each other; the lifecycle must mirror the
resource subsystem (whoever allocates at create frees at destroy); and
adaptive step history must persist across `step` calls, which a
passed-in workspace does with no hidden state at all — determinism
factor 1 becomes structural rather than a promise. The layout is the
method's business (euler: one stage vector, `dim` f64 slots; the generic
s-stage arithmetic reserves one extra scratch vector when s > 1) and it is
never part of the C ABI.

## 5. Determinism

The composition theorem, stated once so every phase can point at it:

    determinism(solver) = integrator determinism
                        × RHS purity
                        × validate purity (when a validate callback is used)
                        × source determinism

Factor 1 is the schema's per-backend property (schema.yaml's determinism
comment) for built-ins, and the registered vtable's `deterministic` field
for plugins; euler is deterministic by construction. Factors 2 and 3 are
the callbacks' contract, stated on the two typedefs in tension_solver.h (a
pure function of `(y, t)`; the engine cannot enforce it). Factor 4 belongs
to the source: world compilation (tension-scene) and the wasm trampoline
each have to keep their side of it. The theorem rests on two ambient
assumptions, both pinned in the build recipe: the compiler series (§2
fact 4) and the flags (§2 fact 2). Phase 1 proves factor 1 on this machine
— two identical runs are bit-identical (T3), and interleaved solvers do
not interfere (T4) — in `tension-core/tests/solver_p1.rs`.

Known limitations (recorded, not hidden)

Phase 1 delivers euler only: one backend, fixed-step, no adaptivity, no
sources, no public ABI; the other six schema-declared methods are
vocabulary, not code.

## 6. The C shim (phase 2)

Phase 2 is the shim: `tension-solver/src/tension_solver.c`, C99,
implementing the header's public surface. The Fortran core is
unchanged from §3; the shim sits between it and the caller.

What the shim owns and the Fortran core does not: the handle/id table
(1-based ids, 64 slots, `-EMFILE` on exhaustion), the hand-rolled JSON
parser (flat object; rejects any structure outside the subset with
`-EINVAL`; no allocation before the first `calloc` at the end of
`create`, so a malformed config never touches the allocator), the
compiled method/source/parameter rules (three static tables and two
constants; cross-checked against schema.yaml by test T20), the plugin
registry (32 slots, keyed by name; a name shadowing a built-in is
`-EINVAL`; `kind` outside the six reserved names is `-EINVAL`;
`deterministic` mismatching `kind` is `-EINVAL` per the header's
registration table), and `bind_callbacks` (rejects rebind after any
attempted step; rejects any non-NULL binding on `source: world`;
accepts NULL/NULL as a no-op on `source: native`).

Not implemented in phase 2: `source: world` returns `-ENOSYS` (P8
resolves it), the six non-euler built-ins register and return
`-ENOSYS` (P3, P6), the wasm-to-C bridge for `source: wasm` is P4
(phase 2 tests the shim side with plain `extern "C"` callbacks).

Known limitations (recorded, not hidden)

The vtable's `state`/`set_state` slots are declared in the header for
plugin backends but are not invoked by the shim in phase 2 — only
`step` is. Plugin lifecycle (state/set_state/destroy dispatch through
the vtable) lands in P5 alongside the Rust safe wrapper.

## 7. The RK family (phase 3)

Phase 3 completes the explicit-RK family — heun, rk23, rk45 — behind the
same nine-argument step shape euler has used since phase 1: `(state, dim,
t, dt, workspace, rhs_fn, rhs_ctx, params, status)`. What differs per
method is behavior, not the ABI.

**The parameter block.** `params` now points at a real `bind(C)` struct:
`tension_solver_params` in the Fortran module, mirrored by the shim's
private `src/solver_params.h` — one field per schema parameter
(`rel_tol`, `abs_tol`, `min_step`, `max_step`, `fixed_step`, `iterations`,
`convergence_tol`, `compliance`, `relaxation`). Each method reads its
subset and ignores the rest (rk23/rk45 read the four step-control fields;
euler and heun read none — fixed-step), so P6 adds methods without
touching the ABI. The two declarations must stay in lockstep: the C
mirror carries a 72-byte size assertion, and both `sizeof` and gfortran's
`storage_size` were probed at 72 when it was written.

**Step semantics.** euler and heun take exactly one step of size `dt`
(heun: the explicit trapezoid, two evaluations, no error control — it
ignores `params` entirely, which T8 pins); the shared trial loop
(`erk_trial`) was generalized from phase 1's fixed-step `erk_step`, and
euler's arithmetic is unchanged. rk23 and rk45 advance exactly `dt`
through as many internal substeps of adaptive size as the tolerances
demand; `status` reports the total RHS evaluations.

**Butcher tables** (compile-time PARAMETER data, `tension_solver_erk.f90`):
rk23 is Bogacki & Shampine, "A 3(2) pair of Runge-Kutta formulas",
Applied Mathematics Letters 2(4), 321–325, 1989 (MATLAB ode23); rk45 is
Dormand & Prince, "A family of embedded Runge-Kutta formulae", Journal of
Computational and Applied Mathematics 6(1), 19–26, 1980 (MATLAB ode45).
Both carry an FSAL stage — the last stage evaluates f at the trial
solution — which the controller carries into the next substep's first
stage, saving one evaluation per accepted substep.

**The adaptive controller** (`erk_adaptive`, private). The trial size
starts at `min(max_step, |remaining|)`; after each trial the scaled RMS
error over per-component `|y_main − y_hat| / (abs_tol + rel_tol·max(|y|,
|y_new|))` drives `h_new = |h| · ERK_SAFETY · err^(−1/(p+1))` with
`ERK_SAFETY = 0.9` (a ~10 % margin, standard practice; p is the main
order — 3 for rk23, 5 for rk45), clamped to `[min_step, max_step]`. A
rejection recomputes from the unchanged state (the trial never writes
`y`; k1 stays valid), an acceptance commits the trial output and carries
the FSAL stage. `err > 1` with `h_new < min_step` is `-EIO`: the
tolerances cannot be met inside the step-size window, and the
alternatives — loosening the tolerance silently, or overshooting `dt` —
would betray the caller's contract.

**Workspace arithmetic.** The generic `erk_workspace_slots(s, dim)` =
`s·dim` plus one `dim` scratch when `s > 1` is what every method uses:
euler 1·dim, heun 3·dim, rk23 5·dim, rk45 8·dim. The phase-3 brief listed
2·dim for heun and 3·dim+dim for rk23; those numbers leave no room for
the stage-state scratch the shared trial loop requires (and rk23's count
omits its FSAL stage). The brief's own instruction — confirm against the
generic formula and reuse it exactly — is what this follows.

**Not delivered in phase 3:** verlet, implicit_euler and spook still
register and answer `-ENOSYS` (P6); the wasm-to-C bridge is P4; the YAML
world compiler is P8; the vtable's state/set_state/destroy slots are
still not dispatched through (P5).

**Observations from the phase tests** (`tests/solver_p3.rs`). Observed
orders on y′ = −y over [0, 1] (nominal → observed, errors at n and 2n):
euler 1 → 1.01 (5.82e−3 / 2.89e−3), heun 2 → 2.03 (2.51e−4 / 6.13e−5),
rk23 3 → 3.07 (3.31e−5 / 3.93e−6), rk45 5 → 5.15 (3.84e−9 / 1.08e−10).
rk45 on one dt = 1.0 step of y′ = −y: relTol = 1e−3 costs 19 evaluations
and lands 1.7e−4 from e^(−1); relTol = 1e−10 costs 181 evaluations and
lands 7.1e−12 away. The minStep-exhaustion test needed y′ = −1e5·y, not
the brief's y′ = −100·y: with λ = 100 the tolerance-required step
(≈ 9.4e−5, the DP5(4) local-error balance) still exceeds a 1e−6
minStep, so that example would converge rather than exhaust; at λ = 1e5
the required step (≈ 9.4e−8) is below minStep, and the step reports
`-EIO` with the state untouched.

---

## 8. The wasm bridge (phase 4)

Phase 4 makes `source: "wasm"` real: the guest's `_derivative`, exported
from a wasm module, is called by the Fortran step loop once per stage,
and the state round-trips through the module's linear memory. Neither
the shim nor the Fortran core changed for this — both are source-agnostic,
and phase 4's tests confirm that by construction.

**Where the bridge lives.** In Rust, in `tension-core/tests/solver_p4.rs`
— the phase's proving ground, not a library module. The test loads the
fixture with wasmtime, wraps its export in a plain `extern "C"` function,
and passes that function's pointer to `tension_solver_bind_callbacks`;
the shim stores the pointer like any other; the Fortran step loop calls
it per stage with no knowledge that wasm is on the other side. P5 will
make this ergonomic with a safe wrapper; P4 proves the mechanism with
raw FFI.

**Why the thread-local.** The ABI's `_derivative` typedef has no
user-data slot (the purity decision at fd8e4bd: a derivative is f(t, y),
and a context pointer is state the contract does not see). A wasm call
needs its store and memory, so the trampoline reaches them through a
`thread_local!` holding the wasm context, set before each `step` and
cleared after. `step` is synchronous, so the set/call/clear window
cannot interleave with another step on the same thread; the interleaving
test (T6) is the proof that the swap does not leak across solvers. This
is P4's shape, not the final one: P5 may replace the manual set/clear
with a scoped-context API if ergonomics warrant.

**The three-export convention.** The fixture
(`tension-core/tests/fixtures/simple_deriv.wat`) exports:

- `_derivative(y_ptr, len, t, dy_ptr, dy_cap) -> i32` — computes
  f(t, y) = −y elementwise;
- `deriv_buf_in() -> i32` — the wasm address of the input buffer;
- `deriv_buf_out() -> i32` — the wasm address of the output buffer.

The two buffers are not allocated by any function: module and host agree
by convention that the regions exist (64 KiB each, at 1024 and 66560).
The trampoline copies host `y` in, calls `_derivative` with the two wasm
addresses, and copies the output back out; the module never sees a host
pointer. This is the standard shim-and-copy pattern, and its cost is
exactly that: one copy in and one copy out per stage evaluation, which
the phase's rk45 runs price at 79 trampoline calls for one dt = 1.0
step. P5 can generalize to arbitrary `dim` via an allocator export if
needed; P4 does not.

(A fixture note: the brief said the module needs 2 pages = 128 KiB, but
its own suggested buffer addresses — 1024 and 66560, 64 KiB each — need
132 096 bytes, so 2 pages fall 1024 bytes short of the layout the brief
also specifies. The fixture declares 3 pages; the deviation is recorded
in the fixture's own comment.)

**What the tests pin** (`tests/solver_p4.rs`, T1–T7). The fixture's
three exports are present and callable; the trampoline without a context
returns −EINVAL, and set-then-clear restores that; one euler step
through shim + wasm matches y₀·(1 − dt) within 1e−12; one rk45 step of
dt = 1.0 through wasm matches the analytic e^(−1) within 1e−5, and
matches the same solve with a plain Rust RHS within 1e−12 — in fact
bit-identically (`0.3678794419310959` both ways, 79 trampoline calls),
because the underlying arithmetic is the same and the copy through wasm
memory moves the same bits; two wasm runs are bit-identical with equal
eval counts; two interleaved solvers match their isolated runs; and
P2's rule that `source: "wasm"` rejects a NULL/NULL bind is unchanged.

**Not delivered in phase 4:** zero-copy (the copy-in / copy-out pattern
above is deliberate — the mechanism, not the optimization); a general
allocator export (fixed 64 KiB buffers; P5 can generalize); the safe
Rust wrapper (P5); the YAML world compiler (P8). No change was made to
`tension_solver.c`, `tension_solver_erk.f90`, `tension_solver.h` or
schema.yaml — the bridge needed none.

---

## 9. The guest surface (phase 5)

Phase 5 connects the two halves: the guest contract (`GUEST_ABI.md`, the
third artifact of record), its guest-side implementation
(`tension-framework/assembly/solver.ts`), its host-side implementation
(`tension-core/src/solver/mod.rs`), and the example that exercises the whole
chain (`examples/solver/`). The Fortran core, the C shim, the header and the
schema are unchanged from §6–§7; phase 5 is a pure adapter layer above them.

**The five-name surface.** The C ABI declares six entry points; the guest
imports five: `solver_create`, `solver_step`, `solver_state`,
`solver_set_state`, `solver_destroy`. `tension_solver_bind_callbacks` is not
a guest import — a wasm module's import table is fixed at instantiation, and
a function the guest never calls must not be a row in it. For
`source: "wasm"` the host performs the bind itself at create; the guest's
part of the contract is its three callbacks (`_derivative`, `deriv_buf_in`,
`deriv_buf_out`), which it passes to `create` and the host resolves and
calls.

**The host-side reentrancy.** At `solver_create` the host import reads the
config, calls the shim, and — when the config declares `source: "wasm"` —
resolves the three callbacks the guest passed, table indices into the
module's exported `table` (validating their signatures),
stores them in a per-store map keyed by the shim's solver id, and calls
`tension_solver_bind_callbacks` with the trampoline. The trampoline cannot
carry a context argument (the callback typedef has no user-data slot; that
purity decision is §6's), so `solver_step` installs a thread-local bridge
around the synchronous shim call — the caller and the bound callbacks for the
id being stepped — and the trampoline, running inside that window, performs
P4's copy-in / call / copy-out dance (§8) against the guest's linear memory.
Nested installs save and restore: a derivative that steps another solver
nests correctly. The bridge is the solver stack's one soundness-relevant
`unsafe` block — the `Caller` is lifetime-erased to a raw pointer for the
duration of the step, and the discipline that keeps it valid (installed and
cleared inside one synchronous call, on one thread) is carried by the
comment and the tests, not by a type.

**The callbacks are per solver.** The guest ABI's create signature takes
the guest's three callbacks as arguments (a `SolverCallbacks` object in the
TS surface, three function-table indices at the ABI), which the host
resolves from the module's exported `table` — the reason the guest build
carries `asc --exportTable`. The earlier shape resolved `_derivative`,
`deriv_buf_in`, `deriv_buf_out` by fixed symbol name at create time; that
permitted only one derivative per guest module, since the derivative
typedef carries no user-data argument. Passing the functions as arguments
makes the callbacks per-solver and preserves the purity the ABI's design
rests on.

**The source probe.** The five-import shape means the host must know whether
a create is `source: "wasm"` before deciding to resolve the callbacks'
indices. The
frozen C surface exposes no source query, so the host import probes the
shim-validated config bytes for the top-level `"source"` member — a cursor
over the documented subset (short escapes, one nested `parameters` object),
not a second validator. Unknown shapes answer "not wasm", which skips the
binding and surfaces as the shim's own `-EINVAL` on the first step. The
probe is unit-tested against the cases that matter, including a decoy
`"source":"wasm"` inside a free-text `description` member.

**Known limitation (recorded, not hidden): one guest per process.** The C
shim's 64-slot solver table is process-global and carries no internal
locking; it is built for the runtime's one-guest, one-thread model. Multiple
guests in one tension-core process would share that table — and the
host-side binding records are per store, so they would not follow — and any
guest can destroy any handle by guessing its id. Not fixed in phase 5; when
isolation matters, the table and the binding map must move behind an owner
keyed by store identity. The host-side bound map (shim id -> guest exports)
is cleared on destroy and on the refused-create path; ids are reused by the
shim after destroy, and a stale entry would misbind a new solver to a
destroyed guest. (The tests hit the unlocked table first: parallel
test threads race on slot allocation, so the P5 tests serialize on a mutex.
The runtime itself is single-threaded per guest, which is why this is a
harness concern now and a limitation only when guests multiply.)

**What phase 5 does not deliver:** the YAML world compiler (`source:
"world"` remains `-ENOSYS`, P8); verlet, implicit_euler and spook (P6);
async stepping or cancellation; guest-visible diagnostics beyond errno; and
the plugin lifecycle through the vtable (only `step` is dispatched).

**Observations from the phase tests** (`tension-core/src/solver/p5_tests.rs`,
H1–H5 and N1–N2, plus `examples/solver/`). A hand-written WAT guest that
imports the five names and passes its three callbacks' table indices
creates, steps (euler, one step of 0.1 on y′ = −y from y₀ = 2.0 → y = 1.8,
bit-exact), steps (rk45, one step of 1.0 from y₀ = 1.0 →
0.3678794419328082, 7.6e−10 from e⁻¹), is bit-identical across two runs,
and is refused with `-EINVAL` when an index does not name a function of the
declared signature; N1 (one module, two solvers, two derivatives) and N2 (a
wrong-signature index) are the correction's evidence, and the example's
numbers are unchanged after it. The AssemblyScript example — ten 0.1-steps
to t = 1.0 at relTol 1e−8 — lands 1.2e−9 from e⁻¹, the accumulation over
the loop, with t at 0.9999999999999999 for the same reason.

---

## 10. The symplectic and implicit families (phase 6)

Phase 6 adds verlet and implicit_euler, each as its own family module per
§3: `tension_solver_symplectic.f90` and `tension_solver_implicit.f90`.
The rule applies as it did for the ERK module — whatever a family's
members share lives once in that family's file — and the two new modules
import the params struct from the ERK module rather than copying it (the
ABI's schema block must have exactly one Fortran declaration; the C
mirror in solver_params.h carries the size assertion). The RHS interface
is redeclared privately in each new module: an interface carries no
layout, so the duplication is structural, not a second source of truth.
`build.sh` compiles the two files after the ERK module (their `use`
needs its `.mod`) and archives all three objects together; the shim's
dispatch learned the two workspace sizes and the two step symbols.

**Verlet's conventions, which the guest agrees to by supplying an RHS.**
The state vector is `[q, v]`: the first `dim/2` slots are positions, the
last `dim/2` are velocities; `dim` must be even (odd dim is `-EINVAL`
from the step; `workspace_size` returns 0 for `dim < 2`). The derivative
returns `[q', v'] = [v, a]` — the standard first-order-isation of a
second-order mechanical system `q'' = a` — and that agreement holds for
the whole symplectic family, not just this member. One step is velocity
Verlet of size `dt` (the call's argument), two RHS evaluations, `status
= 2`; the middle evaluation uses the updated positions and the old
velocities, which is what preserves the symplectic property. Verlet is
fixed-step: `fixedStep` is read as its declared parameter but does not
retime the step (the ABI's step carries the advance), and the tolerance
parameters are ignored without complaint. Failure semantics are stated
rather than implied: a first-evaluation failure leaves the state
untouched; a second-evaluation failure leaves the positions advanced
and the velocities old — a partial step, not rolled back, because 2·dim
of workspace holds the stage state and not a pristine copy of the old
state. Both behaviors are pinned by tests.

**Implicit Euler by fixed-point iteration.** Solve
`y_{n+1} = y_n + h·f(t_{n+1}, y_{n+1})` with the explicit-Euler first
guess, then `y_new = y_n + h·f(t+h, y_iter)` until
`||y_new − y_iter||_inf < convergenceTol`; `iterations` caps the tries.
Not converged → `-EIO`, state untouched; `status` counts the RHS
evaluations (one for the guess plus one per iteration) on success and 0
on failure. The convergence window is `h·L < 1` (L = the local
Lipschitz constant), and — recorded because it is a boundary of this
ABI, not a bug — that window lies *inside* explicit Euler's stability
region (`h·L ≤ 2`). This implementation therefore cannot demonstrate
implicit Euler's A-stability where explicit Euler would fail; at
`h·L = 10` it reports `-EIO` rather than diverging silently, which is
the honest failure the contract asked for. True stiff robustness needs a
Newton solve, and a Jacobian does not cross the derivative-only ABI. The
phase brief's test for stability beyond explicit Euler's bound is
therefore split into the two truths: `-EIO` outside the window,
monotone decay to the correct asymptote inside it.

The fixed-point implementation of implicit Euler is not A-stable.
Fixed-point iteration requires `h·L < 1` to converge, which is tighter
than explicit Euler's stability bound `h·L ≤ 2` on the same problems.
This means the current implementation is slower than explicit Euler on
the same step sizes and offers no stiffness advantage in v1. A truly
stiff-capable implicit Euler needs a Newton solve, which needs a
Jacobian — a channel the frozen ABI does not carry. The method exists in
v1 as the demonstration of the implicit family's shape and as the
target for a Newton-capable variant when (and if) a Jacobian channel is
added.

**Spook is deferred, with its reason.** SPOOK is constraint-based
position-based dynamics: constraints (distance, angle, joint, contact)
are what the method integrates, and the frozen ABI has a derivative
channel and nothing else — no place for a guest to describe a
constraint. A "spook" that ignores constraints would be a different
method wearing SPOOK's name, which is worse than not shipping it. The
natural home is after the world compiler (P8), or a phase that adds a
constraint-definition channel to the guest ABI; either is a design
decision, not a phase-planning one, and neither belongs to P6.
`create({method: "spook", ...})` returns `-ENOSYS`, unchanged from P3,
and the shim's registry entry carries the reason.

**What phase 6 does not deliver:** spook; the YAML world compiler (P8);
async stepping or cancellation; constraint channels; any change to the
header or the schema.

**Observations from the phase tests** (`tests/solver_p6_verlet.rs`,
`tests/solver_p6_implicit.rs`, `tests/solver_p6_shim.rs`). Verlet order
on the harmonic oscillator, measured at t = π/2: e(64) = 3.94e−5,
e(128) = 9.86e−6, observed order 2.00. (Measured at t = 2π the same
test reads 4.00 — the cosine's extremum hides the O(h²) phase error to
first order; a coincidence of the endpoint, not the method's order, and
the test says so where it stands.) Energy over 100 periods at dt = 0.01:
E₀ = 0.5, E_end = 0.49999999979, deviations in [−2.5e−5, −1.1e−15] — a
bounded band, no drift, which is the symplectic property the method is
for. Implicit Euler order on y′ = −y over [0, 1]: e(64) = 2.86e−3,
e(128) = 1.43e−3, observed 0.995. Evaluation counts: tolerance 1e−6 →
7 evals, 1e−9 → 9 evals; `iterations = 2` at tol 1e−12 → `-EIO` with 0
reported, `iterations = 32` → 12 evals. At `h·L = 0.5` the decay over
200 steps reaches 7.1e−28, monotone, first-step cost 27 evals. Two
forward guards from earlier phases were updated to match the delivery:
P2's T20 probe now uses dim 2 (verlet's `dim >= 2` floor) and P3's T12
narrows to spook, asserting the two delivered methods create handles.

---

## 11. The plugin SDK (phase 7)

Phase 7 opens the backend vtable into a real contract. The vtable has
existed since fd8e4bd (name, kind, deterministic, derivative, validate,
and the four lifecycle slots); until now the shim dispatched only `step`
(§6 predicted the rest for P5 — they land here instead). From this phase
all four slots are dispatched, five accessors let a plugin's `step`
reach what it needs, and the header's `rk45_native` pattern is
implementable — and implemented — literally.

**What a plugin author reads and writes.** Read: the header's
register_backend comment block (the pairing table), the vtable
declaration, and the accessor section. Write: a
`tension_solver_backend_vtable` with `name`, `kind`, `deterministic`,
`step` (required), and whichever of `derivative`, `validate`, `state`,
`set_state`, `destroy` the backend needs — plus an init function that
calls `tension_solver_register_backend`. Registration enforces what P2
pinned: a name shadowing a built-in, a `kind` outside the reserved set,
a `deterministic` that contradicts `kind`, or a missing `step` is
`-EINVAL`. The vtable is stored by pointer — it must outlive the
process.

**The lifecycle, as the shim now dispatches it.** create names the
plugin and the handle record points at it (the record's `plugin` field
already existed; no new field was needed). `source: native` requires the
plugin's `derivative` slot — the plugin bundles its f. step calls
`vt->step(id, dt)`; on 0 the shim advances its `t` by `dt` (the
built-ins' convention, unchanged), on nonzero it does not advance and
the value propagates. state / set_state keep the public entry points'
argument contracts and then dispatch to `vt->state` / `vt->set_state`
when those slots are non-NULL; a successful plugin set_state also
updates the shim's `t` mirror, so `get_time` stays coherent with "the
next step advances from t". destroy calls `vt->destroy` first (when
non-NULL) and then releases the handle's own storage. The lifecycle
slots are **optional overrides**, not requirements: a plugin that
leaves any of them NULL gets the shim's default handling — state and
set_state copy from and into the shim's own y and t, destroy is a no-op
the shim then frees.

**The accessors.** Five, all answering for any live id — built-in or
plugin — and reporting a bad id as `-EBADF` (or NULL): `get_dim` (the
state length), `get_time` (the shim's t), `get_derivative` (the pointer
bind_callbacks installed; NULL when none — the one documented
ambiguity), `get_state_ptr` (the shim's y vector), and `get_params`
(the shim's parameter struct — opaque to the plugin, which may only
pass it back into a built-in step's `params` argument). A plugin that
implements its own integrator and its own f needs none of them; a
plugin wrapping a built-in needs all five.

**The state model (the fork, resolved).** The shim owns one y vector
per handle — built-in or plugin — and `get_state_ptr` hands it to a
plugin's step, which mutates it in place exactly as the built-in steps
do; the vtable's `state`/`set_state` slots are for plugins that present
a copy in their own format, and NULL means the shim's default handling.
This is what makes the header's `rk45_native` pattern literal: a
wrapping plugin fetches the state pointer, the derivative, the dim, the
time and the params pointer, allocates its own workspace (the shim's
workspace stays built-in plumbing — there is deliberately no accessor
for it), and calls the built-in step with the same shape the shim would
have used. The phase brief's fork between a fourth accessor and
plugin-owned state resolved to the accessor; the alternative would have
forced every `source: wasm` wrapper to reimplement the integration
loop.

**The sample plugin** (`examples/plugins/midpoint/`): RK2's midpoint
method — not a built-in — in a hundred lines of C against the public
header (`midpoint.c`), a Makefile building `build/midpoint.so` with its
`tension_solver_*` references left for the host, and a README that is
the walkthrough contract for backend authors. It leaves
state/set_state/destroy NULL (the shim defaults) and demonstrates the
fetch-then-integrate shape; its init is once-per-process (a claimed
name may not be re-registered — `-EINVAL`, pinned by the header's
rules). The shim has no load-from-disk, so the P7 tests compile that
same source into the test link (`tension-core/build.rs`) and call its
init: P1 exercises midpoint end to end, P4 and P5 wrap the built-in
euler and rk45 through plugins and prove the results bit-identical to
the direct paths — the header's `rk45_native` example, finally
implemented — P6 pins the NULL-slot defaults, and P7 the
no-advance-on-failure rule.

**What phase 7 does not deliver:** loading a plugin `.so` from disk (a
host application loads its plugins and calls register_backend — the
shim only accepts the call; the in-tree tests link the sample instead);
plugin ABI versioning (the vtable's layout is fixed by this header
version; a version field arrives with the first breaking change, if one
is ever justified); introspection beyond the vtable's name; per-plugin
isolation — a registered plugin runs in the host's address space, which
is what "native backend" means.
