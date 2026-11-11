! tension_solver_implicit — the implicit family, numerical core.
!
! Phase 6 opens the third family: implicit_euler. The same §3 rule as the
! ERK and symplectic modules — one family, one module, and whatever the
! family's members share lives once. The family has two members: the
! fixed-point implicit Euler described immediately below, and bdf2, the
! Newton-Raphson member, whose algorithm is stated at its own section
! further down (they share only the params struct and the RHS interface,
! so there was nothing left to factor out between them).
!
! The algorithm, stated exactly. Implicit Euler solves
!     y_{n+1} = y_n + h·f(t_{n+1}, y_{n+1})
! by fixed-point iteration on g(y) = y_n + h·f(t+h, y):
!     y_iter = y_n + h·f(t_n, y_n)          (explicit-Euler first guess)
!     repeat up to `iterations` times:
!        rhs   = f(t_n + h, y_iter)
!        y_new = y_n + h·rhs
!        if ||y_new - y_iter||_inf < convergenceTol: accept, stop
!        y_iter = y_new
!     if the tolerance was never met: -EIO, state untouched.
!
! Convergence window, stated rather than implied. Fixed-point iteration
! converges iff h·L < 1 near the solution (L = the Lipschitz constant of
! f); outside that window the iterates diverge and the method reports
! -EIO instead of diverging silently. The wrapper must not shrink h on
! its own — that would be adaptivity without a Newton solve, and a
! Jacobian is not expressible through the derivative-only ABI. One
! consequence, recorded so no one is surprised: the iteration's window
! (h·L < 1) lies inside explicit Euler's stability region (h·L <= 2), so
! this implementation cannot demonstrate implicit Euler's A-stability
! where explicit Euler would fail. True stiff robustness needs a Newton
! solve, and the ABI carries no Jacobian channel — but a Jacobian can be
! *differenced* out of the derivative channel, one extra evaluation per
! unknown. That is what bdf2 below does, and it is why the family has a
! second member: the Newton solve has no h·L < 1 window
! (tension-solver/DESIGN.md §10).
!
! Parameters. `iterations` (max fixed-point iterations; schema default
! 10) and `convergenceTol` (acceptance tolerance; default 1e-8) are read;
! relTol/absTol/minStep/maxStep are ignored without complaint (§7).
! `status` reports the RHS evaluations performed on success — one for the
! first guess plus one per iteration; 0 on failure.
!
! There is no module-level SAVE state anywhere in this file — the same
! rule as the ERK module (§4), for the same reason.
module tension_solver_implicit
  use iso_c_binding
  use tension_solver_erk, only: tension_solver_params
  implicit none
  private

  public :: tension_solver_implicit_euler_workspace_size, &
       tension_solver_implicit_euler_step, &
       tension_solver_bdf2_workspace_size, &
       tension_solver_bdf2_step

  ! The RHS callback — the header's tension_solver_derivative_fn, the same
  ! interface the ERK module declares privately (interfaces carry no
  ! memory layout; the params struct above is the one declaration that
  ! must not be copied).
  abstract interface
     function implicit_rhs_iface(y, len, t, dy, dy_cap) bind(C) result(rc)
       import :: c_double, c_int32_t
       real(c_double), intent(in)  :: y(*)
       integer(c_int32_t), value   :: len
       real(c_double), value       :: t
       real(c_double), intent(out) :: dy(*)
       integer(c_int32_t), value   :: dy_cap
       integer(c_int32_t)          :: rc
     end function implicit_rhs_iface
  end interface

  ! ── BDF2 declarations ─────────────────────────────────────────────────

  ! The errno values this module returns across the C boundary. The names
  ! are the reasons; the values are the ABI's (tension_solver.h).
  integer(c_int32_t), parameter :: TS_OK     = 0_c_int32_t
  integer(c_int32_t), parameter :: TS_EINVAL = -22_c_int32_t ! bad dim / NULL callback / NULL params
  integer(c_int32_t), parameter :: TS_EIO    = -5_c_int32_t  ! the step was not taken

  ! A singular Newton matrix is the same "step not taken" errno as a
  ! non-converged iteration: the ABI has one code for it, and this name
  ! records which reason it was.
  integer(c_int32_t), parameter :: TS_ESINGULAR = TS_EIO

  ! A pivot at or below this is treated as zero by the Gaussian
  ! elimination, so the matrix is singular for this step.
  real(c_double), parameter :: PIVOT_EPS = 1.0e-14_c_double

  ! The forward-difference step for the Jacobian, relative to the iterate.
  real(c_double), parameter :: FD_EPS = 1.0e-8_c_double

  ! Backtracking line-search halvings before the step is accepted anyway.
  integer(c_int32_t), parameter :: LINE_SEARCH_STEPS = 5_c_int32_t

  ! The BDF2 workspace as the numerics see it: one object holding the seven
  ! dim-length vectors, the `has_prev` flag and the dim×dim Newton matrix.
  ! The layout itself lives in bdf2_workspace_bind and nowhere else.
  !
  ! The components are pointers, not arrays, because the C buffer's length
  ! is runtime data: `dim` is a dummy argument here, and Fortran can shape
  ! a component only from a constant expression. The textbook answer for a
  ! runtime-shaped record is a bind(C) type with a `len` parameter, and
  ! gfortran 16.2 cannot map one onto raw memory — measured: `c_f_pointer`
  ! onto `type(ws(dim))` returns, reports the wrong storage size, and the
  ! first component write faults. The pointer views cost one association
  ! per step (not one copy) and keep every use site indexed by field name.
  type :: bdf2_workspace
     real(c_double), pointer :: y_prev(:)   => null() ! y_{n-1}, from the previous step
     real(c_double), pointer :: has_prev    => null() ! one slot used as a flag: 1 when y_prev is live
     real(c_double), pointer :: y_iter(:)   => null() ! the Newton iterate
     real(c_double), pointer :: rhs_val(:)  => null() ! f(t+dt, y_iter)
     real(c_double), pointer :: f_pert(:)   => null() ! f at a perturbed / trial iterate
     real(c_double), pointer :: residual(:) => null() ! F(y_iter) = y_iter - y_star - alpha·f
     real(c_double), pointer :: b_vec(:)    => null() ! -residual, then the linear solve's RHS
     real(c_double), pointer :: delta(:)    => null() ! the Newton correction
     real(c_double), pointer :: M(:,:)      => null() ! dF/dy = 1 - alpha·J
  end type bdf2_workspace

contains

  ! Two work vectors: the current iterate y_iter and the RHS output at it.
  pure function implicit_workspace_slots(dim) result(n)
    integer(c_int32_t), intent(in) :: dim
    integer(c_int32_t) :: n
    n = 2_c_int32_t*dim
  end function implicit_workspace_slots

  function tension_solver_implicit_euler_workspace_size(dim) &
       bind(C, name="tension_solver_implicit_euler_workspace_size") result(n)
    integer(c_int32_t), value :: dim
    integer(c_int32_t) :: n
    if (dim < 1_c_int32_t) then
       n = 0_c_int32_t
       return
    end if
    n = implicit_workspace_slots(dim)
  end function tension_solver_implicit_euler_workspace_size

  ! Advance by one implicit-Euler step of size dt, fixed-point iteration:
  !   y_iter = y_n + dt·f(t_n, y_n)                  (explicit first guess)
  !   y_new  = y_n + dt·f(t_n + dt, y_iter)          (per iteration)
  !   accept when ||y_new - y_iter||_inf < convergenceTol
  !   after `iterations` tries without acceptance: -EIO, state untouched.
  !
  ! ws layout: y_iter at ws(1:dim), the RHS output at ws(dim+1:2·dim).
  ! status (out): the RHS evaluations performed on success (1 + the
  ! iterations it took); 0 on failure. Returns 0, or a negative errno:
  ! -EINVAL for dim < 1, a NULL rhs_fn, or a NULL params; -EIO (-5) when
  ! the iteration did not converge inside `iterations`; otherwise the
  ! RHS's own nonzero return, propagated unchanged. A dt of exactly zero
  ! is a no-op: nothing is evaluated, the state is left bit for bit as it
  ! was.
  function tension_solver_implicit_euler_step(state, dim, t, dt, workspace, &
       rhs_fn, rhs_ctx, params, status) &
       bind(C, name="tension_solver_implicit_euler_step") result(rc)
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

    procedure(implicit_rhs_iface), pointer :: rhs
    type(tension_solver_params), pointer :: p
    integer(c_int32_t) :: k, i, evals
    real(c_double) :: maxdiff
    logical :: converged

    status = 0_c_int32_t
    evals = 0_c_int32_t

    if (dim < 1_c_int32_t) then
       rc = TS_EINVAL
       return
    end if

    call c_f_procpointer(rhs_fn, rhs)
    if (.not. associated(rhs)) then
       rc = TS_EINVAL
       return
    end if

    if (dt == 0.0_c_double) then
       rc = 0_c_int32_t
       return
    end if

    if (.not. c_associated(params)) then
       rc = TS_EINVAL
       return
    end if
    call c_f_pointer(params, p)

    ! First guess: one explicit-Euler step; y_iter = y_n + dt·f(t_n, y_n).
    rc = rhs(state, dim, t, workspace(dim + 1), dim)
    if (rc /= 0_c_int32_t) return
    evals = 1_c_int32_t
    do i = 1_c_int32_t, dim
       workspace(i) = state(i) + dt*workspace(dim + i)
    end do

    converged = .false.
    do k = 1_c_int32_t, p%iterations
       rc = rhs(workspace(1), dim, t + dt, workspace(dim + 1), dim)
       if (rc /= 0_c_int32_t) return
       evals = evals + 1_c_int32_t

       ! ||y_new - y_iter||_inf, with y_new = y_n + dt·rhs evaluated
       ! against the pre-update iterate (the check comes before the
       ! update, so both sides of the difference are live).
       maxdiff = 0.0_c_double
       do i = 1_c_int32_t, dim
          maxdiff = max(maxdiff, &
               abs((state(i) + dt*workspace(dim + i)) - workspace(i)))
       end do
       converged = maxdiff < p%convergence_tol

       do i = 1_c_int32_t, dim
          workspace(i) = state(i) + dt*workspace(dim + i)
       end do

       if (converged) exit
    end do

    if (.not. converged) then
       rc = TS_EIO             ! the iteration did not converge
       return
    end if

    do i = 1_c_int32_t, dim
       state(i) = workspace(i)
    end do
    status = evals
  end function tension_solver_implicit_euler_step

  ! ── BDF2: workspace layout, linear solve, Newton step ─────────────────
  !
  ! BDF2 advances
  !     y_{n+1} = y_star + alpha·f(t_{n+1}, y_{n+1})
  ! with, for h = dt,
  !     BDF2        alpha = 2h/3,  y_star = (4·y_n - y_{n-1})/3
  !     first step  alpha = h,     y_star = y_n      (backward Euler)
  ! — the first step has no y_{n-1}, so it takes the first-order rule and
  ! every later step the two-step formula. The equation is solved by
  ! Newton-Raphson on F(y) = y - y_star - alpha·f(t+h, y), with a
  ! forward-difference Jacobian built through the derivative-only ABI (one
  ! extra RHS evaluation per unknown) and a backtracking line search that
  ! refuses a trial step which does not reduce the residual.
  !
  ! Why the backend exists at all: the fixed-point implicit Euler beside it
  ! converges only inside h·L < 1, so it cannot show the A-stability that
  ! justifies an implicit method (DESIGN.md §10). The Newton solve has no
  ! such window — that is the whole point, and why
  ! tests/solver_p6_implicit.rs exercises h·L = 10.

  ! The slot count the C side must allocate. One formula, read by both the
  ! exported size function and the bind check below. Computed in 64 bits
  ! because the dim² term overflows a 32-bit integer for dim > 46340, and
  ! an overflowed size would under-allocate the Newton matrix while the
  ! step kept writing dim² entries into it (dim = 65536 wraps to 458753
  ! slots against a true need of 2³²+458753). 0 means "not expressible",
  ! which the exported size function passes through and the shim refuses
  ! with -EINVAL.
  pure function bdf2_workspace_slots(dim) result(n)
    integer(c_int32_t), intent(in) :: dim
    integer(c_int32_t) :: n
    integer(c_int64_t) :: slots
    integer(c_int64_t) :: d

    if (dim < 1_c_int32_t) then
       n = 0_c_int32_t
       return
    end if
    d = int(dim, c_int64_t)
    slots = 7_c_int64_t*d + 1_c_int64_t + d*d
    if (slots > int(huge(0_c_int32_t), c_int64_t)) then
       n = 0_c_int32_t
       return
    end if
    n = int(slots, c_int32_t)
  end function bdf2_workspace_slots

  ! Solve A·x = b by Gaussian elimination with partial pivoting. A and b
  ! are consumed (they are the workspace's own scratch), x is the solution.
  ! ok is false when a pivot vanishes: the matrix is singular for this
  ! step, and the caller reports -EIO without touching the state.
  subroutine solve_linear_system(n, A, b, x, ok)
    integer(c_int32_t), intent(in) :: n
    real(c_double), intent(inout) :: A(n, n)
    real(c_double), intent(inout) :: b(n)
    real(c_double), intent(out) :: x(n)
    logical, intent(out) :: ok
    integer(c_int32_t) :: i, j, k, max_row
    real(c_double) :: max_val, factor, tmp, sum_val

    ok = .true.
    do k = 1_c_int32_t, n - 1_c_int32_t
       ! Partial pivoting: the largest-magnitude candidate in this column.
       max_val = abs(A(k, k))
       max_row = k
       do i = k + 1_c_int32_t, n
          if (abs(A(i, k)) > max_val) then
             max_val = abs(A(i, k))
             max_row = i
          end if
       end do

       if (max_val < PIVOT_EPS) then
          ok = .false.
          return
       end if

       if (max_row /= k) then
          do j = k, n
             tmp = A(k, j)
             A(k, j) = A(max_row, j)
             A(max_row, j) = tmp
          end do
          tmp = b(k)
          b(k) = b(max_row)
          b(max_row) = tmp
       end if

       do i = k + 1_c_int32_t, n
          factor = A(i, k) / A(k, k)
          do j = k + 1_c_int32_t, n
             A(i, j) = A(i, j) - factor * A(k, j)
          end do
          b(i) = b(i) - factor * b(k)
       end do
    end do

    if (abs(A(n, n)) < PIVOT_EPS) then
       ok = .false.
       return
    end if

    do i = n, 1_c_int32_t, -1_c_int32_t
       sum_val = b(i)
       do j = i + 1_c_int32_t, n
          sum_val = sum_val - A(i, j) * x(j)
       end do
       x(i) = sum_val / A(i, i)
    end do
  end subroutine solve_linear_system

  function tension_solver_bdf2_workspace_size(dim) &
       bind(C, name="tension_solver_bdf2_workspace_size") result(n)
    integer(c_int32_t), value :: dim
    integer(c_int32_t) :: n
    n = bdf2_workspace_slots(dim)
  end function tension_solver_bdf2_workspace_size

  ! Cut the flat C buffer into the workspace's blocks. The cursor walk and
  ! bdf2_workspace_slots() are two statements of one layout; ok is false
  ! when they disagree, so a drift is refused rather than read past.
  subroutine bdf2_workspace_bind(flat, dim, w, ok)
    real(c_double), target, intent(inout) :: flat(*)
    integer(c_int32_t), intent(in) :: dim
    type(bdf2_workspace), intent(out) :: w
    logical, intent(out) :: ok
    integer(c_int32_t) :: next

    next = 1_c_int32_t

    w%y_prev   => flat(next:next + dim - 1);  next = next + dim
    w%has_prev => flat(next);                 next = next + 1_c_int32_t
    w%y_iter   => flat(next:next + dim - 1);  next = next + dim
    w%rhs_val  => flat(next:next + dim - 1);  next = next + dim
    w%f_pert   => flat(next:next + dim - 1);  next = next + dim
    w%residual => flat(next:next + dim - 1);  next = next + dim
    w%b_vec    => flat(next:next + dim - 1);  next = next + dim
    w%delta    => flat(next:next + dim - 1);  next = next + dim
    call c_f_pointer(c_loc(flat(next)), w%M, [dim, dim])
    next = next + dim*dim

    ok = (next - 1_c_int32_t == bdf2_workspace_slots(dim))
  end subroutine bdf2_workspace_bind

  ! One step. w carries every working vector and the Newton matrix; the
  ! only thing kept between calls is w%has_prev (and w%y_prev, which it
  ! says is live). rc is TS_OK, the RHS's own nonzero return propagated
  ! unchanged, TS_ESINGULAR when the Jacobian is singular, or TS_EIO when
  ! the iteration did not converge inside `iterations`. A failed step
  ! leaves `state` and w%y_prev untouched.
  subroutine bdf2_step_impl(state, dim, t, dt, rhs, p, evals, w, rc)
    integer(c_int32_t), intent(in) :: dim
    real(c_double), intent(inout) :: state(dim)
    real(c_double), intent(in) :: t
    real(c_double), intent(in) :: dt
    procedure(implicit_rhs_iface), pointer, intent(in) :: rhs
    type(tension_solver_params), intent(in) :: p
    integer(c_int32_t), intent(inout) :: evals
    type(bdf2_workspace), intent(inout) :: w
    integer(c_int32_t), intent(out) :: rc

    logical :: is_bdf2, converged, ok
    real(c_double) :: alpha, max_res, max_delta, delta_j, saved_yj, df_dy
    real(c_double) :: omega, trial_res
    real(c_double) :: y_star(dim)
    integer(c_int32_t) :: i, j, iter, step_try

    is_bdf2 = w%has_prev > 0.5_c_double
    if (is_bdf2) then
       alpha = (2.0_c_double / 3.0_c_double) * dt
       do i = 1_c_int32_t, dim
          y_star(i) = (4.0_c_double / 3.0_c_double) * state(i) - &
                      (1.0_c_double / 3.0_c_double) * w%y_prev(i)
          w%y_iter(i) = 2.0_c_double * state(i) - w%y_prev(i)
       end do
    else
       alpha = dt
       y_star = state
       rc = rhs(state, dim, t, w%rhs_val, dim)
       if (rc /= TS_OK) return
       evals = evals + 1_c_int32_t
       do i = 1_c_int32_t, dim
          w%y_iter(i) = state(i) + dt * w%rhs_val(i)
       end do
    end if

    converged = .false.
    do iter = 1_c_int32_t, p%iterations
       rc = rhs(w%y_iter, dim, t + dt, w%rhs_val, dim)
       if (rc /= TS_OK) return
       evals = evals + 1_c_int32_t

       max_res = 0.0_c_double
       do i = 1_c_int32_t, dim
          w%residual(i) = w%y_iter(i) - y_star(i) - alpha * w%rhs_val(i)
          max_res = max(max_res, abs(w%residual(i)))
       end do

       if (max_res < p%convergence_tol) then
          converged = .true.
          exit
       end if

       ! Forward-difference Jacobian, column by column: one extra RHS
       ! evaluation per unknown.
       do j = 1_c_int32_t, dim
          delta_j = FD_EPS * max(abs(w%y_iter(j)), 1.0_c_double)
          saved_yj = w%y_iter(j)
          w%y_iter(j) = saved_yj + delta_j

          rc = rhs(w%y_iter, dim, t + dt, w%f_pert, dim)
          w%y_iter(j) = saved_yj
          if (rc /= TS_OK) return
          evals = evals + 1_c_int32_t

          do i = 1_c_int32_t, dim
             df_dy = (w%f_pert(i) - w%rhs_val(i)) / delta_j
             if (i == j) then
                w%M(i, j) = 1.0_c_double - alpha * df_dy
             else
                w%M(i, j) = -alpha * df_dy
             end if
          end do
       end do

       do i = 1_c_int32_t, dim
          w%b_vec(i) = -w%residual(i)
       end do
       call solve_linear_system(dim, w%M, w%b_vec, w%delta, ok)
       if (.not. ok) then
          rc = TS_ESINGULAR
          return
       end if

       max_delta = 0.0_c_double
       do i = 1_c_int32_t, dim
          max_delta = max(max_delta, abs(w%delta(i)))
       end do

       if (max_delta < p%convergence_tol) then
          do i = 1_c_int32_t, dim
             w%y_iter(i) = w%y_iter(i) + w%delta(i)
          end do
          converged = .true.
          exit
       end if

       ! Backtracking line search: halve the Newton step until the residual
       ! falls (or the budget runs out). b_vec holds the trial iterate
       ! here — it is dead once the linear solve above has returned.
       omega = 1.0_c_double
       do step_try = 1_c_int32_t, LINE_SEARCH_STEPS
          do i = 1_c_int32_t, dim
             w%b_vec(i) = w%y_iter(i) + omega * w%delta(i)
          end do
          rc = rhs(w%b_vec, dim, t + dt, w%f_pert, dim)
          if (rc /= TS_OK) return
          evals = evals + 1_c_int32_t

          trial_res = 0.0_c_double
          do i = 1_c_int32_t, dim
             trial_res = max(trial_res, &
                  abs(w%b_vec(i) - y_star(i) - alpha * w%f_pert(i)))
          end do

          if (trial_res < max_res .or. step_try == LINE_SEARCH_STEPS) then
             do i = 1_c_int32_t, dim
                w%y_iter(i) = w%b_vec(i)
             end do
             max_res = trial_res
             exit
          end if
          omega = 0.5_c_double * omega
       end do

       if (max_res < p%convergence_tol) then
          converged = .true.
          exit
       end if
    end do

    if (.not. converged) then
       rc = TS_EIO
       return
    end if

    do i = 1_c_int32_t, dim
       w%y_prev(i) = state(i)
       state(i) = w%y_iter(i)
    end do
    w%has_prev = 1.0_c_double
    rc = TS_OK
  end subroutine bdf2_step_impl

  ! The C entry point. Its only jobs are the checks the numerics must not
  ! repeat (dim, callback, params, dt == 0), mapping the flat buffer into a
  ! workspace, and reporting the evaluation count on success. All layout
  ! knowledge is bdf2_workspace_bind's.
  function tension_solver_bdf2_step(state, dim, t, dt, workspace, &
       rhs_fn, rhs_ctx, params, status) &
       bind(C, name="tension_solver_bdf2_step") result(rc)
    real(c_double), intent(inout) :: state(*)
    integer(c_int32_t), value :: dim
    real(c_double), value :: t
    real(c_double), value :: dt
    real(c_double), target, intent(inout) :: workspace(*)
    type(c_funptr), value :: rhs_fn
    type(c_ptr), value :: rhs_ctx
    type(c_ptr), value :: params
    integer(c_int32_t), intent(out) :: status
    integer(c_int32_t) :: rc

    procedure(implicit_rhs_iface), pointer :: rhs
    type(tension_solver_params), pointer :: p
    type(bdf2_workspace) :: w
    logical :: layout_ok
    integer(c_int32_t) :: evals

    status = 0_c_int32_t
    evals = 0_c_int32_t

    if (dim < 1_c_int32_t) then
       rc = TS_EINVAL
       return
    end if

    call c_f_procpointer(rhs_fn, rhs)
    if (.not. associated(rhs)) then
       rc = TS_EINVAL
       return
    end if

    if (dt == 0.0_c_double) then
       rc = TS_OK
       return
    end if

    if (.not. c_associated(params)) then
       rc = TS_EINVAL
       return
    end if
    call c_f_pointer(params, p)

    call bdf2_workspace_bind(workspace, dim, w, layout_ok)
    if (.not. layout_ok) then
       rc = TS_EINVAL
       return
    end if

    call bdf2_step_impl(state, dim, t, dt, rhs, p, evals, w, rc)

    if (rc == TS_OK) status = evals
  end function tension_solver_bdf2_step

end module tension_solver_implicit
