! tension_solver_erk — the explicit Runge-Kutta family, numerical core.
!
! Phase 1 exposes the euler primitive only. The table-driven stepper and the
! bind(C) symbol shapes are the ones later phases fill in, not rewrite:
! adding a method means adding its Butcher-table PARAMETER data and a thin
! bind(C) wrapper, never another copy of the stage loop.
!
! There is no module-level SAVE state anywhere in this file. Every mutable
! value lives in the caller's state and workspace arrays, which is what lets
! two solvers share one process without contaminating each other
! (tension-solver/DESIGN.md §4).
module tension_solver_erk
  use iso_c_binding
  implicit none
  private

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

  ! ── euler, one stage ──────────────────────────────────────────────────
  ! The Butcher table as compile-time PARAMETER data. A is row-major
  ! flattened (s×s): a_ij = A((i-1)*s + j). Euler has no interior stages:
  !   k1 = f(t, y);  y += dt·k1
  integer(c_int32_t), parameter :: EULER_STAGES = 1
  real(c_double), parameter :: EULER_A(1) = [0.0_c_double]
  real(c_double), parameter :: EULER_B(1) = [1.0_c_double]
  real(c_double), parameter :: EULER_C(1) = [0.0_c_double]

  public :: tension_solver_euler_workspace_size, tension_solver_euler_step

contains

  ! Workspace slots for an s-stage explicit RK over `dim` state variables:
  ! s stage vectors, plus one stage-state scratch vector when there are
  ! interior stages (stage 1 evaluates f at y itself and needs no scratch).
  pure function erk_workspace_slots(s, dim) result(n)
    integer(c_int32_t), intent(in) :: s
    integer(c_int32_t), intent(in) :: dim
    integer(c_int32_t) :: n
    n = s*dim
    if (s > 1) n = n + dim
  end function erk_workspace_slots

  ! The generic explicit-RK stepper: one stage loop, driven by the table.
  ! The only per-method code is the parameter data above and the wrapper
  ! below.
  !
  !   ws layout: k_i at ws((i-1)*dim + 1 : i*dim); when s > 1 the scratch
  !   stage state sits at ws(s*dim + 1 : (s+1)*dim).
  !   rc:    0, or the RHS's own nonzero return propagated unchanged.
  !   evals: number of RHS evaluations attempted.
  subroutine erk_step(s, a, b, c, dim, y, t, dt, ws, rhs, evals, rc)
    integer(c_int32_t), intent(in) :: s
    real(c_double), intent(in) :: a(*)
    real(c_double), intent(in) :: b(*)
    real(c_double), intent(in) :: c(*)
    integer(c_int32_t), intent(in) :: dim
    real(c_double), intent(inout) :: y(*)
    real(c_double), intent(in) :: t
    real(c_double), intent(in) :: dt
    real(c_double), intent(inout) :: ws(*)
    procedure(tension_rhs_iface), pointer :: rhs
    integer(c_int32_t), intent(out) :: evals
    integer(c_int32_t), intent(out) :: rc

    integer(c_int32_t) :: i, j, d
    real(c_double) :: acc, ti

    rc = 0_c_int32_t
    evals = 0_c_int32_t

    do i = 1_c_int32_t, s
       ti = t + c(i)*dt
       if (i == 1_c_int32_t) then
          rc = rhs(y, dim, ti, ws(1), dim)
       else
          do d = 1_c_int32_t, dim
             acc = 0.0_c_double
             do j = 1_c_int32_t, i - 1_c_int32_t
                acc = acc + a((i - 1_c_int32_t)*s + j)*ws((j - 1_c_int32_t)*dim + d)
             end do
             ws(s*dim + d) = y(d) + dt*acc
          end do
          rc = rhs(ws(s*dim + 1), dim, ti, ws((i - 1_c_int32_t)*dim + 1), dim)
       end if
       evals = evals + 1_c_int32_t
       if (rc /= 0_c_int32_t) return
    end do

    do d = 1_c_int32_t, dim
       acc = 0.0_c_double
       do i = 1_c_int32_t, s
          acc = acc + b(i)*ws((i - 1_c_int32_t)*dim + d)
       end do
       y(d) = y(d) + dt*acc
    end do
  end subroutine erk_step

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

  ! Advance the state by one euler step:
  !   tension_solver_euler_step(state, dim, t, dt, workspace,
  !                             rhs_fn, rhs_ctx, params, status) -> i32
  !
  ! `state` is updated in place — the solver owns it and the callback
  ! receives the pointer directly. `workspace` is the caller-allocated f64
  ! array sized by tension_solver_euler_workspace_size(dim); it is scratch,
  ! not state, and its contents on entry are unspecified. `rhs_fn` is the
  ! header's tension_solver_derivative_fn. `rhs_ctx` and `params` are
  ! reserved slots: the derivative callback carries no user-data argument
  ! and no backend parameter has meaning yet, so phase 1 reads neither.
  !
  ! `status` (out): the number of RHS evaluations performed by this step on
  ! success (euler: 1); 0 on failure.
  !
  ! Returns 0, or a negative errno: -EINVAL (-22) for dim < 1 or a NULL
  ! rhs_fn; otherwise the RHS's own nonzero return, propagated unchanged.
  ! A dt of exactly zero is a no-op: nothing is evaluated, and the state is
  ! left bit for bit as it was.
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

    call erk_step(EULER_STAGES, EULER_A, EULER_B, EULER_C, dim, state, t, &
         dt, workspace, rhs, evals, rc)
    if (rc == 0_c_int32_t) status = evals
  end function tension_solver_euler_step

end module tension_solver_erk
