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

double now_us() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clock::now().time_since_epoch()).count();
}

int32_t make_solver(const std::string &method, int32_t dim, uint32_t mask) {
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
    const int32_t bound = tension_solver_bind_callbacks(id, derivative, nullptr);
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

Measurement measure(const std::string &method, int32_t dim, uint32_t mask) {
    Measurement m;

    // A solver's lifetime: what create + bind + destroy cost, the number to
    // compare set_state's per-call cost against (a design that destroyed and
    // recreated the solver per collision would pay this every time).
    {
        const double started = now_us();
        for (int i = 0; i < 20; ++i) {
            const int32_t id = make_solver(method, dim, mask);
            if (id < 1) {
                std::printf("  %s dim=%d: create refused (%d)\n", method.c_str(), dim, id);
                std::exit(2);
            }
            tension_solver_destroy(id);
        }
        m.create_destroy_us = (now_us() - started) / 20.0;
    }

    const int32_t id = make_solver(method, dim, mask);
    if (id < 1) {
        std::printf("  %s dim=%d: create refused (%d)\n", method.c_str(), dim, id);
        std::exit(2);
    }

    std::vector<double> y(static_cast<size_t>(dim), 0.0);
    std::vector<double> out(static_cast<size_t>(dim), 0.0);
    for (int32_t i = 0; i < dim / 2; ++i) y[static_cast<size_t>(i)] = 1.0 + i;
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
