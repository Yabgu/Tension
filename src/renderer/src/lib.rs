/// SDL2-based renderer - Minimal rendering for engine demos
use sdl2::pixels::Color;
use sdl2::rect::{Point, Rect};
use sdl2::render::{Canvas, TextureCreator};
use sdl2::video::{Window, WindowContext};
use sdl2::{EventPump, Sdl};

use tension_core::{
    World, EngineConfig, Result, EngineError, InputManager,
    api::{Transform, RenderComponent, InputEvent, InputModifiers, MouseButton}
};

/// SDL2 renderer implementation
pub struct SdlRenderer {
    _sdl_context: Sdl,
    canvas: Canvas<Window>,
    event_pump: EventPump,
    texture_creator: TextureCreator<WindowContext>,
    
    // Render stats
    triangles_rendered: usize,
    draw_calls: usize,
}

impl SdlRenderer {
    pub fn new(config: &EngineConfig) -> Result<Self> {
        tracing::info!("Initializing SDL2 renderer");
        tracing::info!("Window: {}x{}, VSync: {}", config.window_width, config.window_height, config.vsync);
        
        let sdl_context = sdl2::init()
            .map_err(|e| EngineError::ApiContractViolation { message: format!("SDL2 init failed: {}", e) })?;
        
        let video_subsystem = sdl_context.video()
            .map_err(|e| EngineError::ApiContractViolation { message: format!("SDL2 video init failed: {}", e) })?;
        
        let window = video_subsystem
            .window("Tension Engine - WASM Demo", config.window_width, config.window_height)
            .position_centered()
            .opengl()
            .build()
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Window creation failed: {}", e) })?;
        
        let mut canvas = window.into_canvas()
            .accelerated();
            
        if config.vsync {
            canvas = canvas.present_vsync();
        }
        
        let canvas = canvas.build()
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Canvas creation failed: {}", e) })?;
        
        let event_pump = sdl_context.event_pump()
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Event pump creation failed: {}", e) })?;
        
        let texture_creator = canvas.texture_creator();
        
        tracing::info!("SDL2 renderer initialized successfully");
        
        Ok(Self {
            _sdl_context: sdl_context,
            canvas,
            event_pump,
            texture_creator,
            triangles_rendered: 0,
            draw_calls: 0,
        })
    }
    
    pub fn begin_frame(&mut self) -> Result<()> {
        // Clear the screen
        self.canvas.set_draw_color(Color::RGB(20, 20, 30)); // Dark blue background
        self.canvas.clear();
        
        // Reset stats
        self.triangles_rendered = 0;
        self.draw_calls = 0;
        
        Ok(())
    }
    
    pub fn render_world(&mut self, world: &World, interpolation_alpha: f64) -> Result<()> {
        // Query all entities with render components
        let renderable_entities = world.query_entities_with_component::<RenderComponent>();
        
        for entity_handle in renderable_entities {
            if let (Some(transform), Some(render_component)) = (
                world.get_component::<Transform>(entity_handle),
                world.get_component::<RenderComponent>(entity_handle)
            ) {
                if render_component.visible {
                    self.render_entity(&transform, &render_component, interpolation_alpha)?;
                }
            }
        }
        
        // Draw UI overlay with stats
        self.render_debug_overlay()?;
        
        Ok(())
    }
    
    pub fn end_frame(&mut self) -> Result<()> {
        self.canvas.present();
        Ok(())
    }
    
    /// Handle SDL2 events and update input manager
    pub fn handle_events(&mut self, input_manager: &mut InputManager) -> Result<()> {
        use sdl2::event::Event;
        use sdl2::keyboard::Keycode;
        
        for event in self.event_pump.poll_iter() {
            match event {
                Event::Quit { .. } => {
                    input_manager.quit();
                }
                Event::KeyDown { keycode: Some(keycode), keymod, .. } => {
                    let key_name = format!("{:?}", keycode);
                    let modifiers = InputModifiers {
                        ctrl: keymod.contains(sdl2::keyboard::Mod::LCTRLMOD) || keymod.contains(sdl2::keyboard::Mod::RCTRLMOD),
                        alt: keymod.contains(sdl2::keyboard::Mod::LALTMOD) || keymod.contains(sdl2::keyboard::Mod::RALTMOD),
                        shift: keymod.contains(sdl2::keyboard::Mod::LSHIFTMOD) || keymod.contains(sdl2::keyboard::Mod::RSHIFTMOD),
                        cmd: keymod.contains(sdl2::keyboard::Mod::LGUIMOD) || keymod.contains(sdl2::keyboard::Mod::RGUIMOD),
                    };
                    
                    input_manager.push_event(InputEvent::KeyPressed { key: key_name, modifiers });
                    
                    // Handle escape key
                    if keycode == Keycode::Escape {
                        input_manager.quit();
                    }
                }
                Event::KeyUp { keycode: Some(keycode), keymod, .. } => {
                    let key_name = format!("{:?}", keycode);
                    let modifiers = InputModifiers {
                        ctrl: keymod.contains(sdl2::keyboard::Mod::LCTRLMOD) || keymod.contains(sdl2::keyboard::Mod::RCTRLMOD),
                        alt: keymod.contains(sdl2::keyboard::Mod::LALTMOD) || keymod.contains(sdl2::keyboard::Mod::RALTMOD),
                        shift: keymod.contains(sdl2::keyboard::Mod::LSHIFTMOD) || keymod.contains(sdl2::keyboard::Mod::RSHIFTMOD),
                        cmd: keymod.contains(sdl2::keyboard::Mod::LGUIMOD) || keymod.contains(sdl2::keyboard::Mod::RGUIMOD),
                    };
                    
                    input_manager.push_event(InputEvent::KeyReleased { key: key_name, modifiers });
                }
                Event::MouseButtonDown { mouse_btn, x, y, .. } => {
                    let button = match mouse_btn {
                        sdl2::mouse::MouseButton::Left => MouseButton::Left,
                        sdl2::mouse::MouseButton::Right => MouseButton::Right,
                        sdl2::mouse::MouseButton::Middle => MouseButton::Middle,
                        sdl2::mouse::MouseButton::X1 => MouseButton::Other(4),
                        sdl2::mouse::MouseButton::X2 => MouseButton::Other(5),
                        sdl2::mouse::MouseButton::Unknown => MouseButton::Other(0),
                    };
                    
                    input_manager.push_event(InputEvent::MousePressed { 
                        button, 
                        x: x as f32, 
                        y: y as f32 
                    });
                }
                Event::MouseButtonUp { mouse_btn, x, y, .. } => {
                    let button = match mouse_btn {
                        sdl2::mouse::MouseButton::Left => MouseButton::Left,
                        sdl2::mouse::MouseButton::Right => MouseButton::Right,
                        sdl2::mouse::MouseButton::Middle => MouseButton::Middle,
                        sdl2::mouse::MouseButton::X1 => MouseButton::Other(4),
                        sdl2::mouse::MouseButton::X2 => MouseButton::Other(5),
                        sdl2::mouse::MouseButton::Unknown => MouseButton::Other(0),
                    };
                    
                    input_manager.push_event(InputEvent::MouseReleased { 
                        button, 
                        x: x as f32, 
                        y: y as f32 
                    });
                }
                Event::MouseMotion { x, y, xrel, yrel, .. } => {
                    input_manager.push_event(InputEvent::MouseMoved { 
                        x: x as f32, 
                        y: y as f32, 
                        delta_x: xrel as f32, 
                        delta_y: yrel as f32 
                    });
                }
                Event::MouseWheel { x, y, .. } => {
                    input_manager.push_event(InputEvent::MouseWheel { 
                        delta_x: x as f32, 
                        delta_y: y as f32 
                    });
                }
                _ => {}
            }
        }
        
        Ok(())
    }
    
    /// Render a single entity
    fn render_entity(&mut self, transform: &Transform, render_component: &RenderComponent, _alpha: f64) -> Result<()> {
        // Convert world position to screen coordinates
        let screen_x = (transform.position.x + 10.0) * 50.0; // Simple world-to-screen conversion
        let screen_y = (transform.position.z + 10.0) * 50.0;
        
        // Render based on mesh type (simplified)
        match render_component.mesh_id.as_str() {
            "cube" => {
                self.render_cube(screen_x as i32, screen_y as i32, &render_component.material_id)?;
            }
            "sphere" => {
                self.render_sphere(screen_x as i32, screen_y as i32, &render_component.material_id)?;
            }
            "quad" => {
                self.render_quad(screen_x as i32, screen_y as i32, &render_component.material_id)?;
            }
            _ => {
                // Default: render as a small rectangle
                self.render_quad(screen_x as i32, screen_y as i32, &render_component.material_id)?;
            }
        }
        
        self.draw_calls += 1;
        Ok(())
    }
    
    /// Render a cube (as a square for 2D)
    fn render_cube(&mut self, x: i32, y: i32, material: &str) -> Result<()> {
        let color = self.material_to_color(material);
        self.canvas.set_draw_color(color);
        
        let rect = Rect::new(x - 15, y - 15, 30, 30);
        self.canvas.fill_rect(rect)
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Render error: {}", e) })?;
        
        // Draw outline
        self.canvas.set_draw_color(Color::WHITE);
        self.canvas.draw_rect(rect)
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Render error: {}", e) })?;
        
        self.triangles_rendered += 2; // 2 triangles per quad
        Ok(())
    }
    
    /// Render a sphere (as a circle for 2D) 
    fn render_sphere(&mut self, x: i32, y: i32, material: &str) -> Result<()> {
        let color = self.material_to_color(material);
        self.canvas.set_draw_color(color);
        
        // Draw filled circle (approximate with filled rect for simplicity)
        let rect = Rect::new(x - 12, y - 12, 24, 24);
        self.canvas.fill_rect(rect)
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Render error: {}", e) })?;
        
        // Draw circle outline (approximate)
        self.canvas.set_draw_color(Color::WHITE);
        for angle in 0..360 {
            let rad = (angle as f32 * std::f32::consts::PI / 180.0);
            let px = x + (12.0 * rad.cos()) as i32;
            let py = y + (12.0 * rad.sin()) as i32;
            self.canvas.draw_point(Point::new(px, py))
                .map_err(|e| EngineError::ApiContractViolation { message: format!("Render error: {}", e) })?;
        }
        
        self.triangles_rendered += 8; // Approximate sphere complexity
        Ok(())
    }
    
    /// Render a quad
    fn render_quad(&mut self, x: i32, y: i32, material: &str) -> Result<()> {
        let color = self.material_to_color(material);
        self.canvas.set_draw_color(color);
        
        let rect = Rect::new(x - 10, y - 10, 20, 20);
        self.canvas.fill_rect(rect)
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Render error: {}", e) })?;
        
        self.triangles_rendered += 2;
        Ok(())
    }
    
    /// Convert material name to color
    fn material_to_color(&self, material: &str) -> Color {
        match material {
            "red" => Color::RGB(255, 80, 80),
            "green" => Color::RGB(80, 255, 80), 
            "blue" => Color::RGB(80, 80, 255),
            "yellow" => Color::RGB(255, 255, 80),
            "purple" => Color::RGB(255, 80, 255),
            "cyan" => Color::RGB(80, 255, 255),
            "white" => Color::RGB(255, 255, 255),
            "gray" => Color::RGB(128, 128, 128),
            _ => Color::RGB(200, 200, 200), // Default gray
        }
    }
    
    /// Render debug overlay
    fn render_debug_overlay(&mut self) -> Result<()> {
        // For now, just draw some debug info as colored rectangles
        // In a real implementation, you'd use SDL2_ttf for text
        
        // Draw FPS indicator (green bar for good performance)
        self.canvas.set_draw_color(Color::RGB(0, 255, 0));
        let fps_bar = Rect::new(10, 10, 100, 10);
        self.canvas.fill_rect(fps_bar)
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Render error: {}", e) })?;
        
        // Draw entity count indicator
        self.canvas.set_draw_color(Color::RGB(255, 255, 0));
        let entity_bar = Rect::new(10, 25, std::cmp::min(self.draw_calls * 10, 200) as u32, 5);
        self.canvas.fill_rect(entity_bar)
            .map_err(|e| EngineError::ApiContractViolation { message: format!("Render error: {}", e) })?;
        
        Ok(())
    }
    
    pub fn get_render_stats(&self) -> RenderStats {
        RenderStats {
            triangles_rendered: self.triangles_rendered,
            draw_calls: self.draw_calls,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RenderStats {
    pub triangles_rendered: usize,
    pub draw_calls: usize,
}

// Implement the engine's RendererTrait
impl tension_core::RendererTrait for SdlRenderer {
    fn begin_frame(&mut self) -> tension_core::Result<()> {
        self.begin_frame()
    }
    
    fn render_world(&mut self, world: &World, alpha: f64) -> tension_core::Result<()> {
        self.render_world(world, alpha)
    }
    
    fn end_frame(&mut self) -> tension_core::Result<()> {
        self.end_frame()
    }
    
    fn handle_events(&mut self, input_manager: &mut InputManager) -> tension_core::Result<()> {
        self.handle_events(input_manager)
    }
}