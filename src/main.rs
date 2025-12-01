/// Main executable - The engine runner with full SDL2 integration
use std::env;

use frankenstein_core::{Engine, EngineConfig};
use frankenstein_runtime::{WasmEngine, RuntimeConfig};
use frankenstein_renderer::SdlRenderer;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "frankenstein=debug,info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("🎮 Frankenstein Engine - WASM-Driven Game Engine");
    tracing::info!("Playing safe is the real trap. Welcome to the forbidden lamp.");

    // Parse command-line arguments
    let args: Vec<String> = env::args().collect();
    let demo_name = args.get(1).map(String::as_str).unwrap_or("basic-demo");

    // Engine configuration
    let mut engine_config = EngineConfig::default();
    engine_config.enable_deterministic_mode = true;
    engine_config.enable_hot_reload = true;
    engine_config.master_seed = 12345; // Fixed seed for deterministic replay
    engine_config.window_width = 1280;
    engine_config.window_height = 720;

    // WASM runtime configuration  
    let runtime_config = RuntimeConfig {
        max_memory_bytes: 32 * 1024 * 1024, // 32MB per module
        max_execution_time_ms: 8, // Half frame at 60fps
        enable_wasi: false,
        module_directory: format!("demos/{}/modules", demo_name),
        enable_jit: true,
        debug_info: cfg!(debug_assertions),
    };

    tracing::info!("Starting demo: {}", demo_name);
    tracing::info!("Module directory: {}", runtime_config.module_directory);

    // Create engine with all subsystems
    let mut engine = Engine::new(engine_config.clone())?;
    
    // Initialize SDL2 renderer
    let renderer = SdlRenderer::new(&engine_config)?;
    engine.set_renderer(Box::new(renderer));
    
    // Initialize WASM runtime
    let wasm_runtime = WasmEngine::new(runtime_config)?;
    engine.set_wasm_runtime(Box::new(wasm_runtime));
    
    // Load demo modules
    load_demo_modules(&mut engine, demo_name)?;
    
    // Run main loop with integrated SDL2 event handling
    run_main_loop(engine)?;
    
    tracing::info!("Engine shutdown gracefully");
    Ok(())
}

fn run_main_loop(mut engine: Engine) -> anyhow::Result<()> {
    use sdl2::event::Event;
    use sdl2::keyboard::Keycode;
    use frankenstein_core::api::{InputEvent, InputModifiers, MouseButton};
    
    // We need to extract the SDL event pump to handle events properly
    // This is a bit of a hack - in a real implementation, we'd design this better
    
    // For now, let's use the engine's built-in loop
    // The SDL2 renderer will handle its own events internally
    
    match engine.run() {
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::error!("Engine runtime error: {}", e);
            Err(e.into())
        }
    }
}

fn load_demo_modules(engine: &mut Engine, demo_name: &str) -> anyhow::Result<()> {
    use std::path::Path;
    
    let module_dir = Path::new("demos").join(demo_name).join("modules");
    
    if !module_dir.exists() {
        tracing::warn!("Demo module directory does not exist: {:?}", module_dir);
        tracing::info!("Engine will run with demo entities only");
        return Ok(());
    }

    tracing::info!("Loading modules from: {:?}", module_dir);

    // Use the runtime inside the engine to load and instantiate modules
    // We need a mutable reference to the runtime stored in the engine
    // The Engine API exposes set_wasm_runtime earlier; for now, we assume
    // Engine exposes a method to get a mutable reference to the runtime.
    // We'll use a downcast-like approach via trait object accessors on Engine.

    // NOTE: under current design we don't have a public accessor; so use
    // the Engine's internal API via a helper: this example assumes Engine
    // implements `with_wasm_runtime` utility to mutate the runtime. If not,
    // this will be a no-op (safe) and modules will remain unloaded.

    // Extract world pointer before calling with_wasm_runtime to avoid borrowing `engine` inside the closure
    let world_ptr: *mut frankenstein_core::World = engine.world_mut() as *mut frankenstein_core::World;

    if let Err(e) = engine.with_wasm_runtime(|runtime| {
        // Attach world pointer for host functions (unsafe raw pointer)
        let _ = runtime.attach_world(world_ptr);

        let mut loader = frankenstein_runtime::ModuleLoader::new(module_dir.clone());
        match loader.scan_modules() {
            Ok(paths) => {
                for path in paths {
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        if let Err(err) = runtime.load_module(name, &path) {
                            tracing::error!("Failed to load module {}: {}", name, err);
                            continue;
                        }
                        if let Err(err) = runtime.instantiate_module(name) {
                            tracing::error!("Failed to instantiate module {}: {}", name, err);
                        }
                    }
                }
            }
            Err(err) => tracing::error!("Module scan failed: {}", err),
        }
        Ok(())
    }) {
        tracing::warn!("Unable to load demo modules: {}", e);
    }

    Ok(())
}