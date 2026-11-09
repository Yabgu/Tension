//! Does a control message reach the window?
//!
//! `platform_surface` proves a surface exists; `platform_window` proves the pump
//! delivers events. This proves the third leg: a message posted by *anyone* is
//! queued, confirmed, drained on the window's thread, and applied — and that the
//! queue refuses what it should instead of dropping it.
//!
//! # What is under test, and what is not
//!
//! `ControlBus` (admission, stamping, reservation) and `HostWindow::apply_control`
//! (the executor). The wiring into `host_loop` is not driven here — that needs an
//! interpreter — and is covered end-to-end by `examples/platform-control`.
//!
//! # Confirmation is polling, by design
//!
//! There is no callback. A guest learns the result by reading the published size
//! on a later frame, which is why assertion 2 checks the size *after* an explicit
//! pump and not merely that `apply_control` returned `Ok`.
//!
//! # `harness = false`
//!
//! Same reason as the other two platform probes: `sdl3::init()` lets the first
//! calling thread claim main-thread status and refuses every later one, so a
//! normal `#[test]` passes exactly once.

use std::time::{Duration, Instant};

use tension_core::platform::{
    ControlBus, ControlError, HostWindow, TensionCtrlMsg, WindowTarget, CTRL_CORE_ONLY,
    CTRL_GENERAL_CAPACITY,
    CTRL_OBSERVABLE, CTRL_QUEUE_CAPACITY, CTRL_RESIZE, CTRL_SRC_CORE, CTRL_SRC_GUEST,
    CTRL_SRC_LAYER,
};

fn resize(width: i32, height: i32) -> TensionCtrlMsg {
    TensionCtrlMsg {
        kind: CTRL_RESIZE,
        visibility: CTRL_OBSERVABLE,
        arg0: width,
        arg1: height,
        ..Default::default()
    }
}

/// Pump until the published size changes, or give up.
fn wait_for_size(window: &mut HostWindow, want: (u32, u32)) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        window.pump();
        if window.published_size() == want {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Err(format!(
        "published size is {:?}, expected {want:?}",
        window.published_size()
    ))
}

fn run() -> Result<(), String> {
    let mut window =
        HostWindow::new("tension-control-probe", 320, 240, WindowTarget::Plain).map_err(|e| format!("new: {e}"))?;
    let bus = ControlBus::new();
    println!("driver: {} at {:?}", window.driver(), window.published_size());

    // ── 1. accepted and queued ───────────────────────────────────────────
    bus.post_guest(&resize(640, 480))
        .map_err(|e| format!("a valid RESIZE was refused: {e:?}"))?;
    let stats = bus.stats();
    if stats.queued != 1 || stats.posted != 1 {
        return Err(format!("after one post the bus reports {stats:?}"));
    }
    println!("ok   RESIZE accepted and queued");

    // ── 2. drained, applied, and observable ──────────────────────────────
    let drained = bus.drain();
    if drained.len() != 1 {
        return Err(format!("drain returned {} messages", drained.len()));
    }
    if drained[0].source != CTRL_SRC_GUEST {
        return Err(format!("the bus stamped source {}, expected GUEST", drained[0].source));
    }
    window
        .apply_control(&drained[0])
        .map_err(|e| format!("apply_control: {e}"))?;
    wait_for_size(&mut window, (640, 480))?;
    println!("ok   drained, applied, and published as {:?}", window.published_size());

    // ── 3. the source is stamped, not taken from the caller ──────────────
    let mut forged = resize(1, 1);
    forged.source = CTRL_SRC_CORE;   // a guest claiming to be the core
    bus.post_guest(&forged).map_err(|e| format!("{e:?}"))?;
    let stamped = bus.drain();
    if stamped[0].source != CTRL_SRC_GUEST {
        return Err(format!(
            "a forged source survived: got {}, expected GUEST",
            stamped[0].source
        ));
    }
    println!("ok   a forged source is overwritten with GUEST");

    // ── 4. CORE_ONLY is accepted and leaves nothing observable ───────────
    let before = window.published_size();
    let core_only = TensionCtrlMsg {
        visibility: CTRL_CORE_ONLY,
        ..resize(before.0 as i32 + 7, before.1 as i32 + 7)
    };
    match bus.post_core(&core_only) {
        Ok(admission) => {
            // Whether it queued or came back for immediate application, it is
            // handled either way; what matters is that it is not dropped.
            match admission {
                tension_core::platform::CoreAdmission::Queued => {
                    for msg in bus.drain() {
                        window.apply_control(&msg).map_err(|e| format!("apply: {e}"))?;
                    }
                }
                tension_core::platform::CoreAdmission::ApplyNow(msg) => {
                    window.apply_control(&msg).map_err(|e| format!("apply: {e}"))?;
                }
            }
        }
        Err(e) => return Err(format!("the core's own message was refused: {e:?}")),
    }
    // `CORE_ONLY` means "no confirmation *emitted by the executor*": it does not
    // store the requested size. It cannot mean "nothing in the world changes" —
    // the window really is resized, and SDL's own resize event will report the
    // new size on a later pump, which is correct and is not a confirmation the
    // executor emitted.
    //
    // So the assertion is narrow and true: without pumping, the published size
    // is untouched. That is the only claim the visibility flag actually makes.
    let after = window.published_size();
    if after != before {
        return Err(format!(
            "the executor published a CORE_ONLY result immediately ({before:?} -> {after:?})"
        ));
    }
    println!(
        "ok   CORE_ONLY applied without publishing ({before:?} unchanged; the window \
         system's own resize event may report it later, which is not a confirmation)"
    );

    // ── negative controls ────────────────────────────────────────────────
    let unknown = TensionCtrlMsg { kind: 999, ..TensionCtrlMsg::default() };
    match bus.post_guest(&unknown) {
        Err(ControlError::UnknownKind) => println!("ok   unknown kind refused (EINVAL)"),
        other => return Err(format!("unknown kind gave {other:?}, expected UnknownKind")),
    }

    let malformed = TensionCtrlMsg { reserved: 1, ..resize(1, 1) };
    match bus.post_guest(&malformed) {
        Err(ControlError::Malformed) => println!("ok   non-zero reserved refused (EINVAL)"),
        other => return Err(format!("reserved=1 gave {other:?}, expected Malformed")),
    }

    // Fill the general region; a guest must be refused, not silently dropped.
    let fresh = ControlBus::new();
    let mut accepted = 0usize;
    loop {
        match fresh.post_guest(&resize(1, 1)) {
            Ok(()) => {
                accepted += 1;
                if accepted > CTRL_QUEUE_CAPACITY {
                    return Err("the queue accepted more than its capacity".to_string());
                }
            }
            Err(ControlError::Full) => break,
            Err(other) => return Err(format!("unexpected refusal at capacity: {other:?}")),
        }
    }
    if accepted != CTRL_GENERAL_CAPACITY {
        return Err(format!(
            "a guest filled {accepted} slots, expected the general region's {CTRL_GENERAL_CAPACITY}"
        ));
    }
    println!("ok   a full general region returns Full after {accepted} messages (ENOSPC)");

    // ── reservation: the core still gets in ──────────────────────────────
    match fresh.post_core(&resize(2, 2)) {
        Ok(_) => println!("ok   the core is admitted with the general region full"),
        Err(e) => return Err(format!("the core was starved: {e:?}")),
    }
    let stats = fresh.stats();
    if stats.queued != CTRL_GENERAL_CAPACITY + 1 {
        return Err(format!("expected {} queued, got {}", CTRL_GENERAL_CAPACITY + 1, stats.queued));
    }

    drop(window);
    println!("PASS: control messages are queued, stamped, drained and applied");
    Ok(())
}

fn main() {
    match run() {
        Ok(()) => std::process::exit(0),
        Err(message) => {
            eprintln!("FAIL: {message}");
            std::process::exit(1);
        }
    }
}
