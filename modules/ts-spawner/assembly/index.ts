// AssemblyScript WASM module
// Import host functions
@external("engine", "create_square")
declare function create_square(mat_ptr: i32, mat_len: i32): u64;

@external("engine", "set_rotation")
declare function set_rotation(id: u64, radians: f32): i32;

@external("engine", "log_info")
declare function log_info(msg_ptr: i32, msg_len: i32): void;

@external("engine", "log_f32")
declare function log_f32(val: f32): void;

// Keep track of our spawned entity id and rotation
let entityId: u64 = 0;
let angle: f32 = 0.0;

export function init(): void {
  // Spawn a square with default material (pass empty string)
  entityId = create_square(0, 0);
}

export function update(delta: f64): void {
  // Rotate around Y at 90 degrees per second
  angle += <f32>(delta as f32) * (3.14159265 / 2.0);
  set_rotation(entityId, angle);
  // Log numeric angle via host helper (avoids needing AssemblyScript allocators)
  log_f32(angle);
}
