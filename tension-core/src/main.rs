//! TensionCore interpreter
//!
//! `tension-core` is a command-line *interpreter*: it loads a guest `game.wasm`
//! and supplies the `std:tension/io` host ABI. The guest owns the game logic;
//! the host owns the terminal. That split is what makes it a language runtime
//! rather than a linker: the game compiles *against* the ABI, tension-core
//! *implements* it.
//!
//! Host ABI (module `tension::io`):
//!   print(ptr, len)          write `len` UTF-8 bytes at `ptr` to stdout
//!   read_line(ptr, cap)      read one line -> UTF-8 bytes into buffer, return
//!                            byte count (or -1 on EOF)
//!   arg_count() -> i32       number of extra CLI args passed to the game
//!   arg(i, ptr, cap) -> i32  write arg i as UTF-8 into buffer, return byte
//!                            count (or -1 if out of range). cap==0 probes size.

use std::io::{self, BufRead, Write};
use wasmtime::{Caller, Engine, Linker, Module, Store};

/// State stored alongside the Wasm store: the game's CLI arguments.
struct HostState {
    args: Vec<String>,
}

/// Read an AssemblyScript `String` (UTF-16LE data at `ptr`, `rtSize` at `ptr-4`)
/// out of the guest memory and decode it to a Rust `String`.
fn read_as_string(caller: &mut Caller<'_, HostState>, ptr: i32) -> String {
    if ptr == 0 {
        return String::new();
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return String::new();
    };
    let data = mem.data(&*caller);
    let p = ptr as usize;
    let rt_size = match p.checked_sub(4) {
        Some(h) if h.saturating_add(4) <= data.len() => {
            u32::from_le_bytes(data[h..h + 4].try_into().unwrap_or([0; 4]))
        }
        _ => 0,
    };
    let chars = (rt_size as usize) / 2;
    let mut s = String::new();
    for i in 0..chars {
        let off = p.saturating_add(i * 2);
        if off.saturating_add(2) > data.len() {
            break;
        }
        let u = u16::from_le_bytes([data[off], data[off + 1]]);
        s.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}'));
    }
    s
}

fn main() -> anyhow::Result<()> {
    let mut cli = std::env::args();
    let _prog = cli.next();
    let wasm_path = cli.next().unwrap_or_else(|| {
        eprintln!("usage: tension-core <game.wasm> [args...]");
        std::process::exit(2);
    });
    let args: Vec<String> = cli.collect();

    let engine = Engine::default();
    let module = Module::from_file(&engine, &wasm_path)?;

    let mut store = Store::new(&engine, HostState { args });
    let mut linker: Linker<HostState> = Linker::new(&engine);

    // std:tension/io ABI -----------------------------------------------------
    // AS `stub` runtime traps through `env.abort`(msg_ptr, file_ptr, line, col).
    linker.func_wrap(
        "env",
        "abort",
        |mut caller: Caller<'_, HostState>, msg: i32, file: i32, line: i32, col: i32| -> () {
            let m = read_as_string(&mut caller, msg);
            let f = read_as_string(&mut caller, file);
            eprintln!("[tension-core] game aborted: {m} (in {f}, line {line}, col {col})");
            std::process::exit(1);
        },
    )?;

    linker.func_wrap(
        "tension::io",
        "print",
        |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| {
            let mem = caller
                .get_export("memory")
                .and_then(|e| e.into_memory())
                .expect("game must export a memory named 'memory'");
            let bytes = mem.data(&caller);
            let start = ptr as usize;
            let end = start + len.max(0) as usize;
            let start = start.min(bytes.len());
            let end = end.min(bytes.len());
            let text = String::from_utf8_lossy(&bytes[start..end]);
            print!("{text}");
            let _ = io::stdout().flush();
        },
    )?;

    linker.func_wrap(
        "tension::io",
        "read_line",
        |mut caller: Caller<'_, HostState>, ptr: i32, cap: i32| -> i32 {
            let mut line = String::new();
            let n = io::stdin().lock().read_line(&mut line).unwrap_or(0);
            if n == 0 {
                return -1; // EOF
            }
            while line.ends_with('\n') || line.ends_with('\r') {
                line.pop();
            }
            let bytes = line.as_bytes();
            let to_write = (bytes.len() as i32).min(cap.max(0)) as usize;
            if to_write > 0 {
                let mem = caller
                    .get_export("memory")
                    .and_then(|e| e.into_memory())
                    .expect("game must export a memory named 'memory'");
                let data = mem.data_mut(&mut caller);
                let start = ptr as usize;
                let start = start.min(data.len());
                let end = (start + to_write).min(data.len());
                data[start..end].copy_from_slice(&bytes[..(end - start)]);
            }
            bytes.len() as i32
        },
    )?;

    linker.func_wrap(
        "tension::io",
        "arg_count",
        |caller: Caller<'_, HostState>| -> i32 { caller.data().args.len() as i32 },
    )?;

    linker.func_wrap(
        "tension::io",
        "arg",
        |mut caller: Caller<'_, HostState>, i: i32, ptr: i32, cap: i32| -> i32 {
            if i < 0 {
                return -1;
            }
            let arg = match caller.data().args.get(i as usize) {
                Some(a) => a.clone(),
                None => return -1,
            };
            let bytes = arg.as_bytes();
            let need = bytes.len();
            if cap > 0 {
                let to_write = (need as i32).min(cap) as usize;
                if to_write > 0 {
                    let mem = caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                        .expect("game must export a memory named 'memory'");
                    let data = mem.data_mut(&mut caller);
                    let start = ptr as usize;
                    let start = start.min(data.len());
                    let end = (start + to_write).min(data.len());
                    data[start..end].copy_from_slice(&bytes[..(end - start)]);
                }
            }
            need as i32
        },
    )?;

    let instance = linker.instantiate(&mut store, &module)?;

    // Entrypoint: prefer the Tension-specific `_start_game`, else WASI `_start`.
    if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start_game") {
        func.call(&mut store, ())?;
    } else if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start") {
        func.call(&mut store, ())?;
    } else {
        anyhow::bail!("game.wasm did not export `_start_game` or `_start`");
    }

    Ok(())
}
