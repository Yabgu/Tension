//! The nested guest's frame, on the device that actually draws — on the main thread.
//!
//! # What these five prove
//!
//! 4b-4 taught a capture state to *record* GPU work instead of performing it.
//! These are the tests for the other half — [`Render2dState::replay_deferred`]
//! builds what was recorded, [`Render2dState::forward_into`] moves a record's
//! page to the outer device's numbering, and the pixels prove the two agree.
//!
//! # Why `harness = false`
//!
//! `platform_surface`, `platform_window` and `render2d_open`'s reason, and the
//! one this file was moved for: `sdl3::init()` lets the **first** calling thread
//! claim main-thread status and refuses every later one. A normal `#[test]` runs
//! on a spawned thread.
//!
//! These tests used to live in `src/render2d/device.rs` as five `#[test]`s that
//! serialized on a `Mutex`, on the theory that one dev initialization at a time
//! was the constraint. **It was not.** SDL initializes fine on a libtest worker
//! thread — it is the *teardown* that faults: the last `Sdl` handle drops on a
//! worker thread, Vulkan is torn down from a thread that did not create it, and
//! the process dies with SIGSEGV *after* every assertion in the body has passed.
//! A `Mutex` cannot fix a thread affinity. One `fn main()` on the real main
//! thread can, which is what this binary is. The crash and the isolation that
//! found it are gate finding 9, `docs/backlog/gate-configuration-audit.md`.
//!
//! The assertions are the ones the `#[test]`s made, unchanged: only the harness
//! moved. Each test runs in [`std::panic::catch_unwind`] so one failure reports
//! every other test's verdict in the same run instead of stopping at the first.
//!
//! # What a skip means
//!
//! A machine with no usable GPU skips: the refusal has to *name* the device
//! (`NoDevice`), and anything else fails. Same policy and same one flag as
//! `tests/render2d_open.rs` — `TENSION_TEST_ALLOW_SKIP=1` is the only spelling
//! of "may I skip?", via [`support_ci::skip_allowed`].
//!
//! Run: `cargo test --test replay_device --features render2d-core`.

#[path = "support/ci.rs"]
mod support_ci;

use std::sync::atomic::{AtomicUsize, Ordering};

use tension_core::render2d::device::NESTED_PAGE_BASE;
use tension_core::render2d::pipeline::PIPE_RAW_MIN;
use tension_core::render2d::record::{self, RECORD_SIZE};
use tension_core::render2d::{Render2dError, Render2dState};

/// `TEX_RGBA8` in `src/render2d/device.rs` — the private constant behind the
/// public `texture_load(bytes, target)` argument.
const TEX_RGBA8: i32 = 1;

/// Tests that skipped because the machine has no GPU. Counted so the summary
/// cannot print "PASS" for a run in which nothing ran.
static SKIPPED: AtomicUsize = AtomicUsize::new(0);

/// Build a minimal valid IWI: `components` interleaved 8-bit channels.
///
/// The same container `src/render2d/iwi.rs`'s `iwi_bytes` writes, restated here
/// because that one is `#[cfg(test)] pub(crate)` — visible to the crate's own
/// unit tests, invisible across the crate boundary an integration test sits
/// behind. `tests/render2d_open.rs` builds its container by hand for the same
/// reason and with the same justification: a fixture file would hide which byte
/// was wrong.
fn iwi(width: u32, height: u32, components: u16, pixels: &[u8]) -> Vec<u8> {
    let table = 36 + usize::from(components) * 6;
    let mut bytes = vec![0u8; table];
    bytes[0..4].copy_from_slice(b"IWI1");
    bytes[4..8].copy_from_slice(&width.to_le_bytes());
    bytes[8..12].copy_from_slice(&height.to_le_bytes());
    // 12..16 metaBytes = 0
    // 16..24 storageLayout = interleaved, tightly packed
    // 24..32 payloadEncoding = zero (raw)
    // 32 colorSpace = sRGB, 33 reserved = 0
    bytes[34..36].copy_from_slice(&components.to_le_bytes());
    for i in 0..components {
        let at = 36 + usize::from(i) * 6;
        bytes[at] = i as u8 + 1; // R, G, B, A
        bytes[at + 1] = 2; // CLASS_UNORM
        bytes[at + 2..at + 4].copy_from_slice(&(i * 8).to_le_bytes());
        bytes[at + 4..at + 6].copy_from_slice(&8u16.to_le_bytes());
    }
    bytes.extend_from_slice(pixels);
    bytes
}

/// A solid-colour 8x8 IWI — the canvas's own size, so a record whose `w`/`h`
/// are the canvas maps the whole texture and every pixel of the frame is
/// one colour.
fn solid(color: [u8; 4]) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(8 * 8 * 4);
    for _ in 0..8 * 8 {
        pixels.extend_from_slice(&color);
    }
    iwi(8, 8, 4, &pixels)
}

/// A full-canvas sprite on one page of one pipeline.
fn sprite(page: u16) -> [u8; RECORD_SIZE as usize] {
    let mut record = [0u8; RECORD_SIZE as usize];
    // x, y are already 0 — the canvas's top-left.
    record[record::OFF_W..record::OFF_W + 2].copy_from_slice(&8u16.to_le_bytes());
    record[record::OFF_H..record::OFF_H + 2].copy_from_slice(&8u16.to_le_bytes());
    record[record::OFF_TEX..record::OFF_TEX + 2].copy_from_slice(&page.to_le_bytes());
    // A non-zero key, so the record is not equal to an empty one under the
    // graph's ordering.
    record[record::OFF_SORT_KEY..record::OFF_SORT_KEY + 4]
        .copy_from_slice(&1u32.to_le_bytes());
    record
}

/// An offscreen 8x8 canvas with preset 1 built, or a printed skip.
fn canvas() -> Option<Render2dState> {
    let mut state = Render2dState::default();
    if let Err(error) = state.open_offscreen(8, 8) {
        match error {
            Render2dError::NoDevice(message) => {
                SKIPPED.fetch_add(1, Ordering::Relaxed);
                eprintln!("skipped: no usable GPU device here: {message}");
                return None;
            }
            other => panic!("open_offscreen: {other}"),
        }
    }
    state.set_preset(1).expect("preset 1");
    Some(state)
}

/// Every pixel of the last presented frame, or a panic naming the first that
/// differs.
fn frame_is(state: &mut Render2dState, color: [u8; 4], what: &str) {
    let frame = state.screenshot().expect("screenshot");
    if let Some(first) = frame.chunks_exact(4).position(|px| px != color) {
        panic!(
            "{what}: pixel {first} is {:?}, want {color:?} — the frame did not draw the \
             texture that page holds",
            &frame[first * 4..first * 4 + 4]
        );
    }
}

/// A capture state that loaded one texture, bound it at page 0 of preset 1 if
/// `bind` is set, and presented one full-canvas record naming page 0.
fn nested(bind: bool) -> Render2dState {
    let mut capture = Render2dState::capture();
    let pipe = capture.set_preset(1).expect("preset 1 in capture mode");
    let texture = capture
        .texture_load(&solid([255, 0, 0, 255]), TEX_RGBA8)
        .expect("a valid IWI in capture mode");
    if bind {
        capture.set_texture(pipe, 0, texture).expect("bind page 0");
    }
    capture
        .submit(pipe, &sprite(0), 1, RECORD_SIZE, 0)
        .expect("the capture state stages the frame");
    capture.present(&mut None).expect("a capture presents");
    capture
}

/// The bytes a nested frame leaves for the outer guest, with the outer
/// device's page numbers in them.
fn forwarded(capture: &Render2dState) -> Vec<u8> {
    let mut bytes = vec![0u8; capture.captured_bytes()];
    capture
        .forward_into(&mut bytes, NESTED_PAGE_BASE)
        .expect("the page base fits");
    bytes
}

/// `nested_iwi_lands_at_outer_page_base`.
///
/// The outer draws blue from page 0; the nested guest loads red and binds it
/// at its own page 0. After the replay, the forwarded record names page 1 and
/// the frame is **red**: page 0 was not touched and the nested atlas is one
/// page up. A replay that skipped either step draws the outer's blue here.
fn nested_iwi_lands_at_outer_page_base() {
    let Some(mut outer) = canvas() else { return };

    let blue = outer
        .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
        .expect("the outer's own texture");
    outer.set_texture(1, 0, blue).expect("the outer binds page 0");

    let capture = nested(true);
    let replay = outer
        .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
        .expect("the replay builds the nested scene");

    let pipe = *replay
        .pipelines
        .get(&1)
        .expect("the nested preset 1 was built on this device");
    assert!(
        pipe >= PIPE_RAW_MIN,
        "the replay builds its own pipeline, so the id is in the runtime range: got {pipe}"
    );
    assert_ne!(pipe, 1, "and it is not the id the capture used — preset 1 belongs to the UI");
    assert_eq!(replay.textures.len(), 1, "one texture was recorded and loaded");
    assert_eq!(
        replay.pages,
        vec![(pipe, NESTED_PAGE_BASE, 2)],
        "the recorded page 0 is bound one page up, as the outer's texture 2"
    );

    let records = forwarded(&capture);
    outer
        .submit(pipe, &records, 1, RECORD_SIZE, 0)
        .expect("the outer submits the forwarded frame");
    outer.present(&mut None).expect("present");
    frame_is(&mut outer, [255, 0, 0, 255], "nested_iwi_lands_at_outer_page_base");
}

/// `nested_guest_implicit_page_zero_is_reapplied_at_base`.
///
/// The same frame, but the nested guest never calls `set_texture`: its record
/// names page 0 and means "the atlas I just loaded", which is what a
/// presenting state would serve. The replay has to make that explicit **at
/// the base** — not at 0, where the outer's blue lives.
fn nested_guest_implicit_page_zero_is_reapplied_at_base() {
    let Some(mut outer) = canvas() else { return };

    let blue = outer
        .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
        .expect("the outer's own texture");
    outer.set_texture(1, 0, blue).expect("the outer binds page 0");

    let capture = nested(false);
    assert!(
        capture.deferred().bindings.is_empty(),
        "the guest bound nothing, which is the case under test"
    );
    let replay = outer
        .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
        .expect("the replay reapplies the implicit page");

    let pipe = *replay.pipelines.get(&1).expect("the nested preset 1");
    assert_eq!(
        replay.pages,
        vec![(pipe, NESTED_PAGE_BASE, 2)],
        "the implicit page 0 is bound at the base, not at 0"
    );

    let records = forwarded(&capture);
    outer
        .submit(pipe, &records, 1, RECORD_SIZE, 0)
        .expect("submit");
    outer.present(&mut None).expect("present");
    frame_is(
        &mut outer,
        [255, 0, 0, 255],
        "nested_guest_implicit_page_zero_is_reapplied_at_base",
    );
}

/// `a_preset_the_outer_already_draws_gets_a_second_pipeline`.
///
/// **The editor's exact case, measured before it worked.** The editor's UI is
/// preset 1 with 640x500 font pages; the nested isometric scene is preset 1
/// with 128x128 pages. A replay that resolved preset 1 to the id the UI already
/// holds sent every nested page into the UI's array and was refused
/// (`-EINVAL`, "every page of one pipeline shares the array's size"), so the
/// demo drew nothing. Here the outer's page is 2x1 and the nested's is 8x8: the
/// replay has to give the nested guest a pipeline of its own, and the outer's
/// own record must still draw the outer's atlas through the *same* page 0.
fn a_preset_the_outer_already_draws_gets_a_second_pipeline() {
    let Some(mut outer) = canvas() else { return };

    // The outer's UI: preset 1, its own small atlas at page 0.
    let blue = outer
        .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
        .expect("the outer's own texture");
    outer.set_texture(1, 0, blue).expect("the outer binds preset 1 page 0");

    let capture = nested(true);
    let replay = outer
        .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
        .expect("the nested guest's preset 1 must not be refused by the outer's");
    let pipe = *replay.pipelines.get(&1).expect("a pipeline for the nested preset 1");
    assert_ne!(pipe, 1, "a second pipeline, not the UI's");
    assert_eq!(
        replay.pages,
        vec![(pipe, NESTED_PAGE_BASE, 2)],
        "the nested page went to the nested pipeline, not into the UI's array"
    );

    // The nested frame draws the nested atlas...
    let records = forwarded(&capture);
    outer.submit(pipe, &records, 1, RECORD_SIZE, 0).expect("submit nested");
    outer.present(&mut None).expect("present");
    frame_is(
        &mut outer,
        [255, 0, 0, 255],
        "a_preset_the_outer_already_draws_gets_a_second_pipeline (nested)",
    );

    // ...and the outer's own record still draws its own, from the same page 0.
    outer.submit(1, &sprite(0), 1, RECORD_SIZE, 0).expect("submit outer");
    outer.present(&mut None).expect("present");
    frame_is(
        &mut outer,
        [0, 0, 255, 255],
        "a_preset_the_outer_already_draws_gets_a_second_pipeline (outer)",
    );
}

/// `a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline`.
///
/// The outer's implicit texture is a small generated atlas (the editor's
/// 128x32 box cells); the nested scene's pages are 1024x1024. One array has
/// one size, so the outer's texture cannot be page 0 of the nested pipeline —
/// and binding it there would refuse the whole replay. The replay skips the
/// preservation, binds the nested page at the base, and the frame draws.
fn a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline() {
    let Some(mut outer) = canvas() else { return };

    // The outer's own atlas: 2x1, one page, never bound explicitly.
    let small = iwi(2, 1, 4, &[9, 8, 7, 6, 5, 4, 3, 2]);
    outer
        .texture_load(&small, TEX_RGBA8)
        .expect("the outer's small atlas");

    // The nested frame's page is 8x8, like the canvas.
    let capture = nested(true);
    let replay = outer
        .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
        .expect("a size mismatch on the outer's implicit page must not refuse the replay");
    let pipe = *replay.pipelines.get(&1).expect("the nested preset 1");
    assert_eq!(
        replay.pages,
        vec![(pipe, NESTED_PAGE_BASE, 2)],
        "only the nested page is bound: the outer's 2x1 could not be page 0 of an 8x8 array"
    );

    let records = forwarded(&capture);
    outer.submit(pipe, &records, 1, RECORD_SIZE, 0).expect("submit");
    outer.present(&mut None).expect("present");
    frame_is(
        &mut outer,
        [255, 0, 0, 255],
        "a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline",
    );
}

/// The other half of the implicit rule: making a nested page explicit must
/// not cost the **outer** its implicit page 0.
///
/// Here the outer loads blue and binds nothing — it relies on the implicit
/// page, as every v1 caller does. The nested guest binds its own page 0. The
/// replay has to write the outer's page 0 down (blue) before binding red at
/// page 1, or the outer's own record would sample an unbound layer. The frame
/// is blue: the outer's record, reading page 0, still gets the outer's
/// texture.
fn the_replay_keeps_the_outer_implicit_page_zero() {
    let Some(mut outer) = canvas() else { return };

    outer
        .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
        .expect("the outer's own texture, never bound");

    let capture = nested(true);
    let replay = outer
        .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
        .expect("the replay builds the nested scene");
    assert_eq!(
        replay.pages,
        vec![(*replay.pipelines.get(&1).unwrap(), NESTED_PAGE_BASE, 2)],
        "the report names the nested page only; the outer's page 0 is not part of it"
    );

    // The outer's own record: page 0, exactly as it wrote it before Play.
    outer
        .submit(1, &sprite(0), 1, RECORD_SIZE, 0)
        .expect("submit");
    outer.present(&mut None).expect("present");
    frame_is(
        &mut outer,
        [0, 0, 255, 255],
        "the_replay_keeps_the_outer_implicit_page_zero",
    );
}

fn main() {
    let tests: &[(&str, fn())] = &[
        (
            "nested_iwi_lands_at_outer_page_base",
            nested_iwi_lands_at_outer_page_base,
        ),
        (
            "nested_guest_implicit_page_zero_is_reapplied_at_base",
            nested_guest_implicit_page_zero_is_reapplied_at_base,
        ),
        (
            "a_preset_the_outer_already_draws_gets_a_second_pipeline",
            a_preset_the_outer_already_draws_gets_a_second_pipeline,
        ),
        (
            "a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline",
            a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline,
        ),
        (
            "the_replay_keeps_the_outer_implicit_page_zero",
            the_replay_keeps_the_outer_implicit_page_zero,
        ),
    ];

    if support_ci::skip_allowed() {
        println!(
            "replay_device: SKIP — TENSION_TEST_ALLOW_SKIP=1 ({} test(s), none ran)",
            tests.len()
        );
        println!("       reason a rig needs it: no GPU (Mesa dzn cannot create graphics");
        println!("       pipelines; the pre-port C++ renderer fails the same way)");
        return;
    }

    // Both are upgraded from `#[test]` (one process, one thread) to explicit
    // accounting: `cargo test` printed a line per test, and a harness=false
    // binary owes the reader the same verdicts.
    let mut failed: Vec<&str> = Vec::new();
    for (name, test) in tests {
        // The panic hook still prints the assertion's own message and location;
        // catching only lets the remaining tests run and be reported.
        match std::panic::catch_unwind(test) {
            Ok(()) => println!("test {name} ... ok"),
            Err(_) => {
                println!("test {name} ... FAILED");
                failed.push(name);
            }
        }
    }

    let skipped = SKIPPED.load(Ordering::Relaxed);
    if failed.is_empty() {
        let ran = tests.len() - skipped;
        if skipped == 0 {
            println!("\nreplay_device: PASS ({} test(s))", tests.len());
        } else {
            println!(
                "\nreplay_device: PASS ({ran} ran, {skipped} skipped — no GPU on this machine)"
            );
        }
    } else {
        println!(
            "\nreplay_device: FAIL ({} of {} test(s), {skipped} skipped)",
            failed.len(),
            tests.len()
        );
        for name in &failed {
            println!("  - {name}");
        }
        std::process::exit(1);
    }
}
