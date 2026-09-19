/*
 * midpoint — the sample Tension plugin: RK2's midpoint method.
 *
 * The contract this file implements is the header's:
 * tension-solver/include/tension_solver.h, the register_backend comment
 * block and the accessor section. Read those before this file; read
 * README.md beside it for the walkthrough.
 *
 * The method (second order, and not among the built-ins):
 *   k1 = f(t, y)
 *   y_temp = y + (dt/2)·k1
 *   k2 = f(t + dt/2, y_temp)
 *   y += dt·k2
 *
 * The plugin is self-contained: it fetches its dim, time, state pointer
 * and derivative through the accessors, allocates its own workspace,
 * mutates the shim-owned y in place, and mutates nothing else. It leaves
 * state/set_state/destroy NULL — the shim's defaults apply.
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdlib.h>

#include "tension_solver.h"

static int32_t midpoint_step(int32_t id, double dt);

/*
 * The vtable. `derivative` is NULL: this plugin does not bundle an f, so
 * it works with whichever source supplies one (source: native would be
 * rejected at create — the pairing rule needs a bundled derivative).
 */
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

/*
 * The plugin's init. A host application calls this once before a config
 * can name `method: "midpoint"` (tension-core itself has no
 * load-from-disk; see README.md).
 *
 * Returns 0 on success, a negative errno otherwise (the shim's
 * registration rules: -EINVAL for a shadowing name, a kind/deterministic
 * mismatch, or a missing step).
 */
int32_t tension_plugin_register_midpoint(void)
{
    return tension_solver_register_backend(MIDPOINT_VTABLE.name,
                                           &MIDPOINT_VTABLE);
}

/*
 * One midpoint step. Panic-free and allocation-safe: every failure returns
 * a negative errno and leaves the state exactly as it was.
 */
static int32_t midpoint_step(int32_t id, double dt)
{
    int32_t dim;
    int32_t i;
    int32_t rc;
    double t;
    double *y;
    tension_solver_derivative_fn f;
    double *ka;
    double *stage;

    if (dt == 0.0)
        return 0; /* the no-op convention every backend shares */

    dim = tension_solver_get_dim(id);
    if (dim < 1)
        return -22; /* -EINVAL: no such solver */

    t = tension_solver_get_time(id);
    y = tension_solver_get_state_ptr(id);
    f = tension_solver_get_derivative(id);
    if (y == NULL || f == NULL)
        return -22; /* source: wasm must have bound its derivative first */

    ka = (double *)malloc((size_t)dim * sizeof(double));
    stage = (double *)malloc((size_t)dim * sizeof(double));
    if (ka == NULL || stage == NULL) {
        free(ka);
        free(stage);
        return -12; /* -ENOMEM */
    }

    /* k1 = f(t, y), into ka. */
    rc = f(y, dim, t, ka, dim);
    if (rc != 0)
        goto done;

    /* y_temp = y + (dt/2)·k1, into stage. */
    for (i = 0; i < dim; i++)
        stage[i] = y[i] + (dt / 2.0) * ka[i];

    /* k2 = f(t + dt/2, y_temp), into ka. */
    rc = f(stage, dim, t + dt / 2.0, ka, dim);
    if (rc != 0)
        goto done;

    /* y += dt·k2 — the shim's y, mutated in place. */
    for (i = 0; i < dim; i++)
        y[i] += dt * ka[i];
    rc = 0;

done:
    free(ka);
    free(stage);
    return rc;
}
