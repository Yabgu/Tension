#!/usr/bin/env bash
# Run all test suites across Tension:
#   1. tension-framework  (tension-framework/tests/run.sh)
#   2. tension-ogre guest (tension-ogre/tests/run.sh)
#   3. tension-input      (tension-input/tests/run.sh)
#   4. tension-core       (cargo test)
#   5. tension-ogre unit  (tension-ogre/build.sh --test)
#   6. tension-res        (zig build test)
#
# The order is the dependency order, not a preference. The `ogre_*` integration
# tests in `tension-core` load fixtures the earlier suites build — the
# framework's guest modules (for `ogre_smoke`) and `tension-ogre/tests/run.sh`'s
# compiled guests and packed volume — so those run before `cargo test`. A
# missing fixture is a hard failure rather than a skip
# (`tension-core/tests/support/ci.rs`; opt out with TENSION_TEST_ALLOW_SKIP=1),
# which is what makes this order load-bearing rather than cosmetic.
#
# Usage:
#   ./test.sh                # run all suites
#   ./test.sh --core         # run tension-core tests only
#   ./test.sh --framework    # run tension-framework tests only
#   ./test.sh --ogre         # run the tension-ogre C++ unit tests only
#   ./test.sh --ogre-guest   # run the tension-ogre guest suite only
#   ./test.sh --input        # run the tension-input tests only
#   ./test.sh --res          # run tension-res tests only
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# An in-tree Ogre-Next (third_party/bootstrap.sh) lives outside the loader's
# default search path; the adapter and its render systems resolve from there.
# The example runners and tension-ogre/tests/run.sh do the same, and the
# `ogre_*` integration tests need it here because they spawn the interpreter
# directly rather than through a recipe that sets it.
in_tree_lib="$here/third_party/ogre-next-install/lib"
if [ -d "$in_tree_lib" ]; then
    export LD_LIBRARY_PATH="$in_tree_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

run_all=true
run_core=false
run_framework=false
run_ogre=false
run_ogre_guest=false
run_input=false
run_res=false
run_codegen=false

while [ $# -gt 0 ]; do
  case "$1" in
    --core)       run_core=true; run_all=false ;;
    --framework)  run_framework=true; run_all=false ;;
    --ogre)       run_ogre=true; run_all=false ;;
    --ogre-guest) run_ogre_guest=true; run_all=false ;;
    --input)      run_input=true; run_all=false ;;
    --res)        run_res=true; run_all=false ;;
    --codegen)    run_codegen=true; run_all=false ;;
    -h|--help)
      echo "usage: ./test.sh [--core] [--framework] [--ogre] [--ogre-guest] [--input] [--res] [--codegen]"
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$run_all" = true ]; then
  run_codegen=true
  run_framework=true
  run_ogre_guest=true
  run_input=true
  run_core=true
  run_ogre=true
  run_res=true
fi

passed=()
failed=()

run_suite() {
  local name="$1"
  shift
  echo
  echo "======================================================================"
  echo "==> Running $name tests"
  echo "======================================================================"
  if "$@"; then
    echo "==> $name: PASSED"
    passed+=("$name")
  else
    echo "==> $name: FAILED" >&2
    failed+=("$name")
  fi
}

# The generated wire records first: everything below compiles against them, so a
# schema edit that was not regenerated must fail before the fixtures do.
if [ "$run_codegen" = true ]; then
  run_suite "codegen" node tools/codegen/generate.mjs \
    --schema schema/ogre.json \
    --out-ts tension-framework/assembly/ogre/generated \
    --out-h tension-ogre/src/generated --check
fi

# Fixture producers first: framework guests, then the OGRE guests and volume.
if [ "$run_framework" = true ]; then
  run_suite "tension-framework" bash -c "cd tension-framework && ./tests/run.sh"
fi

if [ "$run_ogre_guest" = true ]; then
  run_suite "tension-ogre (guest)" bash -c "cd tension-ogre && ./tests/run.sh"
fi

if [ "$run_input" = true ]; then
  run_suite "tension-input" bash -c "cd tension-input && ./tests/run.sh"
fi

# Then the consumer: `cargo test`, whose ogre_* cases read the fixtures above.
if [ "$run_core" = true ]; then
  run_suite "tension-core" cargo test --manifest-path tension-core/Cargo.toml
fi

if [ "$run_ogre" = true ]; then
  run_suite "tension-ogre (unit)" bash -c "cd tension-ogre && ./build.sh --test"
fi

if [ "$run_res" = true ]; then
  run_suite "tension-res" bash -c "cd tension-res && zig build test"
fi

echo
echo "======================================================================"
echo "==> Test Summary"
echo "======================================================================"
for name in "${passed[@]}"; do
  echo "  [PASS] $name"
done
for name in "${failed[@]}"; do
  echo "  [FAIL] $name"
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "==> ${#failed[@]} test suite(s) failed." >&2
  exit 1
else
  echo "==> All ${#passed[@]} test suite(s) passed successfully."
fi
