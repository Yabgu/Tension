# Tension solver — guest ABI

Status: **phase 5 in progress — see this document.**
Siblings: **tension-solver/schema.yaml** (configuration vocabulary) and
**tension-solver/include/tension_solver.h** (the C ABI). Where the header
is the surface the engine links against and the schema is what a config
may say, this document is the contract between the engine and a guest
that wants numerical integration: the wasm import module, its host
functions, the guest-side class, and the error and threading conventions
a game can rely on. The bindings that implement it
(`tension-framework/assembly/solver.ts`) follow this document; this
document follows the header and the schema.

Tension project — MIT. See LICENSE at repo root.

---

## 1. What this document is, and what it is not

This is the contract between the engine and a guest that wants
numerical integration. It declares the wasm import module and its host
function names, every signature, the `Solver` class shape, and the
error conventions — the things a game author and the engine runtime
must agree on for the solver to be reachable from AssemblyScript.

It does not declare how the solver computes: the Butcher tables, the
adaptive controller, the workspace discipline, and where determinism
comes from are `tension-solver/DESIGN.md`. It does not declare what
configuration keys exist: the vocabulary is
`tension-solver/schema.yaml`'s, and this document only says how a
config string crosses the boundary. Where this document and either
artifact touch the same fact, the header and the schema are
authoritative and this document reproduces them for the guest reader.

## 2. Import module and host function names

The wasm import module is `tension::solver`, the sibling of
`tension::res` and `tension::io`. The module's host functions are named
`solver_*`; the five below are every import the guest makes from
`tension::solver`. The declarations are the shape the guest bindings
use — the same shape `tension-framework/assembly/res.ts` uses for
`tension::res`:

```
@external("tension::solver", "solver_create")
declare function hostSolverCreate(
  configPtr: usize,
  configLen: i32,
  derivativeIdx: i32,
  bufInIdx: i32,
  bufOutIdx: i32
): i32;

@external("tension::solver", "solver_step")
declare function hostSolverStep(id: i32, dt: f64): i32;

@external("tension::solver", "solver_state")
declare function hostSolverState(id: i32, tPtr: usize, yPtr: usize, yCap: i32): i32;

@external("tension::solver", "solver_set_state")
declare function hostSolverSetState(id: i32, t: f64, yPtr: usize, yLen: i32): i32;

@external("tension::solver", "solver_destroy")
declare function hostSolverDestroy(id: i32): void;
```

The C ABI (`tension_solver.h`) declares six entry points. The guest
ABI declares five. The sixth, `tension_solver_bind_callbacks`, is not
a guest import: for `source: "wasm"` the host takes the three callbacks
the guest passes to `create`, resolves them, and performs the binding
at the C level itself. The guest declares nothing and calls nothing
for it. The `@external` block above is the complete list of what the
guest imports from `tension::solver`.

Conventions, matching res.ts: pointers cross as `usize` (the guest's
linear-memory address), lengths are `i32` byte or slot counts, ids are
`i32` (1-based; 0 is never valid), time and `dt` are `f64`, and every
failure is a negative errno (§5). Nothing throws.

## 3. Host function signatures

One subsection per guest import (§3.1–§3.5), then the host-performed
bind and the three callbacks the guest passes. The wasm-level type is
written the way schema.yaml writes callback signatures; `ptr` and
`usize` both mean a 32-bit guest address at this boundary.

### 3.1 `solver_create` — `i32(ptr u8 config_json, i32 config_len, i32 derivative_idx, i32 buf_in_idx, i32 buf_out_idx)`

Creates a solver from a UTF-8 JSON config: the bytes at `configPtr`,
exactly `configLen` of them, no NUL terminator read (the `hostResOpen`
path convention). The config's vocabulary is exactly what schema.yaml
declares — `method` and `source` required, `dim` required for
`source: "wasm"` and `source: "native"`, `parameters:` drawn from the
nine global parameters — and this document does not restate the keys,
their defaults, or their ranges.

For `source: "wasm"`, the last three arguments are the callbacks the
solver will use, in order: the derivative, `buf_in`, and `buf_out`.
Each is an index into the module's function table, and the module must
export that table as `table` — AssemblyScript produces the export with
`asc --exportTable`. The host resolves the three indices at create and
stores them per solver id; every one must name a function of the
declared signature (§3.6), or create refuses with `-EINVAL`. Two
solvers created with different derivatives therefore behave
independently. For any other source the three indices are ignored.

Returns a handle ≥ 1, or a negative errno. The mapping is the header's:
`-EINVAL` for a malformed config or an unmet source requirement,
`-ENOENT` for an unknown `method`, `-ENOSYS` for a method or source not
available in this build (`source: "world"` in this phase; §7),
`-ENOMEM` on allocation failure, `-EMFILE` when the solver-id table is
full. Handles are 1-based; 0 is never valid.

### 3.2 `solver_step` — `i32(i32 id, f64 dt)`

Advance the solver by `dt`. Returns 0 on success, a negative errno on
failure. Adaptive methods may take internal sub-steps smaller than
`dt`; there is no budget parameter and no sub-step cap — the engine
runs to completion, and real-time constraints are guest policy.

Errors the guest can see here: `-EBADF` for a destroyed or
never-allocated id; `-EINVAL` for a `source: "wasm"` id whose callbacks
are not bound — the call order is create → bind → step, and the host
performs the bind itself (the note following §3.5); `-EIO` when a
callback returns a fatal
error or an adaptive method cannot meet its tolerances within
`minStep` (DESIGN.md §7).

### 3.3 `solver_state` — `i32(i32 id, ptr f64 t_out, ptr f64 y_out, i32 y_cap)`

Copy the current time and state vector out. Writes `t` to `tPtr` (one
`f64` slot) and up to `yCap` `f64` slots to `yPtr`. Returns the number
of state slots written (`dim`), or a negative errno — `-EINVAL` when
`yCap < dim` (a partial state is never returned), `-EBADF` for an
unknown id.

This is a copy out, not a view: the solver owns the state vector. A
checkpoint is `{t, y}`; both must be saved and both restored (§3.4), or
the solver's clock diverges from the guest's. The class presents the
two out-parameters as one buffer with `t` in slot 0 (§4) — the shapes
are coherent: `dim + 1` slots, time first.

### 3.4 `solver_set_state` — `i32(i32 id, f64 t, ptr const f64 y, i32 y_len)`

Restore time `t` and the state vector from `yPtr`, `yLen` `f64` slots;
`yLen` must equal `dim`, and anything else is `-EINVAL`. Returns 0 or a
negative errno. This is the rollback and checkpoint-restore path, not
part of the hot path; after this call the next `step` advances from
`t`, not from wherever the solver had reached.

### 3.5 `solver_destroy` — `void(i32 id)`

Destroy a solver id. Idempotent for in-range ids: destroying twice is
not an error, and a destroyed, never-allocated, or out-of-range id is
ignored. There is no return value and no failure mode — the shape
`res_close` uses. In the class, `destroy` sets the id to 0, which is
what turns `isOpen` false (§4).

**A note on `tension_solver_bind_callbacks`.** The C ABI's sixth
entry point is not a guest import. For `source: "wasm"` the host
resolves the three callbacks the guest passed to `create` and performs
the binding at the C level; the guest declares nothing and calls
nothing for it, and nothing in the guest module's import table
corresponds to it. It is host-level only — the subject of this note,
not of a subsection.

### 3.6 The three callbacks the guest passes to `create` (`_derivative`, `deriv_buf_in`, `deriv_buf_out`)

What the guest must provide is three callbacks from the module that
calls `create` — the convention phase 4 proved (DESIGN.md §8):

- `_derivative(y_ptr, len, t, dy_ptr, dy_cap) -> i32` — f(t, y). The
  guest's function, wasm-level
  `i32(i32 y_ptr, i32 len, f64 t, i32 dy_ptr, i32 dy_cap)`, matching
  schema.yaml's `callbacks._derivative` signature exactly. Reads `len`
  `f64` from `y_ptr`, writes `len` `f64` to `dy_ptr`, returns 0 on
  success or a negative errno. The host calls it with
  `len == dy_cap == dim`.
- `deriv_buf_in() -> i32` — returns the wasm address of the input
  buffer.
- `deriv_buf_out() -> i32` — returns the wasm address of the output
  buffer.

The three functions' table indices are what `create` takes (§3.1). The
module must export its function table as `table` — AssemblyScript
produces that export with `asc --exportTable` — because the host
resolves the indices through it; a module without the export cannot
create a `source: "wasm"` solver. Exporting the three functions by
name is not required (the example still does it; nothing reads the
names).

A note for guests that call the import directly instead of through the
framework: AssemblyScript function references are not table indices. A
function value points at the function's table-index word — that is the
word AssemblyScript's own `call_indirect` sites load through — so the
index is the i32 that pointer addresses, and the framework's
`Solver.create` converts with exactly that dereference. A hand-rolled
guest must convert the same way, or hand `create` something that does
not name its callback.

The two buffers are regions of the guest's own linear memory, not
allocated by any function: guest and host agree by convention that two
non-overlapping regions of at least 64 KiB (8192 `f64` slots) each
exist and stay alive for the solver's lifetime. The addresses are the
guest's to choose; the host asks for them by calling the two functions.
Phase 4's fixture used 1024 and 66560; any pair of addresses satisfying
the convention is valid. The host copies the current state into
`deriv_buf_in`, calls `_derivative` with the two wasm addresses, and
copies the result back from `deriv_buf_out` — so the guest's
`_derivative` reads and writes pointers into its own memory and never
sees a host address. That copy is deliberate: the mechanism, not an
optimization (DESIGN.md §8).

Two requirements the guest owns. `_derivative` must be a pure function
of `(y, t)` — no RNG, no clocks, no hidden state — or
bit-reproducibility is forfeited (tension_solver.h's derivative
comment). And `dim` is bounded by the fixed buffer size in this phase,
`dim ≤ 8192` `f64` slots, until an allocator export generalizes it
(§7).

## 4. The `Solver` class

The guest-side shape, in the res.ts register — declaration only; bodies
are the implementation's, not this document's:

```
/**
 * The guest's three callbacks for a `source: "wasm"` solver: the
 * derivative and the two functions returning the buffer addresses.
 * For any other source they are ignored (§3.1).
 */
export class SolverCallbacks {
  derivative: (yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32) => i32;
  bufIn: () => i32;
  bufOut: () => i32;
}

/**
 * A handle to one solver id. Errors are null / -1; nothing throws.
 * Destroy it when done — like ResFile.close, destroy is idempotent.
 */
export class Solver {
  /** The solver handle; 0 means destroyed (0 is never a valid id). */
  private id: i32;

  /**
   * Create a solver from a JSON config (schema.yaml's vocabulary) and
   * the three callbacks a `source: "wasm"` solver uses. Returns null on
   * any failure: malformed config, unknown method, unmet source
   * requirement, unavailable method or source, a callback index that
   * does not name a function of the declared signature, or a full id
   * table (§5).
   */
  static create(configJson: string, callbacks: SolverCallbacks): Solver | null

  /**
   * Advance by `dt`. Returns 0 on success, -1 on failure. Synchronous;
   * adaptive methods take internal sub-steps as needed — no budget, no
   * cap, real-time policy is the game's.
   */
  step(dt: f64): i32

  /**
   * Copy `{t, y}` out. Slot 0 is the time `t`; slots 1..dim are the
   * state vector. `out` must hold at least dim + 1 slots. Returns the
   * number of slots written (dim + 1), or -1.
   */
  state(out: Float64Array): i32

  /**
   * Restore `{t, y}` — the pair that makes a checkpoint complete. `y`
   * must hold exactly dim slots. Returns 0, or -1.
   */
  setState(t: f64, y: Float64Array): i32

  /** Destroy the solver. Idempotent: safe to call twice. */
  destroy(): void

  /** Whether this handle is still open. False after destroy. */
  isOpen(): bool
}
```

The class holds one field, the id. It caches no `dim`, keeps no state
copies, and carries no error text — every method is a thin crossing of
one import call, translated per §5. A checkpoint is the `state` buffer
itself: `setState(buf[0], buf.slice(1))` restores exactly what
`state(buf)` saved.

## 5. Error convention

Every failure crosses the wasm boundary as a negative errno. The class
translates them: `create` → `null`; `step` / `state` / `setState` →
`-1`; `isOpen` → `false`; `destroy` → nothing (it is `void`). Nothing
throws, and no message text crosses the boundary — the C surface
carries no diagnostics channel.

The errno set, reproduced from tension_solver.h (authoritative; this
list is for the guest reader):

- `-2 ENOENT` — unknown `method` in the config (method lookup failure
  at create).
- `-5 EIO` — callback returned a fatal error; integrator internal
  failure (e.g. `minStep` exhaustion, DESIGN.md §7).
- `-9 EBADF` — destroyed or never-allocated solver id.
- `-12 ENOMEM` — allocation failure (create only).
- `-22 EINVAL` — malformed config, unmet source requirement, bad
  argument; `step` on a `source: "wasm"` solver before its callbacks
  are bound.
- `-24 EMFILE` — solver-id table full (create only).
- `-38 ENOSYS` — method or source named in the config but not available
  in this build (`source: "world"`; verlet / implicit_euler / spook —
  §7).

## 6. Threading and interleaving

`step` is synchronous: it returns when the requested advance is
complete, having called `_derivative` as many times as the method
requires. Phase 5 introduces no async, no cancellation, and no stepping
on a background thread.

What the guest can rely on, established in phase 4 and covered by its
tests (DESIGN.md §8): multiple solvers on the same thread step one at a
time and do not interfere. The host-to-guest callback path runs through
a per-thread context that is installed around each synchronous step and
cleared after it; two interleaved solvers — different sizes, different
step sequences — produce bit-identical results to isolated runs (phase
4, T6).

What the guest must not assume: cross-thread safety. No promise is made
that one solver id can be stepped from two threads concurrently, and no
promise is made that handles are shared between threads. If a game
wants parallel solvers, each thread has its own context; nothing
beyond that is implied.

## 7. What is not delivered in phase 5

- **No YAML world compiler (P8).** `source: "world"` returns `-ENOSYS`
  from create; nothing derives `dim` or f from a scene description yet.
- **No verlet, implicit_euler, spook (P6).** Those `method` names
  return `-ENOSYS` from create. The explicit-RK family (euler, heun,
  rk23, rk45) is the whole delivered set.
- **No plugin lifecycle through the vtable.** A registered native
  backend's `state` / `set_state` / `destroy` slots are not dispatched
  by the runtime yet; only `step` is.
- **No async stepping, no cancellation, no step budgets.** `step` runs
  to completion (§3.2, §6).
- **No solver output beyond the current state.** The guest gets
  `{t, y}` via `state` and nothing else; the eval-count `status`
  out-parameter exists on the internal Fortran symbols and is not part
  of the guest boundary.
- **No arbitrary-dimension buffers.** `source: "wasm"` uses the fixed
  64 KiB export convention (§3.6): `dim ≤ 8192` `f64` slots in this
  phase; a general allocator export is not delivered.
- **No diagnostics channel.** Errors are errno only (§5) — no message
  text, no log, no error buffer at this boundary.

## 8. Example: what a game writes

Pseudo-AssemblyScript for the guest-side loop — a sketch of the
sequence, not compilable as shown:

```
// `_derivative`, `deriv_buf_in`, `deriv_buf_out` are this module's; the
// callback object rides with create and the host resolves it — nothing
// to call by hand.
const s = Solver.create(
  '{"method":"rk45","source":"wasm","dim":2,"parameters":{"relTol":1e-8,"absTol":1e-10}}',
  { derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out }
);
if (s == null) return;                // config rejected: null, never a throw
const buf = new Float64Array(3);      // [t, y0, y1] — slot 0 is the time
while (s.isOpen()) {
  if (s.step(1.0 / 60.0) != 0) break; // 0 on success; adaptive sub-steps are internal
  const n = s.state(buf);             // n == dim + 1 == 3, buf[0] = t
  if (n < 0) break;
  // ... integrate game logic from buf[1], buf[2] ...
}
s.destroy();                          // idempotent — safe to call twice
```
