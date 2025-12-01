/// WASM-native API surface - The sacred boundary between native and scripted
/// 
/// This defines the complete API that WASM modules can access. Every function
/// here is a contract that must be honored for deterministic execution.

use serde::{Deserialize, Serialize};
use glam::{Vec2, Vec3, Vec4, Quat};
use uuid::Uuid;
use std::collections::HashMap;

/// Entity handle - opaque reference to game objects
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntityHandle(pub Uuid);

impl EntityHandle {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
    
    pub fn null() -> Self {
        Self(Uuid::nil())
    }
    
    pub fn is_null(&self) -> bool {
        self.0.is_nil()
    }
}

/// Transform component - fundamental spatial data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transform {
    pub position: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
    pub parent: Option<EntityHandle>,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            position: Vec3::ZERO,
            rotation: Quat::IDENTITY,
            scale: Vec3::ONE,
            parent: None,
        }
    }
}

/// Render component - visual representation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderComponent {
    pub mesh_id: String,
    pub material_id: String,
    pub visible: bool,
    pub layer: u32,
}

/// Physics component - collision and dynamics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhysicsComponent {
    pub body_type: PhysicsBodyType,
    pub mass: f32,
    pub friction: f32,
    pub restitution: f32,
    pub velocity: Vec2,
    pub angular_velocity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PhysicsBodyType {
    Static,
    Kinematic,
    Dynamic,
}

/// Input event data passed to WASM modules
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum InputEvent {
    KeyPressed { key: String, modifiers: InputModifiers },
    KeyReleased { key: String, modifiers: InputModifiers },
    MouseMoved { x: f32, y: f32, delta_x: f32, delta_y: f32 },
    MousePressed { button: MouseButton, x: f32, y: f32 },
    MouseReleased { button: MouseButton, x: f32, y: f32 },
    MouseWheel { delta_x: f32, delta_y: f32 },
    GamepadButtonPressed { gamepad_id: u32, button: GamepadButton },
    GamepadButtonReleased { gamepad_id: u32, button: GamepadButton },
    GamepadAxis { gamepad_id: u32, axis: GamepadAxis, value: f32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputModifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub cmd: bool,
}

#[derive(Debug, Clone, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    Other(u16),
}

#[derive(Debug, Clone, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum GamepadButton {
    South,    // A/Cross
    East,     // B/Circle
    West,     // X/Square
    North,    // Y/Triangle
    LeftBumper,
    RightBumper,
    LeftTrigger,
    RightTrigger,
    Select,
    Start,
    LeftStick,
    RightStick,
    DPadUp,
    DPadDown,
    DPadLeft,
    DPadRight,
}

#[derive(Debug, Clone, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum GamepadAxis {
    LeftStickX,
    LeftStickY,
    RightStickX,
    RightStickY,
    LeftTrigger,
    RightTrigger,
}

/// Random number generator state - seeded for determinism
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RngState {
    pub seed: u64,
    pub state: u64,
}

impl RngState {
    pub fn new(seed: u64) -> Self {
        Self { seed, state: seed }
    }
    
    /// Linear congruential generator - simple, fast, deterministic
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.state
    }
    
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 32) as f32 / u32::MAX as f32
    }
    
    pub fn next_f64(&mut self) -> f64 {
        self.next_u64() as f64 / u64::MAX as f64
    }
    
    pub fn range_i32(&mut self, min: i32, max: i32) -> i32 {
        if max <= min {
            return min;
        }
        let range = (max - min) as u64;
        min + (self.next_u64() % range) as i32
    }
    
    pub fn range_f32(&mut self, min: f32, max: f32) -> f32 {
        min + (max - min) * self.next_f32()
    }
}

/// WASM API - The complete interface available to modules
/// 
/// This trait defines every operation a WASM module can perform.
/// Changes here are breaking changes to the module contract.
pub trait WasmApi {
    // Entity management
    fn create_entity(&mut self) -> EntityHandle;
    fn destroy_entity(&mut self, entity: EntityHandle) -> bool;
    fn entity_exists(&self, entity: EntityHandle) -> bool;
    
    // Component management
    fn add_transform(&mut self, entity: EntityHandle, transform: Transform) -> bool;
    fn get_transform(&self, entity: EntityHandle) -> Option<Transform>;
    fn set_transform(&mut self, entity: EntityHandle, transform: Transform) -> bool;
    
    fn add_render_component(&mut self, entity: EntityHandle, render: RenderComponent) -> bool;
    fn get_render_component(&self, entity: EntityHandle) -> Option<RenderComponent>;
    fn set_render_component(&mut self, entity: EntityHandle, render: RenderComponent) -> bool;
    
    fn add_physics_component(&mut self, entity: EntityHandle, physics: PhysicsComponent) -> bool;
    fn get_physics_component(&self, entity: EntityHandle) -> Option<PhysicsComponent>;
    fn set_physics_component(&mut self, entity: EntityHandle, physics: PhysicsComponent) -> bool;
    
    // Input access
    fn get_input_events(&self) -> Vec<InputEvent>;
    fn is_key_pressed(&self, key: &str) -> bool;
    fn is_mouse_button_pressed(&self, button: MouseButton) -> bool;
    fn get_mouse_position(&self) -> Vec2;
    
    // Random number generation
    fn get_rng(&mut self) -> &mut RngState;
    fn random_f32(&mut self) -> f32;
    fn random_f64(&mut self) -> f64;
    fn random_range_i32(&mut self, min: i32, max: i32) -> i32;
    fn random_range_f32(&mut self, min: f32, max: f32) -> f32;
    
    // Time access
    fn get_delta_time(&self) -> f64;
    fn get_total_time(&self) -> f64;
    fn get_frame_count(&self) -> u64;
    
    // Logging (debug builds only)
    fn log_info(&self, message: &str);
    fn log_warn(&self, message: &str);
    fn log_error(&self, message: &str);
    
    // Resource loading hints (async, non-blocking)
    fn request_mesh(&mut self, mesh_id: &str) -> bool;
    fn request_texture(&mut self, texture_id: &str) -> bool;
    fn request_audio(&mut self, audio_id: &str) -> bool;
    
    // Query system
    fn query_entities_with_transform(&self) -> Vec<EntityHandle>;
    fn query_entities_with_render(&self) -> Vec<EntityHandle>;
    fn query_entities_with_physics(&self) -> Vec<EntityHandle>;
    fn query_entities_in_radius(&self, center: Vec3, radius: f32) -> Vec<EntityHandle>;
}

/// Module manifest - metadata for hot reloading
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub exports: Vec<String>,
    pub dependencies: Vec<String>,
    pub permissions: ModulePermissions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModulePermissions {
    pub can_create_entities: bool,
    pub can_modify_physics: bool,
    pub can_load_resources: bool,
    pub can_access_input: bool,
    pub max_memory_mb: u32,
    pub max_execution_time_ms: u32,
}

impl Default for ModulePermissions {
    fn default() -> Self {
        Self {
            can_create_entities: true,
            can_modify_physics: true,
            can_load_resources: false,
            can_access_input: true,
            max_memory_mb: 16,
            max_execution_time_ms: 16, // ~1 frame at 60fps
        }
    }
}