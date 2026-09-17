#!/bin/sh
# tension-solver build recipe — pinned, not inherited.
#
# Called from tension-core/build.rs the way `zig build` is called for
# tension-res: one command, one archive, loud failure. The flags are pinned
# here, in the recipe, because determinism depends on them (DESIGN.md §2,
# §5); an environment that supplies different flags must edit this file and
# say so, not export something the build cannot see.
#
# Produces: tension-solver/build/libtension_solver.a — a single static
# archive. tension-core/build.rs adds the link directives the archive
# needs: -ltension_solver, -lgfortran, -lm.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out="$here/build"

if ! command -v gfortran >/dev/null 2>&1; then
    echo "tension-solver: gfortran not found on PATH." >&2
    echo "  Install the GNU Fortran compiler (package: gfortran) and retry;" >&2
    echo "  tension-core links the solver core built by this script." >&2
    exit 1
fi

# -O2 -fno-fast-math: pinned for determinism. Fast-math permits
# reassociation and reciprocal contraction, which change results
# bit-for-bit; it is not an optimization detail here, it is part of the
# contract (DESIGN.md §2, §5).
# -fPIC: the Rust host links a PIE; an absolute 32-bit relocation from a
# non-PIC archive cannot be linked into one (tension-res/DESIGN.md §9.2,
# fact 1 — the same lesson for a different toolchain).
FLAGS="-O2 -fno-fast-math -fPIC"

mkdir -p "$out"
# -J / -I: gfortran writes the module interface file
# (tension_solver_erk.mod) to the current working directory unless told
# otherwise — which is whatever directory the caller happened to be in
# (cargo's, when build.rs runs this). Pin it next to the archive: build
# output must not leak into the tree.
gfortran $FLAGS -J "$out" -I "$out" -c "$here/src/fortran/tension_solver_erk.f90" \
    -o "$out/tension_solver_erk.o"
ar rcs "$out/libtension_solver.a" "$out/tension_solver_erk.o"
