#!/usr/bin/env bash
set -euo pipefail

# Build only: compile the AssemblyScript into WASM
cd "$(dirname "$0")"

echo "[demo] Building AssemblyScript WASM module..."
npm run build

echo "[demo] Build finished. Output: modules/entity_spawner.wasm"
#!/bin/bash

# Build script for TypeScript WASM Demo

set -e

echo "🔧 Building TypeScript WASM Demo for Tension Engine..."

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install Node.js"
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Build the WASM module
echo "🔨 Compiling AssemblyScript to WASM..."
npm run build

# Check if the WASM file was created
if [ -f "modules/entity_spawner.wasm" ]; then
    echo "✅ Successfully built entity_spawner.wasm"
    ls -la modules/entity_spawner.wasm
else
    echo "❌ Failed to build WASM module"
    exit 1
fi

echo "🎉 TypeScript WASM Demo build completed!"
echo "The WASM module is ready to be loaded by the Tension engine."