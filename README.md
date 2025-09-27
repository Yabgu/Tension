# Tension

A modular, hot-reloadable game runtime built with Zig and WebAssembly.

## Overview

Tension is a minimal game engine that combines a native Zig core with language-agnostic WebAssembly modules. It focuses on deterministic behavior, fast hot-reload cycles, and complete developer control.

## Architecture

- **Core** (Zig + SDL2): Window management, renderer, event loop, WASM host
- **WASM Host**: Loads `.wasm` modules and provides game API imports
- **Modules**: Game logic written in AssemblyScript, Rust, or any WASM-compatible language
- **Hot-reload**: Core watches for WASM changes and reloads modules instantly

## Quick Start

1. Build the core engine:
   ```bash
   cd core
   zig build run
   ```

2. Build a demo module:
   ```bash
   cd modules/ts-demo
   ./build.sh
   ```

3. The engine will automatically load `scene.wasm` and run the demo.

## API Contract

WASM modules must export:
- `start()` - Called once on module load
- `update(dt: f32)` - Called every frame

Available host functions:
- `createBox(x, y, w, h) -> id`
- `moveEntity(id, dx, dy)`
- `log(ptr, len)` 
- `time() -> f32`
- `input(key) -> bool`

See [docs/api-contract.txt](docs/api-contract.txt) for full details.

## Philosophy

- **Brutally minimal**: No editor, no fluff
- **Deterministic**: Consistent across platforms  
- **Hot-reloadable**: Immediate feedback loop
- **Future-proof**: Language-agnostic WASM modules

See [docs/philosophy.txt](docs/philosophy.txt) for more details.

## Directory Structure

```
Tension/
├── core/           # Zig engine core (main.zig, engine.zig, wasm.zig, graphics.zig, build.zig)
├── modules/        # Game modules (ts-demo/, your-module/)
├── demos/          # Example projects
├── docs/           # Documentation (api-contract.txt, philosophy.txt, vision.txt)
└── README.md
```

## Contribution

1. Modules go in `modules/<name>/`, must export `start()` and `update(dt)`
2. Core development in Zig, keep WASM host isolated in `wasm.zig`  
3. Document new host imports in `docs/api-contract.txt`

## License

MIT - See [LICENSE](LICENSE) for details.