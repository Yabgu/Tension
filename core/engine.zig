const std = @import("std");
const graphics = @import("graphics.zig");
const wasm = @import("wasm.zig");

pub const Engine = struct {
    allocator: std.mem.Allocator,
    graphics: graphics.Graphics,
    wasm_host: wasm.WasmHost,
    running: bool,

    pub fn init(allocator: std.mem.Allocator) !Engine {
        var graphics_system = try graphics.Graphics.init(allocator);
        var wasm_host = try wasm.WasmHost.init(allocator);
        
        return Engine{
            .allocator = allocator,
            .graphics = graphics_system,
            .wasm_host = wasm_host,
            .running = true,
        };
    }

    pub fn deinit(self: *Engine) void {
        self.graphics.deinit();
        self.wasm_host.deinit();
    }

    pub fn run(self: *Engine) !void {
        // Load the WASM module
        try self.wasm_host.loadModule("scene.wasm");
        
        // Call start() on the WASM module
        try self.wasm_host.callStart();

        var last_time = std.time.milliTimestamp();
        
        while (self.running) {
            const current_time = std.time.milliTimestamp();
            const dt = @as(f32, @floatFromInt(current_time - last_time)) / 1000.0;
            last_time = current_time;

            // Handle events
            try self.handleEvents();
            
            // Update WASM module
            try self.wasm_host.callUpdate(dt);
            
            // Render
            try self.graphics.render();
            
            // Check for hot-reload
            try self.checkHotReload();
            
            std.time.sleep(16_000_000); // ~60 FPS
        }
    }

    fn handleEvents(self: *Engine) !void {
        // Poll SDL events and update input state
        // This would integrate with SDL2 event polling
        _ = self;
    }

    fn checkHotReload(self: *Engine) !void {
        // Check if scene.wasm has been modified and reload if necessary
        _ = self;
        // Implementation would watch file modification time
    }
};