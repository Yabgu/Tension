//! Does the in-core renderer produce the same frames as the C++ adapter?
//!
//! # Why this file exists
//!
//! Pass B moved 1,151 lines of SDL_GPU code from C++ into Rust. A port that
//! "looks right" and renders "about the same" is not a port — it is a rewrite
//! that will be debugged for a year. So the two implementations are held to the
//! same bytes, in three parts, each able to run or skip on its own:
//!
//! ## Part A — the shader bytes (runs on any machine)
//!
//! The single largest thing that could silently differ is the SPIR-V. This part
//! compiles preset 1 and both shipped graphs **in-process** (through
//! `pipeline_default` + `naga_backend`, exactly as the renderer does) and
//! compares the result to the modules the C++ build produced, byte for byte:
//!
//! * `tension-2d/build/shaders/default_2d.{vert,frag}.spv` — what
//!   `kSpriteVertSpv`/`kSpriteFragSpv` embedded in the DSO;
//! * `tension-2d/build/graph/default_2d.graph.{vert,frag}.spv` — what the DSO's
//!   `kGraphPipes` embedded for the graph blob.
//!
//! Those files are build artifacts (`scripts/build-2d.mjs` writes them), so the
//! part states the command that produces them and skips when they are absent.
//! It is deliberately **not** replaced by "the build asserts this": the build
//! asserts the *C++* pair agrees; this asserts the *Rust* pair agrees with them,
//! which is the claim the port needs.
//!
//! ## Part B — the ordering and the wire records (runs on any machine)
//!
//! `SORT_KEYS` is the frame's draw order. It is transcribed from the graph, so
//! this part walks `pipeline_default::default_graph()`'s `make_tuple` and
//! rebuilds the key list from the record definition — a drift gate that fails
//! if the graph changes and the table does not.
//!
//! ## Part C — the two binaries on the same guest (needs both, and a GPU)
//!
//! The same guest, run twice: once through the C++ DSO (built
//! `--no-default-features`), once in core (default). Everything the guest writes
//! is compared — stdout line for line, exit code, and the per-verb results the
//! log carries. `hello-sprites` prints its own assertion
//! (`screenshot -> N bytes, M non-black pixels` and `OK: ten sprites at their
//! recorded positions`), where `M` is a **full-frame** count plus ten sampled
//! colours, so matching stdout is matching frames by the strongest measure the
//! guest itself has.
//!
//! **This part needs a graphics pipeline to exist.** On a rig where
//! `vkCreateGraphicsPipelines` fails (`VK_ERROR_OUT_OF_HOST_MEMORY` under Mesa's
//! `dzn`, measured on the development machine — and reproduced by the untouched
//! C++ oracle, so it is the environment and not this port), both backends fail
//! at `set_pipeline` with the same errno. That is still a parity signal and this
//! part reports it as one, but it cannot compare frames. Set
//! `TENSION_TEST_ALLOW_SKIP=1` to skip Part C deliberately — the tree's one skip
//! flag (`tests/support/ci.rs`) — or run it on a machine with a real Vulkan
//! device.
//!
//! # Running it
//!
//! ```sh
//! node scripts/parity-2d.mjs        # builds both binaries, then runs this
//! ```
//!
//! or by hand:
//!
//! ```sh
//! cargo build --no-default-features --features audio
//! cp target/debug/tension-core target/debug/tension-core-cpp
//! cargo build            # default features: render2d-core on
//! cargo test --test render2d_parity
//! ```
//!
//! The binaries are built **outside** this test on purpose: `cargo test` holds
//! the `target/` lock, so a nested `cargo build` here would deadlock.
//!
//! # Why byte-identical rather than statistical
//!
//! A tolerance would hide exactly the bugs this port can have: a wrong blend
//! factor, an off-by-one in the sort, a uniform that is `w/2` where the C++ used
//! `h/2`, a record field read two bytes off. Every one of those produces an
//! image that is "close". Byte-identical is the only comparison that fails when
//! they happen.

use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "support/ci.rs"]
mod support_ci;

use tension_core::pipeline::DType;
use tension_core::render2d::pipeline::{graph_hash, PIPE_GUEST_MIN};
use tension_core::render2d::record::{KeyKind, SORT_KEYS};

/// Collected outcomes, so one run reports every part rather than the first
/// failure — a port that differs in two places should say both.
#[derive(Default)]
struct Report {
    passed: Vec<String>,
    skipped: Vec<String>,
    failed: Vec<String>,
}

impl Report {
    fn pass(&mut self, what: impl Into<String>) {
        let what = what.into();
        println!("  ok   {what}");
        self.passed.push(what);
    }

    fn skip(&mut self, what: impl Into<String>) {
        let what = what.into();
        println!("  SKIP {what}");
        self.skipped.push(what);
    }

    fn fail(&mut self, what: impl Into<String>) {
        let what = what.into();
        println!("  FAIL {what}");
        self.failed.push(what);
    }

    fn check(&mut self, what: &str, condition: bool) {
        if condition {
            self.pass(what);
        } else {
            self.fail(what);
        }
    }
}

/// The repository root, from the crate root `cargo test` runs in.
fn repo() -> PathBuf {
    let mut path = std::env::current_dir().expect("a working directory");
    // `cargo test --test render2d_parity` runs in `tension-core/`.
    if path.ends_with("tension-core") {
        path.pop();
    }
    path
}

fn main() {
    let mut report = Report::default();

    part_a_shaders(&mut report);
    part_b_ordering(&mut report);
    part_c_binaries(&mut report);

    println!();
    println!(
        "render2d_parity: {} passed, {} skipped, {} failed",
        report.passed.len(),
        report.skipped.len(),
        report.failed.len()
    );
    for skip in &report.skipped {
        println!("  skipped: {skip}");
    }
    if report.failed.is_empty() {
        println!("render2d_parity: PASS");
    } else {
        println!("render2d_parity: FAIL");
        for failure in &report.failed {
            println!("  failed: {failure}");
        }
        std::process::exit(1);
    }
}

/// Part A — the Rust-compiled SPIR-V against the C++ build's modules.
fn part_a_shaders(report: &mut Report) {
    println!("A. shader bytes (Rust compile vs the C++ build's modules)");

    let build = repo().join("tension-2d").join("build");
    let preset_vert = build.join("shaders").join("default_2d.vert.spv");
    let preset_frag = build.join("shaders").join("default_2d.frag.spv");
    let graph_vert = build.join("graph").join("default_2d.graph.vert.spv");
    let graph_frag = build.join("graph").join("default_2d.graph.frag.spv");

    if !(preset_vert.is_file() && preset_frag.is_file() && graph_vert.is_file()) {
        report.skip(format!(
            "the C++ build's SPIR-V is absent ({}); run `node scripts/build-2d.mjs` — \
             this part then compares the Rust compiler's output to it byte for byte",
            preset_vert.display()
        ));
        return;
    }

    // The preset: what `set_pipeline(1)` builds, compiled here the way the
    // renderer compiles it.
    let graph = tension_core::pipeline_default::default_graph();
    let compiled = match tension_core::pipeline::naga_backend::compile_graph(&graph) {
        Ok(compiled) => compiled,
        Err(error) => {
            report.fail(format!("preset 1 did not compile in-process: {error}"));
            return;
        }
    };
    let rust_vert = compiled.vertex_bytes().to_vec();
    let rust_frag = compiled.fragment_bytes().to_vec();

    let cpp_vert = std::fs::read(&preset_vert).expect("checked above");
    let cpp_frag = std::fs::read(&preset_frag).expect("checked above");

    report.check(
        &format!(
            "preset 1 vertex SPIR-V is identical ({} bytes)",
            cpp_vert.len()
        ),
        rust_vert == cpp_vert,
    );
    report.check(
        &format!(
            "preset 1 fragment SPIR-V is identical ({} bytes)",
            cpp_frag.len()
        ),
        rust_frag == cpp_frag,
    );

    // The graph blob: what a guest's `default_2d` blob becomes. This is the path
    // that used to be `-ENOSYS` + two `compile_graph` calls.
    let blob = tension_core::pipeline_default::serialize_default_2d();
    match tension_core::render2d::pipeline::compile_blob(&blob) {
        Ok((rust_vs, rust_fs)) => {
            let cpp_gvs = std::fs::read(&graph_vert).expect("checked above");
            let cpp_gfs = std::fs::read(&graph_frag).unwrap_or_default();
            report.check(
                &format!("graph vertex SPIR-V is identical ({} bytes)", cpp_gvs.len()),
                rust_vs == cpp_gvs,
            );
            if !cpp_gfs.is_empty() {
                report.check(
                    &format!(
                        "graph fragment SPIR-V is identical ({} bytes)",
                        cpp_gfs.len()
                    ),
                    rust_fs == cpp_gfs,
                );
            }
        }
        Err(error) => report.fail(format!("the default_2d blob did not compile: {error}")),
    }

    // The hash the renderer routes on must be the hash the compiler and the
    // build script use, or a blob would resolve to a different pipeline in each
    // implementation.
    report.check(
        "graph_hash agrees with pipeline::Graph::hash",
        graph_hash(&blob) == tension_core::pipeline::Graph::hash(&blob),
    );
    report.check(
        "the default_2d blob resolves to the pinned pipe id 100",
        tension_core::render2d::pipeline::builtin_pipe_id(graph_hash(&blob))
            == Some(PIPE_GUEST_MIN),
    );
}

/// Part B — the ordering table against the graph that defines it.
fn part_b_ordering(report: &mut Report) {
    println!("B. ordering (SORT_KEYS vs the default graph's make_tuple)");

    let graph = tension_core::pipeline_default::default_graph();
    let Some(record) = graph.records.first() else {
        report.fail("the default graph declares no record");
        return;
    };

    // The stage's `make_tuple` names the keys; each input is a `load_field`
    // whose `args[0]` is a field index into the record.
    let stage = graph.stages.first();
    let tuple = stage
        .and_then(|stage| stage.nodes.iter().find(|node| node.op == "make_tuple"));
    let Some(tuple) = tuple else {
        report.fail("the default graph has no make_tuple node");
        return;
    };

    let mut derived: Vec<(usize, Option<DType>)> = Vec::new();
    for input in &tuple.inputs {
        let Some(node) = stage.and_then(|s| s.nodes.iter().find(|n| n.id == *input)) else {
            report.fail(format!("make_tuple names node {input}, which does not exist"));
            return;
        };
        if node.op != "load_field" {
            // A scaled key would be a `mul` between the load and the tuple. The
            // shipped graphs have none, and a scale of 1.0 is the only value the
            // C++ comparator's table carries — so an unexpected op is a real
            // difference and not something to normalise away.
            report.fail(format!(
                "make_tuple names a `{}` node, not a load_field; the comparator's scale \
                 column would need to change too",
                node.op
            ));
            return;
        }
        let Some(&field_index) = node.args.first() else {
            report.fail("a load_field node has no field index");
            return;
        };
        let field = record.fields.get(field_index as usize);
        derived.push((
            field.map(|f| f.offset as usize).unwrap_or(usize::MAX),
            field.map(|f| f.dtype),
        ));
    }

    if derived.len() != SORT_KEYS.len() {
        report.fail(format!(
            "the graph names {} keys, SORT_KEYS has {}",
            derived.len(),
            SORT_KEYS.len()
        ));
        return;
    }

    for (index, (offset, dtype)) in derived.iter().enumerate() {
        let key = SORT_KEYS[index];
        report.check(
            &format!("key {index} offset is {offset}"),
            key.offset == *offset,
        );
        let expected = dtype.map(|d| match d {
            DType::F32 => KeyKind::F32,
            DType::U16 => KeyKind::U16,
            DType::I16 => KeyKind::I16,
            DType::U8 => KeyKind::U8,
            DType::I32 => KeyKind::I32,
            DType::U32 => KeyKind::U32,
        });
        report.check(
            &format!("key {index} dtype is {dtype:?}"),
            Some(key.kind) == expected,
        );
    }
}

/// Part C — the same guest through both binaries.
fn part_c_binaries(report: &mut Report) {
    println!("C. the same guest through both binaries");

    if support_ci::skip_allowed() {
        report.skip(
            "both binaries on hello-sprites: TENSION_TEST_ALLOW_SKIP=1. \
             The assertion that would run: identical stdout (including \
             `screenshot -> N bytes, M non-black pixels`, a full-frame count, plus \
             ten sampled colours) and identical exit status. Skipped here because \
             this rig cannot create a graphics pipeline.",
        );
        return;
    }

    let repo = repo();
    let guest = repo.join("examples/2d/hello-sprites/build/game.wasm");
    let dso = repo.join("tension-2d/build/libtension_2d.so");

    // `cargo test` runs in `tension-core/`; the binaries are beside its target.
    let cpp = std::env::var_os("TENSION_PARITY_CPP")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("tension-core/target/debug/tension-core-cpp"));
    let rust = std::env::var_os("TENSION_PARITY_RUST")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("tension-core/target/debug/tension-core"));

    for (label, path) in [("the C++-backend binary", &cpp), ("the in-core binary", &rust)] {
        if !path.is_file() {
            report.skip(format!("{} is not built ({})", label, path.display()));
            println!(
                "       build both with: node scripts/parity-2d.mjs   (or see this file's header)"
            );
            return;
        }
    }
    if !guest.is_file() {
        report.skip(format!(
            "{} is not built; run `npm run build` in examples/2d/hello-sprites",
            guest.display()
        ));
        return;
    }

    // The same argv for both: only the binary differs. The DSO is named in both
    // runs so the comparison is one variable, not two — the in-core binary logs
    // that it skipped the load, which is itself part of the compared output.
    let arguments = vec![
        "--capability".to_string(),
        dso.display().to_string(),
        guest.display().to_string(),
    ];

    let cpp_run = run(&cpp, &arguments, &repo);
    let rust_run = run(&rust, &arguments, &repo);

    let (Some(cpp_run), Some(rust_run)) = (cpp_run, rust_run) else {
        report.fail("a binary could not be started");
        return;
    };

    println!("       (C++ backend: exit {:?})", cpp_run.status);
    println!("       (in-core:     exit {:?})", rust_run.status);

    // The device gate. If neither backend can create a pipeline, the frame
    // comparison is impossible and saying so is more useful than a red line.
    let blocked = |output: &str| {
        output.contains("VK_ERROR_OUT_OF_HOST_MEMORY")
            || output.contains("set_pipeline refused")
    };
    let no_pipeline = blocked(&cpp_run.stdout) && blocked(&rust_run.stdout);

    report.check(
        "both binaries exit with the same status",
        cpp_run.status == rust_run.status,
    );

    if no_pipeline {
        report.skip(
            "frame and verb comparison: this rig cannot create a graphics pipeline \
             (vkCreateGraphicsPipelines: VK_ERROR_OUT_OF_HOST_MEMORY). The assertion that \
             would run: identical stdout line for line, which for hello-sprites includes \
             `screenshot -> N bytes, M non-black pixels` (a full-frame count) and \
             `OK: ten sprites at their recorded positions`. Both backends fail at the same \
             verb with the same errno on this rig, which is itself reported below",
        );
        // The failure being identical is a real signal, and it is the only one
        // this rig can give: same verb, same errno.
        let cpp_verb = first_verb_failure(&cpp_run.stdout);
        let rust_verb = first_verb_failure(&rust_run.stdout);
        report.check(
            &format!("both backends fail at the same verb with the same errno: {cpp_verb:?}"),
            cpp_verb == rust_verb && cpp_verb.is_some(),
        );
        return;
    }

    let cpp_ok = cpp_run.stdout.lines().any(|line| line.starts_with("OK:"));
    let rust_ok = rust_run.stdout.lines().any(|line| line.starts_with("OK:"));
    if !cpp_ok && !rust_ok {
        report.skip(
            "neither backend reached the guest's `OK:` line; nothing to compare yet",
        );
    } else {
        report.check("both backends reach the guest's `OK:` line", cpp_ok && rust_ok);

        let cpp_pixels = pixel_line(&cpp_run.stdout);
        let rust_pixels = pixel_line(&rust_run.stdout);
        report.check(
            &format!("the frame is the same: {cpp_pixels:?} vs {rust_pixels:?}"),
            cpp_pixels.is_some() && cpp_pixels == rust_pixels,
        );
    }

    report.check(
        "stdout is identical line for line",
        cpp_run.stdout == rust_run.stdout,
    );

    if cpp_run.stdout != rust_run.stdout {
        // Print the first difference: a wall of two logs is not readable.
        for (index, (a, b)) in cpp_run
            .stdout
            .lines()
            .zip(rust_run.stdout.lines())
            .enumerate()
        {
            if a != b {
                println!("       first difference at line {index}:");
                println!("         cpp: {a}");
                println!("         rst: {b}");
                break;
            }
        }
    }
}

struct Run {
    status: Option<i32>,
    stdout: String,
}

fn run(binary: &Path, arguments: &[String], repo: &Path) -> Option<Run> {
    let output = Command::new(binary)
        .args(arguments)
        .current_dir(repo)
        .env("SDL_VIDEODRIVER", "offscreen")
        // A deterministic log, so two runs are comparable: timestamps are the
        // one thing that legitimately differs, and the format below drops them.
        .env("TENSION_LOG_LEVEL", "info")
        .env("TENSION_LOG_FORMAT", "text")
        .output()
        .ok()?;

    // Combined streams: the guest's own `print` goes to stdout and the host's
    // log to stderr, and the comparison wants both.
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));

    Some(Run {
        status: output.status.code(),
        stdout: normalise(&combined),
    })
}

/// Drop the parts of a log line that legitimately differ between two runs.
///
/// Timestamps, because they are wall-clock. Nothing else: a path or a size that
/// differs between the backends is a difference worth failing on, not styling to
/// be hidden.
fn normalise(text: &str) -> String {
    text.lines()
        .map(|line| {
            // `2026-11-09T01:03:57.079Z ERROR 2d: …` -> `ERROR 2d: …`
            let without_stamp = match line.find(' ') {
                Some(space) if line.starts_with("20") && line.get(4..5) == Some("-") => {
                    &line[space + 1..]
                }
                _ => line,
            };
            // The C++ adapter registers as the `2d` logger *and* prefixes its
            // own messages with `2d: `, so its lines read `ERROR 2d: 2d: …`.
            // The in-core path logs through the same logger without the second
            // prefix. That is a wart in the DSO's formatting, not a behavioural
            // difference, and reproducing it in core to make a diff clean would
            // be preserving a defect for the test's convenience — so the
            // comparison folds it away and the wart is recorded in the reply.
            strip_duplicated_logger(without_stamp)
        })
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `ERROR 2d: 2d: set_pipeline refused (…)` -> `ERROR 2d: set_pipeline refused (…)`.
fn strip_duplicated_logger(line: &str) -> String {
    const LEVELS: [&str; 4] = ["ERROR", "WARN", "INFO", "DEBUG"];
    let Some(first) = line.split_whitespace().next() else {
        return line.to_string();
    };
    if !LEVELS.contains(&first) {
        return line.to_string();
    }
    let Some(after_level) = line[first.len()..].strip_prefix(' ') else {
        return line.to_string();
    };
    let Some((name, after_name)) = after_level.split_once(": ") else {
        return line.to_string();
    };
    let duplicated = format!("{name}: ");
    match after_name.strip_prefix(duplicated.as_str()) {
        // Rebuilt as `LEVEL name: message` so the comparison has a stable shape
        // rather than two spellings of one line.
        Some(tail) => format!("{first} {name}: {tail}"),
        None => line.to_string(),
    }
}

/// The first refusal, reduced to the two things that are behaviour: the verb
/// and the reason.
///
/// Not the whole line. A log line carries a logger name, a level and a message
/// spelling, and two backends are allowed to punctuate differently — the
/// *verb that refused* and *why* are what a guest and a reader act on.
fn first_verb_failure(text: &str) -> Option<String> {
    let line = text.lines().find(|line| line.contains(" refused ("))?;
    // `… set_pipeline refused (CreateGPUGraphicsPipeline: … )` — the verb is
    // the word before `refused`, and the reason is everything inside the outer
    // parentheses, which themselves may contain parentheses.
    let before = line.split(" refused").next().unwrap_or("");
    let verb = before
        .split_whitespace()
        .last()
        .map(|word| word.trim_end_matches(':'))
        .unwrap_or("?");
    let reason = line
        .split_once(" refused (")
        .map(|(_, tail)| tail.rsplit_once(')').map(|(inner, _)| inner).unwrap_or(tail))
        .unwrap_or("")
        .trim()
        .to_string();
    Some(format!("{verb}: {reason}"))
}

/// The guest's own frame assertion, if it printed one.
fn pixel_line(text: &str) -> Option<String> {
    text.lines()
        .find(|line| line.trim_start().starts_with("screenshot -> "))
        .map(|line| line.trim().to_string())
}
