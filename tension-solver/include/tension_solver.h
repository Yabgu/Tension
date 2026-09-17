/*
 * tension_solver — the numerical solver coprocessor, C ABI.
 *
 * ABI signatures live here; the configuration vocabulary lives in schema.yaml.
 * This header names the entry points and the callback signatures; the schema
 * names methods, sources, parameters, and their per-source requirements. A
 * preset names a `method: "rk45"` and a `source: "wasm"`; the header resolves
 * those to symbols and function pointers.
 *
 * Naming convention: the public ABI is tension_solver_create/step/state/
 * set_state/destroy; internal backend functions follow tension_solver_{name}_*
 * and are dispatched by the generic surface.
 *
 * Memory model:
 *   - The solver owns the state vector. `create` allocates it once from the
 *     `dim` the config declares (for `source: wasm` and `source: native`) or
 *     the YAML compiler derives (for `source: world`). The derivative callback
 *     receives the state pointer directly — no copy at the callback boundary.
 *     The guest reads via `state` (a copy out, for checkpointing) and writes
 *     via `set_state` (a restore, for rollback).
 *   - The workspace (Butcher table, embedded error estimator, per-stage k
 *     vectors, adaptive step history) is allocated once by `create` and reused
 *     across `step` calls. `step` is allocation-free on the hot path.
 *
 * Conventions:
 *   - every entry point is panic-free: any failure comes back as a negative
 *     errno value. 0 means success for the calls that report a status.
 *   - solver handles are 1-based; 0 is never a valid id.
 *   - `config_json` is UTF-8 JSON, validated against schema.yaml before any
 *     allocation. Malformed JSON is -EINVAL; an unknown `method` is -ENOENT;
 *     a `source` whose `requires` are unmet is -EINVAL.
 *   - the two callbacks (derivative, validate) are guest-supplied. For
 *     `source: wasm` the guest exports them from the wasm module; for
 *     `source: native` the plugin supplies them in its registered vtable.
 *     For `source: world` neither callback crosses the boundary — the YAML
 *     compiler emits the RHS on the solver side.
 *
 * Error codes (values are negated POSIX errno numbers, matching tension_res.h):
 *   -2  ENOENT   unknown method in config (config-time method lookup failure)
 *   -5  EIO      callback returned a fatal error, backend internal failure
 *   -9  EBADF    closed or never-allocated solver id (runtime handle failure)
 *   -12 ENOMEM   allocation failure (create only)
 *   -22 EINVAL   malformed config, unmet source requirement, bad argument
 *   -24 EMFILE   solver-id table full (create only)
 *   -38 ENOSYS   method named in config but not compiled into this build
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_SOLVER_H
#define TENSION_SOLVER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── callbacks ───────────────────────────────────────────────────────── */
/*
 * The guest-side callback names in schema.yaml (`_derivative`, `_validate`)
 * map to the C function-pointer typedefs below
 * (`tension_solver_derivative_fn`, `tension_solver_validate_fn`). Same
 * signatures; the underscore-prefixed names are the wasm exports the guest
 * provides, the typedefs are what the host stores and calls.
 */

/*
 * The RHS f(t, y). `y` is the solver-owned state, read-only from the
 * callback's perspective; `dy` is the output buffer of `dy_cap` f64 slots
 * (== `dim`). Returns 0 on success, a negative errno on failure.
 *
 * Called per integration stage. RK45 calls this seven times per accepted
 * step; RK23 calls it three times. This is a declaration of what the
 * physics *is*, not the integration loop.
 */
typedef int32_t (*tension_solver_derivative_fn)(
    const double *y, int32_t len, double t, double *dy, int32_t dy_cap);

/*
 * The acceptance function. `prev` / `next` are the state before and after a
 * proposed step; `dt` is the step size. `out` receives a fixed-width 16-byte
 * record: { double margin; uint32_t reason_code; uint32_t flags; }.
 * `margin > 0` accepts, `margin <= 0` rejects. Returns 0 on success, a
 * negative errno on failure. Classical backends do not call this; the
 * AI/hallucinator module (separate schema, `extends: tension-solver`) makes
 * it mandatory for its backends.
 */
typedef int32_t (*tension_solver_validate_fn)(
    const double *prev, int32_t prev_len,
    const double *next, int32_t next_len,
    double dt, uint8_t *out, int32_t out_cap);

/* ── native backend registration ─────────────────────────────────────── */

/*
 * A native plugin registers itself once, at load time, under a `method:`
 * name. That name is what configs use (`method: <name>`); it is not a
 * `source:` name. A plugin is a method, not a source — the `source:` a
 * config pairs with it selects where f comes from, not what is registered.
 *
 * A plugin must supply `step` to be registered — without an integrator
 * there is nothing to call. The other slots are optional and used only for
 * the pairings that require them:
 *
 *   Config                                 Plugin must have   Uses
 *   ─────────────────────────────────────  ─────────────────  ──────────────────────
 *   method: <plugin>, source: native       step + derivative  plugin's step, plugin's f
 *   method: <plugin>, source: wasm         step               plugin's step, wasm's f
 *   method: <plugin>, source: world        step               plugin's step, world's f
 *   method: <builtin>, source: native      (invalid)          built-in has no bundled f
 *
 * A guest that wants to use its own f with a built-in integrator does not
 * register a bare `derivative`: there is no v1 path for that. It registers
 * a plugin named e.g. `rk45_native` that supplies both `derivative` (the
 * guest's f) and `step` (a wrapper that calls the built-in rk45), and names
 * it in the config as `method: rk45_native, source: native`.
 *
 * Unused slots are NULL. The struct's layout is fixed here so a plugin
 * compiled against one version of this header links against the same engine.
 * A registration that shadows a built-in method is refused with -EINVAL.
 */
typedef struct tension_solver_backend_vtable {
    const char *name;                        /* the `method:` string presets use */

    /*
     * The backend's kind, matching the reserved vocabulary in schema.yaml
     * (explicit_rk, symplectic, implicit, variational_constraint, stochastic,
     * custom). A plugin may declare a reserved kind — e.g. `symplectic` — so
     * engine tooling can introspect it the way it introspects built-ins.
     * `custom` is the fallback for a backend that matches none of the
     * reserved semantics.
     */
    const char *kind;

    /*
     * 0 = non-deterministic, 1 = deterministic. The schema's derivation rule
     * (`kind: stochastic` implies non-deterministic; every other reserved
     * kind is deterministic) applies to schema-declared backends. For a
     * runtime-registered backend, this field is authoritative — the engine
     * reads it directly and does not derive. A `kind: custom` plugin must
     * declare it explicitly; a plugin declaring a reserved kind should keep
     * this field consistent with the rule, and a mismatch is a registration
     * error.
     */
    uint32_t deterministic;

    tension_solver_derivative_fn derivative; /* required when source: native */
    tension_solver_validate_fn   validate;   /* required when kind: stochastic */

    int32_t (*step)(int32_t id, double dt);   /* required; the integrator */
    int32_t (*state)(int32_t id, double *out, int32_t cap);
    int32_t (*set_state)(int32_t id, const double *in, int32_t len);
    void    (*destroy)(int32_t id);
} tension_solver_backend_vtable;

/* ── public API ──────────────────────────────────────────────────────── */

/*
 * Create a solver from a JSON config. On success returns a handle >= 1; on
 * failure returns a negative errno: -EINVAL for malformed config or an
 * unmet source requirement, -ENOENT for an unknown method, -ENOSYS for a
 * method not compiled into this build, -ENOMEM for allocation failure,
 * -EMFILE for a full solver-id table. The config is validated against
 * schema.yaml before any allocation.
 */
int32_t tension_solver_create(const char *config_json, size_t config_len);

/*
 * Advance the solver by `dt`. Returns 0 on success, a negative errno on
 * failure. Adaptive methods may take internal sub-steps smaller than `dt`;
 * there is no budget parameter and no sub-step cap — the engine runs to
 * completion. Real-time constraints are guest policy.
 */
int32_t tension_solver_step(int32_t id, double dt);

/*
 * Copy the state vector into `out` (up to `cap` f64 slots). Returns the
 * number of slots written, or a negative errno. `cap < dim` is -EINVAL.
 * This is a copy out, not a view — the solver owns the state, the caller
 * receives a snapshot it can checkpoint.
 */
int32_t tension_solver_state(int32_t id, double *out, int32_t cap);

/*
 * Restore the state vector from `in` (`len` f64 slots; must equal `dim`).
 * Returns 0 on success, a negative errno. Used for rollback and checkpoint
 * restore; not part of the hot path.
 */
int32_t tension_solver_set_state(int32_t id, const double *in, int32_t len);

/* Destroy a solver id. Idempotent for in-range ids. */
void tension_solver_destroy(int32_t id);

/*
 * Register a native backend. `name` is the method string presets use;
 * `vtable` is the plugin's function table (see tension_solver_backend_vtable).
 * Returns 0 on success, a negative errno on failure (a name that shadows a
 * built-in method is -EINVAL). Called by the plugin's init before any create
 * that names it.
 */
int32_t tension_solver_register_backend(const char *name,
                                        const tension_solver_backend_vtable *vtable);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_SOLVER_H */
