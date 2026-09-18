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

One convention carries a format rather than a string: `solver_create`'s
first two arguments are the *config wire* — the binary layout of
`solver/DESIGN.md §12` (a 64-byte header, a parameters block, a string
table), not text. The framework's `SolverConfig` encodes it
(`tension-framework/assembly/solver.ts`), the host decodes and validates
it strictly, and the shim behind the host reads a resolved struct. The
sections below say "the config" and mean that layout.

## 3. Host function signatures

One subsection per guest import (§3.1–§3.5), then the host-performed
bind and the three callbacks the guest passes. The wasm-level type is
written the way schema.yaml writes callback signatures; `ptr` and
`usize` both mean a 32-bit guest address at this boundary.

### 3.1 `solver_create` — `i32(ptr u8 configPtr, i32 configLen, i32 derivativeIdx, i32 bufInIdx, i32 bufOutIdx)`

Creates a solver from the config wire: the bytes at `configPtr`,
exactly `configLen` of them, the binary layout of `solver/DESIGN.md §12` (the
same `(ptr, len)` convention as `hostResOpen`, but the bytes are not
text). The config's vocabulary is exactly what schema.yaml declares —
`method` and `source` required, `dim` required for `source: "wasm"` and
`source: "native"`, the nine global parameters optionally stated — and
this document does not restate the keys, their defaults, or their
ranges; §12 does, at the byte level. A wire that does not match §12 is
refused with `-EINVAL` (the host logs why; §5).

For `source: "wasm"`, the last three arguments are the callbacks the
solver will use, in order: the derivative, `buf_in`, and `buf_out`.
Each is an index into the module's function table, and the module must
export that table as `table` — AssemblyScript produces the export with
`asc --exportTable`. The host resolves the three indices at create and
stores them per solver id; every one must name a function of the
declared signature (§3.6), or create refuses with `-EINVAL`. Two
solvers created with different derivatives therefore behave
independently. For any other source the three indices are ignored.

For `source: "world"` the config carries the world's YAML in the wire's
`world` entry and does not state `dim` (the host derives it from the
compiled world — stating it is `-EINVAL`); the host compiles the YAML
and binds the resulting evaluator exactly as it does the wasm callbacks,
and the
three index arguments are ignored.

Returns a handle ≥ 1, or a negative errno. The mapping is the header's:
`-EINVAL` for a malformed config or an unmet source requirement,
`-ENOENT` for an unknown `method`, `-ENOSYS` for a `method` not
available in this build (§7),
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

### 3.7 Working with raw pointers

The ABI passes raw pointers — `usize` addresses into the guest's own
linear memory — and the guest reads and writes through them. Three
patterns, in increasing order of convenience. Patterns 1 and 2, where
the toolchain has them, allocate nothing and belong in hot paths like
`_derivative`; pattern 3 allocates and belongs on cold paths.

**1. `load<f64>` / `store<f64>` — always works, no allocation.** The
memory-arithmetic form, in two spellings that compile to the same code:

**1a — inline raw.** Fewest moving parts; the loop body shows the
addressing directly. The shipped example (`examples/solver/game.ts`) is
this form:

```ts
// dy[i] = -y[i]:
for (let i = 0; i < len; i++) {
  store<f64>(dyPtr + (<usize>i << 3), -load<f64>(yPtr + (<usize>i << 3)));
}
```

**1b — named addressing.** Same generated code — the `@inline` helpers
vanish into the identical `f64.load` / `f64.store` pair — for when you
would rather read `f64Get`/`f64Set` than `<usize>i << 3`:

```ts
@inline function f64Get(ptr: usize, i: i32): f64 { return load<f64>(ptr + (<usize>i << 3)); }
@inline function f64Set(ptr: usize, i: i32, v: f64): void { store<f64>(ptr + (<usize>i << 3), v); }
for (let i = 0; i < len; i++) {
  f64Set(dyPtr, i, -f64Get(yPtr, i));
}
```

**2. `Float64Array.wrap(ptr, len)` — reads as data, no allocation — but
not in this toolchain.** AssemblyScript 0.28.8's `wrap` takes an
`ArrayBuffer`, not a pointer: `Float64Array.wrap(yPtr, len)` fails to
compile (`TS2322: Type 'usize' is not assignable to type
'~lib/arraybuffer/ArrayBuffer'`), and reinterpreting the data pointer as
an `ArrayBuffer` with `changetype` compiles but is a lie — the emitted
code then reads object-header fields out of the data (an `ArrayBuffer`'s
length lives at negative offsets of its object). Verify in your own
build before reaching for this shape; if a future AssemblyScript adds an
external-pointer overload, it would be the readable no-allocation form:

```ts
// If (and only when) your toolchain's wrap accepts a raw pointer:
const y = Float64Array.wrap(yPtr, len);
const dy = Float64Array.wrap(dyPtr, len);
for (let i = 0; i < len; i++) dy[i] = -y[i];
```

**3. `@unmanaged` struct + wrapper class — reads as the natural shape;
but the wrapper allocates.** For fixed-layout data (fields at
compile-time-known offsets), an `@unmanaged` class is just a layout: its
field reads compile to plain loads at those offsets, and
`changetype<T>(ptr)` views memory through it for free. A wrapper class
with `@operator("[]")` indexes an array of them:

```ts
@unmanaged class Vec2 { x: f64; y: f64; }   // x at +0, y at +8

class Vec2Array {
  private ptr: usize;
  private len: i32;
  private constructor(ptr: usize, len: i32) { this.ptr = ptr; this.len = len; }
  static wrap(ptr: usize, len: i32): Vec2Array { return new Vec2Array(ptr, len); }
  @operator("[]") get(i: i32): Vec2 { return changetype<Vec2>(this.ptr + (<usize>i << 4)); }
  get length(): i32 { return this.len; }
}

// dy = -y, per component:
const y = Vec2Array.wrap(yPtr, len);
const dy = Vec2Array.wrap(dyPtr, len);
for (let i = 0; i < len; i++) { dy[i].x = -y[i].x; dy[i].y = -y[i].y; }
```

`Vec2Array.wrap(...)` is a real allocation — the wrapper object — while
the `changetype` views are not; and the `[]` getter performs no bounds
check, exactly like pattern 1's arithmetic. Use this form for setup,
readback, and per-frame bookkeeping, not per-stage callbacks.

The wire stays raw pointers. Wrappers are guest-side ergonomics and
never cross the ABI: the host sees addresses, lengths, and errno, no
matter which form a guest uses. The reference implementation of pattern
1a is `examples/solver/game.ts`'s `_derivative`.

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
 * A solver configuration in the schema.yaml vocabulary: the object form
 * of the §12 wire. `method` and `source` are required; `dim` is required
 * by the wasm and native sources and must stay 0 for `source: "world"`
 * (the host derives it); `world` carries the YAML text for
 * `source: "world"`.
 *
 * A parameter left at its "absent" value is not written to the wire at
 * all and the schema's default applies. The absent values are sentinels,
 * not nulls, because AssemblyScript 0.28.8 has no nullable value types
 * (`f64 | null` is `AS204`): NaN for the eight f64 parameters, -1 for
 * `iterations`, and null for the two string fields (`description`,
 * `world` — references, where null is legal).
 */
export class SolverConfig {
  method: string;
  source: string;
  dim: i32;                    // 0 unless the source requires it
  description: string | null;  // null = absent
  relTol: f64;                 // NaN = absent; same for the next four
  absTol: f64;
  minStep: f64;
  maxStep: f64;
  fixedStep: f64;
  iterations: i32;             // -1 = absent
  convergenceTol: f64;         // NaN = absent; same for the next two
  compliance: f64;
  relaxation: f64;
  world: string | null;        // the YAML text; null = absent
}

/**
 * A handle to one solver id. Errors are null / -1; nothing throws.
 * Destroy it when done — like ResFile.close, destroy is idempotent.
 */
export class Solver {
  /** The solver handle; 0 means destroyed (0 is never a valid id). */
  private id: i32;

  /**
   * Create a solver from a `SolverConfig` and, for `source: "wasm"`,
   * the three callbacks that solver uses. The framework encodes the
   * object to the §12 wire and passes its bytes to `solver_create`.
   * Callbacks are optional — world-source and native-source solvers have
   * none — and default to null, which the framework passes as 0/0/0.
   * Returns null on any failure: a wire the host refuses (unset method or
   * source, a source's requirements unmet, a world that does not
   * compile), unknown method, unavailable method or source, a callback
   * index that does not name a function of the declared signature, or a
   * full id table (§5).
   */
  static create(config: SolverConfig, callbacks: SolverCallbacks | null = null): Solver | null

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
itself: `setState(buf[0], buf.subarray(1))` restores exactly what
`state(buf)` saved — `subarray` is a view into the same buffer, where
`slice` would copy it.

Callbacks are optional because they are a property of the source, not the
solver: `source: "wasm"` needs the three callback functions, while
`source: "world"` (the evaluator is host-side; the world *is* the f) and
`source: "native"` (the registered vtable carries them) need none. Calling
`create` with the config alone passes 0/0/0 for the three indices, and the
host ignores them for every non-wasm source (§3.1).

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
- `-22 EINVAL` — a config the host refuses (a wire that does not match
  DESIGN.md §12, an empty method or source, an unmet source requirement,
  an out-of-range parameter) or a bad argument; `step` on a
  `source: "wasm"` solver before its callbacks are bound.
- `-24 EMFILE` — solver-id table full (create only).
- `-38 ENOSYS` — `method` named in the config but not available in this
  build (verlet / implicit_euler / spook — §7).

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

- **No error channel for world-source compile failures.** A world
  config that does not compile is `-EINVAL`, with the compiler's
  line/column message on the debug channel (`[tension-core]`-prefixed
  stderr) — not across the wasm boundary, because create has no err
  buffer (solver/DESIGN.md §9).
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
const config = new SolverConfig();
config.method = "rk45";
config.source = "wasm";
config.dim = 2;
config.relTol = 1e-8;                 // a parameter left NaN is absent
config.absTol = 1e-10;
const s = Solver.create(config,
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
