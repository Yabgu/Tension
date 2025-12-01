/// Host function bindings - The sacred API contract
use wasmtime::{Linker, Caller};
use wasmtime_wasi::WasiCtx;
use frankenstein_core::{World, api::*};

/// Host bindings - implements the complete WASM API
pub struct HostBindings;

impl HostBindings {
    /// Bind all host functions to the linker
    pub fn add_host_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        Self::bind_entity_functions(linker)?;
        Self::bind_component_functions(linker)?;
        Self::bind_input_functions(linker)?;
        Self::bind_random_functions(linker)?;
        Self::bind_time_functions(linker)?;
        Self::bind_logging_functions(linker)?;
        Self::bind_query_functions(linker)?;
        Ok(())
    }
    
    /// Entity management functions
    fn bind_entity_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        linker.func_wrap("env", "spawn_entity", 
            |mut caller: Caller<'_, ()>| -> u64 {
                // TODO: Access world through caller context
                // For now, return a placeholder entity ID
                42u64
            }
        )?;
        
        linker.func_wrap("engine", "destroy_entity",
            |mut caller: Caller<'_, ()>, entity_id: u64| -> i32 {
                // TODO: Implement entity destruction
                1i32 // Success
            }
        )?;
        
        linker.func_wrap("engine", "entity_exists",
            |mut caller: Caller<'_, ()>, entity_id: u64| -> i32 {
                // TODO: Check entity existence
                1i32 // Exists
            }
        )?;
        
        Ok(())
    }
    
    /// Component management functions
    fn bind_component_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        // Transform component functions
        linker.func_wrap("engine", "add_transform",
            |mut caller: Caller<'_, ()>, entity_id: u64, pos_x: f32, pos_y: f32, pos_z: f32| -> i32 {
                // TODO: Add transform component
                tracing::debug!("Adding transform to entity {}: ({}, {}, {})", entity_id, pos_x, pos_y, pos_z);
                1i32 // Success
            }
        )?;
        
        linker.func_wrap("engine", "get_transform_position",
            |mut caller: Caller<'_, ()>, entity_id: u64, out_x: i32, out_y: i32, out_z: i32| -> i32 {
                // TODO: Get transform position and write to WASM memory
                0i32 // Not found
            }
        )?;
        
        // Render component functions
        linker.func_wrap("engine", "add_render_component",
            |mut caller: Caller<'_, ()>, entity_id: u64, mesh_ptr: i32, mesh_len: i32| -> i32 {
                if let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) {
                    let data = memory.data(&caller);
                    if let Ok(mesh_id) = std::str::from_utf8(&data[mesh_ptr as usize..(mesh_ptr + mesh_len) as usize]) {
                        tracing::debug!("Adding render component to entity {}: mesh={}", entity_id, mesh_id);
                        return 1i32; // Success
                    }
                }
                0i32 // Failed
            }
        )?;
        
        Ok(())
    }
    
    /// Input access functions
    fn bind_input_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        linker.func_wrap("engine", "is_key_pressed",
            |mut caller: Caller<'_, ()>, key_ptr: i32, key_len: i32| -> i32 {
                if let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) {
                    let data = memory.data(&caller);
                    if let Ok(key) = std::str::from_utf8(&data[key_ptr as usize..(key_ptr + key_len) as usize]) {
                        // TODO: Check actual key state
                        tracing::trace!("Checking key state: {}", key);
                        return 0i32; // Not pressed
                    }
                }
                0i32 // Error
            }
        )?;
        
        linker.func_wrap("engine", "get_mouse_position",
            |mut caller: Caller<'_, ()>, out_x: i32, out_y: i32| -> i32 {
                // TODO: Write mouse position to WASM memory
                if let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) {
                    let data = memory.data_mut(&mut caller);
                    // Write placeholder mouse position
                    let x_bytes = 100.0f32.to_le_bytes();
                    let y_bytes = 200.0f32.to_le_bytes();
                    
                    if out_x >= 0 && (out_x as usize + 4) <= data.len() {
                        data[out_x as usize..out_x as usize + 4].copy_from_slice(&x_bytes);
                    }
                    if out_y >= 0 && (out_y as usize + 4) <= data.len() {
                        data[out_y as usize..out_y as usize + 4].copy_from_slice(&y_bytes);
                    }
                    
                    return 1i32; // Success
                }
                0i32 // Failed
            }
        )?;
        
        Ok(())
    }
    
    /// Random number generation functions
    fn bind_random_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        linker.func_wrap("engine", "random_f32",
            |mut caller: Caller<'_, ()>| -> f32 {
                // TODO: Use seeded RNG from engine context
                0.5f32 // Placeholder
            }
        )?;
        
        linker.func_wrap("engine", "random_range_i32",
            |mut caller: Caller<'_, ()>, min: i32, max: i32| -> i32 {
                // TODO: Use seeded RNG
                (min + max) / 2 // Placeholder
            }
        )?;
        
        Ok(())
    }
    
    /// Time access functions
    fn bind_time_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        linker.func_wrap("engine", "get_delta_time",
            |mut caller: Caller<'_, ()>| -> f64 {
                // TODO: Get actual delta time from engine
                1.0 / 60.0 // 60 FPS placeholder
            }
        )?;
        
        linker.func_wrap("engine", "get_total_time",
            |mut caller: Caller<'_, ()>| -> f64 {
                // TODO: Get actual total time
                0.0 // Placeholder
            }
        )?;
        
        linker.func_wrap("engine", "get_frame_count",
            |mut caller: Caller<'_, ()>| -> u64 {
                // TODO: Get actual frame count
                0u64 // Placeholder
            }
        )?;
        
        Ok(())
    }
    
    /// Logging functions
    fn bind_logging_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        linker.func_wrap("engine", "log_info",
            |mut caller: Caller<'_, ()>, ptr: i32, len: i32| {
                Self::log_message(&mut caller, ptr, len, tracing::Level::INFO);
            }
        )?;
        
        linker.func_wrap("engine", "log_warn",
            |mut caller: Caller<'_, ()>, ptr: i32, len: i32| {
                Self::log_message(&mut caller, ptr, len, tracing::Level::WARN);
            }
        )?;
        
        linker.func_wrap("engine", "log_error",
            |mut caller: Caller<'_, ()>, ptr: i32, len: i32| {
                Self::log_message(&mut caller, ptr, len, tracing::Level::ERROR);
            }
        )?;

        // Numeric log helpers (useful for WASM modules that cannot allocate strings)
        linker.func_wrap("engine", "log_f32",
            |mut _caller: Caller<'_, ()>, value: f32| {
                // Also print to stdout to ensure visible in plain runs
                println!("[WASM-F32]: {}", value);
                tracing::info!("[WASM-F32]: {}", value);
            }
        )?;

        linker.func_wrap("engine", "log_f64",
            |mut _caller: Caller<'_, ()>, value: f64| {
                println!("[WASM-F64]: {}", value);
                tracing::info!("[WASM-F64]: {}", value);
            }
        )?;
        
        Ok(())
    }
    
    /// Query system functions
    fn bind_query_functions(linker: &mut Linker<()>) -> anyhow::Result<()> {
        linker.func_wrap("engine", "query_entities_in_radius",
            |mut caller: Caller<'_, ()>, center_x: f32, center_y: f32, center_z: f32, radius: f32, out_ptr: i32, max_count: i32| -> i32 {
                // TODO: Implement spatial query
                tracing::debug!("Querying entities in radius {} around ({}, {}, {})", radius, center_x, center_y, center_z);
                0i32 // No entities found
            }
        )?;
        
        Ok(())
    }
    
    /// Helper function to extract string from WASM memory and log it
    fn log_message(caller: &mut Caller<()>, ptr: i32, len: i32, level: tracing::Level) {
        if let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) {
            let data = memory.data(caller);
            if let Ok(message) = std::str::from_utf8(&data[ptr as usize..(ptr + len) as usize]) {
                match level {
                    tracing::Level::INFO => tracing::info!("[WASM]: {}", message),
                    tracing::Level::WARN => tracing::warn!("[WASM]: {}", message),
                    tracing::Level::ERROR => tracing::error!("[WASM]: {}", message),
                    tracing::Level::DEBUG => tracing::debug!("[WASM]: {}", message),
                    tracing::Level::TRACE => tracing::trace!("[WASM]: {}", message),
                }
            }
        }
    }
}