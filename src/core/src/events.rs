/// Event system - Decoupled communication between systems
use std::collections::VecDeque;
use serde::{Serialize, Deserialize};
use crate::{World, api::EntityHandle};

/// Game events that flow through the system
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GameEvent {
    // Entity events
    EntityCreated { entity: EntityHandle },
    EntityDestroyed { entity: EntityHandle },
    
    // Collision events  
    CollisionStarted { entity_a: EntityHandle, entity_b: EntityHandle },
    CollisionEnded { entity_a: EntityHandle, entity_b: EntityHandle },
    
    // Gameplay events
    PlayerSpawned { entity: EntityHandle, position: glam::Vec3 },
    PlayerDied { entity: EntityHandle },
    ItemCollected { item: EntityHandle, collector: EntityHandle },
    
    // System events
    LevelLoaded { level_name: String },
    GamePaused,
    GameResumed,
    
    // Audio events
    PlaySound { sound_id: String, position: Option<glam::Vec3>, volume: f32 },
    StopSound { sound_id: String },
    
    // Custom events (for WASM modules)
    Custom { event_type: String, data: Vec<u8> },
}

/// Event bus - manages event queue and delivery
pub struct EventBus {
    events: VecDeque<GameEvent>,
    max_events_per_frame: usize,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            events: VecDeque::new(),
            max_events_per_frame: 1000, // Prevent event spam
        }
    }
    
    /// Push event to queue
    pub fn push_event(&mut self, event: GameEvent) {
        if self.events.len() < self.max_events_per_frame {
            self.events.push_back(event);
        } else {
            tracing::warn!("Event queue full, dropping event: {:?}", event);
        }
    }
    
    /// Process all events this frame
    pub fn process_events(&mut self, world: &mut World) -> crate::Result<()> {
        let mut processed = 0;
        
        while let Some(event) = self.events.pop_front() {
            self.handle_event(&event, world)?;
            processed += 1;
            
            // Safety valve to prevent infinite processing
            if processed >= self.max_events_per_frame {
                tracing::warn!("Event processing limit reached, {} events remain in queue", 
                              self.events.len());
                break;
            }
        }
        
        if processed > 0 {
            tracing::debug!("Processed {} events", processed);
        }
        
        Ok(())
    }
    
    /// Handle individual event
    fn handle_event(&self, event: &GameEvent, world: &mut World) -> crate::Result<()> {
        match event {
            GameEvent::EntityCreated { entity } => {
                tracing::debug!("Entity created: {:?}", entity);
            }
            
            GameEvent::EntityDestroyed { entity } => {
                tracing::debug!("Entity destroyed: {:?}", entity);
            }
            
            GameEvent::CollisionStarted { entity_a, entity_b } => {
                tracing::debug!("Collision started: {:?} <-> {:?}", entity_a, entity_b);
                // Could trigger WASM callbacks here
            }
            
            GameEvent::CollisionEnded { entity_a, entity_b } => {
                tracing::debug!("Collision ended: {:?} <-> {:?}", entity_a, entity_b);
            }
            
            GameEvent::PlayerSpawned { entity, position } => {
                tracing::info!("Player spawned at {:?}: {:?}", position, entity);
            }
            
            GameEvent::PlayerDied { entity } => {
                tracing::info!("Player died: {:?}", entity);
                // Could respawn logic here
            }
            
            GameEvent::ItemCollected { item, collector } => {
                tracing::debug!("Item {:?} collected by {:?}", item, collector);
                // Remove item from world
                world.destroy_entity(*item);
            }
            
            GameEvent::LevelLoaded { level_name } => {
                tracing::info!("Level loaded: {}", level_name);
            }
            
            GameEvent::GamePaused => {
                tracing::info!("Game paused");
            }
            
            GameEvent::GameResumed => {
                tracing::info!("Game resumed");
            }
            
            GameEvent::PlaySound { sound_id, position, volume } => {
                tracing::debug!("Play sound: {} at {:?} (volume: {})", sound_id, position, volume);
                // Would integrate with audio system
            }
            
            GameEvent::StopSound { sound_id } => {
                tracing::debug!("Stop sound: {}", sound_id);
            }
            
            GameEvent::Custom { event_type, data } => {
                tracing::debug!("Custom event: {} ({} bytes)", event_type, data.len());
                // WASM modules can register handlers for custom events
            }
        }
        
        Ok(())
    }
    
    /// Get pending events (for WASM module access)
    pub fn get_events(&self) -> Vec<GameEvent> {
        self.events.iter().cloned().collect()
    }
    
    /// Clear all events
    pub fn clear(&mut self) {
        self.events.clear();
    }
    
    /// Get event count
    pub fn event_count(&self) -> usize {
        self.events.len()
    }
}