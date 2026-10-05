# AGENTS.md — Tension

Guidance for AI coding agents working in this repository. The **hard rules**
come first; the rest is the Windows build cheat-sheet.

## Hard rules

1. **`third_party/` is read-only.** Never edit, generate into, format, or
   delete anything under it — including its build trees (`ogre-next-build*`,
   `ogre-next-install`) and the `ogre-next` submodule. `.gitignore` may cover
   paths there, but the tree itself is off limits. Build OGRE only through
   `third_party/bootstrap.sh`.
2. **Never use destructive git commands and never commit on the user's behalf.**
   Leave changes in the working tree for the user to review and commit.
3. **Honor runtime tool/approval gates.** If a command is refused, surface it;
   do not route around it.

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

`build.bat` at the repo root is the entry point: it finds vcvars (VS 18),
Zig, and MSYS2 UCRT64 itself, then builds `tension-res` → `tension-ogre` →
`tension-core` (release, audio-only by default; `set AI=1` to include `ai`).

Manual equivalents:

```
tension-res     zig build -Doptimize=ReleaseSafe -Dtarget=x86_64-windows-msvc
tension-ogre    cmake -S tension-ogre -B tension-ogre\build-cmake -G Ninja -DCMAKE_BUILD_TYPE=Release
                cmake --build tension-ogre\build-cmake
tension-core    cargo build --release --no-default-features --features audio
tests           cargo test  --no-default-features --features audio
```

- The Zig archive **must** use `-Dtarget=x86_64-windows-msvc` when the Rust
  host is MSVC; a default-ABI build yields a MinGW archive that `link.exe`
  rejects with `LNK1143`.
- The default `ai` feature pulls a vendored llama.cpp C++ build and needs
  `LIBCLANG_PATH=C:\msys64\ucrt64\bin`; it is not required for the host or the
  test suite.
- OGRE-Next must already be installed at `third_party\ogre-next-install`.

### PATH-shadowing gotcha

MSYS2 UCRT64 compilers fail *silently* when an earlier `PATH` entry shadows one
of their DLLs. `tension-core/build.rs`'s `prefer_tool_own_dir` reruns each
compiler with its own directory first on the child's `PATH` — keep that when
touching the solver build, and don't "simplify" it away.
