#!/bin/bash

# Build script for AssemblyScript demo module

echo "Building AssemblyScript demo module..."

# Check if AssemblyScript is installed
if ! command -v asc &> /dev/null; then
    echo "AssemblyScript compiler (asc) not found. Please install with:"
    echo "npm install -g assemblyscript"
    exit 1
fi

# Compile TypeScript to WebAssembly
asc scene.ts \
    --target release \
    --outFile scene.wasm \
    --textFile scene.wat \
    --optimize \
    --runtime stub \
    --exportRuntime

if [ $? -eq 0 ]; then
    echo "Build successful! Generated:"
    echo "  - scene.wasm (WebAssembly binary)"
    echo "  - scene.wat (WebAssembly text format)"
    
    # Copy to parent directory for the engine to find
    cp scene.wasm ../../scene.wasm
    echo "  - Copied scene.wasm to project root"
else
    echo "Build failed!"
    exit 1
fi