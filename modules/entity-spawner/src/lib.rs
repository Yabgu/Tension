#![no_std]

/// Entity Spawner WASM Module
/// 
/// This module demonstrates the WASM ↔ native API contract.
/// It spawns entities dynamically based on user input and time.

// Use wee_alloc for smaller binary size
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// Panic handler for no_std
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

// External functions provided by the engine (imports)
extern "C" {
    // Entity management
    fn create_entity() -> u64;
    fn destroy_entity(entity_id: u64) -> i32;
    fn entity_exists(entity_id: u64) -> i32;
    
    // Transform component
    fn add_transform(entity_id: u64, pos_x: f32, pos_y: f32, pos_z: f32) -> i32;
    fn get_transform_position(entity_id: u64, out_x: *mut f32, out_y: *mut f32, out_z: *mut f32) -> i32;
    
    // Render component  
    fn add_render_component(entity_id: u64, mesh_ptr: *const u8, mesh_len: i32) -> i32;
    
    // Input
    fn is_key_pressed(key_ptr: *const u8, key_len: i32) -> i32;
    fn get_mouse_position(out_x: *mut f32, out_y: *mut f32) -> i32;
    
    // Random numbers
    fn random_f32() -> f32;
    fn random_range_i32(min: i32, max: i32) -> i32;
    
    // Time
    fn get_delta_time() -> f64;
    fn get_total_time() -> f64;
    fn get_frame_count() -> u64;
    
    // Logging
    fn log_info(ptr: *const u8, len: i32);
    fn log_warn(ptr: *const u8, len: i32);
    fn log_error(ptr: *const u8, len: i32);
    
    // Query system
    fn query_entities_in_radius(center_x: f32, center_y: f32, center_z: f32, radius: f32, out_ptr: *mut u64, max_count: i32) -> i32;
}

// Module state
static mut SPAWN_TIMER: f64 = 0.0;
static mut SPAWNED_ENTITIES: [u64; 100] = [0; 100];
static mut ENTITY_COUNT: usize = 0;
static mut TOTAL_SPAWNED: u32 = 0;

// Module exports (called by engine)
#[no_mangle]
pub extern "C" fn init() {
    log_str("Entity Spawner module initialized");
    unsafe {
        SPAWN_TIMER = 0.0;
        ENTITY_COUNT = 0;
        TOTAL_SPAWNED = 0;
    }
}

#[no_mangle]
pub extern "C" fn update(delta_time: f64) {
    unsafe {
        SPAWN_TIMER += delta_time;
        
        // Spawn new entity every 2 seconds
        if SPAWN_TIMER >= 2.0 {
            spawn_random_entity();
            SPAWN_TIMER = 0.0;
        }
        
        // Clean up old entities (every 10 seconds)
        let total_time = get_total_time();
        if total_time as u32 % 10 == 0 && get_frame_count() % 60 == 0 {
            cleanup_old_entities();
        }
        
        // Animate existing entities
        animate_entities(delta_time);
    }
}

#[no_mangle]
pub extern "C" fn on_input_event(event_type: i32, _data: *const u8, _data_len: i32) {
    // Handle input events
    match event_type {
        0 => { // Key pressed
            log_str("Key pressed in WASM module");
        }
        1 => { // Mouse pressed
            log_str("Mouse pressed - spawning entity at cursor");
            unsafe {
                spawn_entity_at_cursor();
            }
        }
        _ => {}
    }
}

unsafe fn spawn_random_entity() {
    if ENTITY_COUNT >= 100 {
        return; // Max entities reached
    }
    
    let entity_id = create_entity();
    if entity_id == 0 {
        log_str("Failed to create entity");
        return;
    }
    
    // Random position
    let x = (random_f32() - 0.5) * 10.0;
    let y = 0.0;
    let z = (random_f32() - 0.5) * 10.0;
    
    // Add transform
    if add_transform(entity_id, x, y, z) == 0 {
        log_str("Failed to add transform");
        return;
    }
    
    // Add render component with random mesh
    let mesh_name = if random_range_i32(0, 2) == 0 {
        "cube"
    } else {
        "sphere"
    };
    
    if add_render_component(entity_id, mesh_name.as_ptr(), mesh_name.len() as i32) == 0 {
        log_str("Failed to add render component");
        return;
    }
    
    // Store entity ID
    SPAWNED_ENTITIES[ENTITY_COUNT] = entity_id;
    ENTITY_COUNT += 1;
    TOTAL_SPAWNED += 1;
    
    // Log spawn
    log_str("Spawned new entity from WASM");
}

unsafe fn spawn_entity_at_cursor() {
    let mut mouse_x: f32 = 0.0;
    let mut mouse_y: f32 = 0.0;
    
    if get_mouse_position(&mut mouse_x, &mut mouse_y) == 0 {
        return;
    }
    
    let entity_id = create_entity();
    if entity_id == 0 {
        return;
    }
    
    // Convert screen coordinates to world coordinates (simple mapping)
    let world_x = (mouse_x - 640.0) / 100.0;
    let world_z = (mouse_y - 360.0) / 100.0;
    
    add_transform(entity_id, world_x, 0.0, world_z);
    add_render_component(entity_id, "sphere".as_ptr(), 6);
    
    // Store entity
    if ENTITY_COUNT < 100 {
        SPAWNED_ENTITIES[ENTITY_COUNT] = entity_id;
        ENTITY_COUNT += 1;
    }
}

unsafe fn cleanup_old_entities() {
    if ENTITY_COUNT == 0 {
        return;
    }
    
    // Remove oldest entity
    let old_entity = SPAWNED_ENTITIES[0];
    destroy_entity(old_entity);
    
    // Shift array
    for i in 1..ENTITY_COUNT {
        SPAWNED_ENTITIES[i - 1] = SPAWNED_ENTITIES[i];
    }
    ENTITY_COUNT -= 1;
    
    log_str("Cleaned up old entity");
}

unsafe fn animate_entities(delta_time: f64) {
    let time = get_total_time() as f32;
    
    // Animate spawned entities (make them float up and down)
    for i in 0..ENTITY_COUNT {
        let entity_id = SPAWNED_ENTITIES[i];
        if entity_exists(entity_id) == 0 {
            continue;
        }
        
        // Get current position
        let mut x: f32 = 0.0;
        let mut y: f32 = 0.0;
        let mut z: f32 = 0.0;
        
        if get_transform_position(entity_id, &mut x, &mut y, &mut z) != 0 {
            // Animate Y position with sine wave
            let new_y = libm::sinf(time * 2.0 + i as f32) * 0.5;
            add_transform(entity_id, x, new_y, z);
        }
    }
}

// Helper function to log strings
fn log_str(message: &str) {
    unsafe {
        log_info(message.as_ptr(), message.len() as i32);
    }
}

// Memory management exports (required for WASM)
// Memory allocation is handled by wee_alloc globally