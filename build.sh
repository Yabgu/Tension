#!/usr/bin/env bash
# Build the whole tree: the interpreter (core), the guest API (framework), and
# every example.
#
# - tension-core: one `cargo build`. Its build.rs also builds the resource
#   packer (Zig) and the solver core (gfortran) that the host links. The `ai`
#   feature is on by default, which links vendored llama.cpp — needs cmake +
#   a C++ compiler and takes ~2 min the first time. Without that toolchain,
#   build the host manually with
#       cargo build --manifest-path tension-core/Cargo.toml \
#           --no-default-features --features audio
#   and `tension::ai` falls back to the deterministic headless stub.
# - tension-framework: the guest API. Examples consume it as source (a `file:`
#   dependency), so its build compiles the barrel with asc — a broken SDK
#   fails here instead of inside the first example that imports it.
# - examples: each is its own npm project (or, for plugins/midpoint, a
#   Makefile) and builds with its own recipe. Installs set
#   TENSION_SKIP_MODEL_FETCH=1 because the ai example's postinstall fetches
#   ~2.3 GB of weights — this script never downloads the model
#   (examples/ai/prepare.sh does, on demand).
#
# Nothing here runs a game — that is demo.sh.
set -euo pipefail
cd "$(dirname "$0")"

# ---- core ----------------------------------------------------------------
if ! command -v cmake >/dev/null 2>&1 \
  || ! { command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1; }; then
  echo "build.sh: the default build links llama.cpp (the `ai` feature is on" >&2
  echo "by default) and needs cmake + a C++ compiler. Neither is on PATH —" >&2
  echo "build the host without it with:" >&2
  echo "    cargo build --manifest-path tension-core/Cargo.toml \\" >&2
  echo "        --no-default-features --features audio" >&2
  exit 1
fi

echo "==> building tension-core (ai is a default feature: links llama.cpp)"
cargo build --manifest-path tension-core/Cargo.toml

# ---- api ------------------------------------------------------------------
echo "==> building the guest API (tension-framework)"
if [ ! -x tension-framework/node_modules/.bin/asc ]; then
  echo "    installing tension-framework deps (assemblyscript)"
  ( cd tension-framework && npm install --no-audit --no-fund )
fi
( cd tension-framework && npm run build )

# ---- examples --------------------------------------------------------------
# Each example is its own npm project, so it carries its own dependencies.
build_example() {
  local name="$1" dir="examples/$1"
  if [ ! -x "$dir/node_modules/.bin/asc" ]; then
    echo "    installing $dir deps (assemblyscript + tension-framework)"
    ( cd "$dir" && TENSION_SKIP_MODEL_FETCH=1 npm install --no-audit --no-fund )
  fi
  echo "==> building the $name example"
  ( cd "$dir" && npm run build )
}

build_example io
build_example audio
build_example ai
build_example res
build_example solver/wasm
build_example solver/world
build_example solver/collision

echo "==> building the plugins/midpoint example plugin"
make -C examples/plugins/midpoint

echo
echo "build.sh: done. Run a game with:"
echo "    tension-core/target/debug/tension-core <game.wasm> [args...]"
