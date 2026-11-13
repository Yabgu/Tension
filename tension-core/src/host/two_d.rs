//! `tension::2d` — the ten verbs of the in-core 2D renderer.
//!
//! Moved out of `main()` verb for verb. The verb bodies are byte-identical to
//! what `main()` held; what changed is the module they live in. Nothing here
//! closes over a `main` local: every verb reaches the canvas through
//! `Caller::data().render2d`, and the helpers below take what they need as
//! parameters.
//!
//! **Why the helpers moved with it.** `guest_bytes`, `put_guest_bytes`,
//! `check_handle` and `log_refusal` have no caller outside this block
//! (`guest_bytes` appears elsewhere in `main()` only as an unrelated local
//! variable holding the guest's wasm). Leaving them behind would have made four
//! functions dead the moment the verbs left, and dead code is a warning — so
//! they travel with the only code that uses them.
//!
//! **The file is named `two_d` because a module cannot be named `2d`.** The
//! import namespace is `tension::2d`, and `host::io` / `host::res` follow their
//! namespaces the same way; this is the one that needs a spelling.
//!
//! Compiled only under `render2d-core`. Without it the verbs come from the
//! capability DSO exactly as they did before the pass, and this module is not
//! linked at all.

use wasmtime::{Caller, Linker};

use tension_core::logging::{self, Level};
use tension_core::render2d;

use crate::HostState;

/// The copy is the point, not an implementation detail: the guest pointer is not
/// kept past the call (`tension_adapter.h` rule 6), and the renderer sorts and
/// re-reads records after the verb has returned.
#[cfg(feature = "render2d-core")]
fn guest_bytes(caller: &mut Caller<'_, HostState>, ptr: u32, len: u32) -> Result<Vec<u8>, i32> {
    use render2d::error::{EINVAL, ENOSPC};
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return Err(render2d::error::EBADF);
    };
    let data = mem.data(&*caller);
    let start = ptr as usize;
    let end = start.checked_add(len as usize).ok_or(EINVAL)?;
    if end > data.len() {
        return Err(ENOSPC);
    }
    Ok(data[start..end].to_vec())
}

/// Write a span into guest memory, refusing a buffer shorter than the write.
///
/// The DSO's `write_guest` (`adapter.cpp:108`): `-ENOSPC` when the caller's
/// capacity cannot hold the bytes, `-EBADF` when there is no memory to write to.
#[cfg(feature = "render2d-core")]
fn put_guest_bytes(
    caller: &mut Caller<'_, HostState>,
    ptr: u32,
    cap: u32,
    src: &[u8],
) -> Result<(), i32> {
    use render2d::error::{ENOSPC, EINVAL};
    if src.len() > cap as usize {
        return Err(ENOSPC);
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return Err(render2d::error::EBADF);
    };
    let data = mem.data_mut(&mut *caller);
    let start = ptr as usize;
    let end = start.checked_add(src.len()).ok_or(EINVAL)?;
    if end > data.len() {
        return Err(ENOSPC);
    }
    data[start..end].copy_from_slice(src);
    Ok(())
}

/// Refuse a verb whose handle is not the open canvas.
///
/// One helper because the rule is one rule: the DSO's handle is 1 or 0
/// (`adapter.cpp:44-46`), and a verb that names anything else is `-EINVAL`.
/// `info` is the exception — it answers `-ENODEV` for a missing canvas, which is
/// the DSO's own split (`adapter.cpp:359-363`) and information a guest uses: "no
/// canvas" and "wrong handle" are different mistakes.
#[cfg(feature = "render2d-core")]
fn check_handle(state: &HostState, handle: i32) -> Option<i32> {
    if handle == 1 && state.render2d.canvas().is_some() {
        None
    } else {
        Some(render2d::error::EINVAL)
    }
}

/// Log a refusal at the level the DSO used, so a reader comparing the two
/// backends sees the same lines.
#[cfg(feature = "render2d-core")]
fn log_refusal(verb: &str, error: &render2d::Render2dError) {
    logging::log(
        Level::Error,
        "2d",
        &format!("{verb} refused ({})", error.message()),
    );
}

/// Register the ten `tension::2d` verbs as `func_wrap`s.
///
/// # Why these live in the binary
///
/// A `func_wrap` closure takes `Caller<'_, HostState>`, and `HostState` is the
/// binary's. The library owns the mechanism ([`render2d::Render2dState`]: the
/// device, the window claim, the frame stager, the tables, the swapchain guard);
/// this owns the guest-facing names. That is the split `platform` already makes,
/// and it is what lets the tests drive the mechanism with no wasm in sight.
///
/// # The signatures
///
/// `adapter.cpp:440-486`'s registration table, verb for verb. The arity and the
/// parameter count are part of the contract: a guest built against the DSO must
/// not see a different shape, so `submit` still takes
/// `(handle, pipe_id, hdr_ptr, bucket)` even though an in-core call could pass a
/// slice.
///
/// # The one verb that is still `-ENOSYS`
///
/// `shader_compile_raw` never had a body in the DSO either
/// (`adapter.cpp:248-253`): the wire has the door, and no build has a GLSL to
/// SPIR-V translator behind it. The in-core path *could* serve it —
/// [`render2d::pipeline`] reaches Naga — but that would be a new capability, not
/// a port, and Pass B is a port. It stays `-ENOSYS` and says so.
#[cfg(feature = "render2d-core")]
pub fn link_2d(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    use render2d::error::{ENOSPC, ENOSYS, EINVAL};
    use render2d::record::{SubmitHeader, RECORD_SIZE};

    linker.func_wrap(
        "tension::2d",
        "open",
        |mut caller: Caller<'_, HostState>, width: i32, height: i32, flags: i32| -> i32 {
            // The DSO's validation, unchanged (`adapter.cpp:117-131`): bit 0 is
            // the only flag, and a canvas is never zero-sized.
            const OPEN_WINDOWED: i32 = 1;
            if flags & !OPEN_WINDOWED != 0 {
                logging::log(Level::Warn, "2d", &format!("open: unknown flag bits {flags:#x}"));
                return EINVAL;
            }
            if width <= 0 || height <= 0 {
                logging::log(
                    Level::Warn,
                    "2d",
                    &format!("open: {width}x{height} is not a canvas size"),
                );
                return EINVAL;
            }

            let state = caller.data_mut();
            let HostState {
                render2d,
                host_window,
                shared,
                ..
            } = state;

            let windowed = flags & OPEN_WINDOWED != 0;
            let result = if windowed {
                render2d.open_windowed(host_window, width as u32, height as u32, shared)
            } else {
                render2d.open_offscreen(width as u32, height as u32)
            };

            match result {
                Ok(handle) => {
                    let kind = if windowed { "window" } else { "offscreen" };
                    // A capture state has no device to report; saying "device
                    // up" there would be the one log line a reader checks to
                    // answer "is this the nested guest or the outer one".
                    let what = if render2d.is_capture() {
                        "capture canvas"
                    } else {
                        "GPU device up"
                    };
                    logging::log(
                        Level::Info,
                        "2d",
                        &format!("open: {what}, {kind} {width}x{height} target"),
                    );
                    handle
                }
                Err(error) => {
                    logging::log(
                        Level::Error,
                        "2d",
                        &format!("open refused ({})", error.message()),
                    );
                    error.errno()
                }
            }
        },
    )?;

    linker.func_wrap(
        "tension::2d",
        "close",
        |mut caller: Caller<'_, HostState>, handle: i32| -> i32 {
            let state = caller.data_mut();
            let capture = state.render2d.is_capture();
            match state.render2d.close(handle) {
                Ok(value) => {
                    logging::log(
                        Level::Info,
                        "2d",
                        if capture { "close: capture canvas released" } else { "close: device released" },
                    );
                    value
                }
                Err(error) => {
                    logging::log(
                        Level::Warn,
                        "2d",
                        &format!("close refused ({})", error.message()),
                    );
                    error.errno()
                }
            }
        },
    )?;

    // set_pipeline(handle, blob_ptr, blob_len).
    //
    // The DSO's `blob_len < 100` convention for "this is a preset id" is kept:
    // it is the wire's encoding, not an implementation detail, and a guest that
    // passes a 1..99 length is naming a preset (`adapter.cpp:243-246`).
    linker.func_wrap(
        "tension::2d",
        "set_pipeline",
        |mut caller: Caller<'_, HostState>, handle: i32, blob_ptr: i32, blob_len: i32| -> i32 {
            {
                let state = caller.data();
                if let Some(errno) = check_handle(state, handle) {
                    return errno;
                }
            }

            let result = if blob_ptr != 0 {
                if blob_len <= 0 {
                    return EINVAL;
                }
                match guest_bytes(&mut caller, blob_ptr as u32, blob_len as u32) {
                    Ok(blob) => caller.data_mut().render2d.set_pipeline_blob(&blob),
                    Err(errno) => {
                        return if errno == ENOSPC { EINVAL } else { errno };
                    }
                }
            } else {
                if !(render2d::pipeline::PIPE_PRESET_MIN as i32
                    ..=render2d::pipeline::PIPE_PRESET_MAX as i32)
                    .contains(&blob_len)
                {
                    return render2d::error::ENOENT;
                }
                caller.data_mut().render2d.set_preset(blob_len as u16)
            };

            match result {
                Ok(pipe_id) => {
                    logging::log(
                        Level::Debug,
                        "2d",
                        &format!("set_pipeline -> pipe {pipe_id}"),
                    );
                    pipe_id as i32
                }
                Err(error) => {
                    log_refusal("set_pipeline", &error);
                    error.errno()
                }
            }
        },
    )?;

    // shader_compile_raw(handle, src_ptr, src_len, fmt, out_ptr): still -ENOSYS.
    linker.func_wrap(
        "tension::2d",
        "shader_compile_raw",
        |_: Caller<'_, HostState>, _a: i32, _b: i32, _c: i32, _d: i32, _e: i32| -> i32 {
            // The wire has the door; this build has no GLSL -> SPIR-V verb
            // behind it (`docs/modules/2d.md` §4). An honest -ENOSYS beats a
            // half-door, and the module comment says why the port did not open
            // this one.
            logging::log(
                Level::Debug,
                "2d",
                "shader_compile_raw: no shader translator in this build",
            );
            ENOSYS
        },
    )?;

    // submit(handle, pipe_id, hdr_ptr, bucket).
    linker.func_wrap(
        "tension::2d",
        "submit",
        |mut caller: Caller<'_, HostState>, handle: i32, pipe_id: i32, hdr_ptr: i32, bucket: i32| -> i32 {
            {
                let state = caller.data();
                if let Some(errno) = check_handle(state, handle) {
                    return errno;
                }
            }

            // One read for the header, one for the array: the guest pointer is
            // not kept past this call.
            let header_bytes = match guest_bytes(&mut caller, hdr_ptr as u32, 12) {
                Ok(bytes) => bytes,
                Err(errno) => return if errno == ENOSPC { EINVAL } else { errno },
            };
            let Some(header) = SubmitHeader::parse(&header_bytes) else {
                return EINVAL;
            };

            if header.flags != 0 || header.records_count == 0 {
                return EINVAL;
            }
            if u32::from(header.record_stride) != RECORD_SIZE {
                return EINVAL;
            }
            if bucket < 0 {
                return EINVAL;
            }
            let bytes = u64::from(header.records_count) * u64::from(header.record_stride);
            if bytes > u64::from(u32::MAX) {
                return EINVAL;
            }

            let records =
                match guest_bytes(&mut caller, header.records_ptr, bytes as u32) {
                    Ok(bytes) => bytes,
                    Err(errno) => return if errno == ENOSPC { EINVAL } else { errno },
                };

            let state = caller.data_mut();
            match state.render2d.submit(
                pipe_id as u32,
                &records,
                header.records_count,
                u32::from(header.record_stride),
                bucket as u32,
            ) {
                Ok(accepted) => accepted as i32,
                Err(error) => {
                    log_refusal("submit", &error);
                    error.errno()
                }
            }
        },
    )?;

    linker.func_wrap(
        "tension::2d",
        "present",
        |mut caller: Caller<'_, HostState>, handle: i32| -> i32 {
            let state = caller.data_mut();
            let HostState {
                render2d,
                host_window,
                ..
            } = state;
            if handle != 1 || render2d.canvas().is_none() {
                return EINVAL;
            }
            match render2d.present(host_window) {
                Ok(value) => value,
                Err(error) => {
                    // A cancelled present is not a failure: it is the one
                    // message that the user closed the window, and the DSO
                    // logged it at error level too so an example's output shows
                    // why the frame stopped.
                    log_refusal("present", &error);
                    error.errno()
                }
            }
        },
    )?;

    // texture_load(handle, src_ptr, src_len, target_format).
    linker.func_wrap(
        "tension::2d",
        "texture_load",
        |mut caller: Caller<'_, HostState>, handle: i32, src_ptr: i32, src_len: i32, format: i32| -> i32 {
            {
                let state = caller.data();
                if let Some(errno) = check_handle(state, handle) {
                    return errno;
                }
            }
            let source = match guest_bytes(&mut caller, src_ptr as u32, src_len as u32) {
                Ok(bytes) => bytes,
                Err(errno) => return if errno == ENOSPC { EINVAL } else { errno },
            };
            match caller.data_mut().render2d.texture_load(&source, format) {
                Ok(texture_id) => texture_id as i32,
                Err(error) => {
                    log_refusal("texture_load", &error);
                    error.errno()
                }
            }
        },
    )?;

    // set_texture(handle, pipe_id, slot, texture_id).
    linker.func_wrap(
        "tension::2d",
        "set_texture",
        |mut caller: Caller<'_, HostState>, handle: i32, pipe_id: i32, slot: i32, texture_id: i32| -> i32 {
            {
                let state = caller.data();
                if let Some(errno) = check_handle(state, handle) {
                    return errno;
                }
            }
            if pipe_id <= 0 || slot < 0 || texture_id <= 0 {
                return EINVAL;
            }
            let state = caller.data_mut();
            match state
                .render2d
                .set_texture(pipe_id as u32, slot as u32, texture_id as u32)
            {
                Ok(value) => value,
                Err(error) => {
                    log_refusal("set_texture", &error);
                    error.errno()
                }
            }
        },
    )?;

    // info(handle, out_ptr, cap).
    linker.func_wrap(
        "tension::2d",
        "info",
        |mut caller: Caller<'_, HostState>, handle: i32, out_ptr: i32, cap: i32| -> i32 {
            {
                let state = caller.data();
                if handle != 1 || state.render2d.canvas().is_none() {
                    // `info` is the one verb that distinguishes this: a guest
                    // probing whether it has a canvas wants `-ENODEV`, not
                    // `-EINVAL` (`adapter.cpp:359-363`).
                    return render2d::error::ENODEV;
                }
            }
            let info = match caller.data().render2d.info() {
                Ok(info) => info,
                Err(error) => return error.errno(),
            };
            let bytes = info.to_bytes();
            if (cap as usize) < bytes.len() {
                return ENOSPC;
            }
            match put_guest_bytes(&mut caller, out_ptr as u32, cap as u32, &bytes) {
                Ok(()) => bytes.len() as i32,
                Err(errno) => errno,
            }
        },
    )?;

    // screenshot(handle, ptr, cap).
    linker.func_wrap(
        "tension::2d",
        "screenshot",
        |mut caller: Caller<'_, HostState>, handle: i32, ptr: i32, cap: i32| -> i32 {
            {
                let state = caller.data();
                if let Some(errno) = check_handle(state, handle) {
                    return errno;
                }
                let needed = state.render2d.width() as usize * state.render2d.height() as usize * 4;
                if (cap as usize) < needed {
                    return ENOSPC;
                }
            }
            let frame = match caller.data_mut().render2d.screenshot() {
                Ok(frame) => frame,
                Err(error) => {
                    log_refusal("screenshot", &error);
                    return error.errno();
                }
            };
            let written = frame.len();
            match put_guest_bytes(&mut caller, ptr as u32, cap as u32, &frame) {
                Ok(()) => written as i32,
                Err(errno) => errno,
            }
        },
    )?;

    logging::log(
        Level::Debug,
        "2d",
        "link: ten verbs registered in core",
    );
    Ok(())
}
