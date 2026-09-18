! tension_solver_symplectic — the symplectic family, numerical core.
!
! Phase 6 opens the second family: verlet. §3's module-per-family rule
! applies as it did to the ERK module — one family, one module, and
! whatever the family's members share lives once. The symplectic family
! has one member today, so "shared" means the velocity-Verlet step
! itself; a second symplectic method would be a thin wrapper over the
! same update, not a forked copy.
!
! State layout — an ABI convention the guest agrees to. The state vector
! is [q, v]: the first dim/2 slots are positions, the last dim/2 slots
! are velocities. `dim` must be even (odd dim is -EINVAL). The RHS
! returns [q', v'] = [v, a]: the first dim/2 slots of `dy` are the
! velocities, the last dim/2 are the accelerations. This is the standard
! first-order-isation of a second-order mechanical system (q'' = a) and
! is the shape schema.yaml's `_derivative` carries for symplectic
! methods (DESIGN.md §10).
!
! Parameters. Verlet is fixed-step: the ABI's step(id, dt) carries the
! advance — one call is one Verlet step of size dt, and `status` reports
! its two RHS evaluations. `fixed_step` is verlet's declared parameter
! in schema.yaml and is read here, but with the advance fixed by the
! call there is no retiming role for it: the wrapper executes exactly
! one step of size dt. The tolerance parameters (relTol/absTol/minStep/
! maxStep) are ignored without complaint — the shared config object
! tolerates unused knobs (§7).
!
! Failure semantics, stated rather than implied: an RHS failure of the
! first evaluation leaves the state untouched. A failure of the second
! leaves the positions advanced and the velocities unchanged — the
! partial step is not rolled back, because 2·dim of workspace holds the
! stage state, not a pristine copy of the old state; the errno is the
! caller's signal, and the shim's step contract does not promise
! atomicity.
!
! There is no module-level SAVE state anywhere in this file — the same
! rule as the ERK module (§4), for the same reason.
module tension_solver_symplectic
  use iso_c_binding
  use tension_solver_erk, only: tension_solver_params
  implicit none
  private

  public :: tension_solver_verlet_workspace_size, tension_solver_verlet_step

  ! The RHS callback — the header's tension_solver_derivative_fn, and the
  ! same interface the ERK module declares privately. Interfaces carry no
  ! memory layout, so redeclaring this one is structural; the params
  ! struct above is imported instead of copied, because its layout must
  ! have exactly one Fortran declaration.
  abstract interface
     function symplectic_rhs_iface(y, len, t, dy, dy_cap) bind(C) result(rc)
       import :: c_double, c_int32_t
       real(c_double), intent(in)  :: y(*)
       integer(c_int32_t), value   :: len
       real(c_double), value       :: t
       real(c_double), intent(out) :: dy(*)
       integer(c_int32_t), value   :: dy_cap
       integer(c_int32_t)          :: rc
     end function symplectic_rhs_iface
  end interface

contains

  ! Two stage vectors: k1 = [v_n, a_n] at the current state, k2 = [*, a_n+1]
  ! evaluated at the position-advanced, velocity-unchanged stage state.
  pure function verlet_workspace_slots(dim) result(n)
    integer(c_int32_t), intent(in) :: dim
    integer(c_int32_t) :: n
    n = 2_c_int32_t*dim
  end function verlet_workspace_slots

  ! Workspace slots for verlet at `dim`: 2·dim for dim >= 2, 0 below —
  ! evenness is the step's business, not the size query's.
  function tension_solver_verlet_workspace_size(dim) &
       bind(C, name="tension_solver_verlet_workspace_size") result(n)
    integer(c_int32_t), value :: dim
    integer(c_int32_t) :: n
    if (dim < 2_c_int32_t) then
       n = 0_c_int32_t
       return
    end if
    n = verlet_workspace_slots(dim)
  end function tension_solver_verlet_workspace_size

  ! Advance by one velocity-Verlet step of size dt:
  !   k1  = _derivative(y_n)                ! [v_n, a_n]
  !   q_{n+1} = q_n + h·v_n + (h²/2)·a_n
  !   k2  = _derivative((q_{n+1}, v_n))     ! [*, a_{n+1}]
  !   v_{n+1} = v_n + (h/2)·(a_n + a_{n+1})
  !
  ! The middle evaluation uses the UPDATED positions and the OLD
  ! velocities; evaluating it at updated velocities is the classic way to
  ! lose the method's symplectic property.
  !
  ! ws layout: k1 at ws(1:dim), k2 at ws(dim+1:2·dim).
  ! status (out): 2 (the RHS evaluations of the step) on success; 0 on
  ! failure. Returns 0, or a negative errno: -EINVAL for dim < 2, odd
  ! dim, a NULL rhs_fn, a NULL params, or a negative fixed_step;
  ! otherwise the RHS's own nonzero return, propagated unchanged. A dt of
  ! exactly zero is a no-op: nothing is evaluated, the state is left bit
  ! for bit as it was.
  function tension_solver_verlet_step(state, dim, t, dt, workspace, &
       rhs_fn, rhs_ctx, params, status) &
       bind(C, name="tension_solver_verlet_step") result(rc)
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

    procedure(symplectic_rhs_iface), pointer :: rhs
    type(tension_solver_params), pointer :: p
    integer(c_int32_t) :: half, i
    real(c_double) :: h2

    status = 0_c_int32_t

    if (dim < 2_c_int32_t) then
       rc = -22_c_int32_t
       return
    end if
    if (mod(dim, 2_c_int32_t) /= 0_c_int32_t) then
       rc = -22_c_int32_t          ! odd dim: [q, v] needs two equal halves
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

    ! fixed_step is read as verlet's declared parameter (schema.yaml);
    ! the advance is the call's dt (see the module header). The read also
    ! guards a direct caller that bypasses the shim's validation.
    if (p%fixed_step < 0.0_c_double) then
       rc = -22_c_int32_t
       return
    end if

    half = dim/2_c_int32_t
    h2 = dt*dt

    ! k1 = [v_n, a_n].
    rc = rhs(state, dim, t, workspace(1), dim)
    if (rc /= 0_c_int32_t) return

    ! q_{n+1} = q_n + h·v_n + (h²/2)·a_n, in place — each position slot
    ! depends only on its own; the velocities are untouched.
    do i = 1_c_int32_t, half
       state(i) = state(i) + dt*state(half + i) + &
            0.5_c_double*h2*workspace(half + i)
    end do

    ! k2 at (q_{n+1}, v_n) — the state is exactly that stage now: positions
    ! advanced, velocities still the old ones.
    rc = rhs(state, dim, t + dt, workspace(dim + 1), dim)
    if (rc /= 0_c_int32_t) return

    ! v_{n+1} = v_n + (h/2)·(a_n + a_{n+1}), in place, per component.
    do i = 1_c_int32_t, half
       state(half + i) = state(half + i) + &
            0.5_c_double*dt*(workspace(half + i) + workspace(dim + half + i))
    end do

    status = 2_c_int32_t
  end function tension_solver_verlet_step

end module tension_solver_symplectic
