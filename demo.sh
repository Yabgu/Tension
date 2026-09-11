#!/usr/bin/env bash
# Build the interpreter + a game and run it against a few arguments.
set -euo pipefail
cd "$(dirname "$0")"

HOST=tension-core/target/debug/tension-core

echo "==> building tension-core"
cargo build --manifest-path tension-core/Cargo.toml

echo "==> installing examples deps (assemblyscript + tension-framework)"
if [ ! -x examples/node_modules/.bin/asc ]; then
  ( cd examples && npm install )
fi

echo "==> building examples/io/game.ts (game.wasm)"
( cd examples && ./node_modules/.bin/asc io/game.ts -o io/build/game.wasm --runtime stub --target release )

echo "==> running the io example"
printf 'hello from the terminal\n' \
  | "$HOST" examples/io/build/game.wasm alpha beta gamma

echo "==> building examples/audio/demo.ts (demo.wasm)"
( cd examples && ./node_modules/.bin/asc audio/demo.ts -o audio/build/demo.wasm --runtime stub --target release )

echo "==> running the audio demo (stderr shows the [tension:audio] ABI trace)"
"$HOST" examples/audio/build/demo.wasm
