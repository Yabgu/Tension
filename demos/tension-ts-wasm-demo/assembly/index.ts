// AssemblyScript WASM module for Tension Engine Demo
// Based on the entity-spawner module but written in AssemblyScript

// Host bindings are generated automatically into `assembly/host.ts`
// Run `node ../generate_host_decls.js` (or the demo `build.sh`) to regenerate.
// The generated file provides ambient declarations and thin wrappers so
// the rest of this module can call `create_entity()`, `add_transform()`, etc.

// Module state
let spawnTimer: f64 = 0.0;
let spawnedEntities: StaticArray<u64> = new StaticArray<u64>(100);
let entityCount: i32 = 0;
let totalSpawned: i32 = 0;

// Helper to log strings
function logString(message: string): void {
    let encoded = String.UTF8.encode(message);
    log_info(changetype<i32>(encoded), encoded.byteLength);
}

// Module exports - called by the Tension engine

// Initialize the module
export function init(): void {
    logString("TypeScript Entity Spawner module initialized");
    spawnTimer = 0.0;
    entityCount = 0;
    totalSpawned = 0;
    spawnRandomEntity();
}

// Update function called each frame
export function update(deltaTime: f64): void {
    spawnTimer += deltaTime;
    logString(`update called at time ${spawnTimer}`);
}

// Handle input events
export function on_input_event(eventType: i32, data: i32, dataLen: i32): void {
    if (eventType == 0) { // Key pressed
        logString("Key pressed in TypeScript WASM module");
    } else if (eventType == 1) { // Mouse pressed
        logString("Mouse pressed - spawning entity");
        spawnRandomEntity();
    }
}

// Spawn a random entity
function spawnRandomEntity(): void {
    if (entityCount >= 100) {
        return; // Max entities reached
    }
    
    let entityId = create_entity();
    if (entityId == 0) {
        logString("Failed to create entity");
        return;
    }
    
    // Random position
    let x: f32 = 0.0;
    let y: f32 = 0.0;
    let z: f32 = -1.0;
    
    // Add transform
    if (add_transform(entityId, x, y, z) == 0) {
        logString("Failed to add transform");
        return;
    }
    
    // Add render component with random mesh
    let meshName: string;
    if (random_range_i32(0, 2) == 0) {
        meshName = "cube";
    } else {
        meshName = "sphere";
    }
    
    let encoded = String.UTF8.encode(meshName);
    if (add_render_component(entityId, changetype<i32>(encoded), encoded.byteLength) == 0) {
        logString("Failed to add render component");
        return;
    }
    
    // Store entity ID
    spawnedEntities[entityCount] = entityId;
    entityCount += 1;
    totalSpawned += 1;
    
    logString("Spawned new entity from TypeScript WASM");
}

// Clean up old entities
function cleanupOldEntities(): void {
    if (entityCount == 0) {
        return;
    }
    
    // Remove oldest entity
    let oldEntity = spawnedEntities[0];
    destroy_entity(oldEntity);
    
    // Shift array left
    for (let i = 1; i < entityCount; i++) {
        spawnedEntities[i - 1] = spawnedEntities[i];
    }
    entityCount -= 1;
    
    logString("Cleaned up old entity");
}

// Animate entities (simple up/down floating motion)
function animateEntities(deltaTime: f64): void {
    let time = f32(get_total_time());
    
    for (let i = 0; i < entityCount; i++) {
        let entityId = spawnedEntities[i];
        if (entity_exists(entityId) == 0) {
            continue;
        }
        
        // Simple animation: recreate transform with new Y position
        let x = (random_f32() - 0.5) * 10.0; // Keep some randomness
        let newY = Mathf.sin(time * 2.0 + f32(i)) * 0.5;
        let z = (random_f32() - 0.5) * 10.0;
        
        add_transform(entityId, x, newY, z);
    }
}