# tension-2d/reference — the C++ renderer, kept until Pass C

The 2D renderer lives in `tension-core/src/render2d/` as of Pass B of the merge.
This directory is the C++ it was ported from, kept **unchanged** so that:

* a parity failure in `tension-core/tests/render2d_parity.rs` has a known-good
  source to read beside the Rust;
* a reviewer can diff the two without going through git history, where the
  originals lived at `tension-2d/src/`;
* the bisect path still exists, and this is why it is not a matter of taste —
  see below.

## The bisect path

`cargo build --no-default-features` produces a binary with no `tension::2d`
imports at all. The only way to give that binary a working 2D path is to load a
capability, and the only 2D capability is the one built from these files:

```sh
node scripts/build-2d.mjs --cpp    # writes build/libtension_2d.so
cargo build --manifest-path tension-core/Cargo.toml --no-default-features --features audio
tension-core/target/debug/tension-core --capability tension-2d/build/libtension_2d.so game.wasm
```

That is the contract Pass B has to keep: flipping the default to in-core must not
break the ability to build and run the old path, or the flag is a flag that
builds a binary nothing can use. So `adapter.cpp` — the vtable, the ten shims,
the guest memory reads — stays here rather than being deleted with the rest of
the DSO's reason for existing.

## What is never built

The **default** build compiles nothing here. `node scripts/build-2d.mjs` (no
flag) generates the shader modules and the graph blobs and stops; the modules are
what the parity test compares the in-core compiler against, byte for byte.

## Deleted in Pass C

All of it, once the parity test has run in CI and the bisect window has closed.
If you are reading this after Pass C and the directory still exists, that is the
bug.

## Not here: `tests/smoke_core.cpp`

The C++ stub host that dlopened the DSO, and `scripts/test-2d.mjs` which drove
it, were deleted in Pass B. They tested the ABI, and the ABI is what the port
removed. What they asserted about behaviour is now `tests/render2d_open.rs` and
`tests/render2d_parity.rs`, which drive the renderer directly and compare the two
backends against each other rather than one backend against a stub.
