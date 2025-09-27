#!/usr/bin/env bash

# Build script for the entire Tension project

set -euo pipefail

echo "=== Building Tension Engine ==="

# Resolve repo root (directory containing this script)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build core engine
echo "Building Zig core..."
if command -v zig &> /dev/null; then
    pushd "$ROOT/core" >/dev/null
    zig build
    popd >/dev/null
    echo "✓ Core engine built successfully"
else
    echo "⚠ Zig not found. Install Zig to build the core engine."
    echo "  Download from: https://ziglang.org/download/"
fi

# Build demo module (run its own build script if present)
DEMO_DIR="$ROOT/modules/ts-demo"
echo "Building demo module (if present)..."
if [ -f "$DEMO_DIR/build.sh" ]; then
    pushd "$DEMO_DIR" >/dev/null
    # Execute with bash so the script doesn't need +x
    bash ./build.sh
    popd >/dev/null
    echo "✓ Demo module build step finished"
else
    echo "⚠ Demo build script not found at $DEMO_DIR/build.sh"
    echo "  If you expect an AssemblyScript demo, ensure modules/ts-demo exists and contains a build.sh"
fi

echo ""
echo "=== Build Summary ==="
if [ -f "$ROOT/core/zig-out/bin/tension" ]; then
    echo "Core: ✓ Built"
else
    echo "Core: ⚠ Not built"
fi

# Detect .wasm produced by demo: either at repo root (scene.wasm) or anywhere under demo dir
WASM_FOUND=false
if [ -f "$ROOT/scene.wasm" ]; then
    WASM_FOUND=true
fi
if find "$DEMO_DIR" -maxdepth 4 -type f -name '*.wasm' | grep -q .; then
    WASM_FOUND=true
fi

if [ "$WASM_FOUND" = true ]; then
    echo "Demo: ✓ Built (wasm found)"
else
    echo "Demo: ⚠ Not built (no .wasm found in $DEMO_DIR or repo root)"
fi

echo ""
echo "Run the engine with: cd core && zig build run"