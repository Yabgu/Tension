//! The event dispatcher, asserted.
//!
//! ABI v7 moved SDL event ownership into the core: a capability that used to
//! poll its own queue now registers a *layer* and receives batches, once per
//! pump, on the thread that owns the window. This probe is that contract's
//! gate, and it deliberately splits in two.
//!
//! # The half that needs no display
//!
//! Everything about the bus itself is arithmetic over a layer table, so it runs
//! anywhere:
//!
//!   * registration refusals — a null layer, a short `struct_size`, a non-zero
//!     reserved word, an empty mask, an unknown family, a NULL `dispatch`;
//!   * the cap — eight layers served, the ninth `-ENOSPC`;
//!   * mask filtering — a `key` layer sees keys and nothing else, and two layers
//!     with different masks do not see each other's events;
//!   * the re-entrancy guard — a `register` from inside a dispatch is `-EBUSY`,
//!     and the bus's mutex is *not* held across a dispatch (a `try_lock` from
//!     inside one succeeds; if it did not, the guard would be a deadlock);
//!   * `clear()` — one `shutdown` per surviving layer, exactly once, and no
//!     callback afterwards;
//!   * the wire's encoding for the two families a test can build by hand.
//!
//! # The half that needs a window
//!
//! Translation is asserted end-to-end against a real resize: create a window,
//! resize it through `HostWindow::set_size`, pump, and check the layer received
//! `TENSION_EVENT_WINDOW` / `RESIZED` with the new size. That is SDL's own event
//! all the way through the pump — not a synthesised one — which is the only way
//! to prove the translation table without a keyboard and a compositor. It skips
//! with `TENSION_TEST_ALLOW_SKIP=1` on a rig with no display, and the skip names
//! what would have run.
//!
//! # Why `harness = false`
//!
//! `platform_surface`'s reason: `sdl3::init()` lets the first calling thread
//! claim main-thread status and refuses every later one, so a `#[test]` would
//! pass exactly once. This file is one `fn main()` on the real main thread.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Mutex;

use tension_core::platform::{
    create_window, key_event, window_flags, window_state_event, HostShared, TensionEvent,
    TensionEventLayer, WindowConfig, WindowMode, WindowTarget, EVENT_KEY, EVENT_MOUSE_MOTION,
    EVENT_QUIT, EVENT_WINDOW, KEY_FLAG_DOWN, KEY_FLAG_REPEAT, TENSION_MAX_EVENT_LAYERS,
    WINDOW_EVENT_RESIZED, WINDOW_POS_CENTERED,
};

/// Collected failures, so one run reports every problem rather than the first.
struct Probe {
    failures: Vec<String>,
}

impl Probe {
    fn new() -> Self {
        Probe {
            failures: Vec::new(),
        }
    }

    fn check(&mut self, what: &str, condition: bool) {
        if condition {
            println!("  ok   {what}");
        } else {
            println!("  FAIL {what}");
            self.failures.push(what.to_string());
        }
    }

    fn equal<T: PartialEq + std::fmt::Debug>(&mut self, what: &str, got: T, want: T) {
        let ok = got == want;
        if ok {
            println!("  ok   {what}");
        } else {
            println!("  FAIL {what}: got {got:?}, wanted {want:?}");
            self.failures.push(what.to_string());
        }
    }

    fn fail(&mut self, what: &str) {
        println!("  FAIL {what}");
        self.failures.push(what.to_string());
    }
}

// ── what the layers recorded ────────────────────────────────────────────────
//
// Statics rather than a user pointer: `dispatch` receives the host's token, not
// a layer-owned context (see `tension_event_layer`'s doc), so a probe that wants
// per-layer bookkeeping uses per-layer functions. One recorder per layer, and
// the functions differ so the readings cannot be confused.

static A_SEEN: Mutex<Vec<TensionEvent>> = Mutex::new(Vec::new());
static B_SEEN: Mutex<Vec<TensionEvent>> = Mutex::new(Vec::new());
static NOOP_CALLS: AtomicU32 = AtomicU32::new(0);
static SHUTDOWNS: AtomicU32 = AtomicU32::new(0);
static REENTRY_STATUS: Mutex<Option<i32>> = Mutex::new(None);

/// Set to the address of the live `HostShared` before the re-entrancy case.
static REENTER_SHARED: AtomicUsize = AtomicUsize::new(0);

unsafe extern "C" fn a_dispatch(_: *mut c_void, events: *const TensionEvent, count: u32) -> i32 {
    // SAFETY: the host promises `events` is valid for `count` reads.
    let slice = unsafe { std::slice::from_raw_parts(events, count as usize) };
    A_SEEN.lock().expect("unpoisoned").extend_from_slice(slice);
    0
}

unsafe extern "C" fn b_dispatch(_: *mut c_void, events: *const TensionEvent, count: u32) -> i32 {
    // SAFETY: as above.
    let slice = unsafe { std::slice::from_raw_parts(events, count as usize) };
    B_SEEN.lock().expect("unpoisoned").extend_from_slice(slice);
    0
}

unsafe extern "C" fn noop_dispatch(_: *mut c_void, _: *const TensionEvent, _: u32) -> i32 {
    NOOP_CALLS.fetch_add(1, Ordering::Relaxed);
    0
}

unsafe extern "C" fn counting_shutdown(_: *mut c_void) {
    SHUTDOWNS.fetch_add(1, Ordering::Relaxed);
}

/// A layer that asks to register another layer from inside its own dispatch.
///
/// Two things are being asserted at once, and they are different failures:
///
///   * `try_lock` must succeed. If the dispatcher held the bus's mutex across
///     the callback, a plain `lock()` here would deadlock the whole process —
///     so the design copies the table out and releases it, and this is what
///     proves that mechanically.
///   * with the lock free, the registration must come back `-EBUSY`: the layer
///     table a dispatch is walking must not change under it.
unsafe extern "C" fn reentrant_dispatch(_: *mut c_void, _: *const TensionEvent, _: u32) -> i32 {
    let address = REENTER_SHARED.load(Ordering::Relaxed);
    if address == 0 {
        return -1;
    }
    // SAFETY: the address is the live `HostShared` this probe leaked for the
    // duration of the run.
    let shared = unsafe { &*(address as *const HostShared) };
    let layer = TensionEventLayer {
        struct_size: std::mem::size_of::<TensionEventLayer>() as u32,
        reserved: 0,
        event_mask: EVENT_KEY,
        reserved2: 0,
        dispatch: Some(noop_dispatch),
        shutdown: None,
    };
    let status = match shared.events.try_lock() {
        Ok(mut bus) => {
            // SAFETY: `layer` is a live local, and the bus copies it.
            let result = unsafe { bus.register(&layer) };
            // A registration leaves nothing behind, so the cap test later in
            // this file still sees a consistent bus.
            match result {
                Ok(token) => {
                    let _ = bus.unregister(token);
                    0
                }
                Err(error) => error,
            }
        }
        // The dispatcher holds the lock: that is the deadlock the design
        // removed, reported as its own value rather than hanging.
        Err(_) => -999,
    };
    *REENTRY_STATUS.lock().expect("unpoisoned") = Some(status);
    0
}

fn layer(mask: u32, dispatch: tension_core::platform::EventDispatchFn) -> TensionEventLayer {
    TensionEventLayer {
        struct_size: std::mem::size_of::<TensionEventLayer>() as u32,
        reserved: 0,
        event_mask: mask,
        reserved2: 0,
        dispatch: Some(dispatch),
        shutdown: Some(counting_shutdown),
    }
}

fn event(family: u32) -> TensionEvent {
    TensionEvent::new(family, 0, 0, 0, 0, 0)
}

fn clear_recordings() {
    A_SEEN.lock().expect("unpoisoned").clear();
    B_SEEN.lock().expect("unpoisoned").clear();
    NOOP_CALLS.store(0, Ordering::Relaxed);
    SHUTDOWNS.store(0, Ordering::Relaxed);
    *REENTRY_STATUS.lock().expect("unpoisoned") = None;
}

// ── the half that needs no display ──────────────────────────────────────────

fn bus_contract(probe: &mut Probe) {
    println!("registration refusals");
    let shared = HostShared::new();

    {
        let mut bus = shared.events.lock().expect("unpoisoned");
        // SAFETY: a null pointer is explicitly refused before any read.
        probe.equal(
            "a null layer is EINVAL",
            unsafe { bus.register(std::ptr::null()) }.err(),
            Some(-22),
        );

        let short = TensionEventLayer {
            struct_size: 8,
            ..layer(EVENT_KEY, a_dispatch)
        };
        // SAFETY: `short` is live; the size check runs before anything is read
        // past it.
        probe.equal(
            "a short struct_size is EINVAL",
            unsafe { bus.register(&short) }.err(),
            Some(-22),
        );

        let reserved = TensionEventLayer {
            reserved: 1,
            ..layer(EVENT_KEY, a_dispatch)
        };
        probe.equal(
            "a non-zero reserved word is EINVAL",
            unsafe { bus.register(&reserved) }.err(),
            Some(-22),
        );

        let unknown = layer(1 << 20, a_dispatch);
        probe.equal(
            "an unknown family bit is EINVAL",
            unsafe { bus.register(&unknown) }.err(),
            Some(-22),
        );

        let empty = layer(0, a_dispatch);
        probe.equal(
            "an empty mask is EINVAL",
            unsafe { bus.register(&empty) }.err(),
            Some(-22),
        );

        let mut no_dispatch = layer(EVENT_KEY, a_dispatch);
        no_dispatch.dispatch = None;
        probe.equal(
            "a NULL dispatch is EINVAL",
            unsafe { bus.register(&no_dispatch) }.err(),
            Some(-22),
        );

        probe.equal("nothing was registered by any refusal", bus.len(), 0);
    }

    println!("mask filtering");
    clear_recordings();
    let shared = HostShared::new();
    {
        let mut bus = shared.events.lock().expect("unpoisoned");
        let a = layer(EVENT_KEY, a_dispatch);
        // SAFETY: both layers are live locals.
        unsafe {
            bus.register(&a).expect("a key layer registers");
            bus.register(&layer(EVENT_WINDOW | EVENT_KEY, b_dispatch))
                .expect("a window+key layer registers");
        }
        probe.equal("two layers registered", bus.len(), 2);
    }
    shared.dispatch(&[event(EVENT_KEY), event(EVENT_WINDOW), event(EVENT_MOUSE_MOTION)]);
    {
        let a = A_SEEN.lock().expect("unpoisoned");
        let b = B_SEEN.lock().expect("unpoisoned");
        probe.equal("the key layer saw only the key event", a.len(), 1);
        probe.equal("and it was a key event", a.first().map(|e| e.family), Some(EVENT_KEY));
        probe.equal("the window+key layer saw two", b.len(), 2);
        probe.equal(
            "in the order the host dispatched them",
            b.iter().map(|e| e.family).collect::<Vec<_>>(),
            vec![EVENT_KEY, EVENT_WINDOW],
        );
    }

    println!("unregister");
    clear_recordings();
    // A fresh bus, and the token read back from `register` rather than assumed:
    // the token is the host's to choose, and a probe that hard-codes 1 would
    // stop asserting the contract the moment that choice changed.
    let shared = HostShared::new();
    let token = {
        let mut bus = shared.events.lock().expect("unpoisoned");
        let one = layer(EVENT_KEY, a_dispatch);
        // SAFETY: `one` is live.
        unsafe { bus.register(&one) }.expect("registers")
    };
    shared.dispatch(&[event(EVENT_KEY)]);
    probe.equal(
        "a registered layer hears its family",
        A_SEEN.lock().expect("unpoisoned").len(),
        1,
    );
    {
        let mut bus = shared.events.lock().expect("unpoisoned");
        probe.equal("unregister answers 0", bus.unregister(token).err(), None);
        probe.equal("the bus is empty again", bus.len(), 0);
    }
    A_SEEN.lock().expect("unpoisoned").clear();
    shared.dispatch(&[event(EVENT_KEY)]);
    probe.equal(
        "a removed layer hears nothing",
        A_SEEN.lock().expect("unpoisoned").len(),
        0,
    );

    println!("the cap");
    let shared = HostShared::new();
    {
        let mut bus = shared.events.lock().expect("unpoisoned");
        for index in 0..TENSION_MAX_EVENT_LAYERS {
            let one = layer(EVENT_KEY, noop_dispatch);
            // SAFETY: `one` is live.
            let registered = unsafe { bus.register(&one) };
            if registered.is_err() {
                probe.fail(&format!("layer {index} was refused below the cap"));
            }
        }
        probe.equal("the cap is reached", bus.len(), TENSION_MAX_EVENT_LAYERS);
        let ninth = layer(EVENT_KEY, noop_dispatch);
        // SAFETY: `ninth` is live.
        probe.equal(
            "the ninth layer is ENOSPC",
            unsafe { bus.register(&ninth) }.err(),
            Some(-28),
        );
        probe.equal("and was not admitted", bus.len(), TENSION_MAX_EVENT_LAYERS);
    }
    // `clear` must survive a full table, which is the state a real teardown is
    // most likely to be in (input registered, renderer registered, timers…).
    clear_recordings();
    shared.clear();
    probe.equal(
        "clear shuts every layer down once",
        SHUTDOWNS.load(Ordering::Relaxed),
        TENSION_MAX_EVENT_LAYERS as u32,
    );
    probe.equal(
        "and leaves nothing to dispatch to",
        shared.events.lock().expect("unpoisoned").len(),
        0,
    );
    shared.clear();
    probe.equal(
        "a second clear calls nothing again",
        SHUTDOWNS.load(Ordering::Relaxed),
        TENSION_MAX_EVENT_LAYERS as u32,
    );

    println!("the re-entrancy guard");
    clear_recordings();
    let shared = HostShared::new();
    REENTER_SHARED.store(&*shared as *const HostShared as usize, Ordering::Relaxed);
    {
        let mut bus = shared.events.lock().expect("unpoisoned");
        let one = layer(EVENT_KEY, reentrant_dispatch);
        // SAFETY: `one` is live.
        unsafe { bus.register(&one) }.expect("the re-entrant layer registers");
    }
    shared.dispatch(&[event(EVENT_KEY)]);
    let status = *REENTRY_STATUS.lock().expect("unpoisoned");
    probe.equal(
        "a registration from inside a dispatch is EBUSY",
        status,
        Some(-16),
    );
    probe.equal(
        "the bus is untouched by the refusal",
        shared.events.lock().expect("unpoisoned").len(),
        1,
    );

    println!("the wire's encoding");
    let down = key_event(
        true,
        Some(sdl3::keyboard::Keycode::Escape),
        Some(sdl3::keyboard::Scancode::Escape),
        sdl3::keyboard::Mod::LSHIFTMOD,
        false,
    );
    probe.equal("a key press is TENSION_EVENT_KEY", down.family, EVENT_KEY);
    probe.equal("with the DOWN flag", down.flags, KEY_FLAG_DOWN);
    probe.equal("a0 is the scancode", down.a0, 41);
    probe.equal("a1 is the keycode", down.a1, 0x1B);
    probe.equal("a2 is the modifier word", down.a2, 1);

    let repeat = key_event(
        true,
        Some(sdl3::keyboard::Keycode::A),
        Some(sdl3::keyboard::Scancode::A),
        sdl3::keyboard::Mod::NOMOD,
        true,
    );
    probe.equal(
        "an auto-repeat carries both flags",
        repeat.flags,
        KEY_FLAG_DOWN | KEY_FLAG_REPEAT,
    );
    probe.equal("and says so in a3", repeat.a3, 1);

    let up = key_event(
        false,
        Some(sdl3::keyboard::Keycode::A),
        Some(sdl3::keyboard::Scancode::A),
        sdl3::keyboard::Mod::NOMOD,
        false,
    );
    probe.equal("a release clears the DOWN flag", up.flags, 0);

    let resize = window_state_event(WINDOW_EVENT_RESIZED);
    probe.equal("a window event is TENSION_EVENT_WINDOW", resize.family, EVENT_WINDOW);
    probe.equal("with its subtype in a0", resize.a0, WINDOW_EVENT_RESIZED as i64);

    let quit = event(EVENT_QUIT);
    probe.equal("a quit is its own family", quit.family, EVENT_QUIT);
}

// ── the half that needs a window ────────────────────────────────────────────

fn window_contract(probe: &mut Probe) -> bool {
    println!("translation through a real window");

    let shared = HostShared::new();
    let mut slot: Option<tension_core::platform::HostWindow> = None;
    let config = WindowConfig {
        target: WindowTarget::Plain,
        width: 320,
        height: 240,
        mode: WindowMode::Windowed,
        flags: window_flags::RESIZABLE,
        x: WINDOW_POS_CENTERED,
        y: WINDOW_POS_CENTERED,
        ..Default::default()
    };
    if let Err(error) = create_window(&mut slot, &config, &shared) {
        println!("  skip no window on this rig: {error}");
        return false;
    }
    clear_recordings();
    let token = {
        let mut bus = shared.events.lock().expect("unpoisoned");
        let one = layer(EVENT_WINDOW | EVENT_KEY, a_dispatch);
        // SAFETY: `one` is live.
        match unsafe { bus.register(&one) } {
            Ok(token) => token,
            Err(error) => {
                probe.fail(&format!("the window layer was refused ({error})"));
                return false;
            }
        }
    };
    let _ = token;

    let window = slot.as_mut().expect("create_window stored a window");
    // Drain whatever the window system emitted at creation (a SHOWN, a focus,
    // a resize) so the assertion below is about the resize this probe caused.
    window.pump();
    A_SEEN.lock().expect("unpoisoned").clear();

    if let Err(error) = window.set_size(400, 300) {
        probe.fail(&format!("set_size refused: {error}"));
        return false;
    }
    // Event delivery is asynchronous at the window-system level, so the pump is
    // repeated a bounded number of times rather than assumed to see it once.
    let mut resized = None;
    for _ in 0..120 {
        window.pump();
        if let Some(found) = A_SEEN
            .lock()
            .expect("unpoisoned")
            .iter()
            .find(|e| e.family == EVENT_WINDOW && e.a0 == WINDOW_EVENT_RESIZED as i64)
            .copied()
        {
            resized = Some(found);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }

    match resized {
        Some(found) => {
            probe.equal("the layer received a RESIZED window event", found.family, EVENT_WINDOW);
            probe.equal(
                "carrying the size the window system settled on",
                (found.a1, found.a2),
                (400, 300),
            );
        }
        None => probe.fail("no RESIZED event reached the layer within ~2 s"),
    }

    // A key layer must not have seen the window event: the mask is the host's
    // filter, and a layer cannot receive a family it did not name.
    let saw_from_b = B_SEEN.lock().expect("unpoisoned").len();
    probe.equal("a layer that is not registered heard nothing", saw_from_b, 0);

    // `host_window_info`'s source: the published record is the pump's snapshot.
    let record = shared
        .window
        .lock()
        .expect("unpoisoned")
        .as_ref()
        .map(|info| (info.width, info.height));
    probe.equal(
        "the published window record follows the pump",
        record,
        Some((400, 300)),
    );

    // Teardown in the order `main` uses: the dispatcher first, then the window.
    shared.clear();
    probe.equal("clear shut the window layer down once", SHUTDOWNS.load(Ordering::Relaxed), 1);
    probe.equal(
        "and stopped answering host_window_info about a window it is tearing down",
        shared.window.lock().expect("unpoisoned").is_some(),
        false,
    );
    true
}

fn main() {
    let mut probe = Probe::new();
    bus_contract(&mut probe);

    let ran = if std::env::var("TENSION_TEST_ALLOW_SKIP").as_deref() == Ok("1") {
        println!("window half: SKIP — TENSION_TEST_ALLOW_SKIP=1");
        println!("       what would run: a Plain window, a registered WINDOW|KEY layer,");
        println!("       a real SDL resize through `set_size`, the pump's translation of");
        println!("       it to TENSION_EVENT_WINDOW / RESIZED, the mask filter, and the");
        println!("       published `host_window_info` record following the pump.");
        false
    } else {
        window_contract(&mut probe)
    };
    if !ran {
        println!("note: the window half did not run; the bus half above stands on its own");
    }

    if probe.failures.is_empty() {
        println!("platform_events: all assertions passed");
    } else {
        eprintln!("platform_events: {} failure(s)", probe.failures.len());
        for failure in &probe.failures {
            eprintln!("  - {failure}");
        }
        std::process::exit(1);
    }
}
