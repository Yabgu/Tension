! tension_solver_implicit — the implicit family, numerical core.
!
! Phase 6 opens the third family: implicit_euler. The same §3 rule as the
! ERK and symplectic modules — one family, one module, and whatever the
! family's members share lives once (today: the fixed-point iteration
! below, which an implicit midpoint rule would reuse).
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
! solve, which needs a Jacobian channel the frozen ABI does not have
! (DESIGN.md §10).
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
       tension_solver_implicit_euler_step

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
       rc = -5_c_int32_t           ! -EIO: the iteration did not converge
       return
    end if

    do i = 1_c_int32_t, dim
       state(i) = workspace(i)
    end do
    status = evals
  end function tension_solver_implicit_euler_step

end module tension_solver_implicit
