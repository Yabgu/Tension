//! `tension::io` — the guest's terminal, its arguments, and its logger.
//!
//! Four imports and two argv readers, moved out of `main()` unchanged so a
//! second store can register them without the binary's whole setup. Nothing
//! here reads a `main` local: every verb goes through `Caller::data()`, which is
//! what makes the move mechanical rather than a refactor.
//!
//! `env.abort` lives here because it is registered with them and shares their
//! one job — turning a guest-side event into a host-side line. It is the trap
//! path, not a `tension::io` verb.

use std::io::{self, BufRead, Write};

use wasmtime::{Caller, Linker};

use crate::logging::{self, Level};
use crate::{guest_text, read_as_string, HostState};

/// Register the `tension::io` verbs and `env.abort`.
pub fn link_io(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    // tension::io ABI -----------------------------------------------------
    // AS `stub` runtime traps through `env.abort`(msg_ptr, file_ptr, line, col).
    linker.func_wrap(
        "env",
        "abort",
        |mut caller: Caller<'_, HostState>, msg: i32, file: i32, line: i32, col: i32| -> () {
            let m = read_as_string(&mut caller, msg);
            let f = read_as_string(&mut caller, file);
            logging::log(
                Level::Error,
                "core",
                &format!("game aborted: {m} (in {f}, line {line}, col {col})"),
            );
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

    // tension::io log imports -------------------------------------------
    // The guest's logging: `log(level, name_ptr, name_len, msg_ptr, msg_len)`
    // and `log_structured(...)` with a JSON payload in place of the message.
    // Both hand a record to the host logger, which owns the layout — the guest
    // never touches the terminal, exactly as with `print`. A level the guest
    // invents is clamped, not refused, and a record that does not fit the
    // guest's memory is dropped: a log call must not trap.
    linker.func_wrap(
        "tension::io",
        "log",
        |mut caller: Caller<'_, HostState>,
         level: i32,
         name_ptr: i32,
         name_len: i32,
         msg_ptr: i32,
         msg_len: i32| {
            let name = guest_text(&mut caller, name_ptr, name_len).unwrap_or_default();
            let message = guest_text(&mut caller, msg_ptr, msg_len).unwrap_or_default();
            logging::log(logging::Level::from_abi_code(level), &name, &message);
        },
    )?;

    linker.func_wrap(
        "tension::io",
        "log_structured",
        |mut caller: Caller<'_, HostState>,
         level: i32,
         name_ptr: i32,
         name_len: i32,
         json_ptr: i32,
         json_len: i32| {
            let name = guest_text(&mut caller, name_ptr, name_len).unwrap_or_default();
            let payload = guest_text(&mut caller, json_ptr, json_len).unwrap_or_default();
            logging::emit(logging::Level::from_abi_code(level), &name, "", Some(&payload));
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

    Ok(())
}
