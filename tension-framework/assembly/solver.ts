// Guest-side bindings for the Tension solver host ABI (`tension::solver`).
//
// The guest imports these five functions from the host under the wasm module
// name `tension::solver`; tension-core implements them over the solver C shim
// and the Fortran numerical core behind it. Config strings cross as UTF-8
// bytes with an explicit pointer and length, the same convention as
// `tension::res` and `tension::io arg`; state vectors cross as f64 slots;
// every error is a negative POSIX errno.
//
// What this file does NOT declare: the guest's own three callbacks
// (`_derivative`, `deriv_buf_in`, `deriv_buf_out`). Under `source: "wasm"`
// the guest passes them to `Solver.create` in a `SolverCallbacks` object and
// the host performs the binding itself (GUEST_ABI.md §3.1, §3.6) — nothing
// is called to register them. A `source: "wasm"` module must be built with
// `asc --exportTable`, because the host resolves the callbacks by their
// indices in the module's exported `table`.
//
// The class is a thin handle, like ResFile: it holds the id and nothing
// else, caches no `dim`, and carries no error text. Nothing here throws:
// errors are null / -1, matching the rest of the framework.

@external("tension::solver", "solver_create")
declare function hostSolverCreate(
  configPtr: usize,
  configLen: i32,
  derivativeIdx: i32,
  bufInIdx: i32,
  bufOutIdx: i32,
): i32;

@external("tension::solver", "solver_step")
declare function hostSolverStep(id: i32, dt: f64): i32;

@external("tension::solver", "solver_state")
declare function hostSolverState(id: i32, tPtr: usize, yPtr: usize, yCap: i32): i32;

@external("tension::solver", "solver_set_state")
declare function hostSolverSetState(id: i32, t: f64, yPtr: usize, yLen: i32): i32;

@external("tension::solver", "solver_destroy")
declare function hostSolverDestroy(id: i32): void;

/**
 * The three callbacks a `source: "wasm"` solver uses: the derivative (the
 * right-hand side f(t, y)) and the two functions returning the addresses of
 * the copy-in / copy-out buffers. `Solver.create` passes their table
 * indices along; for any other source they are ignored.
 */
export class SolverCallbacks {
  derivative: (yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32) => i32;
  bufIn: () => i32;
  bufOut: () => i32;
}

/**
 * The table index of a function reference. AssemblyScript function values are
 * not table indices: a function reference points at the function's
 * table-index word (that is the word AS's own `call_indirect` sites load
 * through), so the index is the i32 the reference addresses. This is the one
 * place in the framework that knows the representation.
 */
function callbackIndex(fn: usize): i32 {
  return load<i32>(fn);
}

/**
 * A handle to one solver id, created from a JSON config (schema.yaml's
 * vocabulary). Errors are null / -1; nothing throws. Destroy it when done —
 * like ResFile.close, destroy is idempotent.
 */
export class Solver {
  private id: i32;

  private constructor(id: i32) {
    this.id = id;
  }

  /**
   * Create a solver from a JSON config (schema.yaml's vocabulary) and the
   * three callbacks a `source: "wasm"` solver uses. Returns `null` on any
   * failure: malformed config, unknown method, unmet source requirement, a
   * method or source not available in this build, a full id table, or — for
   * `source: "wasm"` — a callback whose table index does not name a function
   * of the declared signature.
   */
  static create(configJson: string, callbacks: SolverCallbacks): Solver | null {
    const bytes = String.UTF8.encode(configJson);
    const id = hostSolverCreate(
      changetype<usize>(bytes),
      i32(bytes.byteLength),
      callbackIndex(changetype<usize>(callbacks.derivative)),
      callbackIndex(changetype<usize>(callbacks.bufIn)),
      callbackIndex(changetype<usize>(callbacks.bufOut)),
    );
    if (id < 1) return null;
    return new Solver(id);
  }

  /**
   * Advance by `dt`. Returns 0 on success, -1 on failure. Synchronous:
   * adaptive methods take internal sub-steps as needed, and the call returns
   * when the requested advance is complete.
   */
  step(dt: f64): i32 {
    if (this.id < 1) return -1;
    return hostSolverStep(this.id, dt) < 0 ? -1 : 0;
  }

  /**
   * Copy `{t, y}` out. Slot 0 receives the time `t`; slots 1..dim receive
   * the state vector. `out` must hold at least `dim + 1` slots. Returns the
   * number of slots written (`dim + 1`), or -1.
   */
  state(out: Float64Array): i32 {
    if (this.id < 1) return -1;
    // One crossing, two pointers: the host writes `t` at slot 0 and the
    // state slots directly after it, so no scratch buffer is needed here.
    const rc = hostSolverState(this.id, out.dataStart, out.dataStart + 8, out.length - 1);
    return rc < 0 ? -1 : rc + 1;
  }

  /**
   * Restore `{t, y}` — the pair that makes a checkpoint complete. `y` must
   * hold exactly `dim` slots. Returns 0, or -1.
   */
  setState(t: f64, y: Float64Array): i32 {
    if (this.id < 1) return -1;
    return hostSolverSetState(this.id, t, y.dataStart, y.length) < 0 ? -1 : 0;
  }

  /** Destroy the solver. Idempotent: safe to call twice. */
  destroy(): void {
    if (this.id < 1) return;
    hostSolverDestroy(this.id);
    this.id = 0;
  }

  /** Whether this handle is still open. False after destroy. */
  isOpen(): bool {
    return this.id >= 1;
  }
}
