/// Engine - The beating heart of our WASM-driven architecture
use std::time::Instant;
use crate::{
    EngineConfig, EngineError, Result,
    TimeManager, World, InputManager, EventBus,
    WasmApi, Deterministic, HotReloadable, Instrumented,
    PerformanceMetrics, api::{InputEvent, InputModifiers, MouseButton}
};

/// Main engine struct - orchestrates all subsystems
pub struct Engine {
    config: EngineConfig,
    world: World,
    time_manager: TimeManager,
    input_manager: InputManager,
    event_bus: EventBus,
    
    // Subsystem interfaces (to be implemented)
    renderer: Option<Box<dyn RendererTrait>>,
    physics: Box<dyn PhysicsTrait>,
    audio: Box<dyn AudioTrait>,
    wasm_runtime: Box<dyn WasmRuntimeTrait>,
    
    running: bool,
    frame_count: u64,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Result<Self> {
        tracing::info!("Initializing Tension Engine - Playing safe is the real trap");
        tracing::info!("Config: target_fps={}, deterministic={}, hot_reload={}", 
                      config.target_fps, config.enable_deterministic_mode, config.enable_hot_reload);
        
        let time_manager = TimeManager::new(config.target_fps);
        let world = World::new();
        let input_manager = InputManager::new();
        let event_bus = EventBus::new();
        
        // Initialize subsystems (placeholder implementations for now)
        let renderer = None; // Will be set externally
        let physics = Box::new(NullPhysics);
        let audio = Box::new(NullAudio);
        let wasm_runtime = Box::new(NullWasmRuntime);
        
        Ok(Self {
            config,
            world,
            time_manager,
            input_manager,
            event_bus,
            renderer,
            physics,
            audio,
            wasm_runtime,
            running: false,
            frame_count: 0,
        })
    }
    
    /// Main engine loop - fixed timestep, instrumented, deterministic
    pub fn run(&mut self) -> Result<()> {
        tracing::info!("Starting engine main loop");
        self.running = true;
        
        // Seed all deterministic systems
        if self.config.enable_deterministic_mode {
            self.seed_systems(self.config.master_seed);
        }
        
        // Create test entities for demonstration
        self.create_demo_entities();
        
        while self.running {
            self.frame_count += 1;
            self.time_manager.start_frame();
            
            // Process SDL events and update input state
            self.process_platform_events()?;
            
            // Fixed timestep update
            let steps = self.time_manager.tick();
            for _ in 0..steps {
                self.fixed_update()?;
            }
            
            // Variable timestep render
            let alpha = self.time_manager.interpolation_alpha();
            self.render(alpha)?;
            
            self.time_manager.end_frame();
            
            // Check for exit conditions
            if self.input_manager.should_quit() {
                self.running = false;
            }
            
            // Hot reload check
            if self.config.enable_hot_reload {
                self.check_hot_reload()?;
            }
            
            // Performance monitoring
            if self.frame_count % 60 == 0 {
                let metrics = self.time_manager.get_metrics();
                tracing::debug!("Performance: frame_time={:.2}ms, entities={}", 
                               metrics.frame_time_ms, self.world.entity_count());
            }
        }
        
        tracing::info!("Engine shutdown complete");
        Ok(())
    }
    
    /// Fixed timestep update - where determinism lives
    fn fixed_update(&mut self) -> Result<()> {
        let delta = self.time_manager.fixed_delta_time();
        
        // Update physics
        self.physics.step(delta)?;
        
        // Execute WASM modules
        self.wasm_runtime.execute_modules(&mut self.world, delta)?;
        
        // Process events
        self.event_bus.process_events(&mut self.world)?;
        
        // Update world state
        self.world.step(delta);
        
        Ok(())
    }
    
    /// Variable timestep render - interpolated for smoothness
    fn render(&mut self, interpolation_alpha: f64) -> Result<()> {
        if let Some(renderer) = &mut self.renderer {
            renderer.begin_frame()?;
            renderer.render_world(&self.world, interpolation_alpha)?;
            renderer.end_frame()?;
        }
        Ok(())
    }
    
    /// Process platform events (SDL2, etc.)
    fn process_platform_events(&mut self) -> Result<()> {
        // Let the renderer handle platform events and update input
        if let Some(renderer) = &mut self.renderer {
            renderer.handle_events(&mut self.input_manager)?;
        } else {
            self.input_manager.poll_events();
        }
        Ok(())
    }
    
    /// Create demo entities for testing
    fn create_demo_entities(&mut self) {
        use crate::api::{Transform, RenderComponent};
        use glam::Vec3;
        
        tracing::info!("Creating demo entities");
        
        // Create a few test entities
        for i in 0..5 {
            let entity = self.world.create_entity();
            
            let transform = Transform {
                position: Vec3::new(i as f32 * 2.0 - 4.0, 0.0, 0.0),
                rotation: glam::Quat::IDENTITY,
                scale: Vec3::ONE,
                parent: None,
            };
            
            let render_component = RenderComponent {
                mesh_id: if i % 2 == 0 { "cube".to_string() } else { "sphere".to_string() },
                material_id: match i % 3 {
                    0 => "red".to_string(),
                    1 => "green".to_string(),
                    _ => "blue".to_string(),
                },
                visible: true,
                layer: 0,
            };
            
            self.world.add_component(entity, transform);
            self.world.add_component(entity, render_component);
            
            tracing::debug!("Created demo entity {:?} at position ({}, 0, 0)", entity, i as f32 * 2.0 - 4.0);
        }
        
        tracing::info!("Created {} demo entities", 5);
    }
    
    /// Seed all deterministic systems
    fn seed_systems(&mut self, seed: u64) {
        tracing::info!("Seeding deterministic systems with seed: {}", seed);
        self.world.seed(seed);
        self.wasm_runtime.seed(seed + 1);
    }
    
    /// Check for hot-reloadable modules
    fn check_hot_reload(&mut self) -> Result<()> {
        if self.wasm_runtime.can_reload() {
            tracing::info!("Hot reloading WASM modules");
            self.wasm_runtime.reload()?;
        }
        Ok(())
    }
    
    pub fn shutdown(&mut self) {
        tracing::info!("Initiating engine shutdown");
        self.running = false;
    }
    
    pub fn get_metrics(&self) -> PerformanceMetrics {
        self.time_manager.get_metrics()
    }
    
    pub fn is_running(&self) -> bool {
        self.running
    }
    
    /// Set renderer implementation
    pub fn set_renderer(&mut self, renderer: Box<dyn RendererTrait>) {
        self.renderer = Some(renderer);
    }
    
    /// Set WASM runtime implementation
    pub fn set_wasm_runtime(&mut self, runtime: Box<dyn WasmRuntimeTrait>) {
        self.wasm_runtime = runtime;
    }

    /// Helper to mutably access the wasm runtime for configuration/loading.
    /// The closure receives a mutable reference to the runtime and can perform
    /// operations such as load_module / instantiate_module. Returns any error
    /// generated by the closure.
    pub fn with_wasm_runtime<F, R>(&mut self, mut f: F) -> anyhow::Result<R>
    where
        F: FnMut(&mut dyn WasmRuntimeTrait) -> anyhow::Result<R>,
    {
        // Delegate to the runtime trait object
        f(self.wasm_runtime.as_mut())
    }
    
    /// Get mutable reference to world for external access
    pub fn world_mut(&mut self) -> &mut World {
        &mut self.world
    }
    
    /// Get reference to world
    pub fn world(&self) -> &World {
        &self.world
    }
}

// Traits for subsystems - to be implemented in separate crates
pub trait RendererTrait {
    fn begin_frame(&mut self) -> Result<()>;
    fn render_world(&mut self, world: &World, alpha: f64) -> Result<()>;
    fn end_frame(&mut self) -> Result<()>;
    fn handle_events(&mut self, input_manager: &mut InputManager) -> Result<()>;
}

pub trait PhysicsTrait {
    fn step(&mut self, delta_time: f64) -> Result<()>;
}

pub trait AudioTrait {
    fn update(&mut self, delta_time: f64) -> Result<()>;
}

pub trait WasmRuntimeTrait {
    fn execute_modules(&mut self, world: &mut World, delta_time: f64) -> Result<()>;
    fn seed(&mut self, seed: u64);
    fn can_reload(&self) -> bool;
    fn reload(&mut self) -> Result<()>;
    /// Load a wasm module by name from a filesystem path
    fn load_module(&mut self, name: &str, path: &std::path::Path) -> Result<()>;
    /// Instantiate a previously loaded module by name
    fn instantiate_module(&mut self, name: &str) -> Result<()>;
    /// Attach engine world pointer to runtime so host functions can access world
    fn attach_world(&mut self, _world_ptr: *mut World) -> anyhow::Result<()>;
}

// Null implementations for development
struct NullRenderer;
impl RendererTrait for NullRenderer {
    fn begin_frame(&mut self) -> Result<()> { Ok(()) }
    fn render_world(&mut self, _world: &World, _alpha: f64) -> Result<()> { Ok(()) }
    fn end_frame(&mut self) -> Result<()> { Ok(()) }
    fn handle_events(&mut self, _input_manager: &mut InputManager) -> Result<()> { Ok(()) }
}

struct NullPhysics;
impl PhysicsTrait for NullPhysics {
    fn step(&mut self, _delta_time: f64) -> Result<()> { Ok(()) }
}

struct NullAudio;
impl AudioTrait for NullAudio {
    fn update(&mut self, _delta_time: f64) -> Result<()> { Ok(()) }
}

struct NullWasmRuntime;
impl WasmRuntimeTrait for NullWasmRuntime {
    fn execute_modules(&mut self, _world: &mut World, _delta_time: f64) -> Result<()> { Ok(()) }
    fn seed(&mut self, _seed: u64) {}
    fn can_reload(&self) -> bool { false }
    fn reload(&mut self) -> Result<()> { Ok(()) }
    fn load_module(&mut self, _name: &str, _path: &std::path::Path) -> Result<()> { Ok(()) }
    fn instantiate_module(&mut self, _name: &str) -> Result<()> { Ok(()) }
    /// Attach engine world pointer to runtime so host functions can mutate world
    fn attach_world(&mut self, _world_ptr: *mut World) -> anyhow::Result<()> { Ok(()) }
}

impl HotReloadable for NullWasmRuntime {
    fn can_reload(&self) -> bool { false }
    fn prepare_reload(&mut self) -> anyhow::Result<()> { Ok(()) }
    fn reload(&mut self) -> anyhow::Result<()> { Ok(()) }
    fn rollback_reload(&mut self) -> anyhow::Result<()> { Ok(()) }
}

impl Deterministic for NullWasmRuntime {
    fn seed(&mut self, _seed: u64) {}
    fn step(&mut self, _delta_time: f64) {}
    fn state_hash(&self) -> u64 { 0 }
}