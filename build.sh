#!/bin/bash
# Main build script for Tension Engine

set -e

echo "🎮 Building Tension Engine - WASM-Driven Game Engine"
echo "Playing safe is the real trap. Welcome to the forbidden lamp."

# Build the main engine
echo "🔧 Building engine core..."
cargo build --release

# Build WASM modules
echo "🔧 Building WASM modules..."
./build_wasm.sh

# Build demos
echo "🔧 Building demos..."
cd demos/basic-demo
cargo build --release
cd ../..

echo "🎉 Build complete!"
echo ""
echo "🚀 Run the demo with:"
echo "  cargo run --release"
echo "  or"
echo "  cargo run --release --bin basic-demo"
echo ""
echo "🎯 Controls:"
echo "  - ESC: Quit"
echo "  - Mouse Click: Spawn entity at cursor (if WASM module loaded)"
echo "  - Entities spawn automatically every 2 seconds"
echo ""
echo "🔥 Features demonstrated:"
echo "  ✅ Fixed timestep deterministic loop"
echo "  ✅ SDL2 rendering with entity-component system"
echo "  ✅ WASM module hot-reload architecture (modules/entity-spawner)"
echo "  ✅ Performance instrumentation"
echo "  ✅ Input handling and event system"