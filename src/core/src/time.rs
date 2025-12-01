/// Time management - Fixed timestep determinism is non-negotiable
use std::time::{Duration, Instant};
use crate::{Deterministic, Instrumented, PerformanceMetrics};

/// Fixed timestep manager - guarantees deterministic execution
pub struct TimeManager {
    target_delta: Duration,
    accumulator: Duration,
    last_frame: Instant,
    frame_count: u64,
    performance_metrics: PerformanceMetrics,
    frame_start: Option<Instant>,
}

impl TimeManager {
    pub fn new(target_fps: u32) -> Self {
        let target_delta = Duration::from_secs_f64(1.0 / target_fps as f64);
        
        Self {
            target_delta,
            accumulator: Duration::ZERO,
            last_frame: Instant::now(),
            frame_count: 0,
            performance_metrics: PerformanceMetrics {
                frame_time_ms: 0.0,
                wasm_execution_time_ms: 0.0,
                native_execution_time_ms: 0.0,
                memory_usage_bytes: 0,
                entity_count: 0,
            },
            frame_start: None,
        }
    }
    
    /// Update accumulator and return number of fixed timesteps to execute
    pub fn tick(&mut self) -> u32 {
        let now = Instant::now();
        let frame_time = now.duration_since(self.last_frame);
        self.last_frame = now;
        
        // Cap frame time to prevent spiral of death
        let capped_frame_time = frame_time.min(Duration::from_millis(250));
        self.accumulator += capped_frame_time;
        
        let mut steps = 0;
        while self.accumulator >= self.target_delta {
            self.accumulator -= self.target_delta;
            steps += 1;
            
            // Safety valve: prevent infinite loops
            if steps >= 10 {
                tracing::warn!(
                    "Fixed timestep falling behind: {} steps queued, resetting accumulator",
                    steps
                );
                self.accumulator = Duration::ZERO;
                break;
            }
        }
        
        steps
    }
    
    pub fn fixed_delta_time(&self) -> f64 {
        self.target_delta.as_secs_f64()
    }
    
    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }
    
    pub fn interpolation_alpha(&self) -> f64 {
        self.accumulator.as_secs_f64() / self.target_delta.as_secs_f64()
    }
}

impl Instrumented for TimeManager {
    fn start_frame(&mut self) {
        self.frame_start = Some(Instant::now());
        self.frame_count += 1;
    }
    
    fn end_frame(&mut self) {
        if let Some(start) = self.frame_start.take() {
            let frame_duration = start.elapsed();
            self.performance_metrics.frame_time_ms = frame_duration.as_secs_f64() * 1000.0;
        }
    }
    
    fn get_metrics(&self) -> PerformanceMetrics {
        self.performance_metrics.clone()
    }
}

/// Fixed timestep abstraction for deterministic systems
pub struct FixedTimestep {
    delta_time: f64,
    current_time: f64,
    step_count: u64,
}

impl FixedTimestep {
    pub fn new(target_fps: u32) -> Self {
        Self {
            delta_time: 1.0 / target_fps as f64,
            current_time: 0.0,
            step_count: 0,
        }
    }
    
    pub fn step(&mut self) {
        self.current_time += self.delta_time;
        self.step_count += 1;
    }
    
    pub fn delta_time(&self) -> f64 {
        self.delta_time
    }
    
    pub fn current_time(&self) -> f64 {
        self.current_time
    }
    
    pub fn step_count(&self) -> u64 {
        self.step_count
    }
}

impl Deterministic for FixedTimestep {
    fn seed(&mut self, _seed: u64) {
        // Time doesn't need seeding, it's deterministic by design
    }
    
    fn step(&mut self, _delta_time: f64) {
        // Fixed timestep ignores variable delta
        self.step();
    }
    
    fn state_hash(&self) -> u64 {
        // Hash the step count for determinism verification
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let mut hasher = DefaultHasher::new();
        self.step_count.hash(&mut hasher);
        self.current_time.to_bits().hash(&mut hasher);
        hasher.finish()
    }
}