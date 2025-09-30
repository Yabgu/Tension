// Minimal AssemblyScript WASM module for Tension Engine Demo
// Simplified to avoid runtime dependencies

// Import host functions provided by the Tension engine
@external("engine", "create_entity")
declare function create_entity(): u64;

@external("engine", "destroy_entity")
declare function destroy_entity(entity_id: u64): i32;

@external("engine", "entity_exists")
declare function entity_exists(entity_id: u64): i32;

@external("engine", "add_transform")
declare function add_transform(entity_id: u64, pos_x: f32, pos_y: f32, pos_z: f32): i32;

@external("engine", "add_render_component")
declare function add_render_component(entity_id: u64, mesh_ptr: i32, mesh_len: i32): i32;

@external("engine", "random_f32")
declare function random_f32(): f32;

@external("engine", "random_range_i32")
declare function random_range_i32(min: i32, max: i32): i32;

@external("engine", "get_delta_time")
declare function get_delta_time(): f64;

@external("engine", "get_total_time")
declare function get_total_time(): f64;

@external("engine", "log_info")
declare function log_info(msg_ptr: i32, msg_len: i32): void;

// Module state - use simple variables instead of complex arrays
let spawnTimer: f64 = 0.0;
let entityCount: i32 = 0;
let totalSpawned: i32 = 0;

// Hardcoded entity storage (avoid dynamic arrays)
let entity0: u64 = 0;
let entity1: u64 = 0;
let entity2: u64 = 0;
let entity3: u64 = 0;
let entity4: u64 = 0;

// Helper to log a simple message by encoding bytes manually
function logMessage(msg: string): void {
    // For now, just log the length - to avoid string encoding complexity
    log_info(0, msg.length);
}

// Module exports - called by the Tension engine

// Initialize the module
export function init(): void {
    logMessage("TypeScript Entity Spawner initialized");
    spawnTimer = 0.0;
    entityCount = 0;
    totalSpawned = 0;
}

// Update function called each frame
export function update(deltaTime: f64): void {
    spawnTimer += deltaTime;
    
    // Spawn new entity every 3 seconds (less frequent to avoid complexity)
    if (spawnTimer >= 3.0) {
        spawnRandomEntity();
        spawnTimer = 0.0;
    }
    
    // Simple animation for existing entities
    animateEntities();
}

// Handle input events
export function on_input_event(eventType: i32, data: i32, dataLen: i32): void {
    if (eventType == 0) { // Key pressed
        logMessage("Key pressed in TypeScript WASM");
    } else if (eventType == 1) { // Mouse pressed
        logMessage("Mouse pressed - spawning entity");
        spawnRandomEntity();
    }
}

// Spawn a random entity (simplified to avoid arrays)
function spawnRandomEntity(): void {
    if (entityCount >= 5) {
        return; // Max 5 entities to keep it simple
    }
    
    let entityId = create_entity();
    if (entityId == 0) {
        return;
    }
    
    // Random position
    let x = (random_f32() - 0.5) * 8.0;
    let y: f32 = 0.0;
    let z = (random_f32() - 0.5) * 8.0;
    
    // Add transform
    if (add_transform(entityId, x, y, z) == 0) {
        return;
    }
    
    // Add render component - hardcode mesh name as numbers to avoid strings
    // Use mesh name "cube" = 4 bytes: 99, 117, 98, 101
    if (add_render_component(entityId, 99117, 4) == 0) {
        return;
    }
    
    // Store entity ID in one of our simple variables
    if (entityCount == 0) entity0 = entityId;
    else if (entityCount == 1) entity1 = entityId;
    else if (entityCount == 2) entity2 = entityId;
    else if (entityCount == 3) entity3 = entityId;
    else if (entityCount == 4) entity4 = entityId;
    
    entityCount += 1;
    totalSpawned += 1;
    
    logMessage("Spawned new entity from TypeScript");
}

// Simple animation
function animateEntities(): void {
    let time = f32(get_total_time());
    
    for (let i = 0; i < entityCount; i++) {
        let entityId: u64 = 0;
        
        // Get entity ID from our simple storage
        if (i == 0) entityId = entity0;
        else if (i == 1) entityId = entity1;
        else if (i == 2) entityId = entity2;
        else if (i == 3) entityId = entity3;
        else if (i == 4) entityId = entity4;
        
        if (entityId == 0 || entity_exists(entityId) == 0) {
            continue;
        }
        
        // Simple floating animation
        let x = (random_f32() - 0.5) * 8.0;
        let newY: f32 = 0.5 + 0.3 * f32(Math.sin(f64(time * 2.0 + f32(i))));
        let z = (random_f32() - 0.5) * 8.0;
        
        add_transform(entityId, x, newY, z);
    }
}