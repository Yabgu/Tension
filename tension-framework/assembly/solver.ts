// Guest-side bindings for the Tension solver host ABI (`tension::solver`).
//
// The guest imports these five functions from the host under the wasm module
// name `tension::solver`; tension-core implements them over the solver C shim
// and the Fortran numerical core behind it. State vectors cross as f64 slots;
// every error is a negative POSIX errno.
//
// The config crosses as (ptr, len) like every other string in this framework,
// but its bytes are not text: they are the binary layout of
// tension-solver/DESIGN.md §12 — a 64-byte header, a parameters block, and a
// string table. `SolverConfig` is the guest's object form of it and this file
// is the format's *writer*: the layout the encoder emits is the contract, and
// the host is its strict reader (if the two ever disagree, this side changes).
// The host resolves the wire into the C struct the shim takes; the shim never
// sees these bytes.
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
 * A solver configuration, in the schema.yaml vocabulary: the `method` and
 * `source` every config states, an optional `description`, the `dim` the
 * wasm and native sources require (a world source must leave it 0 — the host
 * derives it from the compiled world), and the nine optional parameters.
 *
 * A parameter left at its "absent" value is not written to the wire at all:
 * the schema's declared default applies. The absent values are sentinels,
 * not `null`s, because AssemblyScript 0.28.8 has no nullable value types —
 * `f64 | null` is a compile error there (AS204) — and nothing is lost: the
 * wire may not carry a stated NaN or a negative count anyway (the shim
 * refuses non-finite parameters and counts outside `int32_t`).
 *
 *   - the eight f64 parameters: `NaN` means absent
 *   - `iterations`: `-1` means absent
 *   - `description` and `world`: `null` means absent (references, so `null`
 *     is legal there)
 *
 * A parameter the chosen method does not read is warned about by the host,
 * not refused (schema.yaml's `parameters:` note).
 */
export class SolverConfig {
  method: string = "";
  source: string = "";
  dim: i32 = 0;
  description: string | null = null;
  relTol: f64 = NaN;
  absTol: f64 = NaN;
  minStep: f64 = NaN;
  maxStep: f64 = NaN;
  fixedStep: f64 = NaN;
  iterations: i32 = -1;
  convergenceTol: f64 = NaN;
  compliance: f64 = NaN;
  relaxation: f64 = NaN;
  world: string | null = null;
}

/** An encoded config wire blob: where the host reads from, and how much. */
class Wire {
  ptr: usize;
  len: i32;
  constructor(ptr: usize, len: i32) {
    this.ptr = ptr;
    this.len = len;
  }
}

// The §12 layout's fixed sizes.
const WIRE_HEADER_LEN = 64;
const WIRE_PARAM_STRIDE = 8;
// ASCII "TNSCONF1" = 54 4E 53 43 4F 4E 46 31, little-endian in one u64.
const WIRE_MAGIC: u64 = 0x31464e4f43534e54;
// format_version and schema_version, both 1. The layout's `reserved` bytes
// (56..64) are zero for free: the header is memset below.
const WIRE_FORMAT_VERSION: u16 = 1;
const WIRE_SCHEMA_VERSION: u16 = 1;

/** The `iterations` sentinel: the value that means "not stated". */
const ITERATIONS_ABSENT: i32 = -1;

/** The bitmap bit of each parameter, in schema declaration order. */
const P_RELTOL = 1 << 0;
const P_ABSTOL = 1 << 1;
const P_MINSTEP = 1 << 2;
const P_MAXSTEP = 1 << 3;
const P_FIXEDSTEP = 1 << 4;
const P_ITERATIONS = 1 << 5;
const P_CONVERGENCETOL = 1 << 6;
const P_COMPLIANCE = 1 << 7;
const P_RELAXATION = 1 << 8;

/** Write one string-table entry: a u32 length prefix, then the bytes. */
function writeEntry(at: usize, text: ArrayBuffer): void {
  store<u32>(at, text.byteLength);
  memory.copy(at + 4, changetype<usize>(text), text.byteLength);
}

/**
 * Encode `config` into the §12 wire layout. The writer's duties are the
 * format's: 8-byte alignment of the blob's start, every field at a multiple
 * of its size, a parameters block with one 8-byte slot per *set* bit in bit
 * order, a string table of length-prefixed UTF-8 entries in header-field
 * order (method, source, description, world), and nothing else — no padding,
 * no trailer. The strings are copied into the blob, so the ArrayBuffer is
 * the only thing that has to stay alive across the host call.
 */
function encodeConfig(config: SolverConfig): Wire {
  const method = String.UTF8.encode(config.method);
  const source = String.UTF8.encode(config.source);
  const hasDescription = config.description != null && config.description!.length > 0;
  const hasWorld = config.world != null && config.world!.length > 0;
  const description = hasDescription
    ? String.UTF8.encode(config.description!)
    : new ArrayBuffer(0);
  const world = hasWorld ? String.UTF8.encode(config.world!) : new ArrayBuffer(0);

  // The bitmap and the block's slot count, from the same nine checks.
  let bitmap: u32 = 0;
  let slots: i32 = 0;
  if (!isNaN(config.relTol)) {
    bitmap |= P_RELTOL;
    slots++;
  }
  if (!isNaN(config.absTol)) {
    bitmap |= P_ABSTOL;
    slots++;
  }
  if (!isNaN(config.minStep)) {
    bitmap |= P_MINSTEP;
    slots++;
  }
  if (!isNaN(config.maxStep)) {
    bitmap |= P_MAXSTEP;
    slots++;
  }
  if (!isNaN(config.fixedStep)) {
    bitmap |= P_FIXEDSTEP;
    slots++;
  }
  if (config.iterations != ITERATIONS_ABSENT) {
    bitmap |= P_ITERATIONS;
    slots++;
  }
  if (!isNaN(config.convergenceTol)) {
    bitmap |= P_CONVERGENCETOL;
    slots++;
  }
  if (!isNaN(config.compliance)) {
    bitmap |= P_COMPLIANCE;
    slots++;
  }
  if (!isNaN(config.relaxation)) {
    bitmap |= P_RELAXATION;
    slots++;
  }

  // The string table follows the parameters block, entry by entry.
  let off = WIRE_HEADER_LEN + slots * WIRE_PARAM_STRIDE;
  const methodPtr = off;
  off += 4 + method.byteLength;
  const sourcePtr = off;
  off += 4 + source.byteLength;
  const descriptionPtr = hasDescription ? off : 0;
  if (hasDescription) off += 4 + description.byteLength;
  const worldPtr = hasWorld ? off : 0;
  if (hasWorld) off += 4 + world.byteLength;

  // 8 bytes of slack so the payload can be aligned up; the blob's length is
  // `off`, not the buffer's.
  const buf = new ArrayBuffer(off + 8);
  const base = (changetype<usize>(buf) + 7) & ~(<usize>7);

  store<u64>(base, WIRE_MAGIC);
  store<u16>(base + 8, WIRE_FORMAT_VERSION);
  store<u16>(base + 10, WIRE_SCHEMA_VERSION);
  store<u32>(base + 12, <u32>methodPtr);
  store<u32>(base + 16, <u32>method.byteLength);
  store<u32>(base + 20, <u32>sourcePtr);
  store<u32>(base + 24, <u32>source.byteLength);
  store<u32>(base + 28, <u32>descriptionPtr);
  store<u32>(base + 32, hasDescription ? <u32>description.byteLength : 0);
  store<u32>(base + 36, <u32>config.dim);
  store<u32>(base + 40, bitmap == 0 ? 0 : WIRE_HEADER_LEN);
  store<u32>(base + 44, bitmap);
  store<u32>(base + 48, <u32>worldPtr);
  store<u32>(base + 52, hasWorld ? <u32>world.byteLength : 0);
  store<u64>(base + 56, 0);

  // The parameters block: one slot per set bit, in bit order. The iterations
  // slot is the one u32 (low four bytes; the upper four stay zero).
  let slot: usize = base + WIRE_HEADER_LEN;
  if (!isNaN(config.relTol)) {
    store<f64>(slot, config.relTol);
    slot += WIRE_PARAM_STRIDE;
  }
  if (!isNaN(config.absTol)) {
    store<f64>(slot, config.absTol);
    slot += WIRE_PARAM_STRIDE;
  }
  if (!isNaN(config.minStep)) {
    store<f64>(slot, config.minStep);
    slot += WIRE_PARAM_STRIDE;
  }
  if (!isNaN(config.maxStep)) {
    store<f64>(slot, config.maxStep);
    slot += WIRE_PARAM_STRIDE;
  }
  if (!isNaN(config.fixedStep)) {
    store<f64>(slot, config.fixedStep);
    slot += WIRE_PARAM_STRIDE;
  }
  if (config.iterations != ITERATIONS_ABSENT) {
    // A stated count: any other value crosses as its u32 bits, and a
    // negative one is refused by the shim rather than silently absent.
    const n: u32 = <u32>config.iterations;
    store<u64>(slot, <u64>n);
    slot += WIRE_PARAM_STRIDE;
  }
  if (!isNaN(config.convergenceTol)) {
    store<f64>(slot, config.convergenceTol);
    slot += WIRE_PARAM_STRIDE;
  }
  if (!isNaN(config.compliance)) {
    store<f64>(slot, config.compliance);
    slot += WIRE_PARAM_STRIDE;
  }
  if (!isNaN(config.relaxation)) {
    store<f64>(slot, config.relaxation);
    slot += WIRE_PARAM_STRIDE;
  }

  // The header's offsets are blob-relative; the writes are absolute.
  writeEntry(base + methodPtr, method);
  writeEntry(base + sourcePtr, source);
  if (hasDescription) writeEntry(base + descriptionPtr, description);
  if (hasWorld) writeEntry(base + worldPtr, world);

  return new Wire(base, off);
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
 * A handle to one solver id, created from a `SolverConfig` (schema.yaml's
 * vocabulary). Errors are null / -1; nothing throws. Destroy it when done —
 * like ResFile.close, destroy is idempotent.
 */
export class Solver {
  private id: i32;

  private constructor(id: i32) {
    this.id = id;
  }

  /**
   * Create a solver from a `SolverConfig` and, for `source: "wasm"`, the
   * three callbacks that solver uses. Callbacks are optional: `source:
   * "world"` and `source: "native"` have none, and the framework passes
   * 0/0/0 for the three indices (the host ignores them for non-wasm
   * sources). Returns `null` on any failure: a config the host refuses
   * (unset method or source, a source's requirements unmet, an unknown
   * method, a world that does not compile), a method or source not available
   * in this build, a full id table, or — for `source: "wasm"` — a callback
   * whose table index does not name a function of the declared signature.
   */
  static create(config: SolverConfig, callbacks: SolverCallbacks | null = null): Solver | null {
    const wire = encodeConfig(config);
    let derivativeIdx = 0;
    let bufInIdx = 0;
    let bufOutIdx = 0;
    if (callbacks != null) {
      derivativeIdx = callbackIndex(changetype<usize>(callbacks.derivative));
      bufInIdx = callbackIndex(changetype<usize>(callbacks.bufIn));
      bufOutIdx = callbackIndex(changetype<usize>(callbacks.bufOut));
    }
    const id = hostSolverCreate(wire.ptr, wire.len, derivativeIdx, bufInIdx, bufOutIdx);
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
