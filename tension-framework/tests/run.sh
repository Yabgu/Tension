#!/usr/bin/env bash
# Build the framework's fixtures and run them against tension-core.
#
# Two fixtures, one pipeline (`tension-ogre/DESIGN.md` §10):
#
#   guest-open.ts   the session runtime alone: open, close, print OK;
#   guest-ogre.ts   the capability ABI end to end: a mesh load, a JOB_DONE
#                   delivery, and a job resolved from the event;
#   guest-verlet.ts the solver capability: velocity Verlet from a guest, checked
#                   against a closed form (chunk 6a's P0, which is what settled
#                   the stale claim in `tension-solver/GUEST_ABI.md` §7);
#   guest-physics-units.ts the physics layer's pieces (8b): quaternion recovery,
#                   the impulse formula against hand computation, the bias rule,
#                   a free body's spin, the linear model's invariants, and
#                   MotionBatch.setPose's offsets.
#
# Steps, in the order the design fixes them:
#
#   1. the generator derives layout.ts and the asc flags from session.json, with
#      the layout hash `tension-core layout-hash` prints — a disagreement stops
#      the build instead of shipping a guest the host will refuse;
#   2. `asc` compiles each fixture with those flags;
#   3. `tension-core` runs them. The ogre fixture needs `--capability` pointed at
#      the stub adapter, which cargo builds into its own OUT_DIR.
#
# A fixture's contract is "prints OK, exit 0". A trap is a failure with a
# distinct signature, and so is a non-zero exit.
#
# Usage: run.sh [path-to-tension-core] [path-to-stub-adapter]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
core="${1:-$root/../tension-core/target/debug/tension-core}"

if [ ! -x "$core" ]; then
  echo "run.sh: no interpreter at $core — build it with:" >&2
  echo "        cargo build --manifest-path $root/../tension-core/Cargo.toml --no-default-features" >&2
  exit 2
fi

# The stub adapter cargo built. `--capability` needs a path, so this looks for
# the newest one under the interpreter's target directory unless given one.
if [ $# -ge 2 ]; then
  stub="$2"
else
  stub="$(ls -t "$root"/../tension-core/target/debug/build/tension-core-*/out/libtension_ogre_stub.so 2>/dev/null | head -1 || true)"
fi
if [ -z "$stub" ] || [ ! -f "$stub" ]; then
  echo "run.sh: no ogre stub adapter found — build it with:" >&2
  echo "        cargo build --manifest-path $root/../tension-core/Cargo.toml --no-default-features" >&2
  exit 2
fi

hash="$("$core" layout-hash)"
echo "==> generating the runtime's constants (layout hash $hash)"
bash "$root/build.sh" --hash "$hash"

mkdir -p "$root/build"
run_fixture() {
  local entry="$1" out="$2"
  shift 2
  echo "==> compiling $entry"
  ( cd "$root" && ./node_modules/.bin/asc "tests/$entry" \
      --config build/session.asconfig.json -o "build/$out" )
  echo "==> running $out"
  set +e
  local stdout
  stdout="$("$core" "$@" "$root/build/$out" 2>"$root/build/$out.err")"
  local status=$?
  set -e
  echo "    stdout: $stdout"
  if [ "$status" -ne 0 ]; then
    echo "run.sh: $entry: the interpreter exited $status; stderr:" >&2
    cat "$root/build/$out.err" >&2
    exit 1
  fi
  case "$stdout" in
    *OK*) echo "    == $entry: OK" ;;
    *) echo "run.sh: $entry: the guest did not print OK" >&2; cat "$root/build/$out.err" >&2; exit 1 ;;
  esac
}

run_fixture guest-open.ts guest-open.wasm
run_fixture guest-ogre.ts guest-ogre.wasm --capability "$stub"
run_fixture guest-verlet.ts guest-verlet.wasm
run_fixture guest-physics-units.ts guest-physics-units.wasm
echo "==> all fixtures OK"
