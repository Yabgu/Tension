# AGENTS.md — Tension

Guidance for AI coding agents working in this repository. The **hard rules**
come first; the rest is the Windows build cheat-sheet.

## Hard rules

1. **`third_party/ogre-next` is read-only.** Never edit, generate into, format,
   or delete anything there — including its build trees (`ogre-next-build*`,
   `ogre-next-install`) and the `ogre-next` submodule. `.gitignore` may cover
   paths there, but the tree itself is off limits. Build OGRE only through
   `npm run bootstrap` (`scripts/bootstrap.mjs`).
2. **TensionScript is a sibling repo, not a submodule.** The language lives at
   `~/work/TensionScript` (the canonical checkout). Tension consumes the
   compiler as the published `@yabgu_gm/tensionscript` npm package, which each
   npm project carries as a devDependency (`tension-framework/package.json`,
   each `examples/*/package.json`). To pick up a language change: publish it
   there, then bump the version here. **Do not edit
   `node_modules/@yabgu_gm/tensionscript` in place** — it is an installed
   artifact, and an edit there is lost on the next `npm install`. Version bumps
   flow through `package.json`.
3. **Never use destructive git commands and never commit on the user's behalf.**
   Leave changes in the working tree for the user to review and commit.
4. **Honor runtime tool/approval gates.** If a command is refused, surface it;
   do not route around it.

## Capabilities

A guest reaches the engine only through a capability: a named websocket of
imports, resolved by the session at load time. Two kinds exist — the ones the
host implements itself, and the ones an adapter DSO implements behind the shared
adapter ABI (`TENSION_ADAPTER_ABI_VERSION`, `tension_adapter.h`).

**Implemented by the host** (`tension-core`, registered by the session):

- **`tension::io`** — 6 verbs: `print`, `read_line`, `arg`, `arg_count`, `log`,
  `log_structured` (`write` is a framework convenience over `print`). The
  always-present one; every guest may import it.
- **`tension::audio`** — 6 verbs: `audio_init`, `audio_play`, `audio_stop`,
  `audio_set_gain`, `audio_voice_state`, `audio_shutdown`. Backed by the audio
  feature of the host build.
- **`tension::ai`** — 8 verbs: session create/add/generate/read/state/cancel/
  reset/close over the vendored llama.cpp. Feature-gated (`ai`), excluded from
  the test suite.
- **`tension::res`** — 8 verbs: `res_open`, `res_close`, `res_read`, `res_seek`,
  `res_tell`, `res_stat`, `res_stat_fd`, `res_readdir` — the read-only resource
  VFS over `.tns` volumes. The reader is `tension-res` (Zig); the host links it
  and the adapter links the same archive.
- **`tension::solver`** — 5 verbs: create, step, state, set_state, destroy over
  the Fortran numerical core. `GUEST_ABI.md` is its contract.
- **`tension::session`** — the session ABI itself: arena control, manifest,
  callbacks, task park/wake. Not a capability a game calls directly; the guest
  SDK wraps it as `RuntimeSession`.

**Implemented by an adapter DSO** (each registers `publish`/`apply`/`layout_hash`
through the adapter ABI; a session must be given the DSO with `--capability`):

- **`ogre`** — 11 verbs — `tension-ogre/build/libtension_ogre.so`. The 3D
  renderer: scene nodes, cameras, lights, materials, meshes, jobs, bones,
  animation. Design: `tension-ogre/DESIGN.md`.
- **`tension::input`** — 6 verbs — `tension-input/build/libtension_input.so`.
  Keyboard/pointer state and edge events. Design: `tension-input/DESIGN.md`.
- **`tension::2d`** — 10 verbs — `tension-2d/build/libtension_2d.so`. Sprite
  batching over SDL_GPU: `open`, `close`, `set_pipeline`, `shader_compile_raw`,
  `submit`, `present`, `texture_load`, `info`, `screenshot`, `set_texture`.
  Design: `tension-2d/DESIGN.md`.

### Guest SDK

`tension-framework/` is the guest side of every capability above:

- `assembly/*.ts` — one file per single-module capability (`io`, `audio`, `ai`,
  `res`, `solver`, `input`).
- `assembly/<capability>/` — the ones with several modules: `ogre/` (wire
  records, mesh, motion, bones, animation, async load), `runtime/` (arena,
  session, manifest, callbacks), `2d/` (the scene layer below).
- `assembly/index.ts` re-exports all of it; a guest imports `"tension-framework"`.

**The 2D scene layer** (`assembly/2d/`, on top of `tension::2d`'s verbs):
`Tileset` (page + src rect from a sheet coordinate), `Composite` (layered
character sharing one sort key and group), `IsometricWorld` (tall sprites sliced
into depth-sorted bands). Records are `struct`s written through
`changetype<@unmanaged …>`; the declaration is the layout. Worked examples:
`examples/2d/isometric` (real art, hand-written records — the control) and
`examples/2d/isometric-framework` (the same scene via the library, frames
byte-identical).

**The 2D verbs are declared per example** (`examples/2d/*/src/bindings.ts`), not
in the SDK: `tension-2d/include/tension_2d.h` has no `schema/` entry, so
`tools/codegen` cannot generate them, and the hand-written module documents the
overloads a generator would not. Only `set_texture` is declared inside the SDK,
by `Tileset.bind`. Moving the rest there is a pending cleanup, not a design
choice.

## Running MSYS2 commands on Windows

The repo's build tooling is bash + MSYS2. On Windows, run everything that needs
`gfortran`, `gcc`, `ar`, `sh`, `make`, `zig build`, or a `*.sh` script through
the MSYS2 shell:

```
c:\msys64\msys2_shell.cmd -ucrt64 -defterm -no-start -where C:\Work\Tension -c "<bash command>"
```

- **Do not** invoke `C:\msys64\ucrt64\bin\gfortran.exe` (etc.) directly from
  cmd/PowerShell. With a Visual Studio environment ahead of MSYS2 on `PATH`,
  its helper (`f951.exe`) exits 1 with **no output**, and MSYS may raise a modal
  error dialog that hangs the shell. The wrapper is the reliable path.
- Export `DONT_SHOW_UI_ERRORS=1` before anything that can crash, so Windows
  Error Reporting fails silently instead of showing UI. The durable form is
  `HKCU\Software\Microsoft\Windows\Windows Error Reporting\DontShowUI = 1`.
- Some installers/toolchains need real symlinks:
  `export MSYS="winsymlinks:nativestrict"`.
- Missing packages: prefer the UCRT64 repo,
  `pacman -S mingw-w64-ucrt-x86_64-<pkg>` (`pacman -Syu` first).
- Inside `-c "..."`, use normal bash quoting and POSIX paths
  (`tension-solver/src/...`, `/c/Work/Tension`).

Example:

```
c:\msys64\msys2_shell.cmd -ucrt64 -defterm -no-start -where C:\Work\Tension -c "export MSYS=winsymlinks:nativestrict; export DONT_SHOW_UI_ERRORS=1; gfortran -c tension-solver/src/tension_solver_erk.f90 -o tension-solver/build/erk_probe.o; echo exit=$?"
```

## Windows build and test

**`npm run build` is the build, on every platform.** It runs the same steps on
Windows that it runs on Linux: the toolchain differences (MSVC through vcvars,
MSYS2 UCRT64 for the GNU compilers, WinGet's Zig) are resolved inside
`scripts/lib/toolchain.mjs`, not by a different entry point.

It builds `tension-res` → `tension-ogre` → `tension-core` for the native side
(release, audio-only by default; `TENSION_AI=1` includes `ai`), generates the
session constants, compiles the framework guest, and builds every example.

Manual equivalents, when one target needs rebuilding on its own:

```
res             zig build -Doptimize=ReleaseSafe -Dtarget=x86_64-windows-msvc
adapter         cmake -S tension-ogre -B tension-ogre\build-cmake -G Ninja -DCMAKE_BUILD_TYPE=Release
                cmake --build tension-ogre\build-cmake
core            cargo build --release --no-default-features --features audio
core tests      cargo test  --no-default-features --features audio
```

`npm test` runs every suite (`eol`, `codegen`, `framework`, `ogre-guest`,
`ogre-unit`, `input`, `res`, `core`) and prints a per-suite verdict. It runs the
suites **concurrently on a workstation and serially on CI**: a failing CI job is
diagnosed from a log tail by someone who was not there, and interleaved output
from four suites hides which one broke. `--serial` and `--jobs N` override either
default, and a failure in a suite another depends on skips the dependent rather
than reporting the same cause twice.

`npm test -- <name>` runs one suite (`--list` prints the names).

- The Zig archive **must** use `-Dtarget=x86_64-windows-msvc` when the Rust
  host is MSVC; a default-ABI build yields a MinGW archive that `link.exe`
  rejects with `LNK1143`. `scripts/build-native.mjs` reads the host triple and
  passes it.
- The adapter is built with the **MinGW** compilers when the Ogre install is a
  MinGW build (it ships `libOgreNextMain.dll.a`), because MSVC cannot link those
  import libraries. That mix — MinGW adapter, MSVC host — is deliberate.
- The default `ai` feature pulls a vendored llama.cpp C++ build and needs
  `LIBCLANG_PATH=C:\msys64\ucrt64\bin`; it is not required for the host or the
  test suite.
- OGRE-Next is bootstrapped automatically when `third_party\ogre-next-install`
  is missing or incomplete; `npm run bootstrap` runs that step on its own, and
  `node scripts/bootstrap.mjs --force` rebuilds it.

### PATH-shadowing gotcha

MSYS2 UCRT64 compilers fail *silently* when an earlier `PATH` entry shadows one
of their DLLs. `tension-core/build.rs`'s `prefer_tool_own_dir` reruns each
compiler with its own directory first on the child's `PATH` — keep that when
touching the solver build, and don't "simplify" it away.

## Examples (`npm start`)

Each example's `npm start` runs `scripts/run-example.mjs`, a dependency-free
Node runner that works in cmd/PowerShell: it resolves the host binary for the
platform (`.exe` on Windows), builds the guest, packs what needs packing, and
composes the host's arguments. Per-example specifics live in a `tension` block
in that example's `package.json`. Steps that are the repo's own shell scripts
(the framework session-config generator, `npm run pack`) run through
`msys2_shell.cmd -ucrt64` on Windows or bash elsewhere (override with
`TENSION_BASH`). `TENSION_OGRE_HEADLESS=1` runs the OGRE examples headless.
External prerequisites are unchanged: SDL3 for `input-camera`, gnuplot for
`solver/collision`, llama.cpp/libclang for `ai`.

Each example also ships `.vscode/{launch,tasks,extensions}.json`. The launch
config drives CodeLLDB over `tension-core --debug --symbol-path <example>` with
the example's own arguments, and a `windows` override selects
`tension-core.exe` (a relative program path without it will not launch on
Windows). Its pre-launch task builds the debug guest (source map required) and,
where the example packs a volume, runs `npm run pack` first.
