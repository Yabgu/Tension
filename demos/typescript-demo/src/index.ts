import { Engine, EngineConfig } from 'tension'; // Import the Tension engine
import { loadWasm } from './wasm-loader'; // Import the WASM loader

async function main() {
    // Initialize the tracing subscriber for logging
    tracing_subscriber::fmt::init();

    // Log the start of the demo
    console.log("🚀 Basic Demo - Tension Engine Showcase");

    // Load the WASM module
    const wasmInstance = await loadWasm();

    // Engine configuration optimized for demo
    const config = new EngineConfig();
    config.windowWidth = 1280;
    config.windowHeight = 720;
    config.targetFps = 60;
    config.enableDeterministicMode = true;
    config.masterSeed = 42;

    // Create engine
    const engine = new Engine(config, wasmInstance);

    // Create demo entities
    createDemoWorld(engine.world);

    // Run the demo
    engine.run();

    console.log("Demo completed successfully");
}

function createDemoWorld(world) {
    console.log("Creating demo world with moving entities");

    // Create a central spinning cube
    const centerCube = world.createEntity();
    world.addComponent(centerCube, {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1.5, y: 1.5, z: 1.5 },
        parent: null,
    });
    world.addComponent(centerCube, {
        meshId: "cube",
        materialId: "red",
        visible: true,
        layer: 0,
    });

    // Create orbiting spheres
    for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI * 2) / 8;
        const radius = 4.0;
        const position = {
            x: Math.cos(angle) * radius,
            y: 0,
            z: Math.sin(angle) * radius,
        };

        const sphere = world.createEntity();
        world.addComponent(sphere, {
            position,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
            parent: null,
        });
        world.addComponent(sphere, {
            meshId: "sphere",
            materialId: ["blue", "green", "yellow", "purple"][i % 4],
            visible: true,
            layer: 1,
        });
    }

    // Create some static background objects
    for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
            if (x === 0 && z === 0) continue; // Skip center

            const bgObject = world.createEntity();
            world.addComponent(bgObject, {
                position: { x: x * 6.0, y: -1.0, z: z * 6.0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                scale: { x: 0.5, y: 0.5, z: 0.5 },
                parent: null,
            });
            world.addComponent(bgObject, {
                meshId: "quad",
                materialId: "gray",
                visible: true,
                layer: 0,
            });
        }
    }

    console.log(`Demo world created with ${world.entityCount()} entities`);
}

// Start the application
main().catch(console.error);