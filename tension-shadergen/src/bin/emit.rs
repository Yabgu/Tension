//! `emit` — dump the generated GLSL for a preset.
//!
//! The adapter compiles its shaders at **build** time, not at run time: it has
//! no GLSL -> SPIR-V translator linked into the DSO (`docs/modules/2d.md` §4), and
//! spawning `glslangValidator` from inside a `dlopen`ed capability would be a
//! worse dependency than a build step. So `scripts/build-2d.mjs` runs this
//! binary, pipes the output through `glslangValidator -V`, and embeds the
//! resulting modules.
//!
//! That keeps the promise the design makes — the pipeline comes from
//! `tension-shadergen`, not from a hand-written shader checked in beside it —
//! while leaving runtime graph compilation to v1.1.
//!
//! Usage: `emit --out <dir> [--preset N]`
//!
//! SPDX-License-Identifier: MIT

use std::path::PathBuf;

use tension_shadergen::{
    generate_fragment, generate_vertex, sprite_layout, FragmentOptions, NeutralVocabulary,
};

fn main() {
    let mut out = PathBuf::from(".");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => match args.next() {
                Some(value) => out = PathBuf::from(value),
                None => {
                    eprintln!("emit: --out needs a directory");
                    std::process::exit(2);
                }
            },
            "--preset" => {
                let _ = args.next(); // preset is fixed at 1 for now
            }
            other => {
                eprintln!("emit: unknown argument '{other}'");
                std::process::exit(2);
            }
        }
    }

    if let Err(error) = std::fs::create_dir_all(&out) {
        eprintln!("emit: cannot create {}: {error}", out.display());
        std::process::exit(1);
    }

    let layout = sprite_layout();

    let vertex = match generate_vertex(&layout, &NeutralVocabulary) {
        Ok(source) => source,
        Err(errno) => {
            eprintln!("emit: vertex generation failed ({errno:?})");
            std::process::exit(1);
        }
    };
    let fragment = match generate_fragment(&layout, &FragmentOptions::default()) {
        Ok(source) => source,
        Err(errno) => {
            eprintln!("emit: fragment generation failed ({errno:?})");
            std::process::exit(1);
        }
    };

    for (name, source) in [("default_2d.vert", vertex), ("default_2d.frag", fragment)] {
        let path = out.join(name);
        if let Err(error) = std::fs::write(&path, source) {
            eprintln!("emit: cannot write {}: {error}", path.display());
            std::process::exit(1);
        }
        println!("{}", path.display());
    }
}
