//! TensionCore interpreter
//!
//! `tension-core` is a command-line *interpreter*: it loads a guest `game.wasm`
//! and supplies the `tension::io` host ABI. The guest owns the game logic;
//! the host owns the terminal. That split is what makes it a language runtime
//! rather than a linker: the game compiles *against* the ABI, tension-core
//! *implements* it.
//!
//! Host ABI (module `tension::io`):
//!   print(ptr, len)          write exactly `len` UTF-8 bytes at `ptr` to
//!                            stdout (no newline appended — the SDK owns the
//!                            line terminator)
//!   read_line(ptr, cap)      read one line (terminator stripped):
//!                            cap <= 0 probes the next line's byte length
//!                            without consuming it; cap > 0 consumes the
//!                            line, writes min(cap, len) bytes, and returns
//!                            len. -1 on EOF, 0 for an empty line.
//!   arg_count() -> i32       number of extra CLI args passed to the game
//!   arg(i, ptr, cap) -> i32  write arg i as UTF-8 into buffer, return byte
//!                            count (or -1 if out of range). cap==0 probes size.
//!
//! `read_line` is the ABI's first stateful call: a probe parks the pending
//! line in `HostState::pending_line`. Probes are idempotent until the line
//! is consumed (repeated probes return the same length and never advance
//! stdin), and a probed-but-never-consumed line stays buffered for the
//! store's lifetime — there is no discard API. Future host designs
//! (multi-guest, VM resume) must account for per-guest pending-line state.
//!
//! Command line:
//!   tension-core [options] <game.wasm> [game args...]
//!
//! `--debug` turns on guest debug info (`Config::debug_info`) and reports what
//! a debugger can see of the loaded guest; `--symbol-path <PATH>` (repeatable)
//! says where the debugger should look for the guest's symbols and sources.
//! See the `debug` module for why an AssemblyScript guest carries no source
//! lines even with both.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use wasmtime::{Caller, Config, Engine, Linker, Module, Store};

mod ai;
mod audio;
mod debug;
mod dwarf;

/// The AI adapter the CLI uses. Feature `ai` selects the real in-process
/// llama.cpp adapter; otherwise the deterministic headless stub (the
/// contract reference and the test adapter).
#[cfg(feature = "ai")]
fn default_ai_adapter() -> Box<dyn ai::AiAdapter> {
    Box::new(ai::llama::LlamaAdapter::new())
}

#[cfg(not(feature = "ai"))]
fn default_ai_adapter() -> Box<dyn ai::AiAdapter> {
    Box::new(ai::stub::StubAdapter::new())
}

/// The adapter the CLI uses. The default build (feature `audio`) plays
/// through the system device; `--no-default-features` falls back to the
/// headless WAV adapter (the contract reference and test adapter).
#[cfg(feature = "audio")]
fn default_adapter() -> Box<dyn audio::AudioAdapter> {
    Box::new(audio::real::RealAdapter::new())
}

#[cfg(not(feature = "audio"))]
fn default_adapter() -> Box<dyn audio::AudioAdapter> {
    Box::new(audio::headless::HeadlessAdapter::new())
}

/// State stored alongside the Wasm store: the game's CLI arguments, plus the
/// line parked by a `read_line` probe (`cap <= 0`) and not yet consumed.
/// `read_line` is the ABI's only stateful call; see the doc header.
struct HostState {
    args: Vec<String>,
    pending_line: Option<Vec<u8>>,
    audio: audio::AudioSession,
    ai: ai::AiSession,
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

const USAGE: &str = r"usage: tension-core [options] <game.wasm> [game args...]

options:
  --debug                turn on guest debug info (`Config::debug_info`) and report
                         what a debugger can see of the loaded guest
  --symbol-path <PATH>   where the debugger should look for the guest's symbols
                         and sources; repeatable
  -h, --help             print this help
  -V, --version          print the version
  --                     end options: the next argument is <game.wasm>

Options must precede <game.wasm>; everything after it is passed to the game
verbatim (that is what the guest's `tension::io arg()` hands back).";

/// The parsed command line. See `USAGE` for the contract.
struct Cli {
    debug: bool,
    symbol_paths: Vec<PathBuf>,
    wasm_path: String,
    args: Vec<String>,
}

/// Parse the arguments that follow the program name.
///
/// The first non-option argument is the guest; everything from there on belongs
/// to the game, so a game argument that happens to read `--debug` is still the
/// game's. Options are only recognised ahead of the guest path.
fn parse_cli(argv: Vec<String>) -> Result<Cli, String> {
    let mut debug = false;
    let mut symbol_paths = Vec::new();
    let mut wasm_path = None;
    let mut rest = argv.into_iter();
    while wasm_path.is_none() {
        let Some(arg) = rest.next() else { break };
        if let Some(value) = arg.strip_prefix("--symbol-path=") {
            symbol_paths.push(PathBuf::from(value));
            continue;
        }
        match arg.as_str() {
            "--debug" => debug = true,
            "--symbol-path" => {
                let value = rest.next().ok_or("`--symbol-path` needs a path")?;
                symbol_paths.push(PathBuf::from(value));
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("tension-core {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--" => wasm_path = rest.next(),
            // A lone `-` is taken as a path; anything longer that starts with a
            // dash is a typo, and must not be handed to the loader as a file.
            other if other.len() > 1 && other.starts_with('-') => {
                return Err(format!("unknown option `{other}`"));
            }
            other => wasm_path = Some(other.to_string()),
        }
    }
    let wasm_path = wasm_path.ok_or("missing <game.wasm>")?;
    Ok(Cli {
        debug,
        symbol_paths,
        wasm_path,
        args: rest.collect(),
    })
}

fn main() -> anyhow::Result<()> {
    let cli = match parse_cli(std::env::args().skip(1).collect()) {
        Ok(cli) => cli,
        Err(err) => {
            eprintln!("tension-core: {err}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    // A path that does not exist is a typo the debugger would otherwise report
    // only as a breakpoint that never resolves, so it fails here instead.
    for path in &cli.symbol_paths {
        if !path.exists() {
            eprintln!(
                "tension-core: --symbol-path {} does not exist\n\n{USAGE}",
                path.display()
            );
            std::process::exit(2);
        }
    }
    if !std::path::Path::new(&cli.wasm_path).exists() {
        eprintln!(
            "tension-core: {} does not exist\n\n{USAGE}",
            cli.wasm_path
        );
        std::process::exit(2);
    }

    // `--debug` is the whole host-side switch; see `debug` for what it can and
    // cannot buy. The report runs before the load so a guest that fails to load
    // still shows what was being asked of it.
    // Synthesized guest DWARF, when `--debug` managed to produce any. `None`
    // means the module is loaded from disk exactly as it always was.
    let mut augmented: Option<Vec<u8>> = None;
    if cli.debug {
        let guest = std::path::Path::new(&cli.wasm_path);
        let info = debug::probe(guest);
        debug::report(guest, &info, &cli.symbol_paths);
        augmented = match dwarf::augment(guest, &cli.symbol_paths) {
            dwarf::AugmentResult::Augmented(bytes) => Some(bytes),
            dwarf::AugmentResult::Unchanged(reason) => {
                eprintln!("[tension-core] debug: {reason}");
                None
            }
            dwarf::AugmentResult::Failed(err) => {
                eprintln!("[tension-core] debug: {err}; running the game unchanged");
                None
            }
        };
    }

    // With this on, wasmtime keeps the guest's DWARF and registers the JIT'd
    // code with the platform debugger through the GDB JIT interface — which is
    // what lldb's `plugin.jit-loader.gdb.enable on` picks up. Registration
    // happens as the module is compiled, before `_start_game` runs, so a
    // debugger that launches this process can have breakpoints in place first.
    let mut config = Config::new();
    config.debug_info(cli.debug);
    let engine = Engine::new(&config)?;
    let module = match &augmented {
        Some(bytes) => Module::new(&engine, bytes)?,
        None => Module::from_file(&engine, &cli.wasm_path)?,
    };

    let mut store = Store::new(
        &engine,
        HostState {
            args: cli.args,
            pending_line: None,
            audio: audio::AudioSession::new(default_adapter()),
            ai: ai::AiSession::new(default_ai_adapter()),
        },
    );
    let mut linker: Linker<HostState> = Linker::new(&engine);

    // tension::io ABI -----------------------------------------------------
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
            // Ensure a line is pending: read from stdin if nothing is
            // buffered. EOF with nothing pending means no line is available.
            {
                let state = caller.data_mut();
                if state.pending_line.is_none() {
                    let mut line = String::new();
                    let n = io::stdin().lock().read_line(&mut line).unwrap_or(0);
                    if n == 0 {
                        return -1; // EOF, nothing pending
                    }
                    while line.ends_with('\n') || line.ends_with('\r') {
                        line.pop();
                    }
                    state.pending_line = Some(line.into_bytes());
                }
            }
            // Probe (cap <= 0): return the pending line's length without
            // consuming it. Probes are idempotent until a consuming call.
            if cap <= 0 {
                let state = caller.data();
                return state
                    .pending_line
                    .as_ref()
                    .expect("pending_line ensured above")
                    .len() as i32;
            }
            // Consume (cap > 0): take the line, write min(cap, len) bytes
            // (clamped to guest memory, same pattern as `arg`), return len.
            let line = caller
                .data_mut()
                .pending_line
                .take()
                .expect("pending_line ensured above");
            let to_write = line.len().min(cap as usize);
            if to_write > 0 {
                let mem = caller
                    .get_export("memory")
                    .and_then(|e| e.into_memory())
                    .expect("game must export a memory named 'memory'");
                let data = mem.data_mut(&mut caller);
                let start = ptr as usize;
                let start = start.min(data.len());
                let end = (start + to_write).min(data.len());
                data[start..end].copy_from_slice(&line[..(end - start)]);
            }
            line.len() as i32
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

    // tension::audio ABI --------------------------------------------------
    audio::link_audio(&mut linker)?;

    // tension::ai ABI -----------------------------------------------------
    ai::link_ai(&mut linker)?;

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
