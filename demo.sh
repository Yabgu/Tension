#!/usr/bin/env bash
# Build the interpreter + each example and run them against a few arguments.
#
# The ai example is the one piece that depends on more than the repo: it needs
# a GGUF model and an interpreter built with `--features ai` (which links
# vendored llama.cpp — a one-time ~2 minute C++ build needing cmake + a C++
# compiler). This script links it when both are present and otherwise runs the
# ai demo on the host's deterministic headless adapter, saying so — a plain
# `cargo build` leaves an interpreter that can never answer from a model, and
# that silent downgrade is exactly how "the ai example does not reply".
set -euo pipefail
cd "$(dirname "$0")"

HOST=tension-core/target/debug/tension-core
MODEL="${MODEL:-examples/ai/models/Phi-3-mini-4k-instruct-q4.gguf}"

# Each example is its own npm project, so it carries its own dependencies.
build_example() {
  local name="$1" dir="examples/$1"
  if [ ! -x "$dir/node_modules/.bin/asc" ]; then
    echo "==> installing $dir deps (assemblyscript + tension-framework)"
    # The ai example's postinstall fetches ~2.3 GB of weights; a demo run must
    # not start that behind your back. `npm install` inside examples/ai does.
    ( cd "$dir" && TENSION_SKIP_MODEL_FETCH=1 npm install --no-audit --no-fund )
  fi
  echo "==> building the $name example"
  ( cd "$dir" && npm run build )
}

# The ai example runs on the real model only when the gguf file exists AND the
# toolchain can link llama.cpp; anything less keeps the headless adapter.
AI_FEATURE=0
if [ -f "$MODEL" ] \
  && command -v cmake >/dev/null 2>&1 \
  && { command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1; }; then
  AI_FEATURE=1
fi

echo "==> building tension-core"
if [ "$AI_FEATURE" = 1 ]; then
  echo "    (--features ai: linking vendored llama.cpp; one-time ~2 min)"
  cargo build --manifest-path tension-core/Cargo.toml --features ai
else
  echo "    (headless ai adapter: no $MODEL, or no cmake/C++ compiler)"
  cargo build --manifest-path tension-core/Cargo.toml
fi

build_example io
echo "==> running the io example"
printf 'hello from the terminal\n' \
  | "$HOST" examples/io/build/game.wasm alpha beta gamma

build_example audio
echo "==> running the audio demo (stderr shows the [tension:audio] ABI trace)"
"$HOST" examples/audio/build/demo.wasm

build_example ai
if [ "$AI_FEATURE" = 1 ]; then
  echo "==> running the ai demo (model: $MODEL)"
else
  echo "==> running the ai demo (deterministic headless adapter — no model needed;"
  echo "    fetch weights with 'npm install' in examples/ai for the real thing)"
fi
printf 'hello there\n/quit\n' \
  | "$HOST" examples/ai/build/story.wasm "$MODEL"
