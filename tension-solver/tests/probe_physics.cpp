// probe_physics.cpp — what a step costs, and what the state channel costs.
//
// P1a (chunk 6a). Chunk 6 drives N rigid bodies through one solver and resolves
// contacts between steps, so two numbers decide its shape: the cost of a step
// (which sets the body budget) and the cost of `state`/`set_state` (which
// decides whether the guest may write the state back every sub-step, or whether
// contacts have to live inside the derivative as springs instead).
//
// Linked against the solver's C ABI — the same shim the host calls — with the
// derivative a plain C function: no wasm, no session, no renderer, so what is
// measured is the solver's own cost. The wasm boundary is P1b's question, and
// its numbers are this plus the hop.
//
// Build and run (from tension-solver/):
//   g++ -std=c++17 -O2 -I include tests/probe_physics.cpp \
//       -o build/probe-physics/probe_physics build/libtension_solver.a \
//       -lgfortran -lm
//   ./probe_physics
//
// The state layout is Verlet's (`tension-solver/DESIGN.md` §10): `[q, v]`, the
// first dim/2 slots positions and the last dim/2 velocities, which is also a
// fine layout for the explicit methods. dim = 6N is chunk 6's model: six f64
// per body.
//
// Chunk 8's probe (8a) adds the angular model beside it: 14 slots per body,
// seven per half — `[x, y, z, qx, qy, qz, qw | vx, vy, vz, wx, wy, wz, pad]` —
// because a quaternion and an angular velocity do not fit in six. The two
// models are measured with derivatives that do the same amount of *real* work
// (the angular one composes w ⊗ q, which is what a tumbling body costs per
// step), so the ratio between the columns is the state model's cost and not a
// measurement artifact.

#include "tension_solver.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

constexpr double kDt = 1.0 / 60.0;
constexpr int kIterations = 200;
/** Verlet's declared parameter subset; rk45's is the four before it. */
constexpr uint32_t kVerletMask = 0x010u; // fixedStep
constexpr uint32_t kRk45Mask = 0x00Fu;   // relTol, absTol, minStep, maxStep

long long g_evaluations = 0;

/// f(t, y) with every slot touched, so the measurement includes the copy the
/// host makes around the call and not only the arithmetic: q' = v for the first
/// half, a = -9.81 for the last — the shape chunk 6's bodies have in flight.
int32_t derivative(const double *y, int32_t len, double t, double *dy, int32_t dy_cap) {
    g_evaluations += 1;
    if (dy_cap < len) return -22; // -EINVAL
    const int32_t half = len / 2;
    for (int32_t i = 0; i < half; ++i) dy[i] = y[half + i];
    for (int32_t i = half; i < len; ++i) dy[i] = -9.81;
    (void)t;
    return 0;
}

/// f(t, y) for chunk 8's model: seven slots per body per half. Coordinates are
/// `[x, y, z, qx, qy, qz, qw]`, derivatives `[vx, vy, vz, q'x, q'y, q'z, q'w]`
/// with `q' = ½ w⊗q` — the *derivative* of the quaternion, not the angular
/// velocity, because the symplectic Verlet reads the state's second half as the
/// coordinates' time derivative and its acceleration from the RHS's second half.
/// The RHS is `[v, q' | a, ½ w⊗q']`, recovering `w = 2 q'⊗q⁻¹` per body.
int32_t derivative_angular_products(const double *y, int32_t len, double t, double *dy,
                                    int32_t dy_cap) {
    g_evaluations += 1;
    if (dy_cap < len) return -22; // -EINVAL
    const int32_t half = len / 2; // 7N
    for (int32_t base = 0; base < half; base += 7) {
        const double vx = y[half + base + 0], vy = y[half + base + 1], vz = y[half + base + 2];
        const double dx = y[half + base + 3], dyy = y[half + base + 4];
        const double dz = y[half + base + 5], dw = y[half + base + 6];
        const double qx = y[base + 3], qy = y[base + 4], qz = y[base + 5], qw = y[base + 6];
        dy[base + 0] = vx;
        dy[base + 1] = vy;
        dy[base + 2] = vz;
        dy[base + 3] = dx;
        dy[base + 4] = dyy;
        dy[base + 5] = dz;
        dy[base + 6] = dw;
        dy[half + base + 0] = 0.0;
        dy[half + base + 1] = -9.81;
        dy[half + base + 2] = 0.0;
        const double n2 = qx * qx + qy * qy + qz * qz + qw * qw;
        if (n2 <= 0.0) {
            dy[half + base + 3] = dy[half + base + 4] = 0.0;
            dy[half + base + 5] = dy[half + base + 6] = 0.0;
            continue;
        }
        // p = q' ⊗ q*, then w = 2 p / |q|², then q'' = ½ w ⊗ q'.
        const double pw = dw * qw + dx * qx + dyy * qy + dz * qz;
        const double px = -dw * qx + dx * qw - dyy * qz + dz * qy;
        const double py = -dw * qy + dx * qz + dyy * qw - dz * qx;
        const double pz = -dw * qz - dx * qy + dyy * qx + dz * qw;
        const double s = 2.0 / n2;
        const double wx = s * px, wy = s * py, wz = s * pz;
        (void)pw;
        dy[half + base + 3] = 0.5 * (-wx * dx - wy * dyy - wz * dz);
        dy[half + base + 4] = 0.5 * (wx * dw + wy * dz - wz * dyy);
        dy[half + base + 5] = 0.5 * (-wx * dz + wy * dw + wz * dx);
        dy[half + base + 6] = 0.5 * (wx * dyy - wy * dx + wz * dw);
    }
    (void)t;
    return 0;
}

/// The same derivative with the products collapsed. For a torque-free body
/// `q'' = ½ w⊗q'` and, since `q' = ½ w⊗q` implies `|q'| = ½|w||q|`, that is
/// `-(|q'|² / |q|²) q` — a scalar multiple of q. This is the form the design
/// proposes, and the two are measured side by side so the saving is a number
/// rather than a claim.
int32_t derivative_angular(const double *y, int32_t len, double t, double *dy, int32_t dy_cap) {
    g_evaluations += 1;
    if (dy_cap < len) return -22; // -EINVAL
    const int32_t half = len / 2;
    for (int32_t base = 0; base < half; base += 7) {
        const double vx = y[half + base + 0], vy = y[half + base + 1], vz = y[half + base + 2];
        const double dx = y[half + base + 3], dyy = y[half + base + 4];
        const double dz = y[half + base + 5], dw = y[half + base + 6];
        const double qx = y[base + 3], qy = y[base + 4], qz = y[base + 5], qw = y[base + 6];
        dy[base + 0] = vx;
        dy[base + 1] = vy;
        dy[base + 2] = vz;
        dy[base + 3] = dx;
        dy[base + 4] = dyy;
        dy[base + 5] = dz;
        dy[base + 6] = dw;
        dy[half + base + 0] = 0.0;
        dy[half + base + 1] = -9.81;
        dy[half + base + 2] = 0.0;
        const double n2 = qx * qx + qy * qy + qz * qz + qw * qw;
        const double d2 = dx * dx + dyy * dyy + dz * dz + dw * dw;
        const double c = n2 > 0.0 ? d2 / n2 : 0.0;
        dy[half + base + 3] = -c * qx;
        dy[half + base + 4] = -c * qy;
        dy[half + base + 5] = -c * qz;
        dy[half + base + 6] = -c * qw;
    }
    (void)t;
    return 0;
}

double now_us() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clock::now().time_since_epoch()).count();
}

int32_t make_solver(const std::string &method, int32_t dim, uint32_t mask,
                    tension_solver_derivative_fn rhs = derivative) {
    tension_solver_config config{};
    config.method = method.c_str();
    config.method_len = static_cast<uint32_t>(method.size());
    config.source = "wasm";
    config.source_len = 4;
    config.dim = static_cast<uint32_t>(dim);
    config.parameters_bitmap = mask;
    config.rel_tol = 1e-8;
    config.abs_tol = 1e-10;
    config.min_step = 1e-12;
    config.max_step = 1e300;
    config.fixed_step = kDt;
    const int32_t id = tension_solver_create(&config);
    if (id < 1) return id;
    const int32_t bound = tension_solver_bind_callbacks(id, rhs, nullptr);
    if (bound != 0) {
        tension_solver_destroy(id);
        return bound;
    }
    return id;
}

struct Measurement {
    double create_destroy_us = 0;
    double step_us = 0;
    double state_us = 0;
    double set_state_us = 0;
    double evals_per_step = 0;
};

Measurement measure(const std::string &method, int32_t dim, uint32_t mask,
                    bool angular = false,
                    tension_solver_derivative_fn chosen = nullptr) {
    Measurement m;
    const tension_solver_derivative_fn rhs =
        chosen != nullptr ? chosen : (angular ? derivative_angular : derivative);

    // A solver's lifetime: what create + bind + destroy cost, the number to
    // compare set_state's per-call cost against (a design that destroyed and
    // recreated the solver per collision would pay this every time).
    {
        const double started = now_us();
        for (int i = 0; i < 20; ++i) {
            const int32_t id = make_solver(method, dim, mask, rhs);
            if (id < 1) {
                std::printf("  %s dim=%d: create refused (%d)\n", method.c_str(), dim, id);
                std::exit(2);
            }
            tension_solver_destroy(id);
        }
        m.create_destroy_us = (now_us() - started) / 20.0;
    }

    const int32_t id = make_solver(method, dim, mask, rhs);
    if (id < 1) {
        std::printf("  %s dim=%d: create refused (%d)\n", method.c_str(), dim, id);
        std::exit(2);
    }

    std::vector<double> y(static_cast<size_t>(dim), 0.0);
    std::vector<double> out(static_cast<size_t>(dim), 0.0);
    if (angular) {
        // Seeded the way an angular model is: unit quaternions (so ½ w⊗q is
        // real work on sane numbers rather than a product of garbage), a
        // spread of positions, and a non-zero spin per body.
        const int32_t half = dim / 2;
        for (int32_t base = 0; base < half; base += 7) {
            const double body = static_cast<double>(base / 7);
            y[static_cast<size_t>(base + 0)] = 0.5 * body;
            y[static_cast<size_t>(base + 1)] = 1.0 + 0.25 * body;
            y[static_cast<size_t>(base + 2)] = 0.25 * body;
            y[static_cast<size_t>(base + 6)] = 1.0;   // qw: identity
            y[static_cast<size_t>(half + base + 4)] = 0.25; // q'y = ½ w⊗q, w = ½ y
        }
    } else {
        for (int32_t i = 0; i < dim / 2; ++i) y[static_cast<size_t>(i)] = 1.0 + i;
    }
    if (tension_solver_set_state(id, 0.0, y.data(), dim) != 0) {
        std::printf("  seed refused\n");
        std::exit(2);
    }

    g_evaluations = 0;
    double started = now_us();
    for (int i = 0; i < kIterations; ++i) {
        if (tension_solver_step(id, kDt) != 0) {
            std::printf("  %s dim=%d: step refused at %d\n", method.c_str(), dim, i);
            std::exit(2);
        }
    }
    m.step_us = (now_us() - started) / kIterations;
    m.evals_per_step = static_cast<double>(g_evaluations) / kIterations;

    double t_out = 0.0;
    started = now_us();
    for (int i = 0; i < kIterations; ++i) {
        if (tension_solver_state(id, &t_out, out.data(), dim) < 0) {
            std::printf("  state refused\n");
            std::exit(2);
        }
    }
    m.state_us = (now_us() - started) / kIterations;

    // The state the probe writes back is the state it just read, so the copy is
    // the whole cost and no arithmetic is being timed twice.
    started = now_us();
    for (int i = 0; i < kIterations; ++i) {
        if (tension_solver_set_state(id, t_out, out.data(), dim) != 0) {
            std::printf("  set_state refused\n");
            std::exit(2);
        }
    }
    m.set_state_us = (now_us() - started) / kIterations;

    tension_solver_destroy(id);
    return m;
}

} // namespace

/// The internal symbol, declared the way the shim declares it: it is where the
/// evaluation count is written, and the probe reads it once to check that what
/// the callback counted is what the engine reports.
extern "C" int32_t tension_solver_verlet_step(double *state, int32_t dim, double t, double dt,
                                              double *workspace,
                                              tension_solver_derivative_fn rhs_fn, void *rhs_ctx,
                                              const void *params, int32_t *status);

int main() {
    std::printf("PHYS solver cost probe (P1a): %d iterations of dt = 1/60, "
                "tension-solver's C ABI\n", kIterations);
    std::printf("PHYS state layout: [q, v] with dim = 6N f64 slots (chunk 6's model)\n");

    struct Case {
        const char *method;
        uint32_t mask;
    };
    const Case cases[2] = {{"verlet", kVerletMask}, {"rk45", kRk45Mask}};
    const int32_t counts[3] = {16, 64, 256};

    for (const Case &each : cases) {
        for (int32_t n : counts) {
            const int32_t dim = n * 6;
            const Measurement m = measure(each.method, dim, each.mask);
            std::printf("PHYS %-6s N=%3d dim=%5d: step %8.2f us  state %7.2f us  set_state %7.2f us  "
                        "create+destroy %8.2f us  evals/step %5.2f\n",
                        each.method, n, dim, m.step_us, m.state_us, m.set_state_us,
                        m.create_destroy_us, m.evals_per_step);
        }
    }

    // Chunk 8's model, measured the same way: 14 slots per body, seven per half
    // (`[x, y, z, qx, qy, qz, qw | vx, vy, vz, wx, wy, wz, pad]`). The prediction
    // the design writes down is that the step scales with the slot count —
    // 14/6 = 2.33x the linear model at the same N — and the ratio line is the
    // check on that prediction rather than a claim about it.
    std::printf("PHYS angular model (chunk 8): 14 slots/body, dim = 14N, "
                "quaternion derivative q' = ½ w⊗q in the RHS\n");
    double linear_256 = 0.0, angular_256 = 0.0;
    for (int32_t n : counts) {
        const int32_t dim = n * 14;
        const Measurement m = measure("verlet", dim, kVerletMask, /*angular=*/true);
        std::printf("PHYS verlet N=%3d dim=%5d angular: step %8.2f us  state %7.2f us  "
                    "set_state %7.2f us  create+destroy %8.2f us  evals/step %5.2f\n",
                    n, dim, m.step_us, m.state_us, m.set_state_us, m.create_destroy_us,
                    m.evals_per_step);
        if (n == 256) angular_256 = m.step_us;
    }
    {
        const Measurement m = measure("verlet", 1536, kVerletMask);
        linear_256 = m.step_us;
        std::printf("PHYS step cost, 14 slots/body vs 6 slots/body at N=256: %.2f / %.2f = "
                    "%.2f x (the slot-count prediction is 14/6 = 2.33 x)\n",
                    angular_256, linear_256, angular_256 / linear_256);
    }
    {
        const Measurement m = measure("verlet", 256 * 14, kVerletMask, /*angular=*/true,
                                      derivative_angular_products);
        std::printf("PHYS step cost at N=256, the two quaternion RHS forms: products %.2f us, "
                    "scalar %.2f us -> the products cost %.2f x the scalar form\n",
                    m.step_us, angular_256, m.step_us / angular_256);
    }

    // The dim = 14N acceptance question, asked through the C ABI as well as
    // through the guest — and asked about the *step*, because the workspace
    // query deliberately does not check evenness ("evenness is the step's
    // business"): create is happy with an odd dim, and the step is where 7 + 6
    // is refused. Both halves of that are worth having as a number.
    {
        const int32_t dim = 16 * 14;
        const int32_t verlet_id = make_solver("verlet", dim, kVerletMask, derivative_angular);
        const int32_t rk45_id = make_solver("rk45", dim, kRk45Mask, derivative_angular);
        std::printf("PHYS dim=224 (N=16, 14 slots/body): create verlet -> %d, rk45 -> %d "
                    "(both positive is acceptance)\n", verlet_id, rk45_id);
        if (verlet_id > 0) tension_solver_destroy(verlet_id);
        if (rk45_id > 0) tension_solver_destroy(rk45_id);
    }
    {
        // A direct Fortran call at dim = 14 and dim = 7: the evenness refusal,
        // its errno, and the two evaluations of a step that is accepted.
        const int32_t ok_id = make_solver("verlet", 14, kVerletMask);
        const int32_t odd_id = make_solver("verlet", 7, kVerletMask);
        if (ok_id > 0 && odd_id > 0) {
            const void *params = tension_solver_get_params(ok_id);
            std::vector<double> s7(7, 0.0), w14(28, 0.0), s14(14, 0.0);
            s14[6] = 1.0;
            int32_t status = -1;
            const int32_t rc_odd = tension_solver_verlet_step(s7.data(), 7, 0.0, kDt, w14.data(),
                                                              derivative, nullptr, params, &status);
            int32_t status_even = -1;
            const int32_t rc_even = tension_solver_verlet_step(s14.data(), 14, 0.0, kDt, w14.data(),
                                                               derivative, nullptr, params, &status_even);
            std::printf("PHYS direct verlet step: dim=7 -> rc=%d (the evenness refusal), "
                        "dim=14 -> rc=%d status=%d\n", rc_odd, rc_even, status_even);
        }
        if (ok_id > 0) tension_solver_destroy(ok_id);
        if (odd_id > 0) tension_solver_destroy(odd_id);
    }

    // The status cross-check: one direct call to the Fortran symbol with a
    // status pointer, against the same counter the callback keeps. The params
    // block is fetched from a live solver rather than hand-built — the shim's
    // own (solver_params.h), so the call sees exactly what a step would.
    {
        const int32_t dim = 96; // N = 16
        const int32_t id = make_solver("verlet", dim, kVerletMask);
        if (id < 1) {
            std::printf("PHYS status cross-check: skipped, create refused (%d)\n", id);
        } else {
            const void *params = tension_solver_get_params(id);
            std::vector<double> state(static_cast<size_t>(dim), 0.0);
            std::vector<double> workspace(static_cast<size_t>(dim) * 2, 0.0); // symplectic: 2*dim
            for (int32_t i = 0; i < dim / 2; ++i) state[static_cast<size_t>(i)] = 1.0 + i;
            int32_t status = -1;
            g_evaluations = 0;
            const int32_t rc = tension_solver_verlet_step(state.data(), dim, 0.0, kDt,
                                                          workspace.data(), derivative, nullptr,
                                                          params, &status);
            if (rc != 0) {
                std::printf("PHYS status cross-check: the direct Fortran call was refused "
                            "(rc=%d), so it carries no evidence either way; the callback "
                            "count stands on its own\n", rc);
            } else {
                std::printf("PHYS status cross-check: verlet step rc=0 status=%d callback counted "
                            "%lld — they agree: %s\n",
                            status, g_evaluations,
                            (status == g_evaluations) ? "yes" : "NO");
            }
            tension_solver_destroy(id);
        }
    }

    // What a frame's state channel costs at N = 256 if the guest wrote the state
    // back every sub-step — the number chunk 6's response design turns on.
    {
        const Measurement m = measure("verlet", 1536, kVerletMask);
        const double per_substep = m.step_us + m.state_us + m.set_state_us;
        std::printf("PHYS N=256 verlet per sub-step: step %.1f + state %.1f + set_state %.1f = "
                    "%.1f us; a frame with K sub-steps: K=1 %.1f us, K=2 %.1f us, K=4 %.1f us\n",
                    m.step_us, m.state_us, m.set_state_us, per_substep, per_substep,
                    2 * per_substep, 4 * per_substep);
    }
    return 0;
}
