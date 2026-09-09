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

echo "==> building examples/game.ts (game.wasm)"
( cd examples && ./node_modules/.bin/asc game.ts -o build/game.wasm --runtime stub --target release )

echo "==> running the game"
printf 'hello from the terminal\n' \
  | "$HOST" examples/build/game.wasm alpha beta gamma
