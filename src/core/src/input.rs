/// Input management - Raw input to structured events
use std::collections::{HashMap, VecDeque};
use crate::api::{InputEvent, InputModifiers, MouseButton, GamepadButton, GamepadAxis};

/// Input manager - processes raw input and maintains state
pub struct InputManager {
    input_events: VecDeque<InputEvent>,
    key_states: HashMap<String, bool>,
    mouse_button_states: HashMap<MouseButton, bool>,
    mouse_position: glam::Vec2,
    gamepad_states: HashMap<u32, GamepadState>,
    should_quit: bool,
}

#[derive(Debug, Clone)]
struct GamepadState {
    button_states: HashMap<GamepadButton, bool>,
    axis_values: HashMap<GamepadAxis, f32>,
}

impl GamepadState {
    fn new() -> Self {
        Self {
            button_states: HashMap::new(),
            axis_values: HashMap::new(),
        }
    }
}

impl InputManager {
    pub fn new() -> Self {
        Self {
            input_events: VecDeque::new(),
            key_states: HashMap::new(),
            mouse_button_states: HashMap::new(),
            mouse_position: glam::Vec2::ZERO,
            gamepad_states: HashMap::new(),
            should_quit: false,
        }
    }
    
    /// Poll system events - placeholder for actual windowing system integration
    pub fn poll_events(&mut self) {
        // This would integrate with SDL2/winit/etc in real implementation
        // For now, just clear the event queue
        self.input_events.clear();
    }
    
    /// Add input event to queue
    pub fn push_event(&mut self, event: InputEvent) {
        // Update internal state
        match &event {
            InputEvent::KeyPressed { key, .. } => {
                self.key_states.insert(key.clone(), true);
            }
            InputEvent::KeyReleased { key, .. } => {
                self.key_states.insert(key.clone(), false);
            }
            InputEvent::MouseMoved { x, y, .. } => {
                self.mouse_position = glam::Vec2::new(*x, *y);
            }
            InputEvent::MousePressed { button, .. } => {
                self.mouse_button_states.insert(button.clone(), true);
            }
            InputEvent::MouseReleased { button, .. } => {
                self.mouse_button_states.insert(button.clone(), false);
            }
            InputEvent::GamepadButtonPressed { gamepad_id, button } => {
                let gamepad = self.gamepad_states.entry(*gamepad_id).or_insert_with(GamepadState::new);
                gamepad.button_states.insert(button.clone(), true);
            }
            InputEvent::GamepadButtonReleased { gamepad_id, button } => {
                let gamepad = self.gamepad_states.entry(*gamepad_id).or_insert_with(GamepadState::new);
                gamepad.button_states.insert(button.clone(), false);
            }
            InputEvent::GamepadAxis { gamepad_id, axis, value } => {
                let gamepad = self.gamepad_states.entry(*gamepad_id).or_insert_with(GamepadState::new);
                gamepad.axis_values.insert(axis.clone(), *value);
            }
            _ => {}
        }
        
        // Add to event queue for WASM modules
        self.input_events.push_back(event);
        
        // Check for quit conditions
        if let Some(true) = self.key_states.get("Escape") {
            self.should_quit = true;
        }
    }
    
    /// Get all input events from this frame
    pub fn get_input_events(&self) -> Vec<InputEvent> {
        self.input_events.iter().cloned().collect()
    }
    
    /// Check if key is currently pressed
    pub fn is_key_pressed(&self, key: &str) -> bool {
        self.key_states.get(key).copied().unwrap_or(false)
    }
    
    /// Check if mouse button is currently pressed
    pub fn is_mouse_button_pressed(&self, button: MouseButton) -> bool {
        self.mouse_button_states.get(&button).copied().unwrap_or(false)
    }
    
    /// Get current mouse position
    pub fn get_mouse_position(&self) -> glam::Vec2 {
        self.mouse_position
    }
    
    /// Check if gamepad button is currently pressed
    pub fn is_gamepad_button_pressed(&self, gamepad_id: u32, button: GamepadButton) -> bool {
        self.gamepad_states
            .get(&gamepad_id)
            .and_then(|gamepad| gamepad.button_states.get(&button))
            .copied()
            .unwrap_or(false)
    }
    
    /// Get gamepad axis value
    pub fn get_gamepad_axis_value(&self, gamepad_id: u32, axis: GamepadAxis) -> f32 {
        self.gamepad_states
            .get(&gamepad_id)
            .and_then(|gamepad| gamepad.axis_values.get(&axis))
            .copied()
            .unwrap_or(0.0)
    }
    
    /// Check if engine should quit
    pub fn should_quit(&self) -> bool {
        self.should_quit
    }
    
    /// Force quit
    pub fn quit(&mut self) {
        self.should_quit = true;
    }
}