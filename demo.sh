#!/usr/bin/env bash
# Build the interpreter + each example and run them against a few arguments.
set -euo pipefail
cd "$(dirname "$0")"

HOST=tension-core/target/debug/tension-core

# Each example is its own npm project, so it carries its own dependencies.
build_example() {
  local name="$1" dir="examples/$1"
  if [ ! -x "$dir/node_modules/.bin/asc" ]; then
    echo "==> installing $dir deps (assemblyscript + tension-framework)"
    ( cd "$dir" && npm install --no-audit --no-fund )
  fi
  echo "==> building the $name example"
  ( cd "$dir" && npm run build )
}

echo "==> building tension-core"
cargo build --manifest-path tension-core/Cargo.toml

build_example io
echo "==> running the io example"
printf 'hello from the terminal\n' \
  | "$HOST" examples/io/build/game.wasm alpha beta gamma

build_example audio
echo "==> running the audio demo (stderr shows the [tension:audio] ABI trace)"
"$HOST" examples/audio/build/demo.wasm
