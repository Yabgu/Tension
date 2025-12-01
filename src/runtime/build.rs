use std::fs;
use std::path::Path;
use regex::Regex;

fn main() {
    // Path to the bindings source file (relative to crate root)
    let src_path = Path::new("src/bindings.rs");
    let out_path = Path::new("..").join("..").join("demos").join("tension-ts-wasm-demo").join("host_bindings.json");

    let src = match fs::read_to_string(&src_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Could not read {}: {}", src_path.display(), e);
            return;
        }
    };

    // Regex to capture: linker.func_wrap("module", "name", |...args...| -> return { ... }
    let re = Regex::new(r#"linker\.func_wrap\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*\|([^\)]*)\)\s*(?:->\s*([^\s\{]+))?"#).unwrap();

    use serde_json::json;
    let mut manifest = serde_json::Map::new();

    for cap in re.captures_iter(&src) {
        let module = cap.get(1).unwrap().as_str();
        let name = cap.get(2).unwrap().as_str();
        let params_raw = cap.get(3).map(|m| m.as_str()).unwrap_or("");
        let ret_ty = cap.get(4).map(|m| m.as_str()).unwrap_or("void");

        // Parse parameters: split by ',' and extract type after ':'
        let mut types = Vec::new();
        for p in params_raw.split(',') {
            let part = p.trim();
            if part.is_empty() { continue; }
            // skip caller param that contains 'Caller<' or 'caller'
            if part.contains("Caller") || part.contains("caller") || part.contains("mut caller") { continue; }
            // expected form: name: type
            if let Some(idx) = part.find(':') {
                let ty = part[idx+1..].trim();
                // normalize pointer types like '*const u8' to 'i32' (ptr)
                let mapped = match ty {
                    "*const u8" | "*mut u8" | "*const u8" => "i32",
                    _ => ty,
                };
                types.push(mapped.to_string());
            } else {
                // fallback: maybe it's just a type
                types.push(part.to_string());
            }
        }

        // Insert into manifest JSON under module
        let module_entry = manifest.entry(module.to_string()).or_insert_with(|| json!({}));
        if let serde_json::Value::Object(map) = module_entry {
            map.insert(name.to_string(), json!({"params": types, "result": ret_ty}));
        }
    }

    // Write manifest prettified
    if let Err(e) = fs::create_dir_all(out_path.parent().unwrap()) {
        eprintln!("Failed to create output dir: {}", e);
    }
    match fs::write(&out_path, serde_json::to_string_pretty(&serde_json::Value::Object(manifest)).unwrap()) {
        Ok(_) => println!("cargo:warning=Generated host bindings at {}", out_path.display()),
        Err(e) => eprintln!("Failed to write {}: {}", out_path.display(), e),
    }
}
