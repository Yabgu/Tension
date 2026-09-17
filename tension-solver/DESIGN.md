# Tension solver — design note

Status: **phase 1 in progress — see §5.**
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
