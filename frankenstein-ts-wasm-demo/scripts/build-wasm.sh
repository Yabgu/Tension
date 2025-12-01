#!/bin/bash

# Navigate to the AssemblyScript directory
cd assembly

# Install dependencies
npm install

# Build the WebAssembly module
npm run build

# Move the generated WebAssembly file to the appropriate location if necessary
# cp build/your-module.wasm ../public/your-module.wasm

echo "WebAssembly build completed."