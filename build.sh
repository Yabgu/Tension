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

# ---- preflight: every external tool the build shells out to --------------
# tension-core's build.rs shells out to zig (tension-res's archive), gfortran /
# cc / ar (the solver core, via tension-solver/build.sh), cc (the sample plugin
# and the test fixtures), and — with the default `ai` feature — cmake and a C++
# compiler for vendored llama.cpp. `.cargo/config.toml` adds `-fuse-ld=lld` to
# every link. A missing tool used to surface as a panic inside build.rs, after
# cargo had already compiled the dependency tree; this names what is missing
# and how to get it, before any of that.
#
# Two of them are version-pinned (build.rs's PINNED_ZIG / PINNED_GFORTRAN): a
# different Zig changes the resource ABI's codegen, a different gfortran changes
# the solver's results. A mismatch is refused unless TENSION_ALLOW_UNPINNED=1,
# which demotes it to a warning — the escape hatch for a machine that must build
# with what it has. build.rs enforces the same rule, so a bare `cargo build`
# behaves the same way. **If a pin here moves, move it in build.rs too** (and
# vice versa): they are the same contract in two places.
unpinned=0
if [ "${TENSION_ALLOW_UNPINNED:-0}" = 1 ]; then unpinned=1; fi
missing=0

have() { command -v "$1" >/dev/null 2>&1; }

require() { # <tool> <remedy>
  if ! have "$1"; then
    echo "build.sh: $1 is not on PATH — $2" >&2
    missing=1
  fi
}

pin_mismatch() { # <tool> <reported> <wanted> <why>
  if [ "$unpinned" = 1 ]; then
    echo "build.sh: warning: $1 '$2' is not the pinned $3 ($4);" >&2
    echo "          TENSION_ALLOW_UNPINNED=1 is set, so the build continues." >&2
  else
    echo "build.sh: $1 '$2' does not match the pinned $3 — $4." >&2
    echo "          Use $1 $3, or set TENSION_ALLOW_UNPINNED=1 to build anyway." >&2
    missing=1
  fi
}

echo "==> preflight: checking the toolchain the build shells out to"
# Rust itself: build.rs is a cargo build script, and `cargo build` is below.
require cargo    "install Rust (https://rustup.rs)"
require rustc    "install Rust (https://rustup.rs)"
# The host's linked-in cores and fixtures.
require zig      "install Zig 0.16.x (https://ziglang.org/download/)"
require gfortran "install GNU Fortran (Arch: gfortran; Debian: gfortran)"
require cc       "install a C compiler (Arch: gcc; Debian: gcc/clang)"
require ar       "install binutils (provides ar)"
# The default `ai` feature links vendored llama.cpp through cmake.
require cmake    "install cmake, or build the host without ai: --no-default-features --features audio"
if ! have c++ && ! have g++ && ! have clang++; then
  echo "build.sh: no C++ compiler (c++ / g++ / clang++) — the default ai feature" >&2
  echo "          builds vendored llama.cpp; install one, or build without ai:" >&2
  echo "              cargo build --manifest-path tension-core/Cargo.toml \\" >&2
  echo "                  --no-default-features --features audio" >&2
  missing=1
fi
# The guest SDK and every example build through npm.
require npm      "install Node.js + npm (the framework and examples build with it)"
# lld: .cargo/config.toml links every target with -fuse-ld=lld. rustc bundles a
# copy and points the C compiler at it (-B<sysroot>/…/bin/gcc-ld), so a system
# lld is not usually needed — but a toolchain without the bundle, or a cc that
# cannot see it, fails at link time with an opaque error, which is what this
# catches.
if ! have ld.lld && ! have lld; then
  # `rustc` may itself be missing — the require above already reported that, and
  # probing a missing tool must not abort the preflight (pipefail turns a failed
  # pipeline into a failed assignment, which `set -e` would exit on).
  sysroot=""; host=""
  if have rustc; then
    sysroot=$(rustc --print sysroot 2>/dev/null || true)
    host=$(rustc -vV 2>/dev/null | sed -n 's/^host: //p' || true)
  fi
  if [ -z "$sysroot" ] || [ -z "$host" ] \
    || [ ! -x "$sysroot/lib/rustlib/$host/bin/gcc-ld/ld.lld" ]; then
    echo "build.sh: no lld found — neither a system ld.lld nor rustc's bundled one." >&2
    echo "          .cargo/config.toml links with -fuse-ld=lld; install lld" >&2
    echo "          (Arch: lld; Debian: lld), or remove that flag from .cargo/config.toml." >&2
    missing=1
  fi
fi
# The two version pins.
if have zig; then
  zig_v=$(zig version 2>/dev/null | head -n1)
  case "$zig_v" in
    0.16.*) : ;;
    *) pin_mismatch zig "$zig_v" "0.16.x" "tension-res is compiled by it" ;;
  esac
fi
if have gfortran; then
  gf_v=$(gfortran --version 2>/dev/null | head -n1)
  case "$gf_v" in
    *16.*) : ;;
    *) pin_mismatch gfortran "$gf_v" "16.x" "the solver's numerical core is compiled by it" ;;
  esac
fi

if [ "$missing" != 0 ]; then
  echo >&2
  echo "build.sh: refusing to build until the toolchain above is resolved." >&2
  exit 1
fi

# ---- core ----------------------------------------------------------------
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
