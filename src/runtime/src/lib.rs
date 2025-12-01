/// Frankenstein Runtime - WASM integration for game engine
/// 
/// This crate provides WebAssembly runtime capabilities using Wasmtime,
/// enabling hot-reloadable game logic modules with strict sandboxing.

pub mod engine;
pub mod module;
pub mod bindings;
pub mod loader;
pub mod sandbox;

pub use engine::WasmEngine;
pub use module::{WasmModule, ModuleInstance};
pub use bindings::HostBindings;
pub use loader::ModuleLoader;
pub use sandbox::Sandbox;

/// Runtime configuration for WASM execution
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub max_memory_bytes: usize,
    pub max_execution_time_ms: u64,
    pub enable_wasi: bool,
    pub module_directory: String,
    pub enable_jit: bool,
    pub debug_info: bool,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            max_memory_bytes: 32 * 1024 * 1024, // 32MB
            max_execution_time_ms: 8, // Half frame at 60fps
            enable_wasi: false,
            module_directory: "modules".to_string(),
            enable_jit: true,
            debug_info: cfg!(debug_assertions),
        }
    }
}

/// Runtime-specific error types
#[derive(thiserror::Error, Debug)]
pub enum RuntimeError {
    #[error("Module load failed from {path}: {reason}")]
    ModuleLoadFailed { path: String, reason: String },
    
    #[error("API mismatch in module {module_name}: {details}")]
    ApiMismatch { module_name: String, details: String },
    
    #[error("Execution timeout in module {module_name}: {elapsed_ms}ms > {limit_ms}ms")]
    ExecutionTimeout { module_name: String, elapsed_ms: u64, limit_ms: u64 },
    
    #[error("Hot reload failed: {reason}")]
    HotReloadFailed { reason: String },
    
    #[error("Sandbox violation: {message}")]
    SandboxViolation { message: String },
}

impl From<RuntimeError> for frankenstein_core::EngineError {
    fn from(error: RuntimeError) -> Self {
        frankenstein_core::EngineError::Runtime(error.to_string())
    }
}