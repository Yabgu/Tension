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
use tension_core::thread::GuestMemory;

/// The `InputEvent` ordinals, as the guest's SDK declares them
/// (`tension-framework/assembly/io.ten`). **The wire contract, in one place per side.**
/// A completion's `b` carries one of these, so `await inputTask(source)` answers the event
/// itself rather than a number the guest has to decode.
const INPUT_EVENT_LINE: u32 = 0;
const INPUT_EVENT_END: u32 = 1;

/// Write guest text to the terminal, or to the sandbox's capture buffer.
///
/// A sandboxed guest's output is captured rather than printed: the host reads it
/// right after the entrypoint returns (`dev.out` in Pass 3), and a nested run
/// that interleaved with the editor's own terminal would be the one thing a
/// nested run must not do. Shared by `print` and the showcase's `emit`.
fn write_text(caller: &mut Caller<'_, HostState>, text: &str) {
    let captured = match caller.data_mut().captured_out.as_mut() {
        Some(out) => {
            out.extend_from_slice(text.as_bytes());
            true
        }
        None => false,
    };
    if !captured {
        print!("{text}");
        let _ = io::stdout().flush();
    }
}

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
            // **`GuestMemory`, not `into_memory()`.** A shared-memory guest (a
            // `--sharedMemory` build) exports `Extern::SharedMemory`, which
            // `into_memory()` answers `None` for — measured: the export is there
            // (`is_some()` is true) and the expect fired anyway, which is the
            // least useful shape a refusal can have. `GuestMemory::of` resolves
            // either kind (`tension_core::thread`).
            let Some(mem) = GuestMemory::of(&mut caller) else {
                return;
            };
            let start = ptr as usize;
            let end = start.saturating_add(len.max(0) as usize);
            let bytes = mem.copy(&caller, start, end);
            let text = String::from_utf8_lossy(&bytes).into_owned();
            write_text(&mut caller, &text);
        },
    )?;

    // The showcase's tag protocol: `env.emit(tag, value)` prints `name: value`.
    //
    // This is not a capability verb — it is the import
    // `TensionScript-a2/examples/async-main/main.ts` declares, because that
    // program has no strings and the harness names the tags. Tension's host is
    // the *other* host for that program (`tension-core/tests/programs/async-on-main.ts`
    // is a copy), so it answers the same import with the same names, taken from
    // `TensionScript-a2/examples/host.mjs`'s table. An unknown tag falls back to
    // `tag<id>`, exactly as that harness does.
    linker.func_wrap(
        "env",
        "emit",
        |mut caller: Caller<'_, HostState>, tag: i32, value: i32| {
            const NAMES: [&str; 5] = ["status", "suspensions", "carried", "total", "final"];
            let name = NAMES
                .get(tag as usize)
                .map(|name| (*name).to_string())
                .unwrap_or_else(|| format!("tag{tag}"));
            write_text(&mut caller, &format!("{name}: {value}\n"));
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

    // ── the awaitable input source (DL57, I135) ─────────────────────────────
    //
    // **Why a thread and not the host loop.** `read_line` used to read stdin inline, on
    // whatever thread the guest ran on — and under the fiber backend that thread *is* the
    // host's frame loop. A guest that awaited a line therefore blocked the one thing that
    // could deliver it. The reader moves off-thread; the guest awaits a completion.
    //
    // **Why the source is a key and not a second import.** A socket and a file will post
    // through this same pair with their own descriptor as the key (`CLASS_IO_READY`'s
    // family bounds the key at 63), so the surface a guest writes is:
    //
    //     const event: InputEvent = await inputTask(source);
    //     const line: string = readLineNow();
    //
    // and the second consumer changes `source`, not the shape.
    //
    // **Idempotent.** Arming an armed source is a no-op answering 0, so a loop that arms
    // before every await does not spawn a thread per iteration.
    linker.func_wrap(
        "tension::io",
        "input_arm",
        |mut caller: Caller<'_, HostState>, source: i32| -> i32 {
            // **Two sources today, and the second is a file** (DL57, decision 6). The
            // guest's code is identical for both — `await inputTask(source)` — so this is
            // the shape carrying a second consumer unchanged rather than an AI-shaped
            // surface wearing a general name.
            //
            // 0 is stdin. 1 is a file named by `TENSION_INPUT_FILE`, which is what makes a
            // file reader a check in CI rather than a claim: the example that uses it runs
            // headless with no terminal at all. A socket answers its own id when it lands;
            // refusing a key nobody produces is what keeps a guest from parking on a
            // completion that will never come.
            let mut file: Option<String> = None;
            if source == 1 {
                match std::env::var("TENSION_INPUT_FILE") {
                    Ok(path) if !path.is_empty() => file = Some(path),
                    _ => return -38, // -ENOSYS: no file source configured
                }
            } else if source != 0 {
                return -38;
            }
            if source == 0 && caller.data().line_queue.is_some() {
                return 0;
            }
            if source == 1 && caller.data_mut().file_armed.insert(source) == false {
                // Already armed: idempotent, answering 0 without a second thread.
                return 0;
            }
            let queue = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
            let eof = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            if source == 0 {
                // The stdin queue is the store's own; a file source keeps its lines where
                // `read_file_line` can reach them (below), because one `read_line` import
                // serves both and the guest must not have to know which it armed.
                caller.data_mut().line_queue = Some(queue.clone());
                caller.data_mut().line_eof = Some(eof.clone());
            } else {
                caller.data_mut().file_queues.insert(source, queue.clone());
                caller.data_mut().file_eofs.insert(source, eof.clone());
            }

            let posting = caller.data().posting.clone();
            std::thread::spawn(move || {
                // **One loop, two sources.** A file and stdin differ only in what `read_line`
                // is called on, so the post/queue half below is not duplicated — which is the
                // property decision 6 asks a second consumer to demonstrate.
                let opened: Box<dyn io::BufRead> = match file {
                    Some(path) => match std::fs::File::open(&path) {
                        Ok(handle) => Box::new(io::BufReader::new(handle)),
                        Err(_) => return,
                    },
                    // `Stdin` is not itself `BufRead`; its lock is, and holding it for the
                    // reader's lifetime is what the blocking path already does.
                    None => Box::new(io::stdin().lock()),
                };
                let mut reader = opened;
                let mut line = String::new();
                loop {
                    line.clear();
                    let n = reader.read_line(&mut line).unwrap_or(0);
                    if n == 0 {
                        // End of the source. **A separate class, not a zero-payload line**:
                        // `b == 0` must not have to mean both "an empty line" and "over".
                        eof.store(true, std::sync::atomic::Ordering::Release);
                        // **The payload is the event, not a length** (DL57). The guest's
                        // `await` answers `InputEvent`, so `b` carries its ordinal:
                        // `IO_EOF` -> `InputEvent.End`. The SDK's enum is the wire contract
                        // (`tension-framework/assembly/io.ten`), and this is its other end.
                        let _ = posting.post(
                            0,
                            crate::session::arena::CLASS_IO_EOF,
                            0,
                            source as u32,
                            INPUT_EVENT_END,
                            0.0,
                            0.0,
                        );
                        return;
                    }
                    while line.ends_with('\n') || line.ends_with('\r') {
                        line.pop();
                    }
                    let bytes = line.clone().into_bytes();
                    // No length in the payload: the guest learns the line's size from
                    // `read_line`'s own probe, and `b` is reserved for the event so the
                    // await's value can name it (`InputEvent.Line`).
                    queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push_back(bytes);
                    // **Push before post**, so a woken guest always finds the line it was
                    // told about.
                    let _ = posting.post(
                        0,
                        crate::session::arena::CLASS_IO_READY,
                        0,
                        source as u32,
                        INPUT_EVENT_LINE,
                        0.0,
                        0.0,
                    );
                }
            });
            0
        },
    )?;

    // **The awaitable surface's own reader** (DL57). `read_line` is the blocking call a
    // synchronous guest uses and is left exactly as it was; this one takes the source the
    // event named, so a guest awaiting `inputTask(1)` reads source 1's line and a guest
    // awaiting `inputTask(0)` reads stdin's — same code, one argument.
    //
    // Same probe/consume contract as `read_line` (`cap <= 0` reports the length and does not
    // consume), because the SDK's string wrapper is shared and a second convention would be
    // a second way to get it wrong.
    linker.func_wrap(
        "tension::io",
        "input_read",
        |mut caller: Caller<'_, HostState>, source: i32, ptr: i32, cap: i32| -> i32 {
            let (queue, eof) = if source == 0 {
                let state = caller.data();
                match (&state.line_queue, &state.line_eof) {
                    (Some(q), Some(e)) => (q.clone(), e.clone()),
                    _ => return -1, // not armed: nothing will arrive
                }
            } else {
                let state = caller.data();
                match (state.file_queues.get(&source), state.file_eofs.get(&source)) {
                    (Some(q), Some(e)) => (q.clone(), e.clone()),
                    _ => return -1,
                }
            };
            let line = {
                let mut guard = queue.lock().unwrap_or_else(|e| e.into_inner());
                if cap > 0 { guard.pop_front() } else { guard.front().cloned() }
            };
            let Some(line) = line else {
                return if eof.load(std::sync::atomic::Ordering::Acquire) { -1 } else { 0 };
            };
            if cap > 0 {
                let to_write = line.len().min(cap as usize);
                if to_write > 0 {
                    let mem = caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                        .expect("game must export a memory named 'memory'");
                    let data = mem.data_mut(&mut caller);
                    let start = (ptr as usize).min(data.len());
                    let end = (start + to_write).min(data.len());
                    data[start..end].copy_from_slice(&line[..(end - start)]);
                }
            }
            line.len() as i32
        },
    )?;

    linker.func_wrap(
        "tension::io",
        "read_line",
        |mut caller: Caller<'_, HostState>, ptr: i32, cap: i32| -> i32 {
            // **An armed source is served from the queue, never by blocking** (DL57,
            // I135). `input_arm` started a reader on its own thread, which pushed every
            // complete line here and posted a completion for it; a guest that reaches this
            // call has already been woken by that post. Calling `stdin().read_line` here
            // would block the host loop — which under the fiber backend is the same thread
            // the guest is running on, the defect this round fixes.
            if caller.data().line_queue.is_some() {
                let state = caller.data_mut();
                let queue = state.line_queue.as_ref().expect("checked").clone();
                let eof = state.line_eof.as_ref().expect("armed with the queue").clone();
                // **The probe reads, the consuming call takes** — the same split the
                // blocking path has (`pending_line` is left in place until `cap > 0`).
                // Popping on the probe consumed the line the guest was about to read and
                // made every line arrive one late: measured, `printf 'hello\nworld\n'`
                // printed `line: world` for its first event.
                let line = {
                    let mut guard = queue.lock().unwrap_or_else(|e| e.into_inner());
                    if cap > 0 { guard.pop_front() } else { guard.front().cloned() }
                };
                let Some(line) = line else {
                    // Nothing queued and the source is over: EOF. `-1` is the same answer a
                    // blocking read gives at end of input, so every caller's EOF path is
                    // unchanged.
                    return if eof.load(std::sync::atomic::Ordering::Acquire) { -1 } else { 0 };
                };
                if cap > 0 {
                    let to_write = line.len().min(cap as usize);
                    if to_write > 0 {
                        let mem = caller
                            .get_export("memory")
                            .and_then(|e| e.into_memory())
                            .expect("game must export a memory named 'memory'");
                        let data = mem.data_mut(&mut caller);
                        let start = (ptr as usize).min(data.len());
                        let end = (start + to_write).min(data.len());
                        data[start..end].copy_from_slice(&line[..(end - start)]);
                    }
                }
                return line.len() as i32;
            }
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
