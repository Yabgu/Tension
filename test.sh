#!/usr/bin/env bash
# Run all test suites across Tension:
#   1. tension-core       (cargo test)
#   2. tension-res        (zig build test)
#   3. tension-ogre       (tension-ogre/build.sh --test)
#   4. tension-framework  (tension-framework/tests/run.sh)
#
# Usage:
#   ./test.sh             # run all suites
#   ./test.sh --core      # run tension-core tests only
#   ./test.sh --framework # run tension-framework tests only
#   ./test.sh --ogre      # run tension-ogre tests only
#   ./test.sh --res       # run tension-res tests only
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

run_all=true
run_core=false
run_framework=false
run_ogre=false
run_res=false

while [ $# -gt 0 ]; do
  case "$1" in
    --core)      run_core=true; run_all=false ;;
    --framework) run_framework=true; run_all=false ;;
    --ogre)      run_ogre=true; run_all=false ;;
    --res)       run_res=true; run_all=false ;;
    -h|--help)
      echo "usage: ./test.sh [--core] [--framework] [--ogre] [--res]"
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
  run_core=true
  run_framework=true
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

if [ "$run_core" = true ]; then
  run_suite "tension-core" cargo test --manifest-path tension-core/Cargo.toml
fi

if [ "$run_ogre" = true ]; then
  run_suite "tension-ogre" bash -c "cd tension-ogre && ./build.sh --test"
fi

if [ "$run_framework" = true ]; then
  run_suite "tension-framework" bash -c "cd tension-framework && ./tests/run.sh"
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
