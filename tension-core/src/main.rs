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
//! Host ABI (module `tension::res`, DESIGN.md §7):
//!   res_open(path_ptr, path_len) -> fd | -errno
//!   res_close(fd) -> 0 | -errno
//!   res_read(fd, ptr, len) -> n | 0 | -errno
//!   res_seek(fd, off, whence) -> pos | -errno      (whence 0=SET 1=CUR 2=END)
//!   res_tell(fd) -> pos | -errno
//!   res_stat(path_ptr, path_len, out_ptr) -> 0 | -errno
//!   res_stat_fd(fd, out_ptr) -> 0 | -errno
//!   res_readdir(path_ptr, path_len, index, name_ptr, name_cap, out_ptr)
//!       -> name_len | 0 (end) | -errno
//!
//! Paths cross as UTF-8 (ptr, len); `out_ptr` receives the 12-byte
//! {kind, size, flags} record; errors are negative POSIX errno values. Guest
//! fds pack the owning pak's index (each pak has its own fd table, but the
//! guest sees one namespace), so an fd is `(set << 16) | local`.
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
use tension_core::res::{self, ResourceSet, Stat};
use wasmtime::{Caller, Config, Engine, ExternType, Linker, Memory, Module, Store};

/// The adapter ABI: loading a capability adapter, driving its lifecycle, and
/// installing the imports it registers (`tension-ogre/DESIGN.md` §7). The run
/// path below loads, links, and hands the session what the adapters declared.
mod adapter;
mod ai;
mod audio;
mod debug;
mod dwarf;
pub(crate) mod leb;
/// The session component: it owns the arena memory the guest imports and the
/// two verbs that open and close a session (`tension-ogre/DESIGN.md` §4–§6).
mod session;
mod solver;

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
    /// The loaded resource paks, in load order: `--res` merges them into one
    /// namespace, first match wins (§7.2). Each owns its bytes (1x memory).
    res: Vec<ResourceSet<'static>>,
    audio: audio::AudioSession,
    ai: ai::AiSession,
    /// The `tension::solver` host side: wasm-source bindings keyed by the
    /// shim's solver id (solver/mod.rs). Per store, like everything here.
    solver: solver::SolverHost,
    /// The posting face: the queues an adapter thread writes into through
    /// `post_event`, and the source of what the epoch publishes (`DESIGN.md`
    /// §3.2–§3.4). Shared with the adapter host by `Arc`, and separate from
    /// `session` on purpose: the verbs take the session out of the store for
    /// the duration of a call, and the epoch will need this while they have it.
    /// The arena memory, reachable without the session. The epoch runs *inside*
    /// a verb, and the verbs take the session out of the store — so `guest_write`
    /// and the epoch's own arena writes look here, not through `session`.
    arena: Option<Memory>,
    /// How deep the session is inside callback invocations. Host-side, not in
    /// the arena: it is the re-entrancy guard a callback's `session_wait` hits
    /// (`DESIGN.md` §6.3), and a guest that writes the arena cannot clear it.
    depth: u32,
    /// Deferred submissions: what a `queue_*` verb copied out of a callback, and
    /// what the next epoch's apply phase drains. Host-side, never in the arena,
    /// and never cleared by a trap (R7) — a fault leaves the work where it is.
    pending: session::apply::PendingQueue,
    /// The loaded adapters, in registration order: what the epoch's publish
    /// phase calls, and in what order (`DESIGN.md` §3.3).
    adapters: Vec<adapter::AdapterCall>,
    posting: std::sync::Arc<session::posting::PostingSide>,
    /// The session: it owns the arena memory and the open/close verbs.
    ///
    /// `Option` because the memory can only be created *from* a store, and this
    /// struct is what that store is built with — the session is created right
    /// after the store and installed before instantiation, once. A verb that
    /// finds it `None` returns `-EBADF` rather than panicking.
    session: Option<session::Session>,
}

/// Guest fds are `(pak index << 16) | that pak's fd`, so a guest handle stays
/// unambiguous even though every `ResourceSet` numbers its own handles from 1.
const FD_SET_SHIFT: i32 = 16;
const FD_LOCAL_MASK: i32 = 0xFFFF;

const ENOENT: i32 = -2;
const EBADF: i32 = -9;
const EINVAL: i32 = -22;

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

const PACK_USAGE: &str = r#"usage: tension-core pack <source-dir> [-o output.pak]

Pack a directory tree into an ECMA-208 (SIDF) resource pak. The default output
path is <source-dir>.pak. The layout is documented in tension-res/DESIGN.md
§8.2; packing the same tree twice produces byte-identical output."#;

const USAGE: &str = r#"usage: tension-core [options] <game.wasm> [game args...]
       tension-core pack <source-dir> [-o output.pak]

options:
  --debug                turn on guest debug info (`Config::debug_info`) and report
                         what a debugger can see of the loaded guest
  --symbol-path <PATH>   where the debugger should look for the guest's symbols
                         and sources; repeatable
  --res <PAK>            load an ECMA-208 resource pak; repeatable, and every
                         pak merges into one namespace rooted at "/"
  --capability <CAP>     load a capability adapter; repeatable. A value that
                         names an existing file is that file; anything else is
                         a name resolved as <dir>/libtension_<name>.so through
                         TENSION_CAPABILITY_PATH (colon-separated directories)
  --session-open         A1 test-only: open the session from the host before
                         `_start_game`, for a guest that does not call
                         `session_open` itself. Real guests open their own
                         session; this flag exists so an A1 fixture needs no
                         config blob, and it will go when the guest SDK lands
  --session-callbacks <BATCH>[,<EVENT>]
                         A2 test-only: like --session-open, and also register
                         the guest function table's slot BATCH as `onBatch` (and
                         EVENT as `onEvent`). 0 or an absent value means "no
                         callback for that slot"
  --post-test-events     A2 test-only: post three JOB_DONE events before
                         `_start_game`, so an epoch fixture has something to
                         deliver
  -h, --help             print this help
  -V, --version          print the version
  --                     end options: the next argument is <game.wasm>

Options must precede <game.wasm>; everything after it is passed to the game
verbatim (that is what the guest's `tension::io arg()` hands back)."#;

/// The parsed `pack` subcommand.
#[derive(Debug, PartialEq, Eq)]
struct PackCli {
    source: PathBuf,
    out: PathBuf,
}

/// Parse the arguments of `tension-core pack` (everything after `pack`).
fn parse_pack_cli(argv: Vec<String>) -> Result<PackCli, String> {
    let mut source = None;
    let mut out = None;
    let mut rest = argv.into_iter();
    while let Some(arg) = rest.next() {
        if let Some(value) = arg.strip_prefix("--out=").or_else(|| arg.strip_prefix("-o=")) {
            out = Some(PathBuf::from(value));
            continue;
        }
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{PACK_USAGE}");
                std::process::exit(0);
            }
            "-o" | "--out" => {
                out = Some(PathBuf::from(rest.next().ok_or("`-o` needs a path")?));
            }
            other if other.len() > 1 && other.starts_with('-') => {
                return Err(format!("unknown option `{other}`"));
            }
            other => {
                if source.is_some() {
                    return Err("only one source directory is packed at a time".to_string());
                }
                source = Some(PathBuf::from(other));
            }
        }
    }
    let source: PathBuf = source.ok_or("missing <source-dir>")?;
    let out = out.unwrap_or_else(|| PathBuf::from(format!("{}.tns", source.display())));
    Ok(PackCli { source, out })
}

/// The `pack` subcommand. Routes through the C ABI, never around it.
fn run_pack(cli: PackCli) -> anyhow::Result<()> {
    match tension_core::res::pack(&cli.source, &cli.out) {
        Ok(message) => {
            let detail = if message.is_empty() {
                String::new()
            } else {
                format!(" ({message})")
            };
            println!("packed {} -> {}{detail}", cli.source.display(), cli.out.display());
            Ok(())
        }
        Err(e) => {
            eprintln!("tension-core pack: {e}");
            std::process::exit(1);
        }
    }
}

/// The parsed command line. See `USAGE` for the contract.
#[derive(Debug)]
struct Cli {
    debug: bool,
    symbol_paths: Vec<PathBuf>,
    res_paths: Vec<PathBuf>,
    /// Capability adapters to load: a path, or a bare name resolved through
    /// `TENSION_CAPABILITY_PATH` (`DESIGN.md` §7, r2 decision 3).
    capability_paths: Vec<String>,
    /// A1 test-only: open the session from the host before `_start_game`.
    session_open: bool,
    /// A2 test-only: open with these table slots registered as callbacks.
    /// `Some` implies the host open, because a host-registered callback has no
    /// other way to reach the session.
    session_callbacks: Option<(u32, u32)>,
    /// A2 test-only: post three JOB_DONE events before `_start_game`.
    post_test_events: bool,
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
    let mut res_paths = Vec::new();
    let mut capability_paths = Vec::new();
    let mut session_open = false;
    let mut session_callbacks: Option<(u32, u32)> = None;
    let mut post_test_events = false;
    let mut wasm_path = None;
    let mut rest = argv.into_iter();
    while wasm_path.is_none() {
        let Some(arg) = rest.next() else { break };
        if let Some(value) = arg.strip_prefix("--symbol-path=") {
            symbol_paths.push(PathBuf::from(value));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--res=") {
            res_paths.push(PathBuf::from(value));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--capability=") {
            capability_paths.push(value.to_string());
            continue;
        }
        if let Some(value) = arg.strip_prefix("--session-callbacks=") {
            session_callbacks = Some(parse_callback_slots(value)?);
            continue;
        }
        match arg.as_str() {
            "--debug" => debug = true,
            "--session-open" => session_open = true,
            "--post-test-events" => post_test_events = true,
            "--session-callbacks" => {
                let value = rest
                    .next()
                    .ok_or("`--session-callbacks` needs a table slot (or two)")?;
                session_callbacks = Some(parse_callback_slots(&value)?);
            }
            "--symbol-path" => {
                let value = rest.next().ok_or("`--symbol-path` needs a path")?;
                symbol_paths.push(PathBuf::from(value));
            }
            "--res" => {
                let value = rest.next().ok_or("`--res` needs a pak path")?;
                res_paths.push(PathBuf::from(value));
            }
            "--capability" => {
                let value = rest.next().ok_or("`--capability` needs a path or a name")?;
                capability_paths.push(value);
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
        res_paths,
        capability_paths,
        session_open,
        session_callbacks,
        post_test_events,
        wasm_path,
        args: rest.collect(),
    })
}

fn main() -> anyhow::Result<()> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(|a| a == "pack").unwrap_or(false) {
        argv.remove(0);
        let cli = match parse_pack_cli(argv) {
            Ok(cli) => cli,
            Err(err) => {
                eprintln!("tension-core: {err}\n\n{PACK_USAGE}");
                std::process::exit(2);
            }
        };
        return run_pack(cli);
    }
    if argv.first().map(|a| a == "layout-hash").unwrap_or(false) {
        // The arena's shape hash, for the AS build pipeline: `session.json` and
        // the generated `layout.ts` carry it, and this is where it comes from
        // (`tension-framework/build.sh --hash`, which refuses a disagreement).
        println!("{}", session::arena::layout_hash());
        return Ok(());
    }
    let cli = match parse_cli(argv) {
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

    // The guest's bytes, read once and used for both the load-time checks and
    // the module itself. `Module::new` takes the text format as well as the
    // binary one, so a hand-written `.wat` fixture loads the way a compiled
    // `game.wasm` does (§7 Appendix B's smoke path).
    let guest_bytes = match augmented.take() {
        Some(bytes) => bytes,
        None => std::fs::read(&cli.wasm_path)
            .map_err(|e| anyhow::anyhow!("{}: {e}", cli.wasm_path))?,
    };
    // A malformed guest is reported with the file's name in front of wasmtime's
    // own parse error: `Module::new` does not know where the bytes came from,
    // and "expected a module" with no path in it is a bad diagnostic.
    let module = Module::new(&engine, &guest_bytes)
        .map_err(|e| anyhow::anyhow!("{}: {e}", cli.wasm_path))?;
    check_guest_module(&module, &guest_bytes, &cli.wasm_path)?;

    // Resource paks: loaded and validated before the guest runs, so a bad path
    // or a malformed volume is reported here rather than as a mysterious miss
    // at runtime. `load_file` keeps one copy of each pak (DESIGN.md §9.2).
    let mut resource_sets: Vec<ResourceSet<'static>> = Vec::with_capacity(cli.res_paths.len());
    for path in &cli.res_paths {
        let set = ResourceSet::load_file(path)
            .map_err(|e| anyhow::anyhow!("--res {}: {e}", path.display()))?;
        resource_sets.push(set);
    }
    // §7.2: the paks merge into one namespace, so two of them providing the
    // same path is a load-time error rather than a silent first-match. The
    // check costs one enumeration per pak, and nothing at lookup time.
    {
        let all: Vec<&ResourceSet<'static>> = resource_sets.iter().collect();
        if let Err(err) = check_pak_conflicts(&all) {
            eprintln!("tension-core: {err}");
            std::process::exit(2);
        }
    }

    let mut store = Store::new(
        &engine,
        HostState {
            args: cli.args,
            pending_line: None,
            res: resource_sets,
            audio: audio::AudioSession::new(default_adapter()),
            ai: ai::AiSession::new(default_ai_adapter()),
            solver: solver::SolverHost::default(),
            posting: std::sync::Arc::new(session::posting::PostingSide::default()),
            arena: None,
            depth: 0,
            pending: session::apply::PendingQueue::new(),
            adapters: Vec::new(),
            session: None,
        },
    );

    // tension::session ----------------------------------------------------
    // The session owns the arena memory, so it is created before anything is
    // linked and its arena is prepared before instantiation: the guest's data
    // segments land on a band the session already zeroed and canary-laid, which
    // is what makes `verify_post_instantiate` below a complete check.
    let mut session = session::Session::create_from_module(&mut store, &module)?;
    session.prepare_arena(&mut store)?;
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

    // tension::res ABI ----------------------------------------------------
    // The read-only resource VFS (tension-res, ECMA-208 SIDF). Every call is
    // strict: a path that does not resolve in any loaded pak is -ENOENT, and
    // the framework layer is what turns that into null/[] for the guest (§7).
    linker.func_wrap(
        "tension::res",
        "res_open",
        |mut caller: Caller<'_, HostState>, path_ptr: i32, path_len: i32| -> i32 {
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            match resolve_set(&caller.data().res, |set| set.open_fd(&path)) {
                Ok((index, fd)) => pack_fd(index, fd),
                Err(e) => e.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_close",
        |caller: Caller<'_, HostState>, fd: i32| -> i32 {
            let Some((index, local)) = fd_index(fd) else {
                return EBADF;
            };
            let Some(set) = caller.data().res.get(index) else {
                return EBADF;
            };
            match set.close_fd(local) {
                Ok(()) => 0,
                Err(e) => e.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_read",
        |mut caller: Caller<'_, HostState>, fd: i32, ptr: i32, len: i32| -> i32 {
            if len < 0 {
                return EINVAL;
            }
            let Some((index, local)) = fd_index(fd) else {
                return EBADF;
            };
            let want = len as usize;
            let mut copied: usize = 0;
            let mut chunk = [0u8; 4096];
            while copied < want {
                let step = (want - copied).min(chunk.len());
                let outcome = match caller.data().res.get(index) {
                    Some(set) => set.read_fd(local, &mut chunk[..step]),
                    None => return EBADF,
                };
                match outcome {
                    Ok(0) => break,
                    Ok(n) => {
                        if !write_guest(&mut caller, ptr + copied as i32, &chunk[..n]) {
                            return EINVAL;
                        }
                        copied += n;
                        if n < step {
                            break;
                        }
                    }
                    // Bytes already handed over are the guest's; the error is
                    // only reported when nothing was delivered.
                    Err(e) => {
                        return if copied > 0 { copied as i32 } else { e.code() };
                    }
                }
            }
            copied as i32
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_seek",
        |caller: Caller<'_, HostState>, fd: i32, off: i64, whence: i32| -> i64 {
            let Some((index, local)) = fd_index(fd) else {
                return EBADF as i64;
            };
            let Some(set) = caller.data().res.get(index) else {
                return EBADF as i64;
            };
            match set.seek_fd(local, off, whence) {
                Ok(pos) => pos,
                Err(e) => e.code() as i64,
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_tell",
        |caller: Caller<'_, HostState>, fd: i32| -> i64 {
            let Some((index, local)) = fd_index(fd) else {
                return EBADF as i64;
            };
            let Some(set) = caller.data().res.get(index) else {
                return EBADF as i64;
            };
            match set.tell_fd(local) {
                Ok(pos) => pos,
                Err(e) => e.code() as i64,
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_stat",
        |mut caller: Caller<'_, HostState>, path_ptr: i32, path_len: i32, out_ptr: i32| -> i32 {
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            match resolve_set(&caller.data().res, |set| set.stat(&path)) {
                Ok((_, stat)) => {
                    if write_stat(&mut caller, out_ptr, &stat) {
                        0
                    } else {
                        EINVAL
                    }
                }
                Err(e) => e.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_stat_fd",
        |mut caller: Caller<'_, HostState>, fd: i32, out_ptr: i32| -> i32 {
            let Some((index, local)) = fd_index(fd) else {
                return EBADF;
            };
            let outcome = match caller.data().res.get(index) {
                Some(set) => set.stat_fd(local),
                None => return EBADF,
            };
            match outcome {
                Ok(stat) => {
                    if write_stat(&mut caller, out_ptr, &stat) {
                        0
                    } else {
                        EINVAL
                    }
                }
                Err(e) => e.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_readdir",
        |mut caller: Caller<'_, HostState>,
         path_ptr: i32,
         path_len: i32,
         index: i32,
         name_ptr: i32,
         name_cap: i32,
         out_ptr: i32|
         -> i32 {
            if index < 0 {
                return EINVAL;
            }
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            let entry = match resolve_set(&caller.data().res, |set| {
                set.read_dir_at(&path, index as u32)
            }) {
                Ok((_, Some(entry))) => entry,
                Ok((_, None)) => return 0, // past the last child
                Err(e) => return e.code(),
            };
            if !write_stat(&mut caller, out_ptr, &entry.stat) {
                return EINVAL;
            }
            let bytes = entry.name.as_bytes();
            let cap = name_cap.max(0) as usize;
            if cap > 0 {
                let n = bytes.len().min(cap);
                if !write_guest(&mut caller, name_ptr, &bytes[..n]) {
                    return EINVAL;
                }
            }
            // The `arg` convention: min(cap, len) written, full length back.
            bytes.len() as i32
        },
    )?;

    // tension::audio ABI --------------------------------------------------
    audio::link_audio(&mut linker)?;

    // tension::ai ABI -----------------------------------------------------
    ai::link_ai(&mut linker)?;

    // tension::solver ABI -------------------------------------------------
    // The five guest imports (GUEST_ABI.md), plus the wasm-source binding
    // path: the host resolves the guest's `_derivative` / `deriv_buf_in` /
    // `deriv_buf_out` exports at create and performs the bind itself.
    solver::link_solver(&mut linker)?;

    // tension::session ABI -------------------------------------------------
    // The memory is defined under both import names (the AssemblyScript
    // toolchain emits `env::memory`; Tension documents `session::memory`), the
    // two verbs are registered, and the session is installed into the store —
    // the verbs reach it through `caller.data()`, so it must be there before the
    // guest can run.
    session.install(&mut store, &mut linker)?;
    session::link_session(&mut linker)?;
    // The verbs take the session out of the store, so the arena is also kept
    // where it can be reached without it: `guest_write` during a publish hook,
    // and the epoch's own writes, all need it while a verb holds the session.
    store.data_mut().arena = Some(session.memory());
    store.data_mut().session = Some(session);

    // Capability adapters --------------------------------------------------
    // Loaded before instantiation because `link` is what registers the imports
    // the guest may call, and because `region_lookup` answers from the frozen
    // layout — safe with no arena in sight (§7.2). Nothing loads unless
    // `--capability` (or `TENSION_CAPABILITY_PATH`) asks for it, so a plain run
    // is byte-for-byte the run it always was.
    let capability_paths = resolve_capability_paths(&cli.capability_paths)?;
    let mut adapters: Vec<adapter::LoadedAdapter> = Vec::with_capacity(capability_paths.len());
    for path in &capability_paths {
        match adapter::load_adapter(path) {
            Ok(loaded) => {
                eprintln!(
                    "[tension-core] capability `{}` loaded from {}",
                    loaded.name(),
                    path.display()
                );
                adapters.push(loaded);
            }
            Err(error) => anyhow::bail!("--capability {}: {error}", path.display()),
        }
    }
    // The host must outlive every call the imports make, so it lives here, in
    // `main`'s frame, for as long as the linker does. It carries a clone of the
    // posting face, which is what an adapter thread reaches through
    // `post_event` with no borrow of the store at all.
    let adapter_host = adapter::AdapterHost::new(std::sync::Arc::clone(
        &store.data().posting,
    ));
    if !adapters.is_empty() {
        adapter::link_adapters(&mut linker, &mut adapters, adapter_host.api())?;
    }
    // What the epoch's publish phase calls, in registration order. The vtables
    // stay valid because `adapters` (and the libraries it holds open) lives in
    // this frame, which outlives every epoch.
    store.data_mut().adapters = adapter::adapter_calls(&adapters, adapter_host.api());
    // What each adapter asked about at `link` is what it requires of the arena
    // (§7.2): the query *is* the declaration, and `session_open` is where it is
    // enforced. Handing the set over before instantiation is what makes the
    // guest's own `session_open` the check point.
    let required: Vec<session::RegionNeed> = adapters
        .iter()
        .flat_map(|loaded| {
            let name = loaded.name().to_string();
            loaded.required_regions().iter().map(move |kind| session::RegionNeed {
                kind: *kind,
                adapter: name.clone(),
            })
        })
        .collect();
    if let Some(session) = store.data_mut().session.as_mut() {
        session.set_required_regions(required);
    }

    let instance = linker.instantiate(&mut store, &module)?;

    // The arena as the session left it, before the guest's first instruction:
    // the control block's triple, the region band's zeros, and the gap's canary
    // lattice (DESIGN.md §11 step 2).
    if let Some(session) = store.data().session.as_ref() {
        session.verify_post_instantiate(&store)?;
    }

    // AssemblyScript's runtime initializer, when the guest exports one.
    //
    // The SDK builds with `--exportStart __start` so this is an export rather
    // than a `start` section: a start section would run guest code at
    // instantiation, before the arena had been verified, which is why the
    // load-time check refuses one. Calling it here is the order the design asks
    // for — verify the arena, initialize the runtime, then run the game.
    if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "__start") {
        init.call(&mut store, ())?;
    }

    // `--session-open`: A1's convenience, and *only* a flag. A1 has no guest SDK
    // yet, so a fixture cannot carry the config blob a real session guest sends;
    // with this on, the host performs the same open the verb performs — the
    // arena is READY before `_start_game`, and a guest that then called
    // `session_open` itself would be refused with `-EBUSY`, which is exactly why
    // the real path does not do this.
    if cli.session_open || cli.session_callbacks.is_some() {
        let (on_batch, on_event) = cli.session_callbacks.unwrap_or((0, 0));
        // The record the guest would have written, built here because the host
        // is doing the opening; its slots are resolved against the guest's own
        // exported table, which is what makes them callable.
        let record = session::arena::CallbacksRecord {
            abi_version: session::arena::ABI_VERSION,
            slot_count: session::arena::CALLBACKS_SLOTS,
            flags: 0,
            on_batch,
            on_event,
        };
        let resolved = if on_batch == 0 && on_event == 0 {
            session::ResolvedCallbacks::default()
        } else {
            let table = instance.get_table(&mut store, "table");
            if table.is_none() {
                anyhow::bail!(
                    "--session-callbacks: the guest exports no `table`, so a slot index \
                     has nothing to resolve against"
                );
            }
            match session::Session::resolve_callbacks(&mut store, table.as_ref(), &record) {
                Ok(resolved) => resolved,
                Err(error) => anyhow::bail!("--session-callbacks: {error}"),
            }
        };

        let Some(mut session) = store.data_mut().session.take() else {
            anyhow::bail!("--session-open: no session is installed");
        };
        let memory = session.memory();
        // The smallest legal arena inside the default ceiling: the two numbers
        // the config tests use, and the shape that exercises `arena_size <
        // max_arena_size` rather than the degenerate equality.
        let arena_size = session::arena::LAYOUT_FLOOR as u32;
        let max_arena_size = session.max_arena_size();
        let outcome = {
            let arena_bytes = memory.data_mut(&mut store);
            session.open_from_host_with_callbacks(
                arena_bytes,
                arena_size,
                max_arena_size,
                &record,
                resolved,
            )
        };
        match outcome {
            Ok(()) => eprintln!(
                "[tension-core] host open: arena {arena_size}, ceiling {max_arena_size}, \
                 callbacks onBatch={on_batch} onEvent={on_event}"
            ),
            Err(error) => {
                store.data_mut().session = Some(session);
                anyhow::bail!("--session-open: {error}");
            }
        }
        store.data_mut().session = Some(session);
    }

    // `--post-test-events`: three JOB_DONE events, so an epoch fixture has
    // something to deliver when it waits. Posted through the posting face
    // directly — this is the host, not an adapter — and before the guest runs,
    // so the wait finds them queued rather than having to race a producer.
    if cli.post_test_events {
        let posting = store.data().posting.clone();
        for index in 0..3u32 {
            match posting.post(
                1,
                session::arena::CLASS_JOB_DONE,
                0,
                1 + index * 2,
                2 + index * 2,
                1.5,
                0.25,
            ) {
                Ok(seq) => eprintln!(
                    "[tension-core] --post-test-events: JOB_DONE a={} b={} seq={seq}",
                    1 + index * 2,
                    2 + index * 2
                ),
                Err(error) => anyhow::bail!("--post-test-events: {error}"),
            }
        }
    }

    // Entrypoint: prefer the Tension-specific `_start_game`, else WASI `_start`.
    if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start_game") {
        func.call(&mut store, ())?;
    } else if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start") {
        func.call(&mut store, ())?;
    } else {
        anyhow::bail!("game.wasm did not export `_start_game` or `_start`");
    }

    // What a trapping epoch left behind: a deferred submission belongs to the
    // session, not to the callback that queued it (R7), so the host reports what
    // is still pending rather than quietly dropping it.
    let pending_left = store.data().pending.len();
    if pending_left > 0 {
        eprintln!(
            "[tension-core] pending after the guest: {pending_left} submission(s) (R7: the \
             queue survives a trap and is applied at the guest's next epoch)"
        );
    }

    // The guest owns the session, but a guest that returns without closing it
    // leaves the arena reporting READY. Close what the guest did not, so the
    // process never exits with a session that looks live: `session_close` is
    // idempotent, so a guest that closed properly sees a no-op.
    if let Some(mut session) = store.data_mut().session.take() {
        if session.state() == session::SessionState::Ready {
            let memory = session.memory();
            let arena_bytes = memory.data_mut(&mut store);
            if let Err(error) = session.close(arena_bytes) {
                eprintln!("[tension-core] session_close after the guest returned: {error}");
            }
        }
        store.data_mut().session = Some(session);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// guest load-time checks
// ---------------------------------------------------------------------------

/// The checks that must pass on the guest's own structure before anything is
/// instantiated (`DESIGN.md` §4, §11).
///
/// There were three in the round's list; two are here, because the third is
/// already enforced: a module that imports `session::*` but declares no memory
/// import is refused by [`session::Session::create_from_module`], whose whole
/// rule is that the memory import is *mandatory* — so that case never reaches a
/// second check with a different message, and the message it does get names the
/// fix (`every session guest must import it as env::memory or session::memory`).
///
/// The remaining two are the ones nothing else can see:
///
/// - a module that imports a memory but does not re-export it as `memory`. The
///   host ABI reaches guest memory through `Instance::get_export("memory")`, so
///   without the re-export the first `tension::io` call panics on an `expect`
///   and the process aborts — a load-time bail with the fix in it is strictly
///   better than that.
/// - a module with a `start` section. The session verifies the arena between
///   `instantiate` and `_start_game`; a start section would run guest code
///   *before* that verification, which is exactly the window the check exists to
///   protect.
fn check_guest_module(module: &Module, bytes: &[u8], path: &str) -> anyhow::Result<()> {
    let mut imports_session = false;
    let mut imports_memory = false;
    for import in module.imports() {
        if import.module() == "session" {
            imports_session = true;
        }
        if matches!(import.ty(), ExternType::Memory(_)) {
            imports_memory = true;
        }
    }

    // The ninth verb a session guest needs is the memory itself: a module that
    // speaks the session's protocol but brought no arena is refused here, in
    // those words, rather than by the page-count machinery. (The rule that
    // *every* guest here must import a memory is `Session::create_from_module`'s
    // — this check is the more specific message for the case where the guest
    // clearly meant to be a session guest.)
    if imports_session && !imports_memory {
        anyhow::bail!(
            "{path} imports `session::*` but declares no memory import; the session owns the \
             arena, so it must be imported as env::memory or session::memory"
        );
    }

    if imports_memory {
        // The export must be a *memory*: an export named `memory` of another
        // kind would still make `into_memory()` return `None` and the expect
        // panic, so the kind is part of the check rather than the name alone.
        let exports_memory = module
            .exports()
            .any(|export| export.name() == "memory" && matches!(export.ty(), ExternType::Memory(_)));
        if !exports_memory {
            anyhow::bail!(
                "{path} imports a memory but does not re-export it as `memory`: the host \
                 reaches guest memory through `get_export(\"memory\")`, so the module needs \
                 `(export \"memory\" (memory 0))`"
            );
        }
    }

    if declares_start_section(bytes) {
        anyhow::bail!(
            "{path} declares a `start` section, which runs guest code at instantiation — \
             before the session verifies the arena. Put that work at the top of `_start_game` \
             instead (the session verifies between instantiation and that call)"
        );
    }
    Ok(())
}

/// The wasm section id of the `start` section.
const WASM_SECTION_START: u8 = 8;

/// Whether the module declares a `start` section.
///
/// `wasmtime::Module` exposes imports, exports and custom sections but no
/// accessor for `start`, so the binary is walked here: the magic and version,
/// then `(id, size)` pairs through the repo's own LEB reader. A malformed module
/// answers `false` and is left to `Module::new`, which reports it with a better
/// message than this walk could.
///
/// **The walk reads the binary format only.** A guest handed over as `.wat` text
/// — a development path, which is what the fixtures are — has no section table
/// to walk and answers `false` here, so a text-format module with `(start $f)`
/// would run that function at instantiation. The arena is still verified
/// afterwards (the band-zero sweep and the canary lattice are what catch
/// damage), but the *ordering* guarantee this check exists for would be lost.
/// A shipping guest is a compiled `game.wasm`, so this is a gap in the
/// development path rather than in the ABI; closing it properly means parsing
/// the text format, which no chunk-1 code does. See the A1 report.
fn declares_start_section(bytes: &[u8]) -> bool {
    if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
        return false;
    }
    let mut at = 8usize;
    while at < bytes.len() {
        let id = bytes[at];
        at += 1;
        let Some(size) = leb::read_uleb(bytes, &mut at) else {
            return false;
        };
        if id == WASM_SECTION_START {
            return true;
        }
        match at.checked_add(size) {
            Some(next) => at = next,
            None => return false,
        }
    }
    false
}

/// Parse `--session-callbacks`'s value: `BATCH` or `BATCH,EVENT`, each a guest
/// function-table index (`0` = that slot is absent).
fn parse_callback_slots(value: &str) -> Result<(u32, u32), String> {
    let mut parts = value.split(',');
    let batch = parts
        .next()
        .ok_or("`--session-callbacks` needs a slot")?
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("`--session-callbacks {value}`: `{value}` is not a table index"))?;
    let event = match parts.next() {
        Some(text) => text
            .trim()
            .parse::<u32>()
            .map_err(|_| format!("`--session-callbacks {value}`: `{text}` is not a table index"))?,
        None => 0,
    };
    if parts.next().is_some() {
        return Err(format!("`--session-callbacks {value}`: expected BATCH or BATCH,EVENT"));
    }
    Ok((batch, event))
}

/// Turn `--capability` values into library paths (round-2 decision 3): a value
/// that names an existing file is that file; anything else is a capability
/// *name*, looked up as `<dir>/libtension_<name>.so` in the directories
/// `TENSION_CAPABILITY_PATH` lists, colon-separated. The explicit form is
/// checked first, so an operator pointing at a specific file is never overridden
/// by the environment.
fn resolve_capability_paths(values: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    let mut resolved = Vec::with_capacity(values.len());
    for value in values {
        let direct = PathBuf::from(value);
        if direct.is_file() {
            resolved.push(direct);
            continue;
        }
        let mut found = None;
        if let Some(dirs) = std::env::var_os("TENSION_CAPABILITY_PATH") {
            for dir in std::env::split_paths(&dirs) {
                let candidate = dir.join(format!("libtension_{value}.so"));
                if candidate.is_file() {
                    found = Some(candidate);
                    break;
                }
            }
        }
        match found {
            Some(path) => resolved.push(path),
            None => anyhow::bail!(
                "--capability {value}: no such file, and no libtension_{value}.so in \
                 TENSION_CAPABILITY_PATH — pass the library's path, or set that variable to a \
                 colon-separated list of directories holding it"
            ),
        }
    }
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// tension::res helpers
// ---------------------------------------------------------------------------

/// Every NS1 path a pak provides, walked once. `--res` merges paks into one
/// namespace, so a path served by two of them is a load-time error (§7.2).
fn check_pak_conflicts(sets: &[&ResourceSet<'static>]) -> Result<(), String> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (index, set) in sets.iter().enumerate() {
        let mut stack: Vec<String> = vec!["/".to_string()];
        while let Some(dir) = stack.pop() {
            let entries = set
                .read_dir(&dir)
                .map_err(|e| format!("--res pak {index}: listing `{dir}` failed: {e}"))?;
            for entry in entries {
                let path = if dir == "/" {
                    format!("/{}", entry.name)
                } else {
                    format!("{dir}/{}", entry.name)
                };
                if !seen.insert(path.clone()) {
                    return Err(format!(
                        "duplicate path `{path}`: it is provided by --res pak {index} and an earlier pak"
                    ));
                }
                if entry.is_dir() {
                    stack.push(path);
                }
            }
        }
    }
    Ok(())
}

/// Read a UTF-8 path out of guest memory. `None` means the guest's own bounds
/// (or its bytes) do not describe a path: the ABI answers -EINVAL.
fn guest_path(caller: &mut Caller<'_, HostState>, ptr: i32, len: i32) -> Option<String> {
    if ptr < 0 || len < 0 {
        return None;
    }
    let mem = caller.get_export("memory").and_then(|e| e.into_memory())?;
    let data = mem.data(&*caller);
    let start = ptr as usize;
    let end = start.checked_add(len as usize)?;
    if end > data.len() {
        return None;
    }
    std::str::from_utf8(&data[start..end]).ok().map(str::to_owned)
}

/// Write bytes into guest memory; false when the range does not fit.
fn write_guest(caller: &mut Caller<'_, HostState>, ptr: i32, bytes: &[u8]) -> bool {
    if ptr < 0 {
        return false;
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return false;
    };
    let data = mem.data_mut(caller);
    let start = ptr as usize;
    let Some(end) = start.checked_add(bytes.len()) else {
        return false;
    };
    if end > data.len() {
        return false;
    }
    data[start..end].copy_from_slice(bytes);
    true
}

/// The 12-byte `{kind, size, flags}` record (§7.4), little-endian.
fn write_stat(caller: &mut Caller<'_, HostState>, ptr: i32, stat: &Stat) -> bool {
    let mut rec = [0u8; 12];
    rec[0..4].copy_from_slice(&stat.kind.to_le_bytes());
    rec[4..8].copy_from_slice(&stat.size.to_le_bytes());
    rec[8..12].copy_from_slice(&stat.flags.to_le_bytes());
    write_guest(caller, ptr, &rec)
}

/// Guest fd for a pak's handle.
fn pack_fd(set: usize, fd: i32) -> i32 {
    ((set as i32) << FD_SET_SHIFT) | (fd & FD_LOCAL_MASK)
}

/// Split a guest fd back into (pak index, that pak's handle).
fn fd_index(fd: i32) -> Option<(usize, i32)> {
    if fd <= 0 {
        return None;
    }
    let local = fd & FD_LOCAL_MASK;
    if local == 0 {
        return None;
    }
    Some(((fd >> FD_SET_SHIFT) as usize, local))
}

/// First-match resolution over the pak set (§7.2): the first pak that answers
/// wins; `-ENOENT` from every pak stays `-ENOENT`; any other failure is
/// reported rather than masked, so a malformed path is never disguised as a
/// miss.
fn resolve_set<T>(
    sets: &[ResourceSet<'static>],
    mut f: impl FnMut(&ResourceSet<'static>) -> Result<T, res::Errno>,
) -> Result<(usize, T), res::Errno> {
    let mut first_error: Option<res::Errno> = None;
    for (index, set) in sets.iter().enumerate() {
        match f(set) {
            Ok(value) => return Ok((index, value)),
            Err(e) if e.code() != ENOENT => first_error = first_error.or(Some(e)),
            Err(_) => {}
        }
    }
    Err(first_error.unwrap_or(res::Errno(ENOENT)))
}

#[cfg(test)]
mod res_cli_tests {
    use super::*;

    #[test]
    fn res_flags_are_collected_in_order() {
        let cli = parse_cli(vec![
            "--res".into(),
            "a.tns".into(),
            "--res=b.tns".into(),
            "--debug".into(),
            "game.wasm".into(),
            "--res".into(), // after the guest path: this one is the game's
        ])
        .expect("parses");
        assert_eq!(
            cli.res_paths,
            vec![PathBuf::from("a.tns"), PathBuf::from("b.tns")]
        );
        assert!(cli.debug);
        assert_eq!(cli.wasm_path, "game.wasm");
        assert_eq!(cli.args, vec!["--res".to_string()]);
    }

    #[test]
    fn a_res_without_a_value_is_an_error() {
        // A trailing `--res` has nothing to consume.
        let err = parse_cli(vec!["--res".into()]).unwrap_err();
        assert!(err.contains("--res"), "unexpected error: {err}");
        // `--res` takes the next token unconditionally (like `--symbol-path`),
        // so a guest path written there is consumed as a pak and the guest is
        // then missing — reported, never guessed at.
        let err = parse_cli(vec!["--res".into(), "game.wasm".into()]).unwrap_err();
        assert!(err.contains("<game.wasm>"), "unexpected error: {err}");
    }

    #[test]
    fn without_res_the_set_is_empty() {
        let cli = parse_cli(vec!["game.wasm".into()]).expect("parses");
        assert!(cli.res_paths.is_empty());
    }

    #[test]
    fn guest_fds_pack_the_pak_index() {
        assert_eq!(fd_index(pack_fd(0, 1)), Some((0, 1)));
        assert_eq!(fd_index(pack_fd(3, 64)), Some((3, 64)));
        assert_eq!(fd_index(pack_fd(1, 9)), Some((1, 9)));
        assert_eq!(fd_index(0), None);
        assert_eq!(fd_index(-2), None);
        // A packed fd never collides with a bare local fd.
        assert_ne!(pack_fd(1, 1), 1);
    }
}

#[cfg(test)]
mod adapter_cli_tests {
    use super::*;

    #[test]
    fn capability_values_are_collected_in_order() {
        let cli = parse_cli(vec![
            "--capability".into(),
            "echo".into(),
            "--capability=other.so".into(),
            "game.wasm".into(),
            "--capability".into(), // after the guest path: this one is the game's
        ])
        .expect("parses");
        assert_eq!(
            cli.capability_paths,
            vec!["echo".to_string(), "other.so".to_string()]
        );
        assert_eq!(cli.wasm_path, "game.wasm");
        assert_eq!(cli.args, vec!["--capability".to_string()]);

        let err = parse_cli(vec!["--capability".into()]).unwrap_err();
        assert!(err.contains("--capability"), "unexpected error: {err}");
    }

    #[test]
    fn without_capabilities_nothing_is_loaded() {
        let cli = parse_cli(vec!["game.wasm".into()]).expect("parses");
        assert!(cli.capability_paths.is_empty());
        assert!(
            resolve_capability_paths(&cli.capability_paths)
                .expect("resolves")
                .is_empty()
        );
    }

    #[test]
    fn the_host_open_is_a_flag_and_off_by_default() {
        let cli = parse_cli(vec!["game.wasm".into()]).expect("parses");
        assert!(
            !cli.session_open,
            "the run path must not open a session unless asked"
        );
        let cli = parse_cli(vec!["--session-open".into(), "game.wasm".into()]).expect("parses");
        assert!(cli.session_open);
        assert_eq!(cli.wasm_path, "game.wasm");
    }

    // ── the load-time checks on the guest's own structure ──────────────────

    fn module(wat: &str) -> Module {
        Module::new(&Engine::default(), wat).expect("the test module compiles")
    }

    /// F2 check 1, in its own words: a guest that speaks the session protocol
    /// but brought no arena. (`Session::create_from_module` refuses *any* guest
    /// without a memory import; this is the specific message for the case where
    /// the guest clearly meant to be a session guest.)
    #[test]
    fn a_session_guest_without_a_memory_import_is_refused() {
        let module = module(
            r#"(module
                 (import "session" "open" (func $open (param i32 i32) (result i32)))
                 (func (export "_start_game")))
               "#,
        );
        let error = check_guest_module(&module, b"", "guest.wat").expect_err("refused");
        let text = error.to_string();
        assert!(
            text.contains("imports `session::*` but declares no memory import")
                && text.contains("env::memory or session::memory"),
            "unexpected diagnostic: {text}"
        );
    }

    /// F2 check 2: the memory is imported and re-exported, which is what the
    /// host ABI needs to reach it.
    #[test]
    fn a_guest_that_re_exports_its_memory_passes() {
        let module = module(
            r#"(module
                 (import "session" "memory" (memory 4 256))
                 (export "memory" (memory 0))
                 (func (export "_start_game")))
               "#,
        );
        check_guest_module(&module, b"", "guest.wat").expect("the checks pass");
    }

    #[test]
    fn a_guest_that_hides_its_memory_is_refused() {
        let module = module(
            r#"(module
                 (import "env" "memory" (memory 4 256))
                 (func (export "_start_game")))
               "#,
        );
        let error = check_guest_module(&module, b"", "guest.wat").expect_err("refused");
        let text = error.to_string();
        assert!(
            text.contains("does not re-export it as `memory`")
                && text.contains("(export \"memory\" (memory 0))"),
            "unexpected diagnostic: {text}"
        );
    }

    #[test]
    fn a_guest_without_a_memory_import_at_all_passes_this_check() {
        // The mandatory-import rule is `Session::create_from_module`'s, one line
        // later: it refuses *every* guest without a memory import, so this check
        // stays quiet for a module that never mentions the session — and the
        // diagnostic the operator sees is the general one with the same fix.
        let module = module(r#"(module (func (export "_start_game")))"#);
        check_guest_module(&module, b"", "guest.wat").expect("not this check's case");
    }

    #[test]
    fn a_capability_name_resolves_through_the_path_variable() {
        let dir = std::env::temp_dir().join("tension-capability-path-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let library = dir.join("libtension_probe.so");
        std::fs::write(&library, b"not a library, only a file to find").expect("write");

        std::env::set_var("TENSION_CAPABILITY_PATH", &dir);
        let resolved = resolve_capability_paths(&["probe".to_string()]).expect("resolves");
        assert_eq!(resolved, vec![library.clone()]);

        // The explicit form is checked first and wins: an operator pointing at a
        // file is never overridden by the environment.
        let explicit =
            resolve_capability_paths(&[library.display().to_string()]).expect("resolves");
        assert_eq!(explicit, vec![library.clone()]);

        // A name that resolves nowhere is a refusal that says what it looked
        // for, not a run with one adapter quietly missing.
        let error = resolve_capability_paths(&["absent".to_string()]).expect_err("refused");
        assert!(
            error.to_string().contains("libtension_absent.so"),
            "unexpected error: {error}"
        );
        std::env::remove_var("TENSION_CAPABILITY_PATH");
        let _ = std::fs::remove_file(&library);
    }

    /// The wasm header every module starts with: the magic and the version.
    const HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    /// A binary module built from `(section id, payload)` pairs, sizes in LEB.
    fn module_with(sections: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = HEADER.to_vec();
        for (id, payload) in sections {
            bytes.push(*id);
            leb::write_uleb(&mut bytes, payload.len() as u64);
            bytes.extend_from_slice(payload);
        }
        bytes
    }

    #[test]
    fn a_start_section_is_found_behind_the_other_sections() {
        // Section 8 is `start`; 1 and 3 are types and functions, there so the
        // walk has to skip them by their declared sizes rather than guessing.
        let with_start = module_with(&[(1, vec![0x00]), (3, vec![0x00]), (8, vec![0x00])]);
        assert!(declares_start_section(&with_start));

        let without = module_with(&[(1, vec![0x00]), (10, vec![0x00, 0x00])]);
        assert!(!declares_start_section(&without));
        assert!(!declares_start_section(&HEADER));
    }

    #[test]
    fn the_start_walk_gives_up_on_a_malformed_module() {
        // The text format: no magic, and `Module::new` parses it — the walk has
        // nothing to say about it.
        assert!(!declares_start_section(b"(module)"));
        // A section whose size runs past the end of the module.
        let mut truncated = module_with(&[(1, vec![0x00])]);
        truncated[9] = 0x40;
        assert!(!declares_start_section(&truncated));
        // A stream that ends before the magic does.
        assert!(!declares_start_section(&HEADER[..6]));
        assert!(!declares_start_section(&[]));
    }
}

#[cfg(test)]
mod pack_cli_tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pack_defaults_the_output_path() {
        let cli = parse_pack_cli(strings(&["assets"])).expect("parses");
        assert_eq!(cli.source, PathBuf::from("assets"));
        assert_eq!(cli.out, PathBuf::from("assets.tns"));
    }

    #[test]
    fn pack_takes_o_and_out_in_both_spellings() {
        for args in [
            vec!["assets", "-o", "out.tns"],
            vec!["assets", "--out", "out.tns"],
            vec!["assets", "-o=out.tns"],
            vec!["assets", "--out=out.tns"],
            vec!["-o", "out.tns", "assets"],
        ] {
            let cli = parse_pack_cli(strings(&args)).expect("parses");
            assert_eq!(cli.out, PathBuf::from("out.tns"), "args: {args:?}");
            assert_eq!(cli.source, PathBuf::from("assets"), "args: {args:?}");
        }
    }

    #[test]
    fn pack_rejects_bad_usage() {
        assert!(parse_pack_cli(strings(&[])).unwrap_err().contains("<source-dir>"));
        assert!(parse_pack_cli(strings(&["-o"])).unwrap_err().contains("-o"));
        assert!(parse_pack_cli(strings(&["a", "b"]))
            .unwrap_err()
            .contains("one source"));
        assert!(parse_pack_cli(strings(&["--nope", "a"]))
            .unwrap_err()
            .contains("unknown option"));
    }

    #[test]
    fn a_missing_source_is_an_error_from_the_abi() {
        let tmp = std::env::temp_dir().join("tension-pack-cli-test");
        let cli = PackCli {
            source: tmp.join("does-not-exist"),
            out: tmp.join("out.tns"),
        };
        let err = tension_core::res::pack(&cli.source, &cli.out).unwrap_err();
        assert_eq!(err.to_string().contains("ENOENT"), true, "{err}");
    }

    #[test]
    fn duplicate_paths_across_paks_are_rejected() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tension-res")
            .join("test")
            .join("fixtures")
            .join("minimal.sidf");
        let a = ResourceSet::load_file(&fixture).expect("a loads");
        let b = ResourceSet::load_file(&fixture).expect("b loads");
        assert!(check_pak_conflicts(&[&a]).is_ok());
        let err = check_pak_conflicts(&[&a, &b]).unwrap_err();
        assert!(err.contains("duplicate path `/hello.txt`"), "{err}");
    }
}
