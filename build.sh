#!/bin/bash

# Build script for the entire Tension project

set -e

echo "=== Building Tension Engine ==="

# Build core engine
echo "Building Zig core..."
if command -v zig &> /dev/null; then
    cd core
    zig build
    cd ..
    echo "✓ Core engine built successfully"
else
    echo "⚠ Zig not found. Install Zig to build the core engine."
    echo "  Download from: https://ziglang.org/download/"
fi

# Build demo module
echo "Building AssemblyScript demo module..."
if command -v asc &> /dev/null; then
    cd modules/ts-demo
    ./build.sh
    cd ../..
    echo "✓ Demo module built successfully" 
else
    echo "⚠ AssemblyScript compiler not found."
    echo "  Install with: npm install -g assemblyscript"
fi

echo ""
echo "=== Build Summary ==="
echo "Core: $([ -f core/zig-out/bin/tension ] && echo "✓ Built" || echo "⚠ Not built")"
echo "Demo: $([ -f scene.wasm ] && echo "✓ Built" || echo "⚠ Not built")"
echo ""
echo "Run the engine with: cd core && zig build run"