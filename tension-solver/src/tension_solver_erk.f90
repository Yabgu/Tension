! tension_solver_erk — the explicit Runge-Kutta family, numerical core.
!
! Phase 3 completes the family: euler (phase 1), heun, rk23, rk45. One
! table-driven trial loop (`erk_trial`) and one private adaptive
! controller (`erk_adaptive`) serve every method; adding a method means
! adding its Butcher-table PARAMETER data and a thin bind(C) wrapper,
! never another copy of the loop.
!
! Workspace arithmetic. `erk_workspace_slots(s, dim)` = s·dim slots for
! the stage vectors, plus one dim-slot scratch for the stage-state when
! s > 1. (s = 1 keeps the phase-1 size: its single stage vector doubles
! as the trial output, since a one-stage trial's k1 is dead once the
! trial solution is formed.) The embedded stage of the adaptive pair is
! one of the s stage vectors, so heun needs 3·dim, rk23 (4 stages, one
! of them FSAL) needs 5·dim, and rk45 (7 stages, one of them FSAL)
! needs 8·dim. The phase-3 brief listed 2·dim for heun and 3·dim+dim
! for rk23; those numbers leave no room for the scratch vector the
! shared trial loop requires (and rk23's count omits its FSAL stage).
! The generic formula the brief asked to confirm against is what these
! methods use — see DESIGN.md §7.
!
! There is no module-level SAVE state anywhere in this file. Every
! mutable value lives in the caller's state and workspace arrays, which
! is what lets two solvers share one process without contaminating each
! other (DESIGN.md §4), and what makes the interleaving test a
! structural proof rather than a promise.
module tension_solver_erk
  use iso_c_binding
  implicit none
  private

  ! The schema's parameter block, bind(C): one struct for every method.
  ! Each method reads the subset it needs and ignores the rest — the
  ! config-object discipline at the ABI (DESIGN.md §7). Defaults are
  ! applied by the C shim, not here. The C mirror in
  ! src/solver_params.h must match this type field for field and in
  ! order; it carries a size assertion.
  type, bind(C), public :: tension_solver_params
     real(c_double)     :: rel_tol
     real(c_double)     :: abs_tol
     real(c_double)     :: min_step
     real(c_double)     :: max_step
     real(c_double)     :: fixed_step
     integer(c_int32_t) :: iterations
     real(c_double)     :: convergence_tol
     real(c_double)     :: compliance
     real(c_double)     :: relaxation
  end type tension_solver_params

  ! The RHS callback, exactly the shape of tension_solver_derivative_fn in
  ! tension_solver.h:
  !   int32_t (*)(const double *y, int32_t len, double t,
  !               double *dy, int32_t dy_cap)
  abstract interface
     function tension_rhs_iface(y, len, t, dy, dy_cap) bind(C) result(rc)
       import :: c_double, c_int32_t
       real(c_double), intent(in)  :: y(*)
       integer(c_int32_t), value   :: len
       real(c_double), value       :: t
       real(c_double), intent(out) :: dy(*)
       integer(c_int32_t), value   :: dy_cap
       integer(c_int32_t)          :: rc
     end function tension_rhs_iface
  end interface

  ! ── Butcher tables (compile-time PARAMETER data) ──────────────────────
  ! A is row-major flattened (s×s): a_ij = A((i-1)*s + j). Fractions are
  ! written as literal quotients and folded by the compiler.

  ! euler, one stage: k1 = f(t, y);  y += dt·k1
  integer(c_int32_t), parameter :: EULER_STAGES = 1
  real(c_double), parameter :: EULER_A(1) = [0.0_c_double]
  real(c_double), parameter :: EULER_B(1) = [1.0_c_double]
  real(c_double), parameter :: EULER_C(1) = [0.0_c_double]

  ! heun — the explicit trapezoid (2 stages, order 2; any standard ODE
  ! text, e.g. Hairer, Nørsett & Wanner, Solving Ordinary Differential
  ! Equations I, §II.1). Fixed-step: no embedded pair.
  integer(c_int32_t), parameter :: HEUN_STAGES = 2
  real(c_double), parameter :: HEUN_A(4) = [ &
       0.0_c_double, 0.0_c_double, &
       1.0_c_double, 0.0_c_double]
  real(c_double), parameter :: HEUN_B(2) = [0.5_c_double, 0.5_c_double]
  real(c_double), parameter :: HEUN_C(2) = [0.0_c_double, 1.0_c_double]

  ! rk23 — Bogacki & Shampine, "A 3(2) pair of Runge-Kutta formulas",
  ! Applied Mathematics Letters 2(4), 321–325, 1989 (the pair behind
  ! MATLAB's ode23). Stage 4 is FSAL: a_4j = b_j and c4 = 1, so the
  ! stage-4 evaluation is f at the trial solution, and the embedded
  ! order-2 solution b_hat uses it.
  integer(c_int32_t), parameter :: RK23_STAGES = 4
  real(c_double), parameter :: RK23_A(16) = [ &
       0.0_c_double, 0.0_c_double, 0.0_c_double, 0.0_c_double, &
       1.0_c_double/2.0_c_double, 0.0_c_double, 0.0_c_double, 0.0_c_double, &
       0.0_c_double, 3.0_c_double/4.0_c_double, 0.0_c_double, 0.0_c_double, &
       2.0_c_double/9.0_c_double, 1.0_c_double/3.0_c_double, &
       4.0_c_double/9.0_c_double, 0.0_c_double]
  real(c_double), parameter :: RK23_B(4) = [ &
       2.0_c_double/9.0_c_double, 1.0_c_double/3.0_c_double, &
       4.0_c_double/9.0_c_double, 0.0_c_double]
  real(c_double), parameter :: RK23_B_HAT(4) = [ &
       7.0_c_double/24.0_c_double, 1.0_c_double/4.0_c_double, &
       1.0_c_double/3.0_c_double, 1.0_c_double/8.0_c_double]
  real(c_double), parameter :: RK23_C(4) = [ &
       0.0_c_double, 1.0_c_double/2.0_c_double, &
       3.0_c_double/4.0_c_double, 1.0_c_double]

  ! rk45 — Dormand & Prince, "A family of embedded Runge-Kutta formulae",
  ! Journal of Computational and Applied Mathematics 6(1), 19–26, 1980
  ! (the pair behind MATLAB's ode45). Stage 7 is FSAL: a_7j = b_j and
  ! c7 = 1.
  integer(c_int32_t), parameter :: RK45_STAGES = 7
  real(c_double), parameter :: RK45_A(49) = [ &
       0.0_c_double, 0.0_c_double, 0.0_c_double, 0.0_c_double, &
       0.0_c_double, 0.0_c_double, 0.0_c_double, &
       1.0_c_double/5.0_c_double, 0.0_c_double, 0.0_c_double, &
       0.0_c_double, 0.0_c_double, 0.0_c_double, 0.0_c_double, &
       3.0_c_double/40.0_c_double, 9.0_c_double/40.0_c_double, &
       0.0_c_double, 0.0_c_double, 0.0_c_double, 0.0_c_double, 0.0_c_double, &
       44.0_c_double/45.0_c_double, -56.0_c_double/15.0_c_double, &
       32.0_c_double/9.0_c_double, 0.0_c_double, 0.0_c_double, &
       0.0_c_double, 0.0_c_double, &
       19372.0_c_double/6561.0_c_double, -25360.0_c_double/2187.0_c_double, &
       64448.0_c_double/6561.0_c_double, -212.0_c_double/729.0_c_double, &
       0.0_c_double, 0.0_c_double, 0.0_c_double, &
       9017.0_c_double/3168.0_c_double, -355.0_c_double/33.0_c_double, &
       46732.0_c_double/5247.0_c_double, 49.0_c_double/176.0_c_double, &
       -5103.0_c_double/18656.0_c_double, 0.0_c_double, 0.0_c_double, &
       35.0_c_double/384.0_c_double, 0.0_c_double, &
       500.0_c_double/1113.0_c_double, 125.0_c_double/192.0_c_double, &
       -2187.0_c_double/6784.0_c_double, 11.0_c_double/84.0_c_double, &
       0.0_c_double]
  real(c_double), parameter :: RK45_B(7) = [ &
       35.0_c_double/384.0_c_double, 0.0_c_double, &
       500.0_c_double/1113.0_c_double, 125.0_c_double/192.0_c_double, &
       -2187.0_c_double/6784.0_c_double, 11.0_c_double/84.0_c_double, &
       0.0_c_double]
  real(c_double), parameter :: RK45_B_HAT(7) = [ &
       5179.0_c_double/57600.0_c_double, 0.0_c_double, &
       7571.0_c_double/16695.0_c_double, 393.0_c_double/640.0_c_double, &
       -92097.0_c_double/339200.0_c_double, 187.0_c_double/2100.0_c_double, &
       1.0_c_double/40.0_c_double]
  real(c_double), parameter :: RK45_C(7) = [ &
       0.0_c_double, 1.0_c_double/5.0_c_double, &
       3.0_c_double/10.0_c_double, 4.0_c_double/5.0_c_double, &
       8.0_c_double/9.0_c_double, 1.0_c_double, 1.0_c_double]

  ! Placeholder for methods without an embedded pair (the dummy is never
  ! read when has_hat is false).
  real(c_double), parameter :: ERK_NO_HAT(1) = [0.0_c_double]

  ! The adaptive controller's safety factor: 0.9 leaves a ~10 % margin on
  ! every accepted trial, the standard practice (a controller without one
  ! hunts; see the error-per-step discussion in Hairer et al., or any
  ! production ODE suite's default).
  real(c_double), parameter :: ERK_SAFETY = 0.9_c_double

  integer(c_int32_t), parameter :: EULER_ORDER = 1
  integer(c_int32_t), parameter :: HEUN_ORDER = 2
  integer(c_int32_t), parameter :: RK23_ORDER = 3
  integer(c_int32_t), parameter :: RK45_ORDER = 5

  public :: tension_solver_euler_workspace_size, tension_solver_euler_step, &
       tension_solver_heun_workspace_size, tension_solver_heun_step, &
       tension_solver_rk23_workspace_size, tension_solver_rk23_step, &
       tension_solver_rk45_workspace_size, tension_solver_rk45_step

contains

  ! Workspace slots for an s-stage explicit RK over `dim` state variables:
  ! s stage vectors, plus one stage-state scratch vector when s > 1.
  pure function erk_workspace_slots(s, dim) result(n)
    integer(c_int32_t), intent(in) :: s
    integer(c_int32_t), intent(in) :: dim
    integer(c_int32_t) :: n
    n = s*dim
    if (s > 1) n = n + dim
  end function erk_workspace_slots

  ! Where a trial writes its solution: the scratch block when s > 1, or
  ! the single stage vector when s == 1 (dead by then — see the module
  ! header).
  pure function erk_out_offset(s, dim) result(off)
    integer(c_int32_t), intent(in) :: s
    integer(c_int32_t), intent(in) :: dim
    integer(c_int32_t) :: off
    if (s == 1_c_int32_t) then
       off = 1_c_int32_t
    else
       off = s*dim + 1_c_int32_t
    end if
  end function erk_out_offset

  ! One trial step: evaluate all s stages, form the trial solution in the
  ! output block, and (when the table carries an embedded pair) the scaled
  ! RMS error estimate. `y` is not modified — the caller commits the
  ! output block or rejects the trial; that split is what makes the
  ! adaptive controller's rejections free of rollback.
  !
  !   ws layout: k_i at ws((i-1)*dim + 1 : i*dim); scratch (stage state,
  !   then the trial solution) at ws(s*dim + 1 : s*dim + dim) when s > 1;
  !   for s == 1 the trial solution lands in slot 1.
  !   k1_ready: ws(1:dim) already holds f(t, y) (FSAL reuse or retry).
  !   err: scaled RMS, 0 when has_hat is false.
  !   rc:  0, or the RHS's own nonzero return propagated unchanged.
  subroutine erk_trial(s, a, b, b_hat, has_hat, c, dim, y, t, h, ws, rhs, &
       k1_ready, rel_tol, abs_tol, evals, err, rc)
    integer(c_int32_t), intent(in) :: s
    real(c_double), intent(in) :: a(*)
    real(c_double), intent(in) :: b(*)
    real(c_double), intent(in) :: b_hat(*)
    logical, intent(in) :: has_hat
    real(c_double), intent(in) :: c(*)
    integer(c_int32_t), intent(in) :: dim
    real(c_double), intent(in) :: y(*)
    real(c_double), intent(in) :: t
    real(c_double), intent(in) :: h
    real(c_double), intent(inout) :: ws(*)
    procedure(tension_rhs_iface), pointer :: rhs
    logical, intent(in) :: k1_ready
    real(c_double), intent(in) :: rel_tol
    real(c_double), intent(in) :: abs_tol
    integer(c_int32_t), intent(out) :: evals
    real(c_double), intent(out) :: err
    integer(c_int32_t), intent(out) :: rc

    integer(c_int32_t) :: i, j, d, out_off
    real(c_double) :: acc, ed, sc, r, sum2

    evals = 0_c_int32_t
    err = 0.0_c_double
    rc = 0_c_int32_t
    out_off = erk_out_offset(s, dim)

    do i = 1_c_int32_t, s
       if (i == 1_c_int32_t) then
          if (.not. k1_ready) then
             rc = rhs(y, dim, t, ws(1), dim)
             evals = evals + 1_c_int32_t
             if (rc /= 0_c_int32_t) return
          end if
       else
          do d = 1_c_int32_t, dim
             acc = 0.0_c_double
             do j = 1_c_int32_t, i - 1_c_int32_t
                acc = acc + a((i - 1_c_int32_t)*s + j)*ws((j - 1_c_int32_t)*dim + d)
             end do
             ws(s*dim + d) = y(d) + h*acc
          end do
          rc = rhs(ws(s*dim + 1), dim, t + c(i)*h, ws((i - 1_c_int32_t)*dim + 1), dim)
          evals = evals + 1_c_int32_t
          if (rc /= 0_c_int32_t) return
       end if
    end do

    do d = 1_c_int32_t, dim
       acc = 0.0_c_double
       do i = 1_c_int32_t, s
          acc = acc + b(i)*ws((i - 1_c_int32_t)*dim + d)
       end do
       ws(out_off + d - 1_c_int32_t) = y(d) + h*acc
    end do

    if (has_hat) then
       sum2 = 0.0_c_double
       do d = 1_c_int32_t, dim
          acc = 0.0_c_double
          do i = 1_c_int32_t, s
             acc = acc + (b(i) - b_hat(i))*ws((i - 1_c_int32_t)*dim + d)
          end do
          ed = abs(h*acc)
          sc = abs_tol + rel_tol*max(abs(y(d)), abs(ws(out_off + d - 1_c_int32_t)))
          if (sc > 0.0_c_double) then
             r = ed/sc
          else if (ed == 0.0_c_double) then
             r = 0.0_c_double
          else
             r = huge(1.0_c_double)
          end if
          sum2 = sum2 + r*r
       end do
       err = sqrt(sum2/real(dim, c_double))
    end if
  end subroutine erk_trial

  ! The adaptive controller: advance y by exactly dt (signed) using as
  ! many trial substeps of the embedded pair as the tolerances demand.
  ! The trial step size starts at min(max_step, |remaining|) and follows
  ! the standard error-per-step rule
  !     h_new = |h| · ERK_SAFETY · err^(-1/(order+1)),
  ! clamped to [min_step, max_step]; a rejection recomputes from the
  ! unchanged state (k1 stays valid), an acceptance may carry k_s into
  ! k1 (FSAL). If the error still exceeds tolerance while h_new would
  ! fall below min_step, the step cannot satisfy its own limits and the
  ! controller reports -EIO. Deterministic: no randomness, no clock, no
  ! hidden state.
  subroutine erk_adaptive(s, a, b, b_hat, c, order, fsal, dim, y, t, dt, &
       ws, rhs, rel_tol, abs_tol, min_step, max_step, evals, rc)
    integer(c_int32_t), intent(in) :: s
    real(c_double), intent(in) :: a(*)
    real(c_double), intent(in) :: b(*)
    real(c_double), intent(in) :: b_hat(*)
    real(c_double), intent(in) :: c(*)
    integer(c_int32_t), intent(in) :: order
    logical, intent(in) :: fsal
    integer(c_int32_t), intent(in) :: dim
    real(c_double), intent(inout) :: y(*)
    real(c_double), intent(in) :: t
    real(c_double), intent(in) :: dt
    real(c_double), intent(inout) :: ws(*)
    procedure(tension_rhs_iface), pointer :: rhs
    real(c_double), intent(in) :: rel_tol
    real(c_double), intent(in) :: abs_tol
    real(c_double), intent(in) :: min_step
    real(c_double), intent(in) :: max_step
    integer(c_int32_t), intent(out) :: evals
    integer(c_int32_t), intent(out) :: rc

    real(c_double) :: remaining, h, hmag, hnew, tloc, err, sgn
    real(c_double) :: texp
    integer(c_int32_t) :: trc, tevals, d
    logical :: k1_ready

    evals = 0_c_int32_t
    rc = 0_c_int32_t
    texp = 1.0_c_double/real(order + 1_c_int32_t, c_double)
    remaining = dt
    sgn = sign(1.0_c_double, dt)
    hmag = min(max_step, abs(remaining))
    tloc = t
    k1_ready = .false.

    do
       h = sgn*min(hmag, abs(remaining))
       if (h == 0.0_c_double) then
          rc = -5_c_int32_t
          return
       end if
       call erk_trial(s, a, b, b_hat, .true., c, dim, y, tloc, h, ws, rhs, &
            k1_ready, rel_tol, abs_tol, tevals, err, trc)
       evals = evals + tevals
       if (trc /= 0_c_int32_t) then
          rc = trc
          return
       end if

       if (.not. (err <= 1.0_c_double)) then
          ! rejected: shrink, or report that the window cannot satisfy it
          hnew = abs(h)*ERK_SAFETY*err**(-texp)
          if (hnew < min_step .or. .not. (hnew > 0.0_c_double)) then
             rc = -5_c_int32_t
             return
          end if
          hmag = min(max(hnew, min_step), max_step)
          k1_ready = .true.
          cycle
       end if

       ! accepted: commit the trial and continue
       do d = 1_c_int32_t, dim
          y(d) = ws(s*dim + d)
       end do
       tloc = tloc + h
       remaining = remaining - h
       if (remaining == 0.0_c_double) return

       if (err > 0.0_c_double) then
          hnew = abs(h)*ERK_SAFETY*err**(-texp)
       else
          hnew = max_step
       end if
       hmag = min(max(hnew, min_step), max_step)

       if (fsal) then
          ! k_s is f at the accepted point: the next trial's stage 1
          do d = 1_c_int32_t, dim
             ws(d) = ws((s - 1_c_int32_t)*dim + d)
          end do
          k1_ready = .true.
       else
          k1_ready = .false.
       end if
    end do
  end subroutine erk_adaptive

  ! ── workspace sizes ───────────────────────────────────────────────────

  ! Workspace slots the euler step needs for `dim` state variables.
  ! dim < 1 needs none (and is rejected by the step).
  function tension_solver_euler_workspace_size(dim) &
       bind(C, name="tension_solver_euler_workspace_size") result(n)
    integer(c_int32_t), value :: dim
    integer(c_int32_t) :: n
    if (dim < 1_c_int32_t) then
       n = 0_c_int32_t
       return
    end if
    n = erk_workspace_slots(EULER_STAGES, dim)
  end function tension_solver_euler_workspace_size

  function tension_solver_heun_workspace_size(dim) &
       bind(C, name="tension_solver_heun_workspace_size") result(n)
    integer(c_int32_t), value :: dim
    integer(c_int32_t) :: n
    if (dim < 1_c_int32_t) then
       n = 0_c_int32_t
       return
    end if
    n = erk_workspace_slots(HEUN_STAGES, dim)
  end function tension_solver_heun_workspace_size

  function tension_solver_rk23_workspace_size(dim) &
       bind(C, name="tension_solver_rk23_workspace_size") result(n)
    integer(c_int32_t), value :: dim
    integer(c_int32_t) :: n
    if (dim < 1_c_int32_t) then
       n = 0_c_int32_t
       return
    end if
    n = erk_workspace_slots(RK23_STAGES, dim)
  end function tension_solver_rk23_workspace_size

  function tension_solver_rk45_workspace_size(dim) &
       bind(C, name="tension_solver_rk45_workspace_size") result(n)
    integer(c_int32_t), value :: dim
    integer(c_int32_t) :: n
    if (dim < 1_c_int32_t) then
       n = 0_c_int32_t
       return
    end if
    n = erk_workspace_slots(RK45_STAGES, dim)
  end function tension_solver_rk45_workspace_size

  ! ── step wrappers ─────────────────────────────────────────────────────

  ! Advance the state by one euler step:
  !   tension_solver_euler_step(state, dim, t, dt, workspace,
  !                             rhs_fn, rhs_ctx, params, status) -> i32
  !
  ! `state` is updated in place — the solver owns it and the callback
  ! receives the pointer directly. `workspace` is the caller-allocated f64
  ! array sized by tension_solver_euler_workspace_size(dim). `rhs_fn` is
  ! the header's tension_solver_derivative_fn. `rhs_ctx` is a reserved
  ! slot (the derivative callback carries no user-data argument), and
  ! `params` is accepted but unread — euler is fixed-step (the shim now
  ! passes the real parameter struct; it is simply not consulted).
  !
  ! `status` (out): the number of RHS evaluations performed by this step
  ! on success (euler: 1); 0 on failure.
  !
  ! Returns 0, or a negative errno: -EINVAL (-22) for dim < 1 or a NULL
  ! rhs_fn; otherwise the RHS's own nonzero return, propagated unchanged.
  ! A dt of exactly zero is a no-op: nothing is evaluated, and the state
  ! is left bit for bit as it was.
  function tension_solver_euler_step(state, dim, t, dt, workspace, &
       rhs_fn, rhs_ctx, params, status) &
       bind(C, name="tension_solver_euler_step") result(rc)
    real(c_double), intent(inout) :: state(*)
    integer(c_int32_t), value :: dim
    real(c_double), value :: t
    real(c_double), value :: dt
    real(c_double), intent(inout) :: workspace(*)
    type(c_funptr), value :: rhs_fn
    type(c_ptr), value :: rhs_ctx
    type(c_ptr), value :: params
    integer(c_int32_t), intent(out) :: status
    integer(c_int32_t) :: rc

    procedure(tension_rhs_iface), pointer :: rhs
    integer(c_int32_t) :: evals, d
    real(c_double) :: err

    status = 0_c_int32_t

    if (dim < 1_c_int32_t) then
       rc = -22_c_int32_t
       return
    end if

    call c_f_procpointer(rhs_fn, rhs)
    if (.not. associated(rhs)) then
       rc = -22_c_int32_t
       return
    end if

    if (dt == 0.0_c_double) then
       rc = 0_c_int32_t
       return
    end if

    call erk_trial(EULER_STAGES, EULER_A, EULER_B, ERK_NO_HAT, .false., &
         EULER_C, dim, state, t, dt, workspace, rhs, .false., &
         0.0_c_double, 0.0_c_double, evals, err, rc)
    if (rc == 0_c_int32_t) then
       do d = 1_c_int32_t, dim
          state(d) = workspace(d)
       end do
       status = evals
    end if
  end function tension_solver_euler_step

  ! heun: one fixed step of the explicit trapezoid (no error control, no
  ! parameters consulted — passing different tolerances changes nothing).
  function tension_solver_heun_step(state, dim, t, dt, workspace, &
       rhs_fn, rhs_ctx, params, status) &
       bind(C, name="tension_solver_heun_step") result(rc)
    real(c_double), intent(inout) :: state(*)
    integer(c_int32_t), value :: dim
    real(c_double), value :: t
    real(c_double), value :: dt
    real(c_double), intent(inout) :: workspace(*)
    type(c_funptr), value :: rhs_fn
    type(c_ptr), value :: rhs_ctx
    type(c_ptr), value :: params
    integer(c_int32_t), intent(out) :: status
    integer(c_int32_t) :: rc

    procedure(tension_rhs_iface), pointer :: rhs
    integer(c_int32_t) :: evals, d
    real(c_double) :: err

    status = 0_c_int32_t

    if (dim < 1_c_int32_t) then
       rc = -22_c_int32_t
       return
    end if

    call c_f_procpointer(rhs_fn, rhs)
    if (.not. associated(rhs)) then
       rc = -22_c_int32_t
       return
    end if

    if (dt == 0.0_c_double) then
       rc = 0_c_int32_t
       return
    end if

    call erk_trial(HEUN_STAGES, HEUN_A, HEUN_B, ERK_NO_HAT, .false., &
         HEUN_C, dim, state, t, dt, workspace, rhs, .false., &
         0.0_c_double, 0.0_c_double, evals, err, rc)
    if (rc == 0_c_int32_t) then
       do d = 1_c_int32_t, dim
          state(d) = workspace(HEUN_STAGES*dim + d)
       end do
       status = evals
    end if
  end function tension_solver_heun_step

  ! rk23: adaptive substeps of the Bogacki-Shampine 3(2) pair, advancing
  ! exactly dt. `params` must be non-NULL: rel_tol, abs_tol, min_step and
  ! max_step are read; the other fields are ignored. -EIO when minStep is
  ! exhausted (the tolerances cannot be met inside the step-size window).
  function tension_solver_rk23_step(state, dim, t, dt, workspace, &
       rhs_fn, rhs_ctx, params, status) &
       bind(C, name="tension_solver_rk23_step") result(rc)
    real(c_double), intent(inout) :: state(*)
    integer(c_int32_t), value :: dim
    real(c_double), value :: t
    real(c_double), value :: dt
    real(c_double), intent(inout) :: workspace(*)
    type(c_funptr), value :: rhs_fn
    type(c_ptr), value :: rhs_ctx
    type(c_ptr), value :: params
    integer(c_int32_t), intent(out) :: status
    integer(c_int32_t) :: rc

    procedure(tension_rhs_iface), pointer :: rhs
    type(tension_solver_params), pointer :: p
    integer(c_int32_t) :: evals

    status = 0_c_int32_t

    if (dim < 1_c_int32_t) then
       rc = -22_c_int32_t
       return
    end if

    call c_f_procpointer(rhs_fn, rhs)
    if (.not. associated(rhs)) then
       rc = -22_c_int32_t
       return
    end if

    if (dt == 0.0_c_double) then
       rc = 0_c_int32_t
       return
    end if

    if (.not. c_associated(params)) then
       rc = -22_c_int32_t
       return
    end if
    call c_f_pointer(params, p)

    call erk_adaptive(RK23_STAGES, RK23_A, RK23_B, RK23_B_HAT, RK23_C, &
         RK23_ORDER, .true., dim, state, t, dt, workspace, rhs, &
         p%rel_tol, p%abs_tol, p%min_step, p%max_step, evals, rc)
    if (rc == 0_c_int32_t) status = evals
  end function tension_solver_rk23_step

  ! rk45: adaptive substeps of the Dormand-Prince 5(4) pair; same
  ! contract as rk23.
  function tension_solver_rk45_step(state, dim, t, dt, workspace, &
       rhs_fn, rhs_ctx, params, status) &
       bind(C, name="tension_solver_rk45_step") result(rc)
    real(c_double), intent(inout) :: state(*)
    integer(c_int32_t), value :: dim
    real(c_double), value :: t
    real(c_double), value :: dt
    real(c_double), intent(inout) :: workspace(*)
    type(c_funptr), value :: rhs_fn
    type(c_ptr), value :: rhs_ctx
    type(c_ptr), value :: params
    integer(c_int32_t), intent(out) :: status
    integer(c_int32_t) :: rc

    procedure(tension_rhs_iface), pointer :: rhs
    type(tension_solver_params), pointer :: p
    integer(c_int32_t) :: evals

    status = 0_c_int32_t

    if (dim < 1_c_int32_t) then
       rc = -22_c_int32_t
       return
    end if

    call c_f_procpointer(rhs_fn, rhs)
    if (.not. associated(rhs)) then
       rc = -22_c_int32_t
       return
    end if

    if (dt == 0.0_c_double) then
       rc = 0_c_int32_t
       return
    end if

    if (.not. c_associated(params)) then
       rc = -22_c_int32_t
       return
    end if
    call c_f_pointer(params, p)

    call erk_adaptive(RK45_STAGES, RK45_A, RK45_B, RK45_B_HAT, RK45_C, &
         RK45_ORDER, .true., dim, state, t, dt, workspace, rhs, &
         p%rel_tol, p%abs_tol, p%min_step, p%max_step, evals, rc)
    if (rc == 0_c_int32_t) status = evals
  end function tension_solver_rk45_step

end module tension_solver_erk
