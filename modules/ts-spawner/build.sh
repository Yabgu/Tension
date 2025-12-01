#!/bin/bash
set -e
cd "$(dirname "$0")"

# install deps locally if node_modules missing
if [ ! -d node_modules ]; then
  echo "Installing assemblyscript..."
  npm install
fi

# build
echo "Building AssemblyScript module..."
npx asc assembly/index.ts -b build/ts_spawner.wasm --optimize --runtime none --noAssert

# copy into demo modules
mkdir -p ../../demos/basic-demo/modules
cp build/ts_spawner.wasm ../../demos/basic-demo/modules/ts_spawner.wasm

echo "Built and copied ts_spawner.wasm"