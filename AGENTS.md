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
5. **Declare records plain; name the storage model at every use.** A struct
   declaration carries **no** `@managed`, `@unmanaged` or `@inline`:

   ```ts
   export struct SpriteRecord { x: i32; … }      // declaration: plain
   out[i].set(x, y, frame, sortKey, group, z)    // the record fills itself
   const out = changetype<@unmanaged [SpriteRecord *]>(records);   // use: explicit
   ```

   The declaration says *what the bytes are*; the use says *how they cross*
   (by value, by pointer, as a GC reference). Three rules follow from that and
   they are not negotiable in review:

   - **Never a manual `load<T>`/`store<T>` where a field name will do.** A
     record is reached as `records[i].x`, a pixel as `px.r`; hand-written
     offsets belong only in a byte-level control (see
     `examples/2d/isometric/src/bindings.ts`) or where the layout is packed and
     cannot be a struct (the IWI header, `TS6408`).
   - **No `addr + i * RECORD_SIZE` in guest code.** Records are
     `@unmanaged [T *]` — the compiler supplies the stride.
   - **No free writer function, no named padding.** A record fills itself
     (`out[i].set(…)`); the fields are the fields the wire has, and C's
     implicit padding is not one of them.

   `@managed` and `@unmanaged` are never omitted "because it compiles": an
   omission is a value where a pointer was meant, or the reverse. The ways this
   rule gets broken, each of which has already been written and removed here,
   are catalogued under **Antipatterns** in `## Capabilities`.

   Three compiler limits push against this rule and are the reason a use site
   sometimes looks heavier than expected. All are measured, all are in
   `tension-framework/assembly/2d/types.ts` with their refusals quoted:
   a plain-struct **scalar** param cannot be written through (`AS100`) or be
   host-visible (`TS6411`), so parameters are array views; a view `const` in a
   scope with an integer `const` crashes the compiler, so it is a `let`; and two
   value locals of one struct type in two loops of a function crash it too, so
   one of the two reads through a view instead.

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
into depth-sorted bands). A record is a `struct` declaration and fills itself
through its own `set`; the declaration is the layout, and the compiler supplies
the offsets and the stride. Worked examples:
`examples/2d/isometric` (real art, hand-written records — the control) and
`examples/2d/isometric-framework` (the same scene via the library, frames
byte-identical).

**The 2D verbs are declared per example** (`examples/2d/*/src/bindings.ts`), not
in the SDK: `tension-2d/include/tension_2d.h` has no `schema/` entry, so
`tools/codegen` cannot generate them, and the hand-written module documents the
overloads a generator would not. Only `set_texture` is declared inside the SDK,
by `Tileset.bind`. Moving the rest there is a pending cleanup, not a design
choice.

### How a capability is loaded

`tension-core --capability <name|path>`, repeatable. A value naming an existing
file is that file; anything else is a capability *name*, resolved as
`<dir>/libtension_<name>.so` across `TENSION_CAPABILITY_PATH` (colon-separated).
The explicit path is checked first, so an operator pointing at a file is never
overridden by the environment. `--capability 2d` is therefore
`libtension_2d.so` somewhere on that path.

An adapter DSO exports the shared ABI in `tension_adapter.h`: an import table,
`publish`, `apply`, `layout_hash`. At load the host compares `layout_hash`
against the arena layout it was built with; a mismatch is refused, not repaired.
`publish` is the only place an adapter writes guest memory, it runs inside a byte
budget, and only one runs at a time. An import declared `DEFERRABLE` on an
adapter with no `apply` hook is refused at registration, because nothing could
ever apply the deferred work.

**Order matters in the guest.** `RuntimeSession.open(ConfigBuilder.forThisBuild())`
must succeed before any verb whose arguments live in guest memory. Observed
here: with no ready session, `open` still returns a handle and the first verb
that needs the arena (`info`, `submit`) answers `-EBADF`. Every example checks
the session's return value first, before it checks `open`'s.

**Verb shape.** Every capability verb takes and returns `i32` (no `size_t` at
this boundary). A pointer crosses as a guest address, a failure is a negative
errno, a handle is positive. No verb takes a struct by value or a string: a
string is ptr + len, a record run is ptr + count + stride. The named wrappers in
each example's `bindings.ts` exist to give the positional `i32`s names and to
convert a pointer once; they do no byte work, and a wrapper that starts doing
byte work has stopped being a wrapper.

## Writing a guest in TensionScript

Long form, with the compile-and-run evidence for each claim:
`~/work/TensionScript/docs/showcase.md` §1–§4 (the language is the published
`@yabgu_gm/tensionscript`; versions named there may lag the pin here, so a
limitation quoted below was re-measured against the version in this tree).

The short version: **the language already has a type for every shape a guest
handles.** A record, a run of records, a pixel, a header — each is a `struct`
declaration, and the compiler derives the offsets, the stride and the size. Code
that spells out an offset, a stride or a field count is not "low-level"; it is a
second, unchecked copy of what the declaration already says.

### The four storage models

A declaration says *what the bytes are*. Storage is chosen per type:

```ts
export struct SpriteRecord { x: i32; … }   // a value: bytes in a local, copied
@managed struct Particle { x: f32; … }     // GC record: new allocates, traced
@unmanaged struct Header { … }             // host-reached record: no GC header
```

- **A bare `struct` is a value.** Bytes live in the variable. SROA gives one
  wasm local per field, not one local and an address. Assignment copies, so
  `let b = a; b.x = 1` leaves `a.x` alone. `@inline struct` is its synonym.
- **`@managed struct` is GC-owned.** `new` allocates; the *reference is the
  fields pointer*, so a field read is a load from the reference with no header
  indirection. That is what lets a host read the record through the pointer it
  is given — and why the host must not retain it past the call.
- **`@unmanaged struct` is a record the host reaches through a pointer.** No GC
  header, so no tracing; a use that asks for one is refused (TS6394).
- **A `class` is a reference type.** Use it for anything looked up, stored in a
  `Map`, or handed around — not for the wire. A value cannot be a class field, an
  `Array`/`Map` element, or a non-local argument (AS100 ×3), and `@managed` at a
  use cannot rescue it (TS6395).

### What a `struct` gives you

Layout is C's, computed from the field list:

```ts
struct Inner { a: i32; b: i32; }
struct Outer { tag: u8; inner: Inner; }
sizeof<Outer>()                            // 12: 1 + 3 pad + 8
offsetof<Outer>("inner")                   // 4
alignof<Outer>()                           // 2 — the log2 exponent, so 4 bytes
```

- **Natural alignment, trailing padding included.** The size is the C answer, not
  the sum of the fields — which is what makes the declaration a usable mirror of
  a C header rather than an approximation of one.
- **A struct-typed field is inline** when its declaration is plain (measured:
  `Outer` above is 12, not 8). A field whose *declaration* is `@unmanaged struct`
  is a reference instead — the same `Outer` is 8 bytes (1 + 3 pad + pointer) —
  so the storage word at the field decides the layout there too. A use cannot
  flip it: `inner: @managed Inner` over a plain `Inner` is TS6395.
- **`@abi.alias("name")`** gives a field the C name on the wire while the source
  keeps its own; **`@abi.align(n)`** *raises* the alignment of a field or record
  and refuses anything lower (TS6406–6408). A record that needs nothing C would
  not do needs no annotation at all.
- **Methods belong to the record.** `rec.field = v`, `rec.set(…)`, and a
  static factory all compile — including when the receiver is an element of a
  pointer view. The method is where a multi-field invariant lives, and `this` is
  the record's address. A factory that *returns* the record works in-module;
  across the entry module boundary it is refused like any other value return.

### Runs of records

The pointer-to-records type is `[T *]`; it is indexable and the stride is
`sizeof(T)`:

```ts
let out = changetype<@unmanaged [SpriteRecord *]>(records);
out[i].x = 1;               // i32.mul (index) (i32.const 28), then a store at +0
out[i].set(x, y, frame, …); // the element is an address: the same `this` a setter takes
```

Four properties to know:

- **`[T *]` has no length.** Reading `.length` is `TS2339` — the `*` says the
  count is unknown. Write `@dynamic [T * n]` and the compiler binds `n` as a
  local holding the count.
- **The element is an address, not a value slot.** So `out[i].field = v` and
  `out[i].method()` work, and `out[i] = someRecord` is refused (nothing to copy
  with). Copying is `copyInto(addr, value)`, which names its destination — and
  the address is the one place the stride must be written
  (`<usize>out + i * sizeof<T>()`), so prefer field writes.
- **`Array<T>` does not take a record element** (AS100: a value type in a type
  argument). A run of records means a view, not an `Array`.
- **A `usize` is a byte address, not a record run.** Size a buffer with
  `max * sizeof<T>()`, then convert once to the view. Every arithmetic step
  between the allocation and the view is a place the stride can be wrong.

### Refusals, and the form they ask for

Each of these is a real diagnostic from the pinned compiler, not style:

- `function f(r: @unmanaged SpriteRecord)` — a **field read** compiles (a load at
  the field's offset); a **field write** is `AS100` ("reading an @inline struct
  value as a whole"), and exporting the function refuses the parameter outright
  (`TS6411`: a view in a host-visible signature). So a record that gets written
  crosses as `@unmanaged [T *]`, written at `records[0]`.
- **A method on a value local** is `AS100` for the same reason: a value has no
  address for `this`. Index into a view, or let the record be a view element.
- **A plain-struct return works in-module, not across the module boundary**
  (`AS100: an @inline struct return across the module boundary`). In-module it is
  sret through a hidden destination, so an *expression* as an `@inline` argument
  is also refused — assign to a local first.
- **A single-field record is refused at every boundary.** The C convention passes
  the scalar and this compiler passes a pointer; both are `(param i32)`, so the
  disagreement would be silent. The refusal is the honest answer.
- **`changetype` between pointer types is refused** (`AS202`); a cast is enough
  (`<usize>view`, `<u32>ptr`). `changetype` earns its place only where the
  operand supplies an address *for a view*: `changetype<@unmanaged T>(ptr)`.
- **`T[N]` of a record does not inline yet** (of a scalar it does): a record
  array inside a record is not expressible; a pointer view is.
- **A packed format cannot be a struct.** Alignment only goes up (`@abi.align`
  asking for less than a field's natural alignment is refused, TS6408), so a
  record with a `u16` at an odd offset would silently move every later field.
  Keep byte stores there, and say in a comment which format and which
  diagnostic.

### Antipatterns this tree has already paid for

Each was written here, reviewed, and deleted. They are the same mistake at
different scales: **restating, by hand, something the declaration already
states.**

1. **Offsets as constants.** `const OFF_SORT_KEY = 20` then a `store<u32>` at
   `base + OFF_SORT_KEY`. The field name already says 20; the constant says it
   again, checked by nothing, and drifts the day a field is inserted. Write
   `records[i].sortKey = k`.
2. **Stride arithmetic at the call site.** `addr + i * RECORD_SIZE`. One dropped
   multiply lands a record in the middle of another and the failure is a pixel,
   hours later. Write the `[T *]` view and index it.
3. **`usize` where a record run was meant.** A signature taking a bare address
   forces every caller to re-derive the layout and checks none of them. The view
   type in the signature says what the bytes are.
4. **One accessor per field.** Seven functions, seven hand-written offsets, for
   one record. Declare the record, read it once, ask for `info.canvasWidth`.
5. **A copy of something the caller already has.** Allocating a record and
   assigning its fields from a view the caller already holds is a copy
   constructor wearing a helper's name. Index, name the field, use it.
6. **Layout self-tests.** `if (sizeof<T>() != 28) ERROR(…)` and `offsetof`
   comparisons. A struct that has a field has the field. Re-asserting the layout
   installs a second source of truth that can itself drift; a wire defect belongs
   in a pixel assertion, where running the example catches it.
7. **Storage on the declaration.** Annotating the *type* puts a crossing into it,
   so every use inherits an answer nobody wrote down. Declare plain; say
   `@managed`/`@unmanaged` at the use.
8. **A free function that writes a record.** `f(records, i, x, y, …)` makes the
   record a parameter of somebody else's procedure: the call site names a buffer
   instead of a record, and the field list is restated per call. The record fills
   itself — `out[i].set(…)`, `hdr[0].set(out, count)` — because the element is an
   address. Keep inside it whatever cannot vary: a header's `stride` is
   `sizeof<T>()`, not a parameter, so no caller can submit a stride the adapter
   cannot decode.
9. **A pad field shadowing implicit padding.** C's padding between a `u16` and a
   `u32` is not a field: the header marks it `—`, and nothing reads it. Declaring
   one was a second statement of the layout that could disagree with it. Natural
   alignment produces the offset on its own.
10. **A helper whose body mirrors its parameter list.** The smell behind 4, 5 and
    8. If a body is assignments that restate the arguments, or a second
    declaration of what a type already says, ask what caller it serves. When the
    answer is "it works around a compiler limit", name the limit in a comment or
    delete the function.

### Compiler bugs, worked around

Not style, and not refusals with a form behind them — defects in the pinned
compiler that a use site has to step around. Each is stated with the shape that
triggers it, so the workaround can be recognised (and removed when it is fixed).

- **A `const` view beside an integer `const` in one scope crashes the compiler**:
  `AssertionError` in `setConstantIntegerValue` (0.13.2 and 0.14.1). Use `let`;
  nothing reassigns a view and the emitted code is identical.
- **Two value locals of one struct type in two loops of one function** produce a
  duplicate local name out of `fillSroaFieldLocals`. Keep one local, or read one
  of the two through a view.
- **A value type cannot be a class field, an `Array`/`Map` element, or a
  non-local argument** (AS100, three messages), and `@managed` cannot rescue it
  (TS6395). A looked-up, handed-around thing is a class — `Frame` is, and says
  why in its doc comment.
- **`@abi.align` takes an integer literal (TS6405) and only raises alignment
  (TS6406/TS6407/TS6408).** A decorator must precede the type it applies to
  (TS6392).

### Before you commit guest code

```
cd ~/work/Tension
grep -rn 'load<\|store<' tension-framework/assembly examples/2d/*/src   # oracle or packed format only
grep -rn 'OFF_'                 examples/2d/*/src                        # the isometric oracle only
grep -rn 'RECORD_SIZE'          examples/2d/*/src tension-framework/assembly/2d  # buffer sizing only
grep -rnE '^\s*@(managed|unmanaged) struct' tension-framework/assembly examples/2d/*/src  # expect none
```

The first two may hit only where a comment names the reason: a byte-level
control (`examples/2d/isometric/src/bindings.ts`, the independent oracle) or a
packed format that cannot be a struct (the IWI header). `RECORD_SIZE` should
appear where a buffer is *sized*, never inside an index. The last should be
empty — a declaration carries no storage annotation. A `usize` in a signature is
a raw byte span (a blob, a pixel buffer), never a run of records.

Then run the example: the pixel assertions are where a wire mistake is caught,
and they are the reason the layout needs no test of its own.

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
