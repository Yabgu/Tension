# box-physics — 2D Rigid Body Box Physics Simulation

A full rigid body 2D physics simulation running in TensionScript on top of `tension::2d`:
continuous rotation, Oriented Bounding Box (OBB) collisions via Separating Axis Theorem (SAT),
contact manifold generation via Sutherland-Hodgman polygon clipping, and sequential impulse
resolution with Coulomb friction and restitution.

## What is simulated

- **Oriented Bounding Boxes (OBB):** Each box has continuous position $(x, y)$, continuous orientation angle $\theta$, linear velocity $(v_x, v_y)$, and angular velocity $\omega$.
- **Inertia Tensor:** Moment of inertia $I = \frac{1}{3} m (hw^2 + hh^2)$ derived from box dimensions and mass.
- **Narrow-Phase SAT:** Separating Axis Theorem evaluates the 4 face normals of box pairs to determine separation or minimum penetration depth and collision normal.
- **Contact Manifold Clipping:** Reference face identification and Sutherland-Hodgman polygon clipping computes 1 or 2 contact points per collision pair, allowing realistic edge-edge and vertex-edge impacts with correct torque lever arms.
- **Sequential Impulses:** Impulses resolve normal non-penetration with Baumgarte position stabilization and restitution bounce, while friction impulses apply opposing tangential forces and torque, producing realistic rolling, sliding, and tumbling.
- **Environment:** Floor, ceiling, left/right walls, and angled static ramps are simulated through the same unified OBB collision pipeline with infinite mass and inertia.
- **Rendering via `tension::2d`:** Pre-rasterized 1024x1024 RGBA8 procedural texture atlas encodes 32 discrete rotation angles for each shape type with distinct color identities, border outlines, and orientation markers. Transparent texels blend through SDL_GPU source-over blending.

## Run it

```sh
npm run build
npm start                     # interactive window at 60 fps
npm test                      # headless verification of physics invariants and rendered pixels
```

From the repository root:

```sh
tension-core examples/2d/box-physics/build/game.wasm --windowed
```

Output:

```
  === TensionCore 2D demo: full rigid body box physics simulation ===
  open -> handle 1
  info -> v2, max_records 4096, canvas 640x360
  set_pipeline -> pipe 100
  texture_load -> texture 1 (1024x1024 RGBA), bound to page 0
  physics -> resolved 7944 contact pairs, 9/12 bodies rotated through collision torque
  screenshot -> 921600 bytes, 92702 non-black pixels (46 sprite records)
  OK: full 2d box physics simulation verified
```

## Structure

- `src/math.ts`: 2D scalar math primitives (vectors, dot products, cross products, angle normalization).
- `src/physics.ts`: `Body`, `Contact`, SAT collision detection, polygon clipping, and `PhysicsWorld` with sequential impulse solver.
- `src/atlas.ts`: Generates 1024x1024 RGBA8 IWI1 texture atlas containing pre-rasterized rotated box frames and tile textures.
- `src/main.ts`: Main game entry (`_start_game`), scene setup, simulation loop, canvas submission, screenshot assertion, and window presentation.
- `test.mjs`: Test harness asserting physics invariants, non-penetration, rotational displacement, and rendered frame contents.
