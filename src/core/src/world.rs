/// World - Entity-Component-System architecture with WASM integration
use std::collections::HashMap;
use dashmap::DashMap;
use uuid::Uuid;
// use serde::{Serialize, Deserialize};

use crate::{
    api::{EntityHandle, Transform, RenderComponent, PhysicsComponent},
    Deterministic
};

/// Component storage trait - allows dynamic component types
pub trait Component: Send + Sync + 'static {
    fn type_name() -> &'static str where Self: Sized;
    fn as_any(&self) -> &dyn std::any::Any;
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
    fn clone_component(&self) -> Box<dyn Component>;
}

/// Implement Component for common types
impl Component for Transform {
    fn type_name() -> &'static str { "Transform" }
    fn as_any(&self) -> &dyn std::any::Any { self }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
    fn clone_component(&self) -> Box<dyn Component> { Box::new(self.clone()) }
}

impl Component for RenderComponent {
    fn type_name() -> &'static str { "RenderComponent" }
    fn as_any(&self) -> &dyn std::any::Any { self }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
    fn clone_component(&self) -> Box<dyn Component> { Box::new(self.clone()) }
}

impl Component for PhysicsComponent {
    fn type_name() -> &'static str { "PhysicsComponent" }
    fn as_any(&self) -> &dyn std::any::Any { self }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
    fn clone_component(&self) -> Box<dyn Component> { Box::new(self.clone()) }
}

/// Entity - just an ID with associated components
pub struct Entity {
    pub id: u64,
    pub handle: EntityHandle,
    pub active: bool,
    pub components: HashMap<String, Box<dyn Component>>,
}

impl Entity {
    pub fn new() -> Self {
        Self {
            id: 0, // TODO: Proper ID generation
            handle: EntityHandle::new(),
            active: true,
            components: HashMap::new(),
        }
    }
    
    pub fn add_component<T: Component>(&mut self, component: T) {
        self.components.insert(T::type_name().to_string(), Box::new(component));
    }
    
    pub fn get_component<T: Component>(&self) -> Option<&T> {
        self.components.get(T::type_name())
            .and_then(|c| c.as_any().downcast_ref::<T>())
    }
    
    pub fn get_component_mut<T: Component>(&mut self) -> Option<&mut T> {
        self.components.get_mut(T::type_name())
            .and_then(|c| c.as_any_mut().downcast_mut::<T>())
    }
    
    pub fn has_component<T: Component>(&self) -> bool {
        self.components.contains_key(T::type_name())
    }
    
    pub fn remove_component<T: Component>(&mut self) -> bool {
        self.components.remove(T::type_name()).is_some()
    }
}

/// World - The game state container
pub struct World {
    entities: DashMap<Uuid, Entity>,
    entity_count: usize,
    
    // Determinism state
    step_count: u64,
    state_seed: u64,
}

impl World {
    pub fn new() -> Self {
        Self {
            entities: DashMap::new(),
            entity_count: 0,
            step_count: 0,
            state_seed: 0,
        }
    }
    
    pub fn create_entity(&mut self) -> EntityHandle {
        let entity = Entity::new();
        let handle = entity.handle;
        
        self.entities.insert(handle.0, entity);
        self.entity_count += 1;
        
        tracing::debug!("Created entity: {:?}", handle);
        handle
    }
    
    pub fn destroy_entity(&mut self, handle: EntityHandle) -> bool {
        if let Some(_) = self.entities.remove(&handle.0) {
            self.entity_count -= 1;
            tracing::debug!("Destroyed entity: {:?}", handle);
            true
        } else {
            false
        }
    }
    
    pub fn get_entity(&self, handle: EntityHandle) -> Option<dashmap::mapref::one::Ref<Uuid, Entity>> {
        self.entities.get(&handle.0)
    }
    
    pub fn get_entity_mut(&self, handle: EntityHandle) -> Option<dashmap::mapref::one::RefMut<Uuid, Entity>> {
        self.entities.get_mut(&handle.0)
    }
    
    pub fn entity_exists(&self, handle: EntityHandle) -> bool {
        self.entities.contains_key(&handle.0)
    }
    
    pub fn entity_count(&self) -> usize {
        self.entity_count
    }
    
    /// Query entities with specific component
    pub fn query_entities_with_component<T: Component>(&self) -> Vec<EntityHandle> {
        self.entities
            .iter()
            .filter_map(|entry| {
                let entity = entry.value();
                if entity.active && entity.has_component::<T>() {
                    Some(entity.handle)
                } else {
                    None
                }
            })
            .collect()
    }
    
    /// Query entities within radius (requires Transform component)
    pub fn query_entities_in_radius(&self, center: glam::Vec3, radius: f32) -> Vec<EntityHandle> {
        let radius_squared = radius * radius;
        
        self.entities
            .iter()
            .filter_map(|entry| {
                let entity = entry.value();
                if !entity.active {
                    return None;
                }
                
                if let Some(transform) = entity.get_component::<Transform>() {
                    let distance_squared = (transform.position - center).length_squared();
                    if distance_squared <= radius_squared {
                        Some(entity.handle)
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect()
    }
    
    /// Add component to entity
    pub fn add_component<T: Component>(&self, handle: EntityHandle, component: T) -> bool {
        if let Some(mut entity) = self.get_entity_mut(handle) {
            entity.add_component(component);
            true
        } else {
            false
        }
    }
    
    /// Get component from entity
    pub fn get_component<T: Component>(&self, handle: EntityHandle) -> Option<T> 
    where 
        T: Clone 
    {
        if let Some(entity) = self.get_entity(handle) {
            entity.get_component::<T>().cloned()
        } else {
            None
        }
    }
    
    /// Update component on entity
    pub fn set_component<T: Component>(&self, handle: EntityHandle, component: T) -> bool {
        if let Some(mut entity) = self.get_entity_mut(handle) {
            entity.add_component(component); // This replaces existing component
            true
        } else {
            false
        }
    }
    
    /// Check if entity has component
    pub fn has_component<T: Component>(&self, handle: EntityHandle) -> bool {
        if let Some(entity) = self.get_entity(handle) {
            entity.has_component::<T>()
        } else {
            false
        }
    }
    
    /// Remove component from entity  
    pub fn remove_component<T: Component>(&self, handle: EntityHandle) -> bool {
        if let Some(mut entity) = self.get_entity_mut(handle) {
            entity.remove_component::<T>()
        } else {
            false
        }
    }
    
    pub fn step(&mut self, _delta_time: f64) {
        self.step_count += 1;
        
        // Clean up inactive entities
        self.entities.retain(|_, entity| entity.active);
    }
}

impl Deterministic for World {
    fn seed(&mut self, seed: u64) {
        self.state_seed = seed;
        tracing::debug!("World seeded with: {}", seed);
    }
    
    fn step(&mut self, delta_time: f64) {
        self.step(delta_time);
    }
    
    fn state_hash(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let mut hasher = DefaultHasher::new();
        self.step_count.hash(&mut hasher);
        self.entity_count.hash(&mut hasher);
        self.state_seed.hash(&mut hasher);
        
        // Hash entity positions for determinism verification
        for entry in self.entities.iter() {
            let entity = entry.value();
            if let Some(transform) = entity.get_component::<Transform>() {
                entity.handle.0.hash(&mut hasher);
                transform.position.x.to_bits().hash(&mut hasher);
                transform.position.y.to_bits().hash(&mut hasher);
                transform.position.z.to_bits().hash(&mut hasher);
            }
        }
        
        hasher.finish()
    }
}