# Tension solver — design note

Status: **phase 3 complete — see §7.**
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
