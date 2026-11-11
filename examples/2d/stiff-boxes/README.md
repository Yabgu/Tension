# 2D Box Physics with BDF2 Implicit Solver (`stiff-boxes`)

Demonstrates continuous rigid box physics (collisions, gravity, tumbling, full rotation, sliding, and stacking) integrated using **BDF2** (Backward Differentiation Formula 2nd-order implicit solver) from `tension::solver`, with compile-time generated texture assets loaded from a packed `.tns` resource volume.

## Highlights

- **BDF2 Solver in Core**: Uses the L-stable, 2nd-order implicit solver added to `tension-solver` with Newton-Raphson iteration and numerical Jacobian.
- **Stiff Contact Penalty Physics**: Continuous spring-damper contact mechanics between 10 dynamic boxes, 2 angled ramps, and enclosing boundaries. Stiff penalty forces ($K = 10,000$, $D = 150$) are stepped stably without numerical explosion or micro-substepping.
- **Compile-Time Asset Pipeline**: Textures are not built at runtime; `emit-boxes.mjs` generates a 1024×1024 RGBA8 IWI1 texture atlas at compile time, which is packed into `build/stiff-boxes.tns` via `tension-pack` and loaded at runtime via `canvas.loadTextureFromRes("textures/boxes.iwi")`.
- **Zero-Allocation Rendering**: Sprite records conform to the tension-2d plain struct specification (`@unmanaged [SpriteRecord *]`).

## Running

```bash
# Automated headless test
npm test

# Interactive windowed visualization
npm start
```
