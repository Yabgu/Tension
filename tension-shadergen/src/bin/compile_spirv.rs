//! `compile_spirv` — GLSL in, SPIR-V out, through Naga.
//!
//! This is the build's shader compiler. It replaced `glslangValidator -V` for
//! two reasons: a C++ capability should not need a system binary to build, and
//! Naga is the same library the runtime compiler uses, so a shader that builds
//! is a shader that could be compiled at run time.
//!
//! ```text
//! compile_spirv --stage vert|frag [--in FILE] [--out FILE]
//! ```
//!
//! With no `--in`, GLSL is read from stdin; with no `--out`, SPIR-V words are
//! written little-endian to stdout. Errors go to stderr and exit 1, so a build
//! script sees a non-zero status and the message.
//!
//! SPDX-License-Identifier: MIT

use std::io::{Read, Write};

use naga::front::glsl::{Frontend, Options};
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::ShaderStage;

fn usage() -> ! {
    eprintln!("usage: compile_spirv --stage vert|frag [--in FILE] [--out FILE]");
    std::process::exit(2);
}

fn main() {
    let mut stage: Option<ShaderStage> = None;
    let mut input: Option<String> = None;
    let mut output: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--stage" => {
                stage = Some(match args.next().as_deref() {
                    Some("vert") => ShaderStage::Vertex,
                    Some("frag") => ShaderStage::Fragment,
                    _ => usage(),
                })
            }
            "--in" => input = args.next(),
            "--out" => output = args.next(),
            _ => usage(),
        }
    }
    let stage = stage.unwrap_or_else(|| usage());

    let mut source = String::new();
    match &input {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(text) => source = text,
            Err(error) => {
                eprintln!("compile_spirv: cannot read {path}: {error}");
                std::process::exit(1);
            }
        },
        None => {
            if let Err(error) = std::io::stdin().read_to_string(&mut source) {
                eprintln!("compile_spirv: cannot read stdin: {error}");
                std::process::exit(1);
            }
        }
    }

    let words = match compile(&source, stage) {
        Ok(words) => words,
        Err(error) => {
            // The source is echoed with the error so a build failure names the
            // line a human has to look at, which is what a compiler is for.
            eprintln!("compile_spirv: {error}");
            if let Some(path) = &input {
                eprintln!("--- {path} ---");
            }
            eprintln!("{source}");
            std::process::exit(1);
        }
    };

    let mut bytes = Vec::with_capacity(words.len() * 4);
    for word in &words {
        bytes.extend_from_slice(&word.to_le_bytes());
    }

    match &output {
        Some(path) => {
            if let Err(error) = std::fs::write(path, &bytes) {
                eprintln!("compile_spirv: cannot write {path}: {error}");
                std::process::exit(1);
            }
        }
        None => {
            if let Err(error) = std::io::stdout().write_all(&bytes) {
                eprintln!("compile_spirv: cannot write stdout: {error}");
                std::process::exit(1);
            }
        }
    }
}

/// Parse, validate, emit. The three steps Naga needs, in the order it needs
/// them, and the same three `tension-core`'s runtime compiler performs.
pub fn compile(source: &str, stage: ShaderStage) -> Result<Vec<u32>, String> {
    let mut frontend = Frontend::default();
    let module = frontend
        .parse(
            &Options {
                stage,
                defines: Default::default(),
            },
            source,
        )
        .map_err(|e| format!("naga parse: {e:?}"))?;

    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
    let info = validator
        .validate(&module)
        .map_err(|e| format!("naga validate: {e:?}"))?;

    // Flags explicitly empty — NOT `Options::default()`.
    //
    // `Options::default()` in Naga 29 sets `WriterFlags::ADJUST_COORDINATE_SPACE`
    // (see `back/spv/mod.rs:1092`), and that flag flips Y on `gl_Position`.
    // Reaching for it looks right — glslangValidator flips Y when it compiles
    // GLSL for Vulkan, because GLSL clip space is Y-up and Vulkan's is Y-down —
    // but here it is wrong, and measurably so: with it, every sprite renders
    // mirrored (smoke suite: sprites at y 328..359 instead of 0..31).
    //
    // Naga's **GLSL frontend** already emits Vulkan-oriented clip space, so the
    // writer's flip is a second one. The two compilers agree on the result and
    // disagree about where it happens: glslang does it in the writer, Naga in
    // the frontend.
    //
    // Setting the flags explicitly rather than taking the default also keeps
    // the output independent of `cfg!(debug_assertions)`, which the default
    // conditions on — a debug and a release build must not produce different
    // SPIR-V, or the graph/preset byte comparison would depend on the profile.
    let options = naga::back::spv::Options {
        flags: naga::back::spv::WriterFlags::empty(),
        ..naga::back::spv::Options::default()
    };
    let mut words: Vec<u32> = Vec::new();
    naga::back::spv::Writer::new(&options)
        .map_err(|e| format!("naga SPIR-V writer: {e:?}"))?
        .write(&module, &info, None, &None, &mut words)
        .map_err(|e| format!("naga emit: {e:?}"))?;

    // The same fold the runtime compiler applies, from the same code: naga
    // cannot declare a combined sampler, SDL_GPU's Vulkan backend declares one
    // combined binding per sampler slot, and a module with two bindings where
    // the layout has one is refused at pipeline creation. See
    // `tension_shadergen::combined_sampler`.
    tension_shadergen::combined_sampler::fold_combined_samplers(&mut words)
        .map_err(|e| format!("combined sampler fold: {e}"))?;

    Ok(words)
}
