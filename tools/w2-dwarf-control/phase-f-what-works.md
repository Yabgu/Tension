# Phase F — what a person can debug on this machine today

`examples/io` is the example that runs here and stops here. lldb 20.1.4-codelldb
(CodeLLDB's own), `tension-core.exe --debug`.

## Which lines stop

In `examples/io/game.ts`, `_start_game`:

- **Stop exactly** (`game.ts:N`, requested N): **11, 14, 22** — and any other line
  in the function after the first statement.
- **Stop one line late**: **10**, the first statement — asks for 10, stops on 11.
  This is the general shape: the *first statement of a function* resolves to the
  next source line, because lldb will not put a breakpoint on the address it
  treats as the function's entry.
- **Never stop**: none observed in `_start_game` on this build.

## The configuration to pick

`examples/io/.vscode/launch.json` → **`lldb: tension-core --debug (io example)`**.

- It points at `tension-core/target/debug/tension-core.exe` (a debug build must
  exist: `cargo build --no-default-features --features audio,render2d-core,static-sdl3`).
- Its `preLaunchTask: "debug"` runs `build:debug`, which builds the guest with
  `--debug --sourceMap`, so the artifact the debugger opens does carry DWARF.
- It sets `plugin.jit-loader.gdb.enable on`, which is what makes the guest's
  `JIT(0x…)` image appear.

## Three steps to see both

1. Open `C:\work\Tension\examples\io` in VS Code. Install `vadimcn.vscode-lldb`
   if prompted. Put a breakpoint on **`game.ts:14`** and press **F5**.
   *Good stop:* the frame shows `game/_start_game at game.ts:14:23`.
2. Move the breakpoint to **`game.ts:10`** and press **F5** again.
   *Bad stop:* it stops in the same function, but on **line 11** — the debugger
   highlights `print("Arguments passed to the game:")`, not the line you asked for.
   (`breakpoint list` shows one location, at the line-11 address; both the line-10
   and line-11 breakpoints resolve to the *same* address.)
3. That is the whole picture for this example: the first statement misses, every
   line after it is exact. (The thing that makes `examples/async-on-main`
   undebuggable here is not this defect — its guest is refused at load because
   this host has no stack switching. Different round.)

Workaround while line 10 misbehaves: put the breakpoint on line 11 or any later
line in the function — those bind to their own addresses. A breakpoint set
*by address* on line 10's own row was attempted (`phase-c2-address-probe.json`)
and could not be exercised: by the time the JIT image exists and its addresses
are known, execution is already past those addresses, so the probe's address
breakpoints were created and never hit. Whether that workaround works is
therefore **unverified**.
