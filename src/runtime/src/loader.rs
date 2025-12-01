/// Module loader - Hot reload and dynamic loading
use std::path::{Path, PathBuf};
use std::fs;
use notify::{Event, EventKind};

pub struct ModuleLoader {
    module_directory: PathBuf,
    watched_files: Vec<PathBuf>,
}

impl ModuleLoader {
    pub fn new(module_directory: impl Into<PathBuf>) -> Self {
        Self {
            module_directory: module_directory.into(),
            watched_files: Vec::new(),
        }
    }
    
    /// Scan directory for WASM modules
    pub fn scan_modules(&mut self) -> anyhow::Result<Vec<PathBuf>> {
        let mut modules = Vec::new();
        
        if !self.module_directory.exists() {
            return Ok(modules);
        }
        
        for entry in fs::read_dir(&self.module_directory)? {
            let entry = entry?;
            let path = entry.path();
            
            if path.extension().and_then(|s| s.to_str()) == Some("wasm") {
                modules.push(path);
            }
        }
        
        self.watched_files = modules.clone();
        Ok(modules)
    }
    
    /// Check if file should trigger reload
    pub fn should_reload(&self, event: &Event) -> Option<String> {
        match &event.kind {
            EventKind::Modify(_) | EventKind::Create(_) => {
                for path in &event.paths {
                    if path.extension().and_then(|s| s.to_str()) == Some("wasm") {
                        if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                            return Some(name.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
        None
    }
}

/// Sandbox enforcement
pub struct Sandbox;

impl Sandbox {
    /// Validate module imports for security
    pub fn validate_imports(imports: &[String]) -> Result<(), String> {
        for import in imports {
            if !Self::is_allowed_import(import) {
                return Err(format!("Forbidden import: {}", import));
            }
        }
        Ok(())
    }
    
    /// Check if import is allowed in sandbox
    fn is_allowed_import(import: &str) -> bool {
        // Allow only engine API functions
        import.starts_with("engine::")
    }
}