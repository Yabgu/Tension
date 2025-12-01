/// Core engine architecture - The skeletal framework for our WASM-driven future
/// 
/// This crate defines the fundamental abstractions that bridge native performance
/// with WASM modularity. Every decision here is architectural bedrock.

pub mod engine;
pub mod world;
pub mod time;
pub mod input;
pub mod events;
pub mod memory;
pub mod api;

pub use engine::{Engine, RendererTrait, PhysicsTrait, AudioTrait, WasmRuntimeTrait};
pub use world::{World, Entity, Component};
pub use time::{TimeManager, FixedTimestep};
pub use input::{InputManager};
pub use api::InputEvent;
pub use events::{EventBus, GameEvent};
pub use memory::{MemoryManager, ArenaAllocator};
pub use api::WasmApi;

/// The fundamental contract: deterministic execution
pub trait Deterministic {
    fn seed(&mut self, seed: u64);
    fn step(&mut self, delta_time: f64);
    fn state_hash(&self) -> u64;
}

/// Hot-reloadable module interface
pub trait HotReloadable {
    fn can_reload(&self) -> bool;
    fn prepare_reload(&mut self) -> anyhow::Result<()>;
    fn reload(&mut self) -> anyhow::Result<()>;
    fn rollback_reload(&mut self) -> anyhow::Result<()>;
}

/// Performance instrumentation - measure everything, optimize the critical path
pub trait Instrumented {
    fn start_frame(&mut self);
    fn end_frame(&mut self);
    fn get_metrics(&self) -> PerformanceMetrics;
}

#[derive(Debug, Clone)]
pub struct PerformanceMetrics {
    pub frame_time_ms: f64,
    pub wasm_execution_time_ms: f64,
    pub native_execution_time_ms: f64,
    pub memory_usage_bytes: usize,
    pub entity_count: usize,
}

/// Engine configuration - brutal honesty, no hidden defaults
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub target_fps: u32,
    pub max_frame_time_ms: f64,
    pub wasm_memory_limit_bytes: usize,
    pub enable_hot_reload: bool,
    pub enable_deterministic_mode: bool,
    pub master_seed: u64,
    
    // Renderer config
    pub window_width: u32,
    pub window_height: u32,
    pub vsync: bool,
    
    // Physics config
    pub physics_substeps: u32,
    pub gravity: glam::Vec2,
    
    // Audio config
    pub audio_sample_rate: u32,
    pub audio_buffer_size: u32,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            target_fps: 60,
            max_frame_time_ms: 16.67, // 60fps
            wasm_memory_limit_bytes: 64 * 1024 * 1024, // 64MB
            enable_hot_reload: true,
            enable_deterministic_mode: true,
            master_seed: 42,
            
            window_width: 1920,
            window_height: 1080,
            vsync: true,
            
            physics_substeps: 4,
            gravity: glam::Vec2::new(0.0, -9.81),
            
            audio_sample_rate: 44100,
            audio_buffer_size: 512,
        }
    }
}

/// Error types - explicit failure modes, no surprises
#[derive(thiserror::Error, Debug)]
pub enum EngineError {
    #[error("WASM runtime error: {0}")]
    WasmRuntime(#[from] wasmtime::Error),
    
    #[error("Module not found: {module_name}")]
    ModuleNotFound { module_name: String },
    
    #[error("Hot reload failed: {reason}")]
    HotReloadFailed { reason: String },
    
    #[error("Determinism violation: expected state hash {expected:x}, got {actual:x}")]
    DeterminismViolation { expected: u64, actual: u64 },
    
    #[error("Resource limit exceeded: {resource} ({current}/{limit})")]
    ResourceLimitExceeded { resource: String, current: usize, limit: usize },
    
    #[error("API contract violation: {message}")]
    ApiContractViolation { message: String },
    
    #[error("Runtime error: {0}")]
    Runtime(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;