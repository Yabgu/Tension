# TypeScript WASM Demo for Tension Engine

This demo shows how to write game logic in TypeScript (AssemblyScript) that compiles to WebAssembly and runs on the Tension core engine. Unlike the basic-demo which uses Rust WASM modules, this demo uses TypeScript for all game logic.

## Structure

- `assembly/index.ts` - AssemblyScript game logic that compiles to WASM
- `modules/entity_spawner.wasm` - Compiled WASM module (generated from TypeScript)
- `package.json` - Node.js build configuration for AssemblyScript
- `build.sh` - Build script to compile TypeScript to WASM

## Building the WASM Module

1. Install dependencies:
   ```bash
   cd demos/tension-ts-wasm-demo
   npm install
   ```

2. Build the WASM module from TypeScript:
   ```bash
   npm run build
   # or use the build script
   ./build.sh
   ```

3. The compiled WASM module will be in `modules/entity_spawner.wasm`

## Running the Demo

Run the demo using the main Tension engine with the demo name:

```bash
# From the root Tension directory
cargo run --bin tension-engine -- tension-ts-wasm-demo
```

The main engine will:
1. Load the `modules/entity_spawner.wasm` file (compiled from TypeScript)
2. Create a world with native entities (cubes, spheres, background objects)
3. Let the TypeScript WASM module dynamically spawn and animate additional entities

## Game Logic (TypeScript)

The TypeScript code in `assembly/index.ts` provides the same functionality as the Rust entity-spawner module:
- **Auto-spawning**: Creates new entities every 2 seconds
- **Cleanup**: Removes old entities to prevent memory bloat
- **Animation**: Makes entities float up and down with sine wave motion
- **Input handling**: Spawns entities when mouse is clicked
- **Logging**: Reports activities to the engine console

## Key Difference from Basic Demo

- **basic-demo**: Uses Rust for both engine and WASM modules
- **tension-ts-wasm-demo**: Uses Rust for engine core, TypeScript for game logic WASM modules

This demonstrates the flexibility of the Tension engine architecture where game developers can write their logic in TypeScript while still benefiting from the high-performance native core.