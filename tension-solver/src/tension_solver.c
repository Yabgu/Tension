/*
 * tension_solver — the C ABI shim: handles, config, registry, dispatch.
 *
 * The numerical core lives in Fortran (tension_solver_erk.f90). This file
 * is the plumbing the plan put in C: config-struct validation, the handle
 * table, the method registry, errno mapping. It implements exactly the
 * surface declared in include/tension_solver.h and nothing else. It does
 * not parse text: the guest's config crosses the wasm boundary in the
 * binary layout of DESIGN.md §12, and the host (tension-core) decodes that
 * into the `tension_solver_config` this level validates.
 *
 * The validation rules are compiled in, never loaded from schema.yaml at
 * runtime (the header says so; tests/solver_p2.rs cross-checks every rule
 * against the schema, and drift fails that test):
 *   - the seven built-in method names, only euler compiled in this build
 *   - the three source names and their `requires` (wasm/native need `dim`)
 *   - `bundles_rhs: false` for every built-in, and the pairing rule
 *     `source: native` requires `bundles_rhs: true` — so a built-in with
 *     `source: native` is rejected
 *   - the allowed top-level config members (preset_format.allowed plus the
 *     required method/source pair) and the global parameter vocabulary, with
 *     each method's declared parameter subset
 *   - the nine-parameter bitmap's meaning: bit order = schema declaration
 *     order, bits 9-31 reserved
 *
 * `source: world` is wired as of P8e: the RHS reaches the shim as a bound
 * derivative exactly like `source: wasm`'s, and this file never sees YAML —
 * the host compiles the embedded world, derives dim from it, and
 * synthesizes the `dim` this level requires (tension-world/, phase 8).
 *
 * SPDX-License-Identifier: MIT
 */
#include "tension_solver.h"
#include "solver_params.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── errno-style codes (the header's table) ──────────────────────────── */

#define TS_ENOENT (-2)  /* unknown method in config */
#define TS_EBADF (-9)   /* closed or never-allocated solver id */
#define TS_ENOMEM (-12) /* allocation failure (create only) */
#define TS_EINVAL (-22) /* malformed config, unmet requirement, bad argument */
#define TS_EMFILE (-24) /* solver-id table full (create only) */
#define TS_ENOSYS (-38) /* method named in config but not compiled in */

/* ── sizes ───────────────────────────────────────────────────────────── */

#define TS_MAX_SOLVERS 64
#define TS_MAX_PLUGINS 32
#define TS_MAX_DIM 10000000
#define TS_NAME_MAX 64

/* ── the compiled rules (mirroring schema.yaml) ──────────────────────── */

/* backends[*].name, in registry order. Only euler is compiled in. */
static const char *const TS_BUILTINS[] = {
    "euler", "heun", "rk23", "rk45", "verlet", "implicit_euler", "spook",
};
#define TS_BUILTIN_COUNT ((int)(sizeof TS_BUILTINS / sizeof TS_BUILTINS[0]))
#define TS_EULER_INDEX 0
#define TS_HEUN_INDEX 1
#define TS_RK23_INDEX 2
#define TS_RK45_INDEX 3
#define TS_VERLET_INDEX 4
#define TS_IMPLICIT_INDEX 5
/* TS_BUILTINS[6] is "spook": registered, not compiled — its method is
 * constraint-based position-based dynamics, and the frozen ABI has no
 * constraint channel (DESIGN.md §10). */

/* sources: names and per-source `requires` (1 = requires `dim`). */
static const char *const TS_SOURCES[] = {"world", "wasm", "native"};
enum { TS_SRC_WORLD = 0, TS_SRC_WASM = 1, TS_SRC_NATIVE = 2 };
#define TS_SOURCE_COUNT ((int)(sizeof TS_SOURCES / sizeof TS_SOURCES[0]))
static const int TS_SOURCE_REQUIRES_DIM[TS_SOURCE_COUNT] = {0, 1, 1};

/* pairing_rules.source_native_requires_bundles_rhs. Every built-in has
 * `bundles_rhs: false`; a registered plugin with a `derivative` slot is an
 * implicit `bundles_rhs: true`. */
#define TS_SOURCE_NATIVE_REQUIRES_BUNDLES_RHS 1

/* parameters[] — the global vocabulary, numeric. The order is schema.yaml's
 * declaration order and is load-bearing twice over: it is the bit order of
 * `parameters_bitmap` (DESIGN.md §12) and the bit order of the per-method
 * masks below. */
static const char *const TS_PARAMETERS[] = {
    "relTol",    "absTol",  "minStep",        "maxStep",     "fixedStep",
    "iterations", "convergenceTol", "compliance", "relaxation",
};
#define TS_PARAMETER_COUNT ((int)(sizeof TS_PARAMETERS / sizeof TS_PARAMETERS[0]))
#define TS_PARAMETER_MASK_ALL 0x1FFu /* the nine named bits; 9-31 reserved */

/* backends[*].parameters as bitmasks over TS_PARAMETERS order (bit 0 =
 * relTol … bit 8 = relaxation): the subset of the vocabulary each method
 * reads, mirroring schema.yaml. A parameter outside the mask is warned
 * about, never refused (schema.yaml: "warned, not errored"). A plugin has
 * no declared list here — nothing is warned for it. */
static const uint32_t TS_METHOD_PARAMETERS[] = {
    0x003u, /* euler          relTol, absTol */
    0x003u, /* heun           relTol, absTol */
    0x00Fu, /* rk23           relTol, absTol, minStep, maxStep */
    0x00Fu, /* rk45           relTol, absTol, minStep, maxStep */
    0x010u, /* verlet         fixedStep */
    0x060u, /* implicit_euler iterations, convergenceTol */
    0x1A0u, /* spook          iterations, compliance, relaxation */
};

/* ── the Fortran core's dispatch targets ─────────────────────────────── */
/*
 * Internal backend symbols, not part of the public ABI: the header's
 * naming convention, satisfied by the bind(C) procedures in
 * tension_solver_erk.f90, tension_solver_symplectic.f90 and
 * tension_solver_implicit.f90 (the shape the shim and plugins share).
 * `params` points at the solver_params.h struct — a real parameter
 * block since P3, never NULL from this shim.
 */
extern int32_t tension_solver_euler_workspace_size(int32_t dim);
extern int32_t tension_solver_euler_step(double *state, int32_t dim, double t,
                                         double dt, double *workspace,
                                         tension_solver_derivative_fn rhs_fn,
                                         void *rhs_ctx, const void *params,
                                         int32_t *status);
extern int32_t tension_solver_heun_workspace_size(int32_t dim);
extern int32_t tension_solver_heun_step(double *state, int32_t dim, double t,
                                        double dt, double *workspace,
                                        tension_solver_derivative_fn rhs_fn,
                                        void *rhs_ctx, const void *params,
                                        int32_t *status);
extern int32_t tension_solver_rk23_workspace_size(int32_t dim);
extern int32_t tension_solver_rk23_step(double *state, int32_t dim, double t,
                                        double dt, double *workspace,
                                        tension_solver_derivative_fn rhs_fn,
                                        void *rhs_ctx, const void *params,
                                        int32_t *status);
extern int32_t tension_solver_rk45_workspace_size(int32_t dim);
extern int32_t tension_solver_rk45_step(double *state, int32_t dim, double t,
                                        double dt, double *workspace,
                                        tension_solver_derivative_fn rhs_fn,
                                        void *rhs_ctx, const void *params,
                                        int32_t *status);
extern int32_t tension_solver_verlet_workspace_size(int32_t dim);
extern int32_t tension_solver_verlet_step(double *state, int32_t dim, double t,
                                          double dt, double *workspace,
                                          tension_solver_derivative_fn rhs_fn,
                                          void *rhs_ctx, const void *params,
                                          int32_t *status);
extern int32_t tension_solver_implicit_euler_workspace_size(int32_t dim);
extern int32_t tension_solver_implicit_euler_step(
    double *state, int32_t dim, double t, double dt, double *workspace,
    tension_solver_derivative_fn rhs_fn, void *rhs_ctx, const void *params,
    int32_t *status);

/* The method's workspace requirement, asked of the Fortran side rather
 * than hard-coded: the workspace formula lives with the numerics. -1 for
 * a method that is not compiled in (unreachable: create answers -ENOSYS
 * for those before sizing anything). */
static int32_t builtin_workspace_size(int builtin, int32_t dim)
{
    switch (builtin) {
    case TS_EULER_INDEX: return tension_solver_euler_workspace_size(dim);
    case TS_HEUN_INDEX: return tension_solver_heun_workspace_size(dim);
    case TS_RK23_INDEX: return tension_solver_rk23_workspace_size(dim);
    case TS_RK45_INDEX: return tension_solver_rk45_workspace_size(dim);
    case TS_VERLET_INDEX: return tension_solver_verlet_workspace_size(dim);
    case TS_IMPLICIT_INDEX: return tension_solver_implicit_euler_workspace_size(dim);
    default: return -1;
    }
}

/* ── state ───────────────────────────────────────────────────────────── */

typedef struct {
    int used;
    char name[TS_NAME_MAX];
    const tension_solver_backend_vtable *vt;
} TsPlugin;

typedef struct {
    int used;
    int is_plugin;
    int builtin; /* index into TS_BUILTINS when !is_plugin */
    int source;  /* TS_SRC_* */
    int32_t dim;
    double t;
    double *y;   /* state, dim slots, owned */
    double *ws;  /* workspace, ws_slots slots, owned (built-ins only) */
    int32_t ws_slots;
    int stepped;
    tension_solver_derivative_fn bound_derivative;
    tension_solver_validate_fn bound_validate;
    const TsPlugin *plugin;
    tension_solver_params params; /* the config's parameter block, by value */
} TsSolver;

static TsSolver g_solvers[TS_MAX_SOLVERS];
static TsPlugin g_plugins[TS_MAX_PLUGINS];

static TsSolver *handle(int32_t id)
{
    if (id < 1 || id > TS_MAX_SOLVERS)
        return NULL;
    return g_solvers[id - 1].used ? &g_solvers[id - 1] : NULL;
}

static int find_builtin_n(const char *name, size_t len)
{
    int i;
    for (i = 0; i < TS_BUILTIN_COUNT; i++)
        if (strlen(TS_BUILTINS[i]) == len && memcmp(TS_BUILTINS[i], name, len) == 0)
            return i;
    return -1;
}

static int find_builtin(const char *name)
{
    return name == NULL ? -1 : find_builtin_n(name, strlen(name));
}

static TsPlugin *find_plugin_n(const char *name, size_t len)
{
    int i;
    for (i = 0; i < TS_MAX_PLUGINS; i++)
        if (g_plugins[i].used && strlen(g_plugins[i].name) == len &&
            memcmp(g_plugins[i].name, name, len) == 0)
            return &g_plugins[i];
    return NULL;
}

static TsPlugin *find_plugin(const char *name)
{
    return name == NULL ? NULL : find_plugin_n(name, strlen(name));
}

static int find_source_n(const char *name, size_t len)
{
    int i;
    for (i = 0; i < TS_SOURCE_COUNT; i++)
        if (strlen(TS_SOURCES[i]) == len && memcmp(TS_SOURCES[i], name, len) == 0)
            return i;
    return -1;
}

/* ── the configuration struct ────────────────────────────────────────── */
/*
 * tension_solver_create takes the `tension_solver_config` the host decoded
 * from the guest wire (DESIGN.md §12). Nothing here scans text: the struct's
 * strings carry explicit lengths, so every name lookup is a (pointer,
 * length) comparison against the compiled tables, and the parameter values
 * arrive pre-typed — `iterations` as u32, which this level checks against
 * the int32_t the numerical core reads.
 *
 * `parameters_bitmap` names which of the nine schema parameters the config
 * states (bit order = schema declaration order). A clear bit means the
 * schema's declared default applies and the field is not read. A stated
 * parameter the chosen method does not read is warned about, not refused
 * (schema.yaml's `parameters:` note: "warned, not errored — the parameter
 * is ignored; the warning names the parameter and the backend").
 */

/* The schema's declared defaults (schema.yaml `parameters` defaults). */
static tension_solver_params params_defaults(void)
{
    tension_solver_params p;
    p.rel_tol = 1.0e-6;
    p.abs_tol = 1.0e-9;
    p.min_step = 1.0e-12;
    p.max_step = (double)INFINITY;
    p.fixed_step = 1.0e-2;
    p.iterations = 10;
    p.convergence_tol = 1.0e-8;
    p.compliance = 0.0;
    p.relaxation = 1.0;
    return p;
}

/* Range checks after the struct's fields are collected: the schema's
 * declared ranges ([0, inf] for the five step/tolerance knobs) are advisory
 * there; here they are a floor that catches obviously wrong configs (a
 * negative tolerance). `dim`'s upper bound is TS_MAX_DIM, the same resource
 * bound the JSON era's parser enforced. `iterations` has no declared range
 * beyond its type; a value that does not fit the core's int32_t is refused
 * where it is read. The step-size window must be non-empty — max_step <
 * min_step admits no admissible h, and a zero window admits no progress at
 * all. */
static int32_t params_validate(const tension_solver_params *p)
{
    if (p->rel_tol < 0.0 || p->abs_tol < 0.0 || p->min_step < 0.0 ||
        p->max_step < 0.0 || p->fixed_step < 0.0)
        return TS_EINVAL;
    if (p->max_step < p->min_step)
        return TS_EINVAL;
    if (p->iterations < 0)
        return TS_EINVAL;
    return 0;
}

/* Fill `out` from the struct: the schema defaults, then every field whose
 * bit is set in the bitmap. A stated value must be finite — the JSON-era
 * number scanner refused inf and NaN, and a struct field can carry them;
 * the *unstated* ones keep the defaults, one of which (`max_step`) is +inf
 * by design. Returns -EINVAL for an out-of-range or non-finite value. */
static int32_t params_from_config(const tension_solver_config *cfg,
                                  tension_solver_params *out)
{
    uint32_t bits = cfg->parameters_bitmap;

    *out = params_defaults();
    if (bits & (1u << 0)) {
        if (!isfinite(cfg->rel_tol))
            return TS_EINVAL;
        out->rel_tol = cfg->rel_tol;
    }
    if (bits & (1u << 1)) {
        if (!isfinite(cfg->abs_tol))
            return TS_EINVAL;
        out->abs_tol = cfg->abs_tol;
    }
    if (bits & (1u << 2)) {
        if (!isfinite(cfg->min_step))
            return TS_EINVAL;
        out->min_step = cfg->min_step;
    }
    if (bits & (1u << 3)) {
        if (!isfinite(cfg->max_step))
            return TS_EINVAL;
        out->max_step = cfg->max_step;
    }
    if (bits & (1u << 4)) {
        if (!isfinite(cfg->fixed_step))
            return TS_EINVAL;
        out->fixed_step = cfg->fixed_step;
    }
    if (bits & (1u << 5)) {
        /* the one integer field: u32 on the wire, `>= 0` and int32_t in the
         * core (solver_params.h) */
        if (cfg->iterations > 2147483647u)
            return TS_EINVAL;
        out->iterations = (int32_t)cfg->iterations;
    }
    if (bits & (1u << 6)) {
        if (!isfinite(cfg->convergence_tol))
            return TS_EINVAL;
        out->convergence_tol = cfg->convergence_tol;
    }
    if (bits & (1u << 7)) {
        if (!isfinite(cfg->compliance))
            return TS_EINVAL;
        out->compliance = cfg->compliance;
    }
    if (bits & (1u << 8)) {
        if (!isfinite(cfg->relaxation))
            return TS_EINVAL;
        out->relaxation = cfg->relaxation;
    }
    return params_validate(out);
}

/* A stated parameter the method does not read: warn, do not refuse. The
 * plugin case (`builtin < 0`) has no declared list, so nothing is warned. */
static void warn_ignored_parameters(int builtin, uint32_t bits)
{
    uint32_t read;
    int i;

    if (bits == 0 || builtin < 0)
        return;
    read = TS_METHOD_PARAMETERS[builtin];
    for (i = 0; i < TS_PARAMETER_COUNT; i++)
        if ((bits & (1u << i)) != 0 && (read & (1u << i)) == 0)
            fprintf(stderr,
                    "[tension-solver] parameter '%s' is not read by method "
                    "'%s'; ignored\n",
                    TS_PARAMETERS[i], TS_BUILTINS[builtin]);
}

/* ── registration ────────────────────────────────────────────────────── */

enum {
    TS_KIND_EXPLICIT_RK = 0,
    TS_KIND_SYMPLECTIC,
    TS_KIND_IMPLICIT,
    TS_KIND_VARIATIONAL,
    TS_KIND_STOCHASTIC,
    TS_KIND_CUSTOM,
};

static int kind_from_name(const char *kind)
{
    if (kind == NULL)
        return -1;
    if (strcmp(kind, "explicit_rk") == 0)
        return TS_KIND_EXPLICIT_RK;
    if (strcmp(kind, "symplectic") == 0)
        return TS_KIND_SYMPLECTIC;
    if (strcmp(kind, "implicit") == 0)
        return TS_KIND_IMPLICIT;
    if (strcmp(kind, "variational_constraint") == 0)
        return TS_KIND_VARIATIONAL;
    if (strcmp(kind, "stochastic") == 0)
        return TS_KIND_STOCHASTIC;
    if (strcmp(kind, "custom") == 0)
        return TS_KIND_CUSTOM;
    return -1;
}

int32_t tension_solver_register_backend(
    const char *name, const tension_solver_backend_vtable *vtable)
{
    int kind;
    int slot;

    if (name == NULL || name[0] == '\0' || vtable == NULL)
        return TS_EINVAL;
    if (strlen(name) >= TS_NAME_MAX)
        return TS_EINVAL;
    if (find_builtin(name) >= 0)
        return TS_EINVAL; /* a registration may not shadow a built-in */
    if (find_plugin(name) != NULL)
        return TS_EINVAL; /* nor re-register a name already claimed */
    if (vtable->step == NULL)
        return TS_EINVAL; /* without an integrator there is nothing to call */

    /* kind and deterministic must agree (the registration table). */
    kind = kind_from_name(vtable->kind);
    if (kind < 0)
        return TS_EINVAL;
    switch (kind) {
    case TS_KIND_EXPLICIT_RK:
    case TS_KIND_SYMPLECTIC:
    case TS_KIND_IMPLICIT:
    case TS_KIND_VARIATIONAL:
        if (vtable->deterministic != 1)
            return TS_EINVAL;
        break;
    case TS_KIND_STOCHASTIC:
        if (vtable->deterministic != 0)
            return TS_EINVAL;
        break;
    case TS_KIND_CUSTOM:
        if (vtable->deterministic > 1)
            return TS_EINVAL;
        break;
    }

    for (slot = 0; slot < TS_MAX_PLUGINS; slot++)
        if (!g_plugins[slot].used)
            break;
    if (slot == TS_MAX_PLUGINS)
        return TS_EMFILE;

    g_plugins[slot].used = 1;
    memcpy(g_plugins[slot].name, name, strlen(name) + 1);
    g_plugins[slot].vt = vtable;
    return 0;
}

/* ── public API ──────────────────────────────────────────────────────── */

int32_t tension_solver_create(const tension_solver_config *config)
{
    tension_solver_params params;
    int builtin = -1;
    TsPlugin *plugin = NULL;
    int src;
    int slot;
    TsSolver *h;
    int32_t rc;

    if (config == NULL)
        return TS_EINVAL;
    if (config->method == NULL || config->method_len == 0)
        return TS_EINVAL;
    if (config->source == NULL || config->source_len == 0)
        return TS_EINVAL;
    if (config->parameters_bitmap & ~TS_PARAMETER_MASK_ALL)
        return TS_EINVAL; /* bits 9-31 are reserved and must be zero */
    if (config->dim > (uint32_t)TS_MAX_DIM)
        return TS_EINVAL; /* the resource bound the JSON era's dim had */

    /* Validate before any allocation (the header's rule). */
    rc = params_from_config(config, &params);
    if (rc != 0)
        return rc;

    builtin = find_builtin_n(config->method, config->method_len);
    if (builtin < 0) {
        plugin = find_plugin_n(config->method, config->method_len);
        if (plugin == NULL)
            return TS_ENOENT; /* unknown method */
    }

    src = find_source_n(config->source, config->source_len);
    if (src < 0)
        return TS_EINVAL;

    if (TS_SOURCE_REQUIRES_DIM[src] && config->dim == 0)
        return TS_EINVAL; /* the source's `requires` are unmet */

    if (builtin >= 0 && src == TS_SRC_NATIVE &&
        TS_SOURCE_NATIVE_REQUIRES_BUNDLES_RHS)
        return TS_EINVAL; /* built-ins have bundles_rhs: false */

    if (src == TS_SRC_WORLD && config->dim == 0) {
        /* World-sourced configs declare no `requires` (schema.yaml), but no
         * handle can be allocated without a dim. The host compiles the
         * embedded world, derives dim from the compiled header, and
         * synthesizes it into the struct before calling here (P8e); a config
         * that arrives without one did not come from that path. The wire's
         * own rule is the mirror image: a world-source config states no dim
         * (DESIGN.md §12), so a nonzero one is refused there. */
        return TS_EINVAL;
    }

    if (builtin >= 0 && builtin > TS_IMPLICIT_INDEX)
        return TS_ENOSYS; /* spook: constraint channel pending (DESIGN.md §10) */

    if (plugin != NULL && src == TS_SRC_NATIVE && plugin->vt->derivative == NULL)
        return TS_EINVAL; /* the plugin's f is missing for source: native */

    warn_ignored_parameters(builtin, config->parameters_bitmap);

    for (slot = 0; slot < TS_MAX_SOLVERS; slot++)
        if (!g_solvers[slot].used)
            break;
    if (slot == TS_MAX_SOLVERS)
        return TS_EMFILE;

    h = &g_solvers[slot];
    memset(h, 0, sizeof *h);
    h->dim = (int32_t)config->dim;
    h->source = src;
    h->is_plugin = (builtin < 0);
    h->builtin = builtin;
    h->plugin = plugin;
    h->params = params;

    h->y = (double *)calloc((size_t)h->dim, sizeof(double));
    if (h->y == NULL)
        return TS_ENOMEM;

    if (!h->is_plugin) {
        h->ws_slots = builtin_workspace_size(h->builtin, h->dim);
        if (h->ws_slots < 1) {
            free(h->y);
            h->y = NULL;
            return TS_EINVAL;
        }
    }
    if (h->ws_slots > 0) {
        h->ws = (double *)calloc((size_t)h->ws_slots, sizeof(double));
        if (h->ws == NULL) {
            free(h->y);
            h->y = NULL;
            return TS_ENOMEM;
        }
    }

    h->used = 1;
    h->t = 0.0;
    return (int32_t)(slot + 1);
}

int32_t tension_solver_bind_callbacks(int32_t id,
                                      tension_solver_derivative_fn derivative,
                                      tension_solver_validate_fn validate)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return TS_EBADF;
    if (h->stepped)
        return TS_EINVAL; /* rebinding mid-run would corrupt the integration */

    if (h->source == TS_SRC_WORLD || h->source == TS_SRC_WASM) {
        /* The two sources bind the same way: the RHS crosses as a function
         * pointer and the shim never learns where it came from (the wasm
         * trampoline or the host's world evaluator). A bind with nothing in
         * it would leave the step without an f. */
        if (derivative == NULL && validate == NULL)
            return TS_EINVAL;
        h->bound_derivative = derivative;
        h->bound_validate = validate;
        return 0;
    }

    /* source: native — the registered vtable carries the callbacks; a bind
     * is a documented no-op. */
    (void)derivative;
    (void)validate;
    return 0;
}

int32_t tension_solver_step(int32_t id, double dt)
{
    TsSolver *h = handle(id);
    int32_t rc;
    int32_t status = 0;

    if (h == NULL)
        return TS_EBADF;

    if (h->is_plugin) {
        h->stepped = 1;
        rc = h->plugin->vt->step(id, dt);
        if (rc == 0)
            h->t += dt; /* the same convention as the built-ins */
        return rc;
    }

    if ((h->source == TS_SRC_WASM || h->source == TS_SRC_WORLD) &&
        h->bound_derivative == NULL)
        return TS_EINVAL; /* step before bind_callbacks: no f to call */

    h->stepped = 1;
    switch (h->builtin) {
    case TS_EULER_INDEX:
        rc = tension_solver_euler_step(h->y, h->dim, h->t, dt, h->ws,
                                       h->bound_derivative, NULL, &h->params,
                                       &status);
        break;
    case TS_HEUN_INDEX:
        rc = tension_solver_heun_step(h->y, h->dim, h->t, dt, h->ws,
                                      h->bound_derivative, NULL, &h->params,
                                      &status);
        break;
    case TS_RK23_INDEX:
        rc = tension_solver_rk23_step(h->y, h->dim, h->t, dt, h->ws,
                                      h->bound_derivative, NULL, &h->params,
                                      &status);
        break;
    case TS_RK45_INDEX:
        rc = tension_solver_rk45_step(h->y, h->dim, h->t, dt, h->ws,
                                      h->bound_derivative, NULL, &h->params,
                                      &status);
        break;
    case TS_VERLET_INDEX:
        rc = tension_solver_verlet_step(h->y, h->dim, h->t, dt, h->ws,
                                        h->bound_derivative, NULL, &h->params,
                                        &status);
        break;
    case TS_IMPLICIT_INDEX:
        rc = tension_solver_implicit_euler_step(h->y, h->dim, h->t, dt, h->ws,
                                                h->bound_derivative, NULL,
                                                &h->params, &status);
        break;
    default:
        return TS_ENOSYS; /* spook: constraint channel pending (DESIGN.md §10) */
    }
    if (rc == 0)
        h->t += dt;
    return rc;
}

int32_t tension_solver_state(int32_t id, double *t_out, double *y_out,
                             int32_t y_cap)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return TS_EBADF;
    if (t_out == NULL || y_out == NULL || y_cap < h->dim)
        return TS_EINVAL;
    if (h->is_plugin && h->plugin->vt->state != NULL)
        return h->plugin->vt->state(id, t_out, y_out, y_cap);

    /* Default handling (and every built-in): the shim's own t and y.
     * A NULL vtable slot is an override that is not there, not an error. */
    *t_out = h->t;
    memcpy(y_out, h->y, (size_t)h->dim * sizeof(double));
    return h->dim;
}

int32_t tension_solver_set_state(int32_t id, double t, const double *y,
                                 int32_t y_len)
{
    TsSolver *h = handle(id);
    int32_t rc;

    if (h == NULL)
        return TS_EBADF;
    if (y == NULL || y_len != h->dim)
        return TS_EINVAL;
    if (h->is_plugin && h->plugin->vt->set_state != NULL) {
        rc = h->plugin->vt->set_state(id, t, y, y_len);
        if (rc == 0)
            h->t = t; /* keep get_time coherent with the restore */
        return rc;
    }

    /* Default handling (and every built-in): the shim's own y and t. */
    memcpy(h->y, y, (size_t)h->dim * sizeof(double));
    h->t = t;
    return 0;
}

void tension_solver_destroy(int32_t id)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return; /* never allocated, already destroyed, or out of range */

    if (h->is_plugin && h->plugin->vt->destroy != NULL)
        h->plugin->vt->destroy(id); /* NULL destroy: nothing to release */

    free(h->y);
    free(h->ws);
    memset(h, 0, sizeof *h);
}

/* ── plugin accessors ─────────────────────────────────────────────────── */
/*
 * The asks a plugin's step function may make of the shim (the header's
 * accessor section): dim, time, derivative, the state pointer, and the
 * opaque params pointer. The state pointer is the wrapping pattern's
 * heart — the shim owns one y vector per handle, and a plugin mutates it
 * in place, so a wrapper can hand a built-in step the same pointers the
 * shim would have used. Bad ids: -EBADF for get_dim/get_time, NULL for
 * get_derivative/get_state_ptr/get_params.
 */
int32_t tension_solver_get_dim(int32_t id)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return TS_EBADF;
    return h->dim;
}

double tension_solver_get_time(int32_t id)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return (double)TS_EBADF;
    return h->t;
}

tension_solver_derivative_fn tension_solver_get_derivative(int32_t id)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return NULL;
    return h->bound_derivative;
}

double *tension_solver_get_state_ptr(int32_t id)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return NULL;
    return h->y;
}

const void *tension_solver_get_params(int32_t id)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return NULL;
    return &h->params;
}
