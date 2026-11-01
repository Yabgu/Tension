# @yabgu_gm/tension-core

The Tension interpreter. A cargo release build of `tension-core/`, installed as
`bin/tension-core`.

## Why a package

`npm start` in an example used to require `cargo build` first, and to find the
binary at a path relative to the example directory. Both are build details of
*this repository*, not of the example, so they move here: the example depends on
an interpreter the same way it depends on a compiler.

## Built, not committed

`bin/` is gitignored — it is populated by `npm run build:native` at the
repository root, which runs `cargo build --release` and copies the result.
Nothing here is per-platform prebuilt yet; `os` and `cpu` say linux/x64 because
that is the only thing this build can produce today.

## Size

The release binary is ~19.6 MB against a debug build's ~205 MB. The gap is
debug symbols plus the unoptimized llama.cpp that the default `ai` feature
links; `tension-core/Cargo.toml` sets no `[profile.release]`, so the cargo
defaults (opt-level 3, no debuginfo, unstripped) are what ship. Stripping would
recover a few MB and is not done — the binary is comfortably under the 50 MB
budget this package was given, and a stack trace from a stripped binary is
worth more than the bytes.
