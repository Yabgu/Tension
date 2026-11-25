# Phase E — the two false claims, with the evidence that contradicts them

This round does not rewrite either file. It records what they say, where, and
what this machine does instead. Reproduce with the transcripts beside this file.

## Claim 1 — `docs/debugging.md`

`docs/debugging.md:156–163`:

```
- **Windows — no, and not because of this repository.** Measured on the Windows
  host with the msys2 lldb (`C:\msys64\ucrt64\bin\lldb.exe`): the process runs,
  the guest executes, and `image list` shows **no `JIT(0x…)` image at all**. The
  cause is upstream of the flags: wasmtime gates its GDB-JIT registration on the
  `gdb_jit_int` feature (`wasmtime-internal-jit-debug-50.0.2/src/lib.rs`), the
  ELF-target module the GDB plugin reads, and lldb on Windows does not consume
  that registration. So a guest breakpoint there is impossible today, DWARF or
  not, and no flag or setting changes it.
```

Also `docs/debugging.md:401` ("If `image list` shows no `JIT(0x…)` entry, the
…") depends on the same premise.

### Contradicted by

`phase-e-imagelist-transcript.txt`, same host, `examples/io`, lldb 20.1.4-codelldb:

```
(lldb) image list
...
[ 27] 6CA3140B 0x000001bd9ccb1000 JIT(0x1bd9cd98040) (0x000001bd9cd98040)
```

and a stop inside the guest at that image:

```
    frame #0: 0x000001bd9ccb9fd2 JIT(0x1bd9cd98040)`game/_start_game at game.ts:11:8
```

and the function resolvable in the image:

```
1 match found in JIT(0x1bd9cd98040):
        Address: JIT(0x1bd9cd98040)[0x000001bd9ccb9f20] (…PT_LOAD[0]..text + 36640)
        Summary: JIT(0x1bd9cd98040)`game/_start_game at game.ts:10:8
```

W1 measured the same `JIT(0x…)` image with the msys2 lldb 23.1.5 as well
(`image list` entry `[ 26] 4915ABDA 0x00000167b2721000 JIT(0x167b2802040)`), so
the claim is not merely an artefact of which lldb was run: it was measured on
the very binary the sentence names.

The one thing in that paragraph that *is* reproducible: the msys2 lldb's
`image list` shows the image but a source breakpoint's stop carries no
`at file:line` (W1, and this round's cross-check) — a *line-attribution*
failure, not a missing image. The sentence under test says the image is absent
and a breakpoint is "impossible"; both are false here.

## Claim 2 — `tension-core/tests/debugger.rs`, module documentation

`tension-core/tests/debugger.rs:42–50` (`# The Windows fact`):

```
//! # The Windows fact
//!
//! lldb on Windows does not register wasmtime's GDB-JIT image: the guest runs,
//! and `image list` shows no `JIT(0x…)` entry at all (measured on the msys2
//! lldb; wasmtime gates the JIT-debug module on `gdb_jit_int`, which the GDB
//! plugin reads, and that path exists for the ELF targets). So (b) and (c) keep
//! their count on Windows but assert only what is observable there — the
//! report.
```

and the per-test restatement at `debugger.rs:461–462`:

```
/// Windows cannot bind (module docs, "the Windows fact"), so there the test
/// asserts the capability fact it can check and says what it did not measure.
```

Contradicted by the same transcript above.

## The short-circuits that make the suite pass without measuring

`debugger.rs` has **three** `cfg!(windows)` early returns, and on this machine
**all three are taken** — so three of the five tests never touch lldb:

| test | branch | line |
|---|---|---|
| `a_source_breakpoint_binds_in_a_promise_guest` | `if cfg!(windows) {` … `assert_dwarf_report_only(&guest); return; }` | **469–476** |
| `a_guest_without_dwarf_cannot_be_stopped_at_a_source_line` | `if cfg!(windows) {` … `return; }` ("the negative control is vacuous") | **556–562** |
| `a_source_breakpoint_binds_in_a_stack_switching_guest` | `if cfg!(windows) {` … `assert_dwarf_report_only(&guest); return; }` | **613–620** |

Measured (`gate-cargo-test-debugger.txt`, `--nocapture --test-threads=1`):

```
lldb on windows does not register JIT images, so nothing binds there and the negative control is vacuous (measured; see docs/debugging.md)
test a_guest_without_dwarf_cannot_be_stopped_at_a_source_line ... ok
lldb on windows does not register JIT images, so a guest breakpoint cannot bind (measured; see docs/debugging.md)
test a_source_breakpoint_binds_in_a_promise_guest ... ok
lldb on windows does not register JIT images, so a guest breakpoint cannot bind (measured; see docs/debugging.md)
test a_source_breakpoint_binds_in_a_stack_switching_guest ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

The round's brief expected two; the tree has three, and three fire. Reporting
what ran, not what was expected.

Note on the third: it reaches the Windows branch, not the earlier
"no DWARF for stack-switching" return at `debugger.rs:605–611`, because
`carries_debug_info(&guest)` is now **true** for `main-policy` — the build
artifact carries `.debug_info`, `.debug_line` and `.debug_ranges` (checked by raw
section-name search; `llvm-dwarfdump` 23.1.5 refuses that artifact with
`error: bad form`, so the section is present and its encoding is not something
that tool accepts). The "pinned compiler emits no DWARF for stack-switching
programs yet" note at `605–611` and in the module docs is therefore a second
stale statement. Not edited; recorded.
