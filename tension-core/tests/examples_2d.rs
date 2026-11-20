//! The 2D examples, run and asserted from Rust.
//!
//! These six tests used to be `examples/2d/*/test.mjs`: a Node runner per
//! example that built the guest, ran `tension-core`, and parsed the guest's
//! stdout. The assertions were the only part that mattered, and they belong
//! here — a test's subject is a TensionScript program, and this repository's
//! test language is Rust.
//!
//! Node still appears, and only as build tooling: `build-2d-guest.mjs` compiles
//! the guest, `build-2d.mjs` emits the shader modules, `pack-example.mjs` packs
//! a resource volume, and the isometric scene generator writes the pages. Those
//! are the same recipes `npm run build` uses. Nothing here asks Node to decide
//! whether a frame is correct.
//!
//! What each test reads from the guest's stdout:
//!
//! 1. **hello-sprites** — ten sprites, `10240` non-black pixels (10 x 32x32),
//!    and the guest's own `OK:` line after sampling every sprite's centre.
//! 2. **box-physics** — at least 100 resolved contact pairs, at least 20000
//!    non-black pixels, and the full-simulation verdict.
//! 3. **stiff-boxes** — the packed volume's texture, the BDF2 solver, frame 150,
//!    and no `ERROR:` line.
//! 4. **isometric (art)** — the committed tileset, three pages, the composite
//!    and depth probes, and both revert levers.
//! 5. **isometric (synthetic)** — the same claims from flat-colour pages.
//! 6. **isometric-framework** — the framework's frames byte-identical to the
//!    hand-written scene's, plus the probes and three revert levers.
//!
//! The frames are the guest's `FRAME <name> <offset> <hex>` lines, reassembled
//! here. That protocol exists because a guest has no file writer; it is the
//! same bytes a screenshot would carry, so no PNG decoder is needed. The PNGs
//! the old runners wrote under `screenshots/` were human artifacts, not
//! assertions; they are not regenerated here (see the milestone report).
//!
//! Skip policy: `tests/support/ci.rs`. A machine that cannot create a graphics
//! pipeline, or a build step that fails, prints a skip only with
//! `TENSION_TEST_ALLOW_SKIP=1`; otherwise it fails, and the message names the
//! artifact or the command.
//!
//! Serialized: the isometric tests write the same `examples/2d/isometric`
//! build tree, so the whole file takes one lock. `cargo test --test
//! examples_2d` is therefore safe at cargo's default test parallelism.

#[path = "support/ci.rs"]
mod support_ci;

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// One lock for the whole file. The three isometric tests all write
/// `examples/2d/isometric/{assets,src,build}`, and a parallel cargo run would
/// interleave an asset generator with a compile.
fn serial() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tension-core is a directory under the repository root")
        .to_path_buf()
}

fn example(name: &str) -> PathBuf {
    repo().join("examples").join("2d").join(name)
}

fn script(name: &str) -> PathBuf {
    repo().join("scripts").join(name)
}

/// Run one command and decide what a failure means.
///
/// A build step is a fixture: absent or broken means the test cannot observe
/// anything. The repository's one policy applies — fail by default, skip only
/// with `TENSION_TEST_ALLOW_SKIP=1` — and the message names the exact command.
fn step(program: &Path, args: &[String], cwd: &Path, what: &str) -> bool {
    let status = Command::new(program).args(args).current_dir(cwd).status();
    match status {
        Ok(status) if status.success() => true,
        Ok(status) => {
            support_ci::skip_or_fail(format_args!(
                "examples_2d: {what} failed ({status}): {} {} (in {})",
                program.display(),
                args.join(" "),
                cwd.display()
            ));
            false
        }
        Err(error) => {
            support_ci::skip_or_fail(format_args!(
                "examples_2d: could not run {} for {what}: {error}",
                program.display()
            ));
            false
        }
    }
}

fn node(script_path: &Path, args: &[String], cwd: &Path, what: &str) -> bool {
    let mut all = vec![script_path.to_string_lossy().into_owned()];
    all.extend(args.iter().cloned());
    step(Path::new("node"), &all, cwd, what)
}

/// The compiler entry point every example's `npm run build` uses.
fn build_guest(dir: &Path) -> bool {
    node(
        &script("build-2d-guest.mjs"),
        &[],
        dir,
        &format!("building the guest in {}", dir.display()),
    )
}

/// Shader modules, emitted when missing. Since Pass B the renderer is in core
/// and this produces modules and a graph blob, not a DSO.
fn ensure_shaders() -> bool {
    let vert = repo()
        .join("tension-2d")
        .join("build")
        .join("shaders")
        .join("default_2d.vert.spv");
    if vert.exists() {
        return true;
    }
    node(
        &script("build-2d.mjs"),
        &[],
        &repo(),
        "building the 2D shader modules",
    )
}

/// The bisect DSO, when one was built. An in-core run must not be handed a
/// capability it would skip.
fn capability() -> Vec<String> {
    let dso = repo().join("tension-2d").join("build").join(if cfg!(windows) {
        "libtension_2d.dll"
    } else {
        "libtension_2d.so"
    });
    if dso.exists() {
        vec![
            "--capability".to_string(),
            dso.to_string_lossy().into_owned(),
        ]
    } else {
        Vec::new()
    }
}

/// Pack the example's `assets/` into the volume its `package.json` names.
fn pack(dir: &Path) -> bool {
    node(
        &script("pack-example.mjs"),
        &[".".to_string()],
        dir,
        &format!("packing {}", dir.display()),
    )
}

/// Run the host on one guest, headless.
fn run_core(dir: &Path, before: &[String], guest: &Path, after: &[String]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tension-core"));
    command.args(before).arg(guest).args(after);
    command
        .current_dir(dir)
        .env("SDL_VIDEODRIVER", "offscreen");
    command.output().expect("the interpreter starts")
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn assert_exit(output: &Output, what: &str) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{what}: tension-core exited {:?}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(10).collect::<Vec<_>>().join("\n")
    );
}

/// A graphics pipeline the driver refused is environmental, not a guest bug.
/// The old runners named each Vulkan failure code; this returns the same kind
/// of sentence, or `None`.
fn gpu_refusal(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Some(at) = line.find("vkCreateGraphicsPipeline") {
            let rest = line[at..].split_whitespace().collect::<Vec<_>>();
            let code = rest
                .iter()
                .find(|token| token.starts_with("VK_"))
                .map(|token| token.trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_'))
                .unwrap_or("pipeline creation refused");
            return Some(format!(
                "this machine could not create a graphics pipeline ({code})"
            ));
        }
        if line.contains("set_pipeline -> -5") {
            return Some(
                "this machine could not create a graphics pipeline (set_pipeline -> -5)"
                    .to_string(),
            );
        }
    }
    None
}

/// Skip (or fail) before judging a guest whose frames a driver would not draw.
fn check_gpu(output: &str, context: &str) -> bool {
    if let Some(why) = gpu_refusal(output) {
        support_ci::skip_or_fail(format_args!(
            "{context}: {why}. That is the driver, not the example; CI's lavapipe \
             provides a conformant Vulkan ICD (see docs/known-limitations.md)"
        ));
        return false;
    }
    true
}

/// The number before `suffix` on the first line that carries it.
fn number_before(output: &str, suffix: &str) -> Option<u64> {
    for line in output.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        for (index, token) in tokens.iter().enumerate() {
            if *token == suffix && index > 0 {
                if let Ok(value) = tokens[index - 1]
                    .trim_end_matches(',')
                    .parse::<u64>()
                {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// Reassemble the guest's `FRAME <name> <offset> <hex>` lines.
fn frames(stdout: &str) -> BTreeMap<String, Vec<u8>> {
    let mut chunks: BTreeMap<String, BTreeMap<usize, Vec<u8>>> = BTreeMap::new();
    for line in stdout.lines() {
        let mut parts = line.split(' ');
        if parts.next() != Some("FRAME") {
            continue;
        }
        let (Some(name), Some(offset), Some(hex)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let Ok(offset) = offset.parse::<usize>() else {
            continue;
        };
        let mut bytes = Vec::with_capacity(hex.len() / 2);
        let mut digits = hex.as_bytes().chunks_exact(2);
        let mut ok = true;
        for pair in &mut digits {
            let text = std::str::from_utf8(pair).unwrap_or("");
            match u8::from_str_radix(text, 16) {
                Ok(byte) => bytes.push(byte),
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && hex.len() % 2 == 0 {
            chunks.entry(name.to_string()).or_default().insert(offset, bytes);
        }
    }
    chunks
        .into_iter()
        .map(|(name, parts)| {
            let mut rgba = Vec::new();
            for bytes in parts.values() {
                rgba.extend_from_slice(bytes);
            }
            (name, rgba)
        })
        .collect()
}

fn frame<'a>(frames: &'a BTreeMap<String, Vec<u8>>, name: &str) -> &'a [u8] {
    frames
        .get(name)
        .unwrap_or_else(|| panic!("the guest printed no `{name}` frame"))
}

fn pixel_rgba(rgba: &[u8], width: i32, x: i32, y: i32) -> [u8; 3] {
    let at = ((y * width + x) * 4) as usize;
    [rgba[at], rgba[at + 1], rgba[at + 2]]
}

fn close(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 2)
}

/// Assert one probe's colour, with the coordinate and both colours in the
/// message — the shape the old runners printed per failure.
fn expect_pixel(rgba: &[u8], width: i32, probe: (i32, i32), want: [u8; 3], what: &str) {
    let got = pixel_rgba(rgba, width, probe.0, probe.1);
    assert!(
        close(got, want),
        "{what}: ({},{}) is ({},{},{}), expected ({},{},{})",
        probe.0,
        probe.1,
        got[0],
        got[1],
        got[2],
        want[0],
        want[1],
        want[2]
    );
}

// ── scene.json helpers ──────────────────────────────────────────────────────

fn colour(value: &Value) -> [u8; 3] {
    let array = value.as_array().unwrap_or_else(|| panic!("{value} is not a colour"));
    [
        array[0].as_u64().expect("a channel") as u8,
        array[1].as_u64().expect("a channel") as u8,
        array[2].as_u64().expect("a channel") as u8,
    ]
}

fn point(value: &Value) -> (i32, i32) {
    (
        value["x"].as_i64().expect("a probe x") as i32,
        value["y"].as_i64().expect("a probe y") as i32,
    )
}

fn load_scene(dir: &Path) -> Value {
    let path = dir.join("scene.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

fn canvas(scene: &Value) -> (i32, i32) {
    (
        scene["canvas"]["w"].as_i64().expect("canvas.w") as i32,
        scene["canvas"]["h"].as_i64().expect("canvas.h") as i32,
    )
}

// ── the six examples ────────────────────────────────────────────────────────

#[test]
fn hello_sprites_draw_ten_at_recorded_positions() {
    let _serial = serial();
    if !ensure_shaders() {
        return;
    }
    let dir = example("hello-sprites");
    if !build_guest(&dir) {
        return;
    }
    let output = run_core(&dir, &capability(), &dir.join("build").join("game.wasm"), &[]);
    let all = text(&output);
    if !check_gpu(&all, "hello-sprites") {
        return;
    }
    assert_exit(&output, "hello-sprites");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        all.contains("OK: ten sprites at their recorded positions"),
        "the guest did not print its OK line\n{all}"
    );
    let drawn = number_before(&all, "non-black")
        .unwrap_or_else(|| panic!("the guest printed no pixel count\n{all}"));
    // 10 sprites x 32x32 — the C++ stub's count, deliberately not the guest's
    // own "expected" value: a checker that trusts the number produced by the
    // same constant that drew the frame cannot catch a wrong size.
    assert_eq!(
        drawn, 10240,
        "the guest drew {drawn} non-black pixels, expected 10240 (10 x 32x32)\n{stdout}"
    );
}

#[test]
fn box_physics_resolves_contacts_and_rotates() {
    let _serial = serial();
    let dir = example("box-physics");
    if !build_guest(&dir) {
        return;
    }
    let output = run_core(&dir, &capability(), &dir.join("build").join("game.wasm"), &[]);
    let all = text(&output);
    if !check_gpu(&all, "box-physics") {
        return;
    }
    assert_exit(&output, "box-physics");

    let contacts = number_before(&all, "contact")
        .unwrap_or_else(|| panic!("the guest printed no contact count\n{all}"));
    assert!(
        contacts >= 100,
        "only {contacts} contact pairs resolved; the narrow phase is not being exercised\n{all}"
    );
    let pixels = number_before(&all, "non-black")
        .unwrap_or_else(|| panic!("the guest printed no pixel count\n{all}"));
    assert!(
        pixels >= 20000,
        "only {pixels} non-black pixels rendered; the frame is nearly empty\n{all}"
    );
    assert!(
        all.contains("OK: full 2d box physics simulation verified"),
        "the simulation's own verdict is missing\n{all}"
    );
}

#[test]
fn stiff_boxes_run_bdf2_on_a_packed_volume() {
    let _serial = serial();
    let dir = example("stiff-boxes");
    let here = dir.to_string_lossy().into_owned();
    if !node(
        &dir.join("emit-boxes.mjs"),
        &[],
        &dir,
        "generating the compile-time box textures",
    ) {
        return;
    }
    if !build_guest(&dir) {
        return;
    }
    if !node(
        &script("pack-example.mjs"),
        &[here],
        &dir,
        "packing the stiff-boxes volume",
    ) {
        return;
    }
    let volume = dir.join("build").join("stiff-boxes.tns");
    if !volume.exists() {
        support_ci::skip_or_fail(format_args!(
            "stiff_boxes: {} was not produced by the pack step",
            volume.display()
        ));
        return;
    }
    let before = vec!["--res".to_string(), volume.to_string_lossy().into_owned()];
    let output = run_core(&dir, &before, &dir.join("build").join("game.wasm"), &[]);
    let all = text(&output);
    if !check_gpu(&all, "stiff-boxes") {
        return;
    }
    assert_exit(&output, "stiff-boxes");

    for needle in [
        "OK: Texture loaded from resource volume",
        "OK: Solver initialized with BDF2",
        "OK: Frame 150 reached",
        "OK: stiff-boxes BDF2 simulation stable",
    ] {
        assert!(all.contains(needle), "missing {needle:?}\n{all}");
    }
    assert!(
        !all.contains("ERROR:"),
        "the simulation reported an error\n{all}"
    );
}

/// Build the hand-written isometric scene from the committed tileset.
fn prepare_art(dir: &Path) -> bool {
    node(
        &dir.join("build.mjs"),
        &[],
        dir,
        "slicing the tileset into pages",
    ) && ensure_shaders()
        && build_guest(dir)
        && pack(dir)
}

/// Run a scene with `args`, mounting `volume_name` out of its `build/`.
fn run_scene(dir: &Path, volume_name: &str, args: &[String]) -> Output {
    let volume = dir.join("build").join(volume_name);
    let mut before = capability();
    before.push("--res".to_string());
    before.push(volume.to_string_lossy().into_owned());
    run_core(dir, &before, &dir.join("build").join("game.wasm"), args)
}

/// Run the art scene with `args`, returning its frames.
fn run_art(dir: &Path, args: &[String]) -> Output {
    run_scene(dir, "isometric.tns", args)
}

#[test]
fn isometric_art_holds_the_probes_and_both_reverts() {
    let _serial = serial();
    let dir = example("isometric");
    let tileset = repo().join("examples").join("2d").join("assets").join("tileset.png");
    assert!(
        tileset.exists(),
        "{} is missing.\n  It is generated, not fetched: node examples/2d/assets/build-tileset.mjs",
        tileset.display()
    );
    if !prepare_art(&dir) {
        return;
    }
    let scene = load_scene(&dir);
    let (width, height) = canvas(&scene);

    let normal = run_art(&dir, &[]);
    let all = text(&normal);
    if !check_gpu(&all, "isometric") {
        return;
    }
    assert_exit(&normal, "isometric");

    let parsed = frames(&String::from_utf8_lossy(&normal.stdout));
    let back = frame(&parsed, "back");
    let front = frame(&parsed, "front");
    for (name, rgba) in [("back", back), ("front", front)] {
        assert_eq!(
            rgba.len(),
            (width * height * 4) as usize,
            "frame {name}: {} bytes, expected {}",
            rgba.len(),
            width * height * 4
        );
    }

    let probes = &scene["probes"];
    let expect = &scene["expect"];
    expect_pixel(
        back,
        width,
        point(&probes["composite"]),
        colour(&expect["compositeBack"]),
        "composite (back): the backpack is not on top",
    );
    expect_pixel(
        front,
        width,
        point(&probes["composite"]),
        colour(&expect["compositeFront"]),
        "composite (front): the body is not on top",
    );
    expect_pixel(
        back,
        width,
        point(&probes["crown"]),
        colour(&expect["crownBack"]),
        "depth: the tree crown covers the character",
    );
    expect_pixel(
        back,
        width,
        point(&probes["lantern"]),
        colour(&expect["lantern"]),
        "depth: the character covers the lantern",
    );
    expect_pixel(
        back,
        width,
        point(&probes["pageA"]),
        colour(&expect["pageA"]),
        "multi-atlas: page A",
    );
    expect_pixel(
        back,
        width,
        point(&probes["lantern"]),
        colour(&expect["pageB"]),
        "multi-atlas: page B",
    );
    expect_pixel(
        back,
        width,
        point(&probes["composite"]),
        colour(&expect["pageC"]),
        "multi-atlas: page C",
    );

    // The two revert levers. Each asks for a scene wrong in one way and checks
    // the specific colour that mistake produces — a revert test that passes
    // because its assertion is broken is worse than none.
    let swapped = run_art(&dir, &["--swap-composite".to_string()]);
    assert_exit(&swapped, "isometric --swap-composite");
    let swapped_frames = frames(&String::from_utf8_lossy(&swapped.stdout));
    let swapped_back = frame(&swapped_frames, "back");
    let got = pixel_rgba(
        swapped_back,
        width,
        point(&probes["composite"]).0,
        point(&probes["composite"]).1,
    );
    assert!(
        !close(got, colour(&expect["compositeBack"])),
        "revert composite: the probe still shows the correct colour — the assertion it breaks never tested anything"
    );
    assert!(
        close(got, colour(&expect["compositeFront"])),
        "revert composite: probe shows ({},{},{}), expected the mistake's ({},{},{})",
        got[0],
        got[1],
        got[2],
        colour(&expect["compositeFront"])[0],
        colour(&expect["compositeFront"])[1],
        colour(&expect["compositeFront"])[2],
    );

    let behind = run_art(&dir, &["--lantern-behind".to_string()]);
    assert_exit(&behind, "isometric --lantern-behind");
    let behind_frames = frames(&String::from_utf8_lossy(&behind.stdout));
    let behind_back = frame(&behind_frames, "back");
    let got = pixel_rgba(
        behind_back,
        width,
        point(&probes["lantern"]).0,
        point(&probes["lantern"]).1,
    );
    assert!(
        !close(got, colour(&expect["lantern"])),
        "revert sort: the lantern still shows its correct colour"
    );
    assert!(
        close(got, colour(&expect["lanternBehind"])),
        "revert sort: probe shows ({},{},{}), expected the mistake's lantern-behind colour",
        got[0],
        got[1],
        got[2],
    );
}

/// Emit the synthetic pages and build the guest in `dir`.
fn prepare_synthetic(dir: &Path) -> bool {
    let emit = repo()
        .join("examples")
        .join("2d")
        .join("synthetic")
        .join("emit.mjs");
    node(
        &emit,
        &[dir.to_string_lossy().into_owned()],
        &repo(),
        &format!("emitting the synthetic scene into {}", dir.display()),
    ) && ensure_shaders()
        && build_guest(dir)
        && pack(dir)
}

fn run_synthetic(dir: &Path, args: &[String]) -> Output {
    run_scene(dir, "isometric.tns", args)
}

/// The framework example packs to its own volume name.
fn run_framework(dir: &Path, args: &[String]) -> Output {
    run_scene(dir, "isometric-framework.tns", args)
}

#[test]
fn isometric_synthetic_holds_the_same_probes() {
    let _serial = serial();
    let dir = example("isometric");
    if !prepare_synthetic(&dir) {
        return;
    }
    let scene = load_scene(&dir);
    let (width, _) = canvas(&scene);

    let normal = run_synthetic(&dir, &[]);
    let all = text(&normal);
    if !check_gpu(&all, "isometric-synthetic") {
        return;
    }
    assert_exit(&normal, "isometric-synthetic");

    let parsed = frames(&String::from_utf8_lossy(&normal.stdout));
    let back = frame(&parsed, "back");
    let front = frame(&parsed, "front");
    let probes = &scene["probes"];
    let expect = &scene["expect"];

    expect_pixel(
        back,
        width,
        point(&probes["hair"]),
        colour(&expect["back"]["hair"]),
        "composite (back): the hair is not on top at the centre",
    );
    expect_pixel(
        back,
        width,
        point(&probes["pack"]),
        colour(&expect["back"]["pack"]),
        "composite (back): the backpack is not on top at the lower back",
    );
    expect_pixel(
        front,
        width,
        point(&probes["hair"]),
        colour(&expect["front"]["hair"]),
        "composite (front): the body is not on top at the centre",
    );
    expect_pixel(
        front,
        width,
        point(&probes["pack"]),
        colour(&expect["front"]["pack"]),
        "composite (front): the body is not on top at the lower back",
    );
    expect_pixel(
        back,
        width,
        point(&probes["crownOnly"]),
        colour(&expect["back"]["crownOnly"]),
        "depth: the crown is not visible beside the character",
    );
    expect_pixel(
        back,
        width,
        point(&probes["crownOver"]),
        colour(&expect["back"]["crownOver"]),
        "depth: the crown covers the character",
    );
    expect_pixel(
        back,
        width,
        point(&probes["trunkOver"]),
        colour(&expect["back"]["trunkOver"]),
        "depth: the trunk does not cover the character",
    );
    expect_pixel(
        back,
        width,
        point(&probes["pageA"]),
        colour(&expect["back"]["pageA"]),
        "multi-atlas: page A",
    );
    expect_pixel(
        back,
        width,
        point(&probes["lantern"]),
        colour(&expect["back"]["pageB"]),
        "multi-atlas: page B",
    );
    expect_pixel(
        back,
        width,
        point(&probes["pack"]),
        colour(&expect["back"]["pageC"]),
        "multi-atlas: page C",
    );

    let swapped = run_synthetic(&dir, &["--swap-composite".to_string()]);
    assert_exit(&swapped, "isometric-synthetic --swap-composite");
    let swapped_frames = frames(&String::from_utf8_lossy(&swapped.stdout));
    let got = pixel_rgba(
        frame(&swapped_frames, "back"),
        width,
        point(&probes["pack"]).0,
        point(&probes["pack"]).1,
    );
    assert!(
        !close(got, colour(&expect["back"]["pack"])),
        "revert composite: the probe still shows the correct colour"
    );
    assert!(
        close(got, colour(&expect["wrong"]["compositeSwapped"])),
        "revert composite: probe shows ({},{},{}), expected the mistake's body colour",
        got[0],
        got[1],
        got[2]
    );

    let behind = run_synthetic(&dir, &["--lantern-behind".to_string()]);
    assert_exit(&behind, "isometric-synthetic --lantern-behind");
    let behind_frames = frames(&String::from_utf8_lossy(&behind.stdout));
    let got = pixel_rgba(
        frame(&behind_frames, "back"),
        width,
        point(&probes["lantern"]).0,
        point(&probes["lantern"]).1,
    );
    assert!(
        !close(got, colour(&expect["back"]["lantern"])),
        "revert sort: the lantern still shows its correct colour"
    );
    assert!(
        close(got, colour(&expect["wrong"]["lanternBehind"])),
        "revert sort: probe shows ({},{},{}) instead of the character's colour",
        got[0],
        got[1],
        got[2]
    );
}

/// Compare two frames and name the first differing pixel.
fn assert_bytes_equal(a: &[u8], b: &[u8], width: i32, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: {} bytes vs {}", a.len(), b.len());
    if a == b {
        return;
    }
    let first = a
        .chunks_exact(4)
        .zip(b.chunks_exact(4))
        .position(|(x, y)| x != y)
        .expect("lengths are equal and the slices differ") as i32;
    let at = first * 4;
    panic!(
        "{what}: first differing pixel at ({},{}): framework ({},{},{}) vs hand ({},{},{})",
        first % width,
        first / width,
        a[at as usize],
        a[at as usize + 1],
        a[at as usize + 2],
        b[at as usize],
        b[at as usize + 1],
        b[at as usize + 2]
    );
}

#[test]
fn isometric_framework_is_byte_identical_to_the_hand_written_scene() {
    let _serial = serial();
    let hand_dir = example("isometric");
    let framework_dir = example("isometric-framework");
    if !prepare_synthetic(&hand_dir) || !prepare_synthetic(&framework_dir) {
        return;
    }
    let scene = load_scene(&framework_dir);
    let (width, _) = canvas(&scene);

    let hand = run_synthetic(&hand_dir, &[]);
    let hand_all = text(&hand);
    if !check_gpu(&hand_all, "isometric-framework (hand)") {
        return;
    }
    assert_exit(&hand, "the hand-written scene");
    let framework = run_framework(&framework_dir, &[]);
    let framework_all = text(&framework);
    if !check_gpu(&framework_all, "isometric-framework") {
        return;
    }
    assert_exit(&framework, "the framework scene");

    let hand_frames = frames(&String::from_utf8_lossy(&hand.stdout));
    let fw_frames = frames(&String::from_utf8_lossy(&framework.stdout));
    let (fw_back, fw_front) = (frame(&fw_frames, "back"), frame(&fw_frames, "front"));
    assert_bytes_equal(
        fw_back,
        frame(&hand_frames, "back"),
        width,
        "framework back == hand-written back",
    );
    assert_bytes_equal(
        fw_front,
        frame(&hand_frames, "front"),
        width,
        "framework front == hand-written front",
    );
    assert!(
        fw_back != fw_front,
        "the two facings render the same frame — the composite is not switching"
    );

    let probes = &scene["probes"];
    let expect = &scene["expect"];
    for (probe, want, what) in [
        ("hair", &expect["back"]["hair"], "composite (back): the hair is not on top"),
        ("pack", &expect["back"]["pack"], "composite (back): the backpack is not on top"),
        ("crownOnly", &expect["back"]["crownOnly"], "depth: the crown is not visible beside the character"),
        ("crownOver", &expect["back"]["crownOver"], "depth: the crown covers the character"),
        ("trunkOver", &expect["back"]["trunkOver"], "depth: the trunk does not cover the character"),
        ("pageA", &expect["back"]["pageA"], "multi-atlas: page A"),
    ] {
        expect_pixel(fw_back, width, point(&probes[probe]), colour(want), what);
    }
    expect_pixel(
        fw_front,
        width,
        point(&probes["hair"]),
        colour(&expect["front"]["hair"]),
        "composite (front): the body is not on top at the centre",
    );
    expect_pixel(
        fw_front,
        width,
        point(&probes["pack"]),
        colour(&expect["front"]["pack"]),
        "composite (front): the body is not on top at the lower back",
    );
    expect_pixel(
        fw_back,
        width,
        point(&probes["lantern"]),
        colour(&expect["back"]["pageB"]),
        "multi-atlas: page B",
    );
    expect_pixel(
        fw_back,
        width,
        point(&probes["pack"]),
        colour(&expect["back"]["pageC"]),
        "multi-atlas: page C",
    );

    // The "it works" half: asking for the front facing must change the frame.
    let facing = run_framework(&framework_dir, &["--facing-front".to_string()]);
    assert_exit(&facing, "isometric-framework --facing-front");
    let facing_frames = frames(&String::from_utf8_lossy(&facing.stdout));
    assert!(
        frame(&facing_frames, "front") != frame(&facing_frames, "back"),
        "--facing-front: both frames are identical — setFacing did nothing"
    );

    // Three revert levers, each with the colour its mistake implies.
    let mislabelled = run_framework(&framework_dir, &["--facing-mislabelled".to_string()]);
    assert_exit(&mislabelled, "isometric-framework --facing-mislabelled");
    let mislabelled_frames = frames(&String::from_utf8_lossy(&mislabelled.stdout));
    let got = pixel_rgba(
        frame(&mislabelled_frames, "front"),
        width,
        point(&probes["pack"]).0,
        point(&probes["pack"]).1,
    );
    assert!(
        !close(got, colour(&expect["front"]["pack"])),
        "revert facing: the probe still shows the front colour"
    );
    assert!(
        close(got, colour(&expect["back"]["pack"])),
        "revert facing: probe shows ({},{},{}), expected the back table's colour",
        got[0],
        got[1],
        got[2]
    );

    let unsliced = run_framework(&framework_dir, &["--no-slice".to_string()]);
    assert_exit(&unsliced, "isometric-framework --no-slice");
    let unsliced_frames = frames(&String::from_utf8_lossy(&unsliced.stdout));
    let got = pixel_rgba(
        frame(&unsliced_frames, "back"),
        width,
        point(&probes["crownOver"]).0,
        point(&probes["crownOver"]).1,
    );
    assert!(
        !close(got, colour(&expect["back"]["crownOver"])),
        "revert slicing: the crown still shows the character over it"
    );
    assert!(
        close(got, colour(&expect["wrong"]["noSlice"])),
        "revert slicing: probe shows ({},{},{}), expected the unsliced crown",
        got[0],
        got[1],
        got[2]
    );

    let broken = run_framework(&framework_dir, &["--break-group".to_string()]);
    assert_exit(&broken, "isometric-framework --break-group");
    let broken_frames = frames(&String::from_utf8_lossy(&broken.stdout));
    let got = pixel_rgba(
        frame(&broken_frames, "back"),
        width,
        point(&probes["pack"]).0,
        point(&probes["pack"]).1,
    );
    assert!(
        !close(got, colour(&expect["back"]["pack"])),
        "revert grouping: the backpack still wins its probe"
    );
    assert!(
        close(got, colour(&expect["wrong"]["brokenGroup"])),
        "revert grouping: probe shows ({},{},{}), expected the body colour",
        got[0],
        got[1],
        got[2]
    );
}
