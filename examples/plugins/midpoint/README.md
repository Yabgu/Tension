# Writing a Tension plugin

This directory is the sample backend: `midpoint.c` registers RK2's
midpoint method — a second-order method *not* among the built-ins — as
a plugin, in about a hundred lines of C. Read this file top to bottom
and you have read the contract; the contract itself lives in the
public header.

## Where the contract lives

- `tension-solver/include/tension_solver.h` — the `register_backend`
  comment block (what a plugin must supply, the pairing table, the
  determinism rules), the vtable declaration, and the **plugin
  accessors** section. This is the whole contract; this README teaches
  it, the header is authoritative.
- `tension-solver/DESIGN.md` §11 — the lifecycle as the shim dispatches
  it (what happens at register / create / step / state / set_state /
  destroy), and what is deliberately not delivered yet.

## Build

```
cd examples/plugins/midpoint
make            # → build/midpoint.so
```

The `.so` deliberately leaves its `tension_solver_*` references
undefined: the host process provides them at load time (that is what
"a plugin" means here — the same reason the Makefile does not pass
`-Wl,-z,defs`). The in-tree P7 tests compile this **same file** into
the test binary from `tension-core/build.rs`, so the source you are
reading is the source the test suite exercises.

## The walkthrough

**1. Include the header.** `#include "tension_solver.h"`. A plugin is
an ordinary C program against the public ABI; nothing else is needed.

**2. Define the vtable.**

```c
static const tension_solver_backend_vtable MIDPOINT_VTABLE = {
    "midpoint",     /* name: what configs put in method: */
    "explicit_rk",  /* kind: a well-defined RK2 method (deterministic 1) */
    1u,             /* deterministic: yes */
    NULL,           /* derivative: NULL — f comes from the config's source */
    NULL,           /* validate: classical backends accept every step */
    midpoint_step,  /* step: required */
    NULL,           /* state: shim default (the shim's own y) */
    NULL,           /* set_state: shim default */
    NULL,           /* destroy: nothing of ours to release */
};
```

Two slots are load-bearing: `step` is **required** (registration
refuses a vtable without one), and `kind`/`deterministic` must agree
per the header's table (`explicit_rk` requires `1`; `stochastic`
requires `0`; `custom` accepts either).

**3. Register from an init function.**

```c
int32_t tension_plugin_register_midpoint(void)
{
    return tension_solver_register_backend(MIDPOINT_VTABLE.name,
                                           &MIDPOINT_VTABLE);
}
```

A host application calls this once before a config can say
`method: "midpoint"`. The vtable is stored **by pointer** — it must
outlive the process, which is why this one is `static const`.
Registration returns 0, or `-EINVAL` for a name that shadows a
built-in, a name already claimed (a second registration of the same
plugin is an error — the init is a once-per-process call), a
`kind`/`deterministic` mismatch, or a missing `step`.

**4. Write the step.**

```c
static int32_t midpoint_step(int32_t id, double dt)
```

That signature is the whole interface. Everything else is fetched
through the accessors:

- `tension_solver_get_dim(id)` — the state vector's length.
- `tension_solver_get_time(id)` — the solver's current `t`.
- `tension_solver_get_state_ptr(id)` — the shim-owned `y` vector.
  Mutate it in place; that is the shared state.
- `tension_solver_get_derivative(id)` — the function pointer the wasm
  source bound (`bind_callbacks`), or NULL if none is bound yet.
- `tension_solver_get_params(id)` — the shim's parameter struct,
  **opaque**: never dereference it; pass it straight back into a
  built-in step's `params` argument if you wrap one.

The body then is just the method: `k1 = f(t, y)` into a local buffer,
`stage = y + (dt/2)·k1`, `k2 = f(t + dt/2, stage)`, `y += dt·k2` — with
the two scratch buffers `malloc`ed per call (a plugin that wants to
avoid that can cache them keyed by `id`; the sample prefers clarity).

**5. Return the truth.** `0` on success. On failure return a negative
errno (`-22` for a bad id or unbound derivative, `-12` for allocation
failure, the RHS's own value if it fails). On a nonzero return the shim
does **not** advance its clock: `t` is only advanced by `dt` when the
step reports success.

## What a plugin may and may not assume

- **The shim owns the state.** `get_state_ptr` hands you its `y`; the
  default `state`/`set_state` handling reads and writes that same
  vector. `state`/`set_state`/`destroy` in the vtable are *optional
  overrides* for a plugin that keeps its own format — NULL means the
  shim's default applies (destroy NULL is a no-op the shim then frees).
- **The params pointer is opaque.** Passing it to a built-in step is
  the entire permitted use.
- **Be panic-free.** C has no panics, but the rule generalizes: never
  `abort`, never `exit`; every failure is a negative return. A plugin
  that kills the process takes the game with it.
- **One thread at a time.** A step runs on the guest's thread,
  synchronously; the shim is not a synchronization point.
- **`dim` is fixed at create** and never changes for an `id`.
- **The derivative may be NULL** at step time if the config was
  `source: wasm` and `bind_callbacks` has not happened; return `-22`.

## The wrapping pattern

A plugin can also *wrap a built-in integrator* — the header's
`rk45_native` example. Its step fetches `get_state_ptr`, `get_dim`,
`get_time`, `get_derivative` and `get_params`, allocates its own
workspace (the size its chosen method needs — the shim's workspace is
built-in plumbing and is not exposed), and calls the built-in step
directly. The P7 test suite proves this bit-for-bit for `euler` and
`rk45` (`tension-core/tests/solver_p7.rs`, P4/P5).

## What is still missing

- **Load-from-disk.** Tension-core does not `dlopen` anything; a host
  application links or loads its plugins itself and calls the init
  function. `register_backend` is the only door.
- **ABI versioning.** The vtable's layout is fixed by this header
  version; a plugin compiled against a different layout is undefined
  behavior. A version field arrives with the first breaking change, if
  one is ever justified.
- **Introspection beyond the name.** The engine can report a plugin's
  name and kind; it cannot answer what methods it supports, because
  one plugin is one method.
