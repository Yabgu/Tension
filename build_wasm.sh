#!/bin/bash
# Build script for WASM modules

set -e

echo "🔧 Building WASM modules for Frankenstein Engine"

# Check if wasm32-unknown-unknown target is installed
if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
    echo "Installing wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
fi

# Build entity-spawner module
echo "Building entity-spawner module..."
cd modules/entity-spawner
cargo build --target wasm32-unknown-unknown --release

# Copy WASM file to demo directory
cd ../..
mkdir -p demos/basic-demo/modules
cp target/wasm32-unknown-unknown/release/entity_spawner.wasm demos/basic-demo/modules/
echo "✅ entity-spawner.wasm copied to demo directory"

# Optional: Optimize WASM with wasm-opt (if available)
if command -v wasm-opt &> /dev/null; then
    echo "Optimizing WASM with wasm-opt..."
    wasm-opt -O3 demos/basic-demo/modules/entity_spawner.wasm -o demos/basic-demo/modules/entity_spawner.wasm
    echo "✅ WASM optimization complete"
else
    echo "⚠️  wasm-opt not found. Install it from https://github.com/WebAssembly/binaryen for smaller binaries"
fi

echo "🎉 WASM module build complete!"
echo "📁 Modules available in: demos/basic-demo/modules/"
ls -la demos/basic-demo/modules/