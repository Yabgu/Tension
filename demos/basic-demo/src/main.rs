/// Basic demo - Shows the engine running with native entities and WASM modules
use tension_core::*;
use tension_renderer::SdlRenderer;
use tension_runtime::WasmEngine;

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    
    tracing::info!("🚀 Basic Demo - Tension Engine Showcase");
    
    // Engine configuration optimized for demo
    let mut config = EngineConfig::default();
    config.window_width = 1280;
    config.window_height = 720;
    config.target_fps = 60;
    config.enable_deterministic_mode = true;
    config.master_seed = 42;
    
    // Create engine
    let mut engine = Engine::new(config.clone())?;
    
    // Setup renderer
    let renderer = SdlRenderer::new(&config)?;
    engine.set_renderer(Box::new(renderer));
    
    // Setup WASM runtime
    let runtime_config = tension_runtime::RuntimeConfig {
        max_memory_bytes: 16 * 1024 * 1024, // 16MB
        max_execution_time_ms: 4, // Quarter frame
        enable_wasi: false,
        module_directory: "modules".to_string(),
        enable_jit: true,
        debug_info: true,
    };
    
    let wasm_runtime = WasmEngine::new(runtime_config)?;
    engine.set_wasm_runtime(Box::new(wasm_runtime));
    
    // Create demo entities
    create_demo_world(engine.world_mut())?;
    
    // Run the demo
    engine.run()?;
    
    tracing::info!("Demo completed successfully");
    Ok(())
}

fn create_demo_world(world: &mut World) -> anyhow::Result<()> {
    use tension_core::api::{Transform, RenderComponent};
    use glam::{Vec3, Quat};
    
    tracing::info!("Creating demo world with moving entities");
    
    // Create a central spinning cube
    let center_cube = world.create_entity();
    world.add_component(center_cube, Transform {
        position: Vec3::ZERO,
        rotation: Quat::IDENTITY,
        scale: Vec3::splat(1.5),
        parent: None,
    });
    world.add_component(center_cube, RenderComponent {
        mesh_id: "cube".to_string(),
        material_id: "red".to_string(),
        visible: true,
        layer: 0,
    });
    
    // Create orbiting spheres
    for i in 0..8 {
        let angle = (i as f32) * std::f32::consts::PI * 2.0 / 8.0;
        let radius = 4.0;
        let position = Vec3::new(
            angle.cos() * radius,
            0.0,
            angle.sin() * radius,
        );
        
        let sphere = world.create_entity();
        world.add_component(sphere, Transform {
            position,
            rotation: Quat::IDENTITY,
            scale: Vec3::ONE,
            parent: None,
        });
        world.add_component(sphere, RenderComponent {
            mesh_id: "sphere".to_string(),
            material_id: match i % 4 {
                0 => "blue".to_string(),
                1 => "green".to_string(),
                2 => "yellow".to_string(),
                _ => "purple".to_string(),
            },
            visible: true,
            layer: 1,
        });
    }
    
    // Create some static background objects
    for x in -2..3 {
        for z in -2..3 {
            if x == 0 && z == 0 { continue; } // Skip center
            
            let bg_object = world.create_entity();
            world.add_component(bg_object, Transform {
                position: Vec3::new(x as f32 * 3.0, -1.0, z as f32 * 3.0),
                rotation: Quat::IDENTITY,
                scale: Vec3::splat(0.5),
                parent: None,
            });
            world.add_component(bg_object, RenderComponent {
                mesh_id: "quad".to_string(),
                material_id: "gray".to_string(),
                visible: true,
                layer: 0,
            });
        }
    }
    
    tracing::info!("Demo world created with {} entities", world.entity_count());
    Ok(())
}