# Tension container tooling

A single Arch Linux image serves both continuous integration and development. It carries the
full toolchain (zig, rustup, node/npm, gcc-fortran, clang), a headless
graphics stack (Xvfb, Mesa software GL, lavapipe) and locally built
OGRE-Next packages. Everything runs under Xvfb, so the OGRE
test suites work without a display or GPU.

## Layout

- `Dockerfile` — the image (build context is this directory)
- `ci/docker.mjs` — one entry point for everything container-related
- `ogre-next-pkg/` — built `.pkg.tar.zst` packages consumed by the image
  (gitignored, large, machine-local)
- `README.md` — this file

## Prerequisites

- `podman` (rootless) or `docker` (set `TENSION_CONTAINER_RUNTIME=docker`)
- OGRE-Next Arch packages, produced once with `makepkg`
  (e.g. `paru -B` / `pikaur -B` in an AUR clone of `ogre-next-git`).
  `ci/docker.mjs build` picks the latest non-debug package from
  `$HOME/src/ogre-next-git` and caches a copy in `ci/ogre-next-pkg/`.
  Override with `TENSION_OGRE_PKG_DIR`, or drop `.pkg.tar.zst` files into
  `ci/ogre-next-pkg/` yourself.

## Commands

```sh
node ci/docker.mjs build          # build the tension-dev image
node ci/docker.mjs test           # run the full test suite (npm test) in the container
node ci/docker.mjs test --core    # run one suite; args are forwarded to npm test
node ci/docker.mjs dev            # interactive shell: repo mounted at /app, X available
node ci/docker.mjs dev npm run build  # run one development command
node ci/docker.mjs clean          # remove the image
```

## Continuous integration

`node ci/docker.mjs test` mounts the repository at `/app` and runs `npm test`,
which builds and runs all six suites (tension-framework, the tension-ogre
guest suite, tension-input, tension-core, the tension-ogre unit tests,
tension-res) under Xvfb. The run is strict — a missing fixture fails the test
rather than skipping it (`tension-core/tests/support/ci.rs`) — so a green run
means the fixtures were built. In rootless podman the container runs as
root, which maps to the invoking host user — build artifacts written into
the checkout (`target/`, `zig-out/`, etc.) stay host-owned.

## Development

`node ci/docker.mjs dev` runs as the image's non-root `dev` user with
`--userns=keep-id` (podman), so every file created inside the bind-mounted
checkout is owned by your host user — a plain `cargo build`, `zig build`,
`npm run build` or the demo loop works and leaves no root-owned files behind.
`bash` is the default command; the entrypoint already provides Xvfb, so
`examples/ogre/hello-triangle/npm start`-style demos run headless.

GPU machines: the image pins software rendering
(`LIBGL_ALWAYS_SOFTWARE=1`, lavapipe). For hardware rendering pass your own
values, e.g.
`podman run --rm --device /dev/dri -e LIBGL_ALWAYS_SOFTWARE=0 ...`.

## Image quirks

- `ENTRYPOINT ["xvfb-run", "-a", "--"]` wraps every command in a fresh X
  server; non-GUI commands (e.g. `node ci/docker.mjs dev cargo test`) are
  unaffected.
- Rust is installed under `/opt/rustup` + `/opt/cargo` (shared by root and
  `dev`) via `RUSTUP_HOME` / `CARGO_HOME`.
