#!/usr/bin/env bash
set -euo pipefail

# Build and run the TypeScript WASM demo with the engine
# Usage: ./run.sh

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

echo "[demo] Building AssemblyScript WASM module..."
npm run build

# Determine engine binary path (relative to demo folder)
ENGINE_BIN="$here/../../target/debug/tension-engine"

if [ ! -x "$ENGINE_BIN" ]; then
  echo "[demo] Engine binary not found at $ENGINE_BIN. Building engine..."
  (cd "$here/../.." && cargo build --bin tension-engine)
fi

echo "[demo] Running engine with demo 'tension-ts-wasm-demo'..."
"$ENGINE_BIN" tension-ts-wasm-demo
