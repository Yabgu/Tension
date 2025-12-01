/// WASM Engine - Wasmtime integration with hot reload and sandboxing
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use std::sync::{Arc, Mutex};

use wasmtime::{Engine, Store, Linker, Module, Instance, Caller, Memory};
// use wasmtime_wasi::{WasiCtx, WasiCtxBuilder};
use notify::{Watcher, RecursiveMode, Event, EventKind};

use frankenstein_core::{
    World, WasmApi, Deterministic, HotReloadable,
    api::{EntityHandle, Transform, RenderComponent, PhysicsComponent, InputEvent, MouseButton, RngState},
    Result, EngineError
};
use glam::Quat;

use crate::{RuntimeConfig, RuntimeError, WasmModule, ModuleInstance, HostBindings};

/// WASM engine implementation using Wasmtime
pub struct WasmEngine {
    engine: Engine,
    modules: HashMap<String, WasmModule>,
    instances: HashMap<String, ModuleInstance>,
    config: RuntimeConfig,
    
    // Hot reload support
    _watcher: Option<notify::RecommendedWatcher>,
    reload_queue: Vec<String>,
    
    // Deterministic state
    master_seed: u64,
    frame_count: u64,
    
    // Performance tracking
    last_execution_time: Duration,
    // Pointer to engine world for host bindings (raw pointer to avoid lifetime issues)
    // Shared host state accessible from host function closures
    host_state: Arc<Mutex<HostState>>,
}

/// Shared state exposed to host function closures (must be Send + Sync)
struct HostState {
    // store world pointer as usize so HostState is Send+Sync
    world_ptr: Option<usize>,
    entity_map: HashMap<u64, EntityHandle>,
    next_entity_id: u64,
}

impl WasmEngine {
    pub fn new(config: RuntimeConfig) -> Result<Self> {
        tracing::info!("Initializing WASM runtime (Wasmtime)");
        tracing::info!("Config: max_memory={}MB, max_execution={}ms, jit={}", 
                      config.max_memory_bytes / (1024 * 1024),
                      config.max_execution_time_ms,
                      config.enable_jit);
        
        // Configure Wasmtime engine
        let mut wasmtime_config = wasmtime::Config::new();
        wasmtime_config.wasm_component_model(false); // Use core WASM for now
        wasmtime_config.async_support(false); // Synchronous execution
        wasmtime_config.consume_fuel(true); // Enable execution limits
        
        if config.enable_jit {
            wasmtime_config.strategy(wasmtime::Strategy::Cranelift);
        } else {
            wasmtime_config.strategy(wasmtime::Strategy::Winch);
        }
        
        if config.debug_info {
            wasmtime_config.debug_info(true);
        }
        
        let engine = Engine::new(&wasmtime_config)
            .map_err(|e| EngineError::WasmRuntime(e.into()))?;
        
        let mut wasm_engine = Self {
            engine,
            modules: HashMap::new(),
            instances: HashMap::new(),
            config,
            _watcher: None,
            reload_queue: Vec::new(),
            master_seed: 0,
            frame_count: 0,
            last_execution_time: Duration::ZERO,
            host_state: Arc::new(Mutex::new(HostState {
                world_ptr: None,
                entity_map: HashMap::new(),
                next_entity_id: 1,
            })),
        };
        
        // Setup hot reload watcher
        if wasm_engine.config.enable_hot_reload() {
            wasm_engine.setup_hot_reload()?;
        }
        
        Ok(wasm_engine)
    }
    
    /// Load WASM module from file
    pub fn load_module(&mut self, name: &str, path: &Path) -> Result<()> {
        tracing::info!("Loading WASM module: {} from {:?}", name, path);
        
        let wasm_bytes = std::fs::read(path)
            .map_err(|e| RuntimeError::ModuleLoadFailed {
                path: path.display().to_string(),
                reason: e.to_string(),
            })?;
        
        let module = Module::new(&self.engine, &wasm_bytes)
            .map_err(|e| RuntimeError::ModuleLoadFailed {
                path: path.display().to_string(),
                reason: e.to_string(),
            })?;
        
        let wasm_module = WasmModule::new(name.to_string(), module, path.to_path_buf());
        self.modules.insert(name.to_string(), wasm_module);
        
        tracing::info!("Successfully loaded WASM module: {}", name);
        Ok(())
    }
    
    /// Instantiate loaded module
    pub fn instantiate_module(&mut self, name: &str) -> Result<()> {
        // Clone the module entry to avoid holding an immutable borrow across calls that need &mut self
        let wasm_module = {
            let module_ref = self.modules.get(name)
                .ok_or_else(|| EngineError::ModuleNotFound { module_name: name.to_string() })?;
            module_ref.module().clone()
        };

        tracing::debug!("Instantiating WASM module: {}", name);

        // Create store with fuel for execution limits
        let mut store = Store::new(&self.engine, ());
        store.set_fuel(self.fuel_for_frame())
            .map_err(|e| EngineError::WasmRuntime(e.into()))?;

        // Create linker with host functions
        let mut linker: Linker<()> = Linker::new(&self.engine);
        self.bind_host_functions(&mut linker)?;

        // Instantiate the module using a borrowed Module reference from wasm_module
        let instance = linker.instantiate(&mut store, &wasm_module)
            .map_err(|e| RuntimeError::ApiMismatch {
                module_name: name.to_string(),
                details: e.to_string(),
            })?;

        let mut module_instance = ModuleInstance::new(store, instance);
        // Call module init function if it exists to allow modules to set up state
        if let Err(e) = module_instance.initialize() {
            return Err(RuntimeError::ApiMismatch { module_name: name.to_string(), details: e.to_string() }.into());
        }

        self.instances.insert(name.to_string(), module_instance);
        
        tracing::info!("Successfully instantiated WASM module: {}", name);
        Ok(())
    }
    
    /// Execute all loaded modules
    
    /// Execute single module
    
    /// Bind host functions to linker
    fn bind_host_functions(&mut self, linker: &mut Linker<()>) -> Result<()> {
        // Register the general host bindings
        HostBindings::add_host_functions(linker).map_err(|e| EngineError::WasmRuntime(e.into()))?;

        // Provide module-scoped helpers that need access to the runtime/world pointer via shared HostState.
        let host_state = self.host_state.clone();

        // create_square(material_ptr, material_len) -> u64 (numeric id)
        linker.func_wrap("engine", "create_square",
            move |mut caller: Caller<'_, ()>, mat_ptr: i32, mat_len: i32| -> u64 {
                if let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) {
                    let data = memory.data(&caller);
                    let start = mat_ptr as usize;
                    let end = (mat_ptr + mat_len) as usize;
                    if end <= data.len() {
                        if let Ok(mat) = std::str::from_utf8(&data[start..end]) {
                            let mut state = host_state.lock().unwrap();
                            unsafe {
                                if let Some(world_ptr_usize) = state.world_ptr {
                                    let world_ptr = world_ptr_usize as *mut frankenstein_core::World;
                                    let world = &mut *world_ptr;
                                    let ent = world.create_entity();
                                    world.add_component(ent, Transform::default());
                                    world.add_component(ent, RenderComponent {
                                        mesh_id: "quad".to_string(),
                                        material_id: mat.to_string(),
                                        visible: true,
                                        layer: 0,
                                    });
                                    let id = state.next_entity_id;
                                    state.entity_map.insert(id, ent);
                                    state.next_entity_id = state.next_entity_id.wrapping_add(1);
                                    return id;
                                }
                            }
                        }
                    }
                }
                0u64
            }
        ).map_err(|e| EngineError::WasmRuntime(e.into()))?;

        // set_rotation(numeric_id, radians) -> i32 (1=ok)
        let host_state_rot = self.host_state.clone();
        linker.func_wrap("engine", "set_rotation",
            move |_caller: Caller<'_, ()>, id: u64, rot_rad: f32| -> i32 {
                let mut state = host_state_rot.lock().unwrap();
                unsafe {
                    if let Some(ent) = state.entity_map.get(&id) {
                        if let Some(world_ptr_usize) = state.world_ptr {
                            let world_ptr = world_ptr_usize as *mut frankenstein_core::World;
                            let world = &mut *world_ptr;
                            if let Some(mut entity) = world.get_entity_mut(*ent) {
                                if let Some(transform) = entity.get_component_mut::<Transform>() {
                                    transform.rotation = Quat::from_rotation_y(rot_rad);
                                    return 1;
                                }
                            }
                        }
                    }
                }
                0
            }
        ).map_err(|e| EngineError::WasmRuntime(e.into()))?;

        Ok(())
    }

    /// Attach the engine world pointer so host functions can access world state
    pub fn attach_world_ptr(&mut self, world_ptr: *mut frankenstein_core::World) {
        let mut state = self.host_state.lock().unwrap();
        state.world_ptr = Some(world_ptr as usize);
    }

    /// Trait-compatible attach_world wrapper
    pub fn attach_world(&mut self, world_ptr: *mut frankenstein_core::World) -> anyhow::Result<()> {
        self.attach_world_ptr(world_ptr);
        Ok(())
    }
    
    /// Calculate fuel allocation for this frame
    fn fuel_for_frame(&self) -> u64 {
        // Rough heuristic: 1 unit of fuel per microsecond of allowed execution
        self.config.max_execution_time_ms * 1000
    }
    
    /// Setup hot reload file watcher
    fn setup_hot_reload(&mut self) -> Result<()> {
        use notify::{Watcher, RecursiveMode};
        
        let module_dir = PathBuf::from(&self.config.module_directory);
        if !module_dir.exists() {
            tracing::warn!("Module directory does not exist: {:?}", module_dir);
            return Ok(());
        }
        
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            match res {
                Ok(event) => {
                    if let Err(e) = tx.send(event) {
                        tracing::error!("Failed to send file event: {}", e);
                    }
                }
                Err(e) => tracing::error!("File watcher error: {:?}", e),
            }
        }).map_err(|e| RuntimeError::HotReloadFailed { reason: e.to_string() })?;
        
        watcher.watch(&module_dir, RecursiveMode::Recursive)
            .map_err(|e| RuntimeError::HotReloadFailed { reason: e.to_string() })?;
        
        // Store watcher to keep it alive
        self._watcher = Some(watcher);
        
        // TODO: Setup background thread to process file events
        tracing::info!("Hot reload watcher setup for: {:?}", module_dir);
        Ok(())
    }
    
    pub fn get_execution_time(&self) -> Duration {
        self.last_execution_time
    }
}

impl RuntimeConfig {
    pub fn enable_hot_reload(&self) -> bool {
        true // For now, always enabled in development
    }
}

impl Deterministic for WasmEngine {
    fn seed(&mut self, seed: u64) {
        self.master_seed = seed;
        tracing::debug!("WASM runtime seeded with: {}", seed);
        
        // Seed all module instances
        // This would involve calling seed functions in the WASM modules
    }
    
    fn step(&mut self, delta_time: f64) {
        // The step is handled by execute_modules
    }
    
    fn state_hash(&self) -> u64 {
        // Hash runtime state for determinism verification
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let mut hasher = DefaultHasher::new();
        self.master_seed.hash(&mut hasher);
        self.frame_count.hash(&mut hasher);
        hasher.finish()
    }
}

impl HotReloadable for WasmEngine {
    fn can_reload(&self) -> bool {
        !self.reload_queue.is_empty()
    }
    
    fn prepare_reload(&mut self) -> anyhow::Result<()> {
        // Prepare modules for reload (save state, etc.)
        Ok(())
    }
    
    fn reload(&mut self) -> anyhow::Result<()> {
        // Process reload queue
        let reload_queue: Vec<String> = self.reload_queue.drain(..).collect();
        for module_name in reload_queue {
            tracing::info!("Hot reloading module: {}", module_name);
            
            let maybe_path = self.modules.get(&module_name).map(|m| m.path().clone());
            if let Some(path) = maybe_path {
                // Remove old instance
                self.instances.remove(&module_name);
                
                // Reload module
                if let Err(e) = self.load_module(&module_name, &path) {
                    tracing::error!("Failed to reload module {}: {}", module_name, e);
                    continue;
                }
                
                // Re-instantiate
                if let Err(e) = self.instantiate_module(&module_name) {
                    tracing::error!("Failed to instantiate reloaded module {}: {}", module_name, e);
                }
            }
        }
        
        Ok(())
    }
    
    fn rollback_reload(&mut self) -> anyhow::Result<()> {
        // Rollback failed reload
        tracing::warn!("Rolling back failed hot reload");
        Ok(())
    }
}

impl frankenstein_core::WasmRuntimeTrait for WasmEngine {
    fn execute_modules(&mut self, _world: &mut World, delta_time: f64) -> Result<()> {
        for (name, instance) in &mut self.instances {
            // Set fuel limit based on execution time (approximate fuel per millisecond)
            let max_fuel = (self.config.max_execution_time_ms * 1000) as u64;
            instance.store_mut().set_fuel(max_fuel)?;
            
            // Check if the module has an update function
            if instance.has_export("update") {
                tracing::debug!("Executing module {} with delta_time: {}", name, delta_time);
                // Call the module's update using the ModuleInstance helper
                let _ = instance.call_update(delta_time);
            } else {
                tracing::debug!("Module {} has no update function", name);
            }
        }
        Ok(())
    }
    
    fn seed(&mut self, seed: u64) {
        Deterministic::seed(self, seed);
    }
    
    fn can_reload(&self) -> bool {
        HotReloadable::can_reload(self)
    }
    
    fn reload(&mut self) -> Result<()> {
        HotReloadable::reload(self).map_err(|e| frankenstein_core::EngineError::Runtime(e.to_string()))
    }

    fn load_module(&mut self, name: &str, path: &std::path::Path) -> Result<()> {
        self.load_module(name, path)
    }

    fn instantiate_module(&mut self, name: &str) -> Result<()> {
        self.instantiate_module(name)
    }

    fn attach_world(&mut self, world_ptr: *mut frankenstein_core::World) -> anyhow::Result<()> {
        self.attach_world(world_ptr)
    }
}
