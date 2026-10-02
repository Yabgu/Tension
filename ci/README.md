# Tension CI / Docker tooling

A single Arch Linux image serves both CI and development. It carries the
full toolchain (zig, rustup, node/npm, gcc-fortran, clang), a headless
graphics stack (Xvfb, Mesa software GL, lavapipe) and locally built
OGRE-Next + freeimage packages. Everything runs under Xvfb, so the OGRE
test suites work without a display or GPU.

## Layout

- `Dockerfile` — the image (build context is this directory)
- `docker.sh` — one entry point for everything container-related
- `ogre-next-pkg/` — built `.pkg.tar.zst` packages consumed by the image
  (gitignored, large, machine-local)
- `README.md` — this file

## Prerequisites

- `podman` (rootless) or `docker` (set `TENSION_CONTAINER_RUNTIME=docker`)
- OGRE-Next and freeimage Arch packages, produced once with `makepkg`
  (e.g. `paru -B` / `pikaur -B` in AUR clones of `ogre-next-git` and
  `freeimage`). `docker.sh build` picks the latest non-debug package from
  `$HOME/src/ogre-next-git` and `$HOME/src/freeimage` and caches a copy in
  `ci/ogre-next-pkg/`. Override with `TENSION_OGRE_PKG_DIR` /
  `TENSION_FREEIMAGE_PKG_DIR`, or drop `.pkg.tar.zst` files into
  `ci/ogre-next-pkg/` yourself.

## Commands

```sh
ci/docker.sh build          # build the tension-dev image
ci/docker.sh test           # run the full test suite (./test.sh) in the container
ci/docker.sh test --core    # run one suite; args are forwarded to ./test.sh
ci/docker.sh dev            # interactive shell: repo mounted at /app, X available
ci/docker.sh dev ./build.sh # run one development command
ci/docker.sh clean          # remove the image
```

## CI

`ci/docker.sh test` mounts the repository at `/app` and runs `./test.sh`,
which executes all four suites (tension-core, tension-res, tension-ogre,
tension-framework) under Xvfb. In rootless podman the container runs as
root, which maps to the invoking host user — build artifacts written into
the checkout (`target/`, `zig-out/`, etc.) stay host-owned.

## Development

`ci/docker.sh dev` runs as the image's non-root `dev` user with
`--userns=keep-id` (podman), so every file created inside the bind-mounted
checkout is owned by your host user — a plain `cargo build`, `zig build`,
`./build.sh` or demo loop works and leaves no root-owned files behind.
`bash` is the default command; the entrypoint already provides Xvfb, so
`examples/ogre/hello-triangle/run.sh`-style demos run headless.

GPU machines: the image pins software rendering
(`LIBGL_ALWAYS_SOFTWARE=1`, lavapipe). For hardware rendering pass your own
values, e.g.
`podman run --rm --device /dev/dri -e LIBGL_ALWAYS_SOFTWARE=0 ...`.

## Image quirks

- `ENTRYPOINT ["xvfb-run", "-a", "--"]` wraps every command in a fresh X
  server; non-GUI commands (e.g. `ci/docker.sh dev cargo test`) are
  unaffected.
- Rust is installed under `/opt/rustup` + `/opt/cargo` (shared by root and
  `dev`) via `RUSTUP_HOME` / `CARGO_HOME`.
