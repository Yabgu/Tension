const std = @import("std");

pub const WasmHost = struct {
    allocator: std.mem.Allocator,
    entities: std.ArrayList(Entity),
    next_entity_id: i32,

    const Entity = struct {
        id: i32,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    };

    pub fn init(allocator: std.mem.Allocator) !WasmHost {
        return WasmHost{
            .allocator = allocator,
            .entities = std.ArrayList(Entity).init(allocator),
            .next_entity_id = 1,
        };
    }

    pub fn deinit(self: *WasmHost) void {
        self.entities.deinit();
    }

    pub fn loadModule(self: *WasmHost, path: []const u8) !void {
        // Load WASM module from file
        _ = self;
        _ = path;
        // Implementation would use a WASM runtime like wasmtime or wasmer
        std.debug.print("Loading WASM module: {s}\n", .{path});
    }

    pub fn callStart(self: *WasmHost) !void {
        // Call the start() function in the WASM module
        _ = self;
        std.debug.print("Calling WASM start()\n", .{});
    }

    pub fn callUpdate(self: *WasmHost, dt: f32) !void {
        // Call the update(dt) function in the WASM module
        _ = self;
        _ = dt;
        // std.debug.print("Calling WASM update({})\n", .{dt});
    }

    // WASM import functions that the module can call

    pub fn createBox(self: *WasmHost, x: f32, y: f32, w: f32, h: f32) i32 {
        const entity = Entity{
            .id = self.next_entity_id,
            .x = x,
            .y = y,
            .w = w,
            .h = h,
        };
        
        self.entities.append(entity) catch return -1;
        const id = self.next_entity_id;
        self.next_entity_id += 1;
        
        std.debug.print("Created box: id={}, x={}, y={}, w={}, h={}\n", .{ id, x, y, w, h });
        return id;
    }

    pub fn moveEntity(self: *WasmHost, id: i32, dx: f32, dy: f32) void {
        for (self.entities.items) |*entity| {
            if (entity.id == id) {
                entity.x += dx;
                entity.y += dy;
                std.debug.print("Moved entity {}: dx={}, dy={} -> x={}, y={}\n", .{ id, dx, dy, entity.x, entity.y });
                return;
            }
        }
        std.debug.print("Entity {} not found for move\n", .{id});
    }

    pub fn logMessage(self: *WasmHost, ptr: u32, len: u32) void {
        _ = self;
        _ = ptr;
        _ = len;
        // In a real implementation, we'd read memory from the WASM instance
        std.debug.print("WASM log: [ptr={}, len={}]\n", .{ ptr, len });
    }

    pub fn getTime(self: *WasmHost) f32 {
        _ = self;
        return @as(f32, @floatFromInt(std.time.milliTimestamp())) / 1000.0;
    }

    pub fn getInput(self: *WasmHost, key: u32) bool {
        _ = self;
        _ = key;
        // In a real implementation, this would check SDL keyboard state
        return false;
    }
};