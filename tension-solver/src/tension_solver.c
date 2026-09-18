/*
 * tension_solver — the C ABI shim: handles, config, registry, dispatch.
 *
 * The numerical core lives in Fortran (tension_solver_erk.f90). This file
 * is the plumbing the plan put in C: JSON parse + validation, the handle
 * table, the method registry, errno mapping. It implements exactly the
 * surface declared in include/tension_solver.h and nothing else.
 *
 * The validation rules are compiled in, never loaded from schema.yaml at
 * runtime (the header says so; tests/solver_p2.rs cross-checks every rule
 * against the schema, and drift fails that test):
 *   - the seven built-in method names, only euler compiled in this build
 *   - the three source names and their `requires` (wasm/native need `dim`)
 *   - `bundles_rhs: false` for every built-in, and the pairing rule
 *     `source: native` requires `bundles_rhs: true` — so a built-in with
 *     `source: native` is rejected
 *   - the allowed top-level config keys (preset_format.allowed plus the
 *     required method/source pair) and the global parameter vocabulary
 *
 * `source: world` cannot be built yet: the RHS comes from the YAML world
 * compiler (tension-scene, phase 8), which does not exist. create answers
 * -ENOSYS — "not compiled into this build" — until P8 resolves it.
 *
 * SPDX-License-Identifier: MIT
 */
#include "tension_solver.h"
#include "solver_params.h"

#include <math.h>
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

/* parameters[] — the global vocabulary, numeric. */
static const char *const TS_PARAMETERS[] = {
    "relTol",    "absTol",  "minStep",        "maxStep",     "fixedStep",
    "iterations", "convergenceTol", "compliance", "relaxation",
};
#define TS_PARAMETER_COUNT ((int)(sizeof TS_PARAMETERS / sizeof TS_PARAMETERS[0]))

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

static int find_builtin(const char *name)
{
    int i;
    for (i = 0; i < TS_BUILTIN_COUNT; i++)
        if (strcmp(name, TS_BUILTINS[i]) == 0)
            return i;
    return -1;
}

static TsPlugin *find_plugin(const char *name)
{
    int i;
    for (i = 0; i < TS_MAX_PLUGINS; i++)
        if (g_plugins[i].used && strcmp(g_plugins[i].name, name) == 0)
            return &g_plugins[i];
    return NULL;
}

static int find_source(const char *name)
{
    int i;
    for (i = 0; i < TS_SOURCE_COUNT; i++)
        if (strcmp(name, TS_SOURCES[i]) == 0)
            return i;
    return -1;
}

static int find_parameter(const char *name)
{
    int i;
    for (i = 0; i < TS_PARAMETER_COUNT; i++)
        if (strcmp(name, TS_PARAMETERS[i]) == 0)
            return i;
    return -1;
}

/* ── config parsing (the documented subset) ──────────────────────────── */
/*
 * Accepted input: one flat JSON object; keys are the strings below; values
 * are string / number per key. `parameters` is the one nested object: its
 * keys are the global parameter names, its values numbers. Everything
 * else — arrays, null, booleans, nested objects beyond `parameters`,
 * duplicate keys, escapes beyond the standard short set, trailing bytes —
 * is -EINVAL. The parser allocates nothing.
 */

typedef struct {
    char method[TS_NAME_MAX];
    char source[16];
    int has_method;
    int has_source;
    int has_dim;
    int32_t dim;
    tension_solver_params params; /* schema defaults, overwritten by the
                                     `parameters` object when present */
} TsConfig;

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

/* Range checks after parsing: the schema's declared ranges ([0, inf] for
 * the five step/tolerance knobs) are advisory there; here they are a
 * floor that catches obviously wrong configs (a negative tolerance).
 * `iterations` has no declared range; negative counts are still a config
 * error. The step-size window must be non-empty — max_step < min_step
 * admits no admissible h, and a zero window admits no progress at all. */
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

static const char *skip_ws(const char *s, const char *end)
{
    while (s < end && (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r'))
        s++;
    return s;
}

/* Parse a JSON string; returns the position past the closing quote, or
 * NULL. Short escapes only (`\uXXXX` is outside the P2 subset). */
static const char *parse_string(const char *s, const char *end, char *out,
                                size_t cap)
{
    size_t n = 0;
    if (s >= end || *s != '"')
        return NULL;
    s++;
    while (s < end && *s != '"') {
        unsigned char c = (unsigned char)*s;
        if (c < 0x20)
            return NULL;
        if (c == '\\') {
            s++;
            if (s >= end)
                return NULL;
            switch (*s) {
            case '"': c = '"'; break;
            case '\\': c = '\\'; break;
            case '/': c = '/'; break;
            case 'b': c = '\b'; break;
            case 'f': c = '\f'; break;
            case 'n': c = '\n'; break;
            case 'r': c = '\r'; break;
            case 't': c = '\t'; break;
            default: return NULL;
            }
        }
        if (n + 1 >= cap)
            return NULL;
        out[n++] = (char)c;
        s++;
    }
    if (s >= end)
        return NULL;
    out[n] = '\0';
    return s + 1;
}

/* Parse a JSON number; returns the position after it, or NULL. */
static const char *parse_number(const char *s, const char *end, double *out)
{
    char buf[32];
    size_t n = 0;
    char *stop = NULL;
    const char *p = s;
    while (p < end && n < sizeof buf - 1 &&
           ((*p >= '0' && *p <= '9') || *p == '-' || *p == '+' ||
            *p == '.' || *p == 'e' || *p == 'E'))
        buf[n++] = *p++;
    if (n == 0)
        return NULL;
    buf[n] = '\0';
    *out = strtod(buf, &stop);
    if (stop == NULL || *stop != '\0' || !isfinite(*out))
        return NULL;
    return p;
}

/* parameters: { <known-name>: <number>, ... } — values are stored into
 * `out`, which starts from the schema defaults. */
static const char *parse_parameters(const char *s, const char *end,
                                    tension_solver_params *out)
{
    const char *p = s;
    unsigned seen = 0;
    if (p >= end || *p != '{')
        return NULL;
    p = skip_ws(p + 1, end);
    if (p < end && *p == '}') {
        p++;
        return p;
    }
    for (;;) {
        char key[TS_NAME_MAX];
        double v;
        int idx;
        p = skip_ws(p, end);
        p = parse_string(p, end, key, sizeof key);
        if (p == NULL)
            return NULL;
        idx = find_parameter(key);
        if (idx < 0)
            return NULL;
        if (seen & (1u << idx))
            return NULL;
        seen |= 1u << idx;
        p = skip_ws(p, end);
        if (p >= end || *p != ':')
            return NULL;
        p = skip_ws(p + 1, end);
        p = parse_number(p, end, &v);
        if (p == NULL)
            return NULL;
        switch (idx) {
        case 0: out->rel_tol = v; break;
        case 1: out->abs_tol = v; break;
        case 2: out->min_step = v; break;
        case 3: out->max_step = v; break;
        case 4: out->fixed_step = v; break;
        case 5:
            /* the one integer field: integer-valued and non-negative */
            if (v < 0.0 || v > 2147483647.0 || v != (double)(int32_t)v)
                return NULL;
            out->iterations = (int32_t)v;
            break;
        case 6: out->convergence_tol = v; break;
        case 7: out->compliance = v; break;
        case 8: out->relaxation = v; break;
        default: return NULL; /* unreachable: find_parameter bounds idx */
        }
        p = skip_ws(p, end);
        if (p < end && *p == ',') {
            p++;
            continue;
        }
        if (p < end && *p == '}') {
            p++;
            return p;
        }
        return NULL;
    }
}

static int32_t parse_config(const char *s, size_t len, TsConfig *cfg)
{
    const char *end = s + len;
    const char *p = skip_ws(s, end);
    unsigned seen = 0;

    memset(cfg, 0, sizeof *cfg);
    cfg->params = params_defaults();
    if (p >= end || *p != '{')
        return TS_EINVAL;
    p = skip_ws(p + 1, end);
    if (p < end && *p == '}') {
        p++;
    } else {
        for (;;) {
            char key[TS_NAME_MAX];
            p = skip_ws(p, end);
            p = parse_string(p, end, key, sizeof key);
            if (p == NULL)
                return TS_EINVAL;
            p = skip_ws(p, end);
            if (p >= end || *p != ':')
                return TS_EINVAL;
            p = skip_ws(p + 1, end);

            if (strcmp(key, "method") == 0) {
                if (seen & 1u)
                    return TS_EINVAL;
                seen |= 1u;
                p = parse_string(p, end, cfg->method, sizeof cfg->method);
                if (p == NULL)
                    return TS_EINVAL;
                cfg->has_method = 1;
            } else if (strcmp(key, "source") == 0) {
                if (seen & 2u)
                    return TS_EINVAL;
                seen |= 2u;
                p = parse_string(p, end, cfg->source, sizeof cfg->source);
                if (p == NULL)
                    return TS_EINVAL;
                cfg->has_source = 1;
            } else if (strcmp(key, "dim") == 0) {
                double d;
                if (seen & 4u)
                    return TS_EINVAL;
                seen |= 4u;
                p = parse_number(p, end, &d);
                if (p == NULL)
                    return TS_EINVAL;
                if (d < 1.0 || d > (double)TS_MAX_DIM || d != (double)(int32_t)d)
                    return TS_EINVAL;
                cfg->dim = (int32_t)d;
                cfg->has_dim = 1;
            } else if (strcmp(key, "dt") == 0) {
                /* preset_format.allowed; the runtime takes dt per step() */
                double d;
                if (seen & 8u)
                    return TS_EINVAL;
                seen |= 8u;
                p = parse_number(p, end, &d);
                if (p == NULL)
                    return TS_EINVAL;
            } else if (strcmp(key, "description") == 0) {
                char tmp[256];
                if (seen & 16u)
                    return TS_EINVAL;
                seen |= 16u;
                p = parse_string(p, end, tmp, sizeof tmp);
                if (p == NULL)
                    return TS_EINVAL;
            } else if (strcmp(key, "parameters") == 0) {
                if (seen & 32u)
                    return TS_EINVAL;
                seen |= 32u;
                p = parse_parameters(p, end, &cfg->params);
                if (p == NULL)
                    return TS_EINVAL;
            } else {
                return TS_EINVAL; /* key outside preset_format.allowed */
            }

            p = skip_ws(p, end);
            if (p < end && *p == ',') {
                p++;
                continue;
            }
            if (p < end && *p == '}') {
                p++;
                break;
            }
            return TS_EINVAL;
        }
    }
    p = skip_ws(p, end);
    if (p != end)
        return TS_EINVAL; /* trailing bytes */
    return 0;
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

int32_t tension_solver_create(const char *config_json, size_t config_len)
{
    TsConfig cfg;
    int builtin = -1;
    TsPlugin *plugin = NULL;
    int src;
    int slot;
    TsSolver *h;
    int32_t rc;

    if (config_json == NULL || config_len == 0)
        return TS_EINVAL;

    /* Parse and validate before any allocation (the header's rule). */
    rc = parse_config(config_json, config_len, &cfg);
    if (rc != 0)
        return rc;
    if (!cfg.has_method || !cfg.has_source)
        return TS_EINVAL;
    rc = params_validate(&cfg.params);
    if (rc != 0)
        return rc;

    builtin = find_builtin(cfg.method);
    if (builtin < 0) {
        plugin = find_plugin(cfg.method);
        if (plugin == NULL)
            return TS_ENOENT; /* unknown method */
    }

    src = find_source(cfg.source);
    if (src < 0)
        return TS_EINVAL;

    if (TS_SOURCE_REQUIRES_DIM[src] && !cfg.has_dim)
        return TS_EINVAL; /* the source's `requires` are unmet */

    if (builtin >= 0 && src == TS_SRC_NATIVE &&
        TS_SOURCE_NATIVE_REQUIRES_BUNDLES_RHS)
        return TS_EINVAL; /* built-ins have bundles_rhs: false */

    if (src == TS_SRC_WORLD) {
        /* The RHS comes from the YAML world compiler (tension-scene), which
         * does not exist yet; P8 resolves source: world. Until then no
         * world-sourced config can be built. */
        return TS_ENOSYS;
    }

    if (builtin >= 0 && builtin > TS_IMPLICIT_INDEX)
        return TS_ENOSYS; /* spook: constraint channel pending (DESIGN.md §10) */

    if (plugin != NULL && src == TS_SRC_NATIVE && plugin->vt->derivative == NULL)
        return TS_EINVAL; /* the plugin's f is missing for source: native */

    for (slot = 0; slot < TS_MAX_SOLVERS; slot++)
        if (!g_solvers[slot].used)
            break;
    if (slot == TS_MAX_SOLVERS)
        return TS_EMFILE;

    h = &g_solvers[slot];
    memset(h, 0, sizeof *h);
    h->dim = cfg.dim;
    h->source = src;
    h->is_plugin = (builtin < 0);
    h->builtin = builtin;
    h->plugin = plugin;
    h->params = cfg.params;

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

    if (h->source == TS_SRC_WORLD) {
        /* No callback crosses the boundary; the guard stays for P8, when
         * world-sourced handles can exist. */
        if (derivative != NULL || validate != NULL)
            return TS_EINVAL;
        return 0;
    }
    if (h->source == TS_SRC_WASM) {
        if (derivative == NULL && validate == NULL)
            return TS_EINVAL; /* nothing bound; the step would have no f */
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
        return h->plugin->vt->step(id, dt);
    }

    if (h->source == TS_SRC_WASM && h->bound_derivative == NULL)
        return TS_EINVAL; /* step before bind_callbacks */

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

    *t_out = h->t;
    memcpy(y_out, h->y, (size_t)h->dim * sizeof(double));
    return h->dim;
}

int32_t tension_solver_set_state(int32_t id, double t, const double *y,
                                 int32_t y_len)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return TS_EBADF;
    if (y == NULL || y_len != h->dim)
        return TS_EINVAL;

    memcpy(h->y, y, (size_t)h->dim * sizeof(double));
    h->t = t;
    return 0;
}

void tension_solver_destroy(int32_t id)
{
    TsSolver *h = handle(id);

    if (h == NULL)
        return; /* never allocated, already destroyed, or out of range */

    free(h->y);
    free(h->ws);
    memset(h, 0, sizeof *h);
}
