/// WASM Module representation and management
use std::path::PathBuf;
use wasmtime::{Module, Store, Instance};
// use wasmtime_wasi::WasiCtx;

/// WASM module metadata and binary
#[derive(Debug)]
pub struct WasmModule {
    name: String,
    module: Module,
    path: PathBuf,
    
    // Metadata extracted from module
    exports: Vec<String>,
    imports: Vec<String>,
    memory_requirements: Option<u64>,
}

impl WasmModule {
    pub fn new(name: String, module: Module, path: PathBuf) -> Self {
        // Extract module metadata
        let exports = module.exports()
            .map(|export| export.name().to_string())
            .collect();
        
        let imports = module.imports()
            .map(|import| format!("{}::{}", import.module(), import.name()))
            .collect();
        
        // TODO: Extract memory requirements from module
        let memory_requirements = None;
        
        Self {
            name,
            module,
            path,
            exports,
            imports,
            memory_requirements,
        }
    }
    
    pub fn name(&self) -> &str {
        &self.name
    }
    
    pub fn module(&self) -> &Module {
        &self.module
    }
    
    pub fn path(&self) -> &PathBuf {
        &self.path
    }
    
    pub fn exports(&self) -> &[String] {
        &self.exports
    }
    
    pub fn imports(&self) -> &[String] {
        &self.imports
    }
    
    pub fn has_export(&self, name: &str) -> bool {
        self.exports.iter().any(|export| export == name)
    }
    
    pub fn memory_requirements(&self) -> Option<u64> {
        self.memory_requirements
    }
    
    /// Validate module has required exports for engine integration
    pub fn validate_api(&self) -> Result<(), String> {
        let required_exports = ["update", "init"];
        
        for required in &required_exports {
            if !self.has_export(required) {
                return Err(format!("Missing required export: {}", required));
            }
        }
        
        Ok(())
    }
}

/// WASM module instance with execution context
pub struct ModuleInstance {
    store: Store<()>,
    instance: Instance,
}

impl ModuleInstance {
    pub fn new(store: Store<()>, instance: Instance) -> Self {
        Self { store, instance }
    }
    
    pub fn store(&self) -> &Store<()> {
        &self.store
    }
    
    pub fn store_mut(&mut self) -> &mut Store<()> {
        &mut self.store
    }
    
    pub fn instance(&self) -> &Instance {
        &self.instance
    }
    
    /// Call module initialization function
    pub fn initialize(&mut self) -> Result<(), wasmtime::Error> {
        if let Ok(init_func) = self.instance.get_typed_func::<(), ()>(&mut self.store, "init") {
            init_func.call(&mut self.store, ())?;
        }
        Ok(())
    }
    
    /// Check if module has specific export
    pub fn has_export(&mut self, name: &str) -> bool {
        self.instance.get_export(&mut self.store, name).is_some()
    }

    /// Call the exported update(delta_time: f64) function if present
    pub fn call_update(&mut self, delta_time: f64) -> Result<(), wasmtime::Error> {
        if let Ok(update_func) = self.instance.get_typed_func::<f64, ()>(&mut self.store, "update") {
            update_func.call(&mut self.store, delta_time)?;
        }
        Ok(())
    }
    
    /// Get memory usage of this instance
    pub fn memory_usage(&mut self) -> usize {
        if let Some(memory) = self.instance.get_memory(&mut self.store, "memory") {
            memory.data_size(&self.store)
        } else {
            0
        }
    }
}