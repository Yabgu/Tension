/*
 * tension-solver — the numeric parameter block, C mirror of the Fortran
 * bind(C) type `tension_solver_params` in tension_solver_erk.f90.
 *
 * Private to the build: not installed, and not part of the public ABI
 * (include/tension_solver.h). The shim fills this struct from the config's
 * `parameters` object and passes a pointer to it through the `params`
 * c_ptr of every step wrapper; the Fortran side casts that pointer back to
 * its own type. The two declarations must therefore stay in lockstep —
 * field for field, in order, and in width — because a layout drift is
 * silent corruption of every tolerance rather than a compile error.
 *
 * The size assertion below is the tripwire. 72 bytes = five doubles, one
 * int32 plus four bytes of padding, three more doubles, on every LP64 ABI
 * this project builds on; gfortran's `storage_size` and cc's `sizeof` were
 * both probed at 72 when this file was written. If the two ever diverge,
 * this fails the build here — and test T3 (a tighter rel_tol must cost
 * more RHS evaluations) would fail loudly at runtime in any case.
 * (_Static_assert is a C11 spelling; the pinned gcc accepts it under
 * -std=c99, probed at P3.)
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_SOLVER_PARAMS_H
#define TENSION_SOLVER_PARAMS_H

#include <stdint.h>

typedef struct tension_solver_params {
    double  rel_tol;         /* schema relTol — read by rk23/rk45 */
    double  abs_tol;         /* schema absTol — read by rk23/rk45 */
    double  min_step;        /* schema minStep — read by rk23/rk45 */
    double  max_step;        /* schema maxStep — read by rk23/rk45 */
    double  fixed_step;      /* schema fixedStep — read by verlet (P6) */
    int32_t iterations;      /* schema iterations — read by implicit methods (P6) */
    double  convergence_tol; /* schema convergenceTol — read by implicit methods (P6) */
    double  compliance;      /* schema compliance — read by spook (P6) */
    double  relaxation;      /* schema relaxation — read by spook (P6) */
} tension_solver_params;

_Static_assert(sizeof(tension_solver_params) == 72,
               "tension_solver_params drifted from the Fortran bind(C) type");

#endif /* TENSION_SOLVER_PARAMS_H */
