# DL17B — the flag now fails loudly, and `-v` still reaches the guest

Three debts, all closed. **Two PRs**, because I39's behaviour is guest code and
the rest is host code:

- **`~/work/TensionScript-a2` `main` @ `3f59ec08`** — PR **#81**, merged
  fast-forward. Run **`45084737976`**: success, **16/16 jobs**.
- **`~/work/Tension` `integration/dwarf-debug` @ `a40350c`** — PR **#82**, merged
  fast-forward. Run **`45084745626`**: E2E debug, success (the one job this repo
  runs).

**`dist/assemblyscript.js` is unchanged at `aa74d6a1`** — verified, not assumed.
`dist/asc.js` moved (`f8297c0c` → `da283bcd`) because it embeds the std sources;
that is the file a CLI actually runs, and it is installed in the harness.

## 0. Phase 0, verbatim

```
$ cd ~/work/Tension
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
integration/dwarf-debug
a124c1f
$ cd ~/work/TensionScript-a2
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
main
9393acc9
$ sha256sum dist/assemblyscript.js ~/work/Tension/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js
aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d  /home/acakar/work/TensionScript-a2/dist/assemblyscript.js
aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d  …/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js
$ stat -c '%s %y' ~/work/Tension/tension-core/target/release/tension-core
33586784 2026-11-22 18:13:56.622527933 +0100
```

The `aa74d6a1` install from DL17 Phase A stuck. Both trees clean.

### The trap the brief warned about, found again — in std

While Phase 0-checking the install I compared the package's **std** and found it
**predated DL16 entirely**: `threadInitPlain`/`carveThreadLayout` absent (the
installed `std/assembly/thread.ts` was `fe9b5d72`, the tree's `5966cbdb`). DL16
installed `dist/` and not `std/`. The bin still behaved correctly because the
CLI bundle embeds std (`dist/asc.js`), so the stale `std/` dir was inert — but
that is luck, not design, and it is the same three-copies trap.

I39 changes std, so this round had to install std anyway. Both are now in step
and verified against the merged tree:

```
tree asc.js da283bcd   installed da283bcd
tree as.js  aa74d6a1   installed aa74d6a1
std/assembly/thread.ts: tree == installed
```

## 1. I32 — the table, quoted

`HOST_OPTIONS` in `tension-core/src/main.rs`. Fifteen entries, every spelling,
and the missing-value wording that used to live in the parser's error strings:

```rust
struct HostOption {
    /// Every spelling. The **first** is canonical: messages name it.
    spellings: &'static [&'static str],
    value: ValueForm,
    kind: HostOptionKind,
    /// Completes "`--flag` " when the value is missing, e.g. `needs a count`.
    missing_value: &'static str,
}

const HOST_OPTIONS: &[HostOption] = &[
    HostOption { spellings: &["--debug"],            value: ValueForm::None,         kind: Debug,           missing_value: "" },
    HostOption { spellings: &["--symbol-path"],      value: ValueForm::Both,         kind: SymbolPath,      missing_value: "needs a path" },
    HostOption { spellings: &["--res"],              value: ValueForm::Both,         kind: Res,             missing_value: "needs a pak path" },
    HostOption { spellings: &["--write-root"],       value: ValueForm::SeparateOnly, kind: WriteRoot,       missing_value: "needs a directory" },
    HostOption { spellings: &["--capability"],       value: ValueForm::Both,         kind: Capability,      missing_value: "needs a path or a name" },
    HostOption { spellings: &["--log-level"],        value: ValueForm::Both,         kind: LogLevel,        missing_value: "needs a spec" },
    HostOption { spellings: &["--log-format"],       value: ValueForm::Both,         kind: LogFormat,       missing_value: "needs `text` or `json`" },
    HostOption { spellings: &["--log-file"],         value: ValueForm::Both,         kind: LogFile,         missing_value: "needs a path" },
    HostOption { spellings: &["--session-open"],     value: ValueForm::None,         kind: SessionOpen,     missing_value: "" },
    HostOption { spellings: &["--session-callbacks"],value: ValueForm::Both,         kind: SessionCallbacks,missing_value: "needs a table slot (or two)" },
    HostOption { spellings: &["--post-test-events"], value: ValueForm::None,         kind: PostTestEvents,  missing_value: "" },
    HostOption { spellings: &["--executors"],        value: ValueForm::Both,         kind: Executors,       missing_value: "needs a count" },
    HostOption { spellings: &["-h", "--help"],       value: ValueForm::None,         kind: Help,            missing_value: "" },
    HostOption { spellings: &["-V", "--version"],    value: ValueForm::None,         kind: Version,         missing_value: "" },
    HostOption { spellings: &["--"],                 value: ValueForm::None,         kind: Terminator,      missing_value: "" },
];
```

(The literals are one field per line in the file; condensed here for reading.)

`SeparateOnly` exists because Phase A measured that `--write-root=/tmp` is
`unknown option` — that option has no `=` form, and a table that did not record
it would "fix" the suggestion into the same non-spelling that failed.

**One recogniser.** `match_host_option(&arg) -> Option<HostMatch>` — `Exact` or
`Equals(option, Option<&str>)`, where the inner `None` means "an `=` form this
option does not accept". `parse_cli` dispatches on the result; the refusal in
`misdirected_host_option` reads the same function. `HostOptionKind` is an enum so
the dispatch `match` is exhaustive — a table entry without an arm does not
compile, which is what makes "the table is the source of truth" a mechanical
claim rather than a promise.

**The refusal.** Exit 2 (the route `unknown option` already took), the flag
named as typed, the rule, and the corrected line:

```
tension-core: `--executors` came after the module path, so it was handed to the
guest as argv instead of applied by the host.

Host options must precede <game.wasm>: everything after it is passed to the
game verbatim (that is what the guest's `tension::io arg()` returns).

The corrected order is:

    tension-core --executors 2 tension-core/tests/programs/build/count.wasm
```

The suggestion is rebuilt, not templated: what the host understood
(`--res a.tns` if you gave one) + the moved flag + the path + the remaining guest
args. Measured on a mixed line:

```
$ tension-core --res a.tns game.wasm --executors 2 foo
    tension-core --res a.tns --executors 2 game.wasm foo
```

## 2. I34 — the corrected paragraph

`docs/threads.md` §1, replacing the three false lines:

> Both are emitted only by a `--sharedMemory` build, and only when the program's
> own code reaches the threading surface — a program that names no thread API
> gets neither, and a host that does not define them can still link such a
> module. (The condition used to be "the module has an async shell", which was
> never the right question: it made a shared build with a plain `main` carry two
> imports it could not use, and a host that defined only `env` then failed to
> link it at all. See `docs/thread-abi.md` §5 in TensionScript for the emission
> rule that replaced it.)

The rest of §1 is accurate and untouched.

## 3. I39 — the contract sentence, and both collision comments

The export's contract, in `std/assembly/thread.ts` above `__workerMainPlain`:

> **The status is `0` on success — not the entry's answer (I39).** An entry's
> return value is its own: for an async entry it is the `Task` handle, a heap
> address (measured: 169888), and for a sync entry whatever the function
> returned. Nothing consumes it — the host's only reader is a Debug log line,
> and `__threadJoin` waits on the state word written below — so the success path
> answers `0`, which is what `0` means everywhere else in this ABI. The three
> refusals above keep their codes. (The served body answers `__lastStatus()`: a
> real status, because it drove resumes.)

The body change, and the reason at the call site:

```ts
  let entry = atomicLoad<i32>(sig + 16);
  if (entry >= 0) {
    ...
    // The answer is dropped on purpose: it is the entry's own word, and for an
    // async entry that word is a heap address rather than a status (I39).
    __callStart(entry);
  }
  atomicStore<i32>(sig + 12, 2);
  ...
  return 0;
```

**Both sites name the other user of the channel.** Guest side, above the
function:

> **Those refusals share a numeric channel with the host's `ERR_*` codes**
> (`tension-core/src/thread.rs`): both leave a negative `i32` in this export's
> return. `-1` agrees; `-2` (`thread.rs`'s `ERR_ALREADY_BORN`) and `-3`
> (`ERR_INSTANTIATE`) mean different things here. Renumbering touches the ABI,
> so it is filed as its own round; until then read a negative from here against
> *this* list, not against the host's.

Host side, above `ERR_ID_OUT_OF_RANGE`:

> **These numbers share a channel with the guest's own refusals** — the value an
> exported `__workerMain` answers (`std/assembly/thread.ts` in TensionScript
> answers `-1` … `-2` … `-3` …). `-1` agrees; `-2` and `-3` do not. Nothing
> reads the guest's answer today except the Debug lines in `run_worker` and
> `ExecutorPool::join_finished`, so the collision is latent rather than active —
> but a negative read off a log belongs to whichever side produced it, and
> renumbering either half is an ABI change with its own round. See I39.

Nothing renumbered, per the brief.

## 4. Phase C — the four commands

```
$ tension-core --executors 2 count.wasm
executors=3
executorTotal=3                              exit 0          ← unchanged

$ tension-core count.wasm --executors 2
tension-core: `--executors` came after the module path, so it was handed to the
guest as argv instead of applied by the host.
Host options must precede <game.wasm>: everything after it is passed to the game
verbatim (that is what the guest's `tension::io arg()` returns).
The corrected order is:
    tension-core --executors 2 tension-core/tests/programs/build/count.wasm
                                             exit 2          ← was exit 0, executors=1

$ tension-core count.wasm --debug
tension-core: `--debug` came after the module path, so it was handed to the guest
as argv instead of applied by the host.
                                             exit 2          ← bare flag, same rule

$ tension-core examples/io/build/game.wasm -v
=== TensionCore demo game ===
Arguments passed to the game:
  count = 1
  arg[0] = "-v"
                                             exit 0          ← NOT a host flag
```

**Guest argv is unchanged.** Beyond `-v`: `--window=1280x720` and a literal `--`
both still arrive (`count = 2`, `arg[0] = "--window=1280x720"`, `arg[1] = "--"`),
which is what `examples/2d/hello-sprites/dist/run.sh` and
`apps/editor/dist/run.sh` pass. The fix is narrow by measurement, not by claim.

Two more forms, because they are the ones a table could get wrong:

```
$ tension-core game.wasm --executors=2
    tension-core --executors=2 examples/io/build/game.wasm      (inline form moves whole)

$ tension-core game.wasm --write-root=/tmp
    tension-core --write-root /tmp examples/io/build/game.wasm  (split: that option
                                                                 has no `=` form)
```

### I39's observable

`strand-nested`, an async entry on a Promise build, `--executors 2`:

```
before (DL17 Phase A, old std): executor 1 finished (__workerMain answered 169888)
after  (this round):            executor 1 finished (__workerMain answered 0)
```

and the guest is otherwise identical: `recorded 1 park(s)`, DL12B's refusal, exit
1 — the value changed, the behaviour did not.

## 5. Regressions and the two new tests

| check | result |
|---|---|
| `cargo test --test threads` | **5 passed**, 0 failed (artifacts force-rebuilt first) |
| `cargo test --test async_main_promise` | **2 passed** |
| `examples/async-on-main` Promise build | **28 lines**, `main: done, total=67`, exit 0 |
| the stranding guest | **exit 1**, DL12B refusal present |
| `plain-worker.ts` | `counter=10`, exit 0 |
| `cargo test --test e2e_debug` | 3 passed (what this repo's CI runs) |
| `cargo test --test debugger` | 5 passed (ditto) |
| `cargo test --bin tension-core` | **307 passed**, 0 failed |

The artifacts were **force-rebuilt** (`build-test-programs.mjs --force`,
`25 built, 0 up to date`) before the thread tests — DL16's lesson: a suite that
runs against stale artifacts proves nothing about this round's compiler.

**Two new tests, in `tension-core/src/main.rs`, module `host_option_table_tests`
(count 305 → 307, and no other test added or removed):**

1. `every_table_entry_is_recognised_and_refused_after_the_module_path` — for
   every spelling: `match_host_option` recognises it; `parse_cli` accepts it
   (with a value its own parser accepts) and leaves no guest argv; and
   `misdirected_host_option` refuses it **and names it** — except `--`, the
   terminator, which must not be refused.
2. `the_usage_text_and_the_table_agree_about_every_dash_token` — every dash
   token the options block of `USAGE` documents is in the table, and every table
   spelling is documented; plus four dash tokens that are *not* host options
   (`-v`, `--window=1280x720`, `--title=Tension Editor`, `-`) must not match.

Proven able to fail: adding `--not-in-the-table` to `USAGE` alone made test 2
fail by name —

```
`--not-in-the-table` is documented in USAGE but missing from HOST_OPTIONS, so the
post-path check cannot refuse it — add it to the table
```

— and reverting restored green.

**Three existing tests asserted the old rule and were updated, not weakened.**
Each keeps its real intent (guest argv survives) and gains the new assertion:

- `res_flags_are_collected_in_order` — the post-path token is now
  `--window=1280x720` + `-v` (what the 2d examples pass), and `game.wasm --res
  a.tns` is asserted to be an error naming `--res`.
- `capability_values_are_collected_in_order` — post-path token is
  `--title=Tension Editor`; `game.wasm --capability=echo` is asserted refused.
- `log_flags_after_the_guest_belong_to_the_game` → **`_are_refused`**: the log
  flag after the path is now an error, and the half that is still true (a
  non-host `--level=debug` reaches the guest) is asserted.

## 6. ABI doc

Regenerated, because my comment block moved `thread.rs`'s registration lines by
+10 (`thread.rs:404` → `:414`, `:359` → `:369`, etc.). Row count unchanged at
**96**; the only changes are the line numbers, 9 rows.

`node scripts/test-abi-docs.mjs` still reports **I36** and nothing else:

```
ok      docs/abi/adapter.md is current (adapter)
ok      docs/abi/guest.md is current (guest)
ok      sizeof(tension_core_api) == 224
ok      sizeof(tension_adapter) == 80
ok      every offset in docs/abi/adapter.md matches cc
not ok  the pre-commit hook could not be exercised: the copied tree is already stale:
ok      docs/abi/adapter.md has 38 table rows
ok      docs/abi/guest.md has 96 table rows
abi-docs: 1 check(s) failed
```

Not fixed, per scope.

## 7. A deviation from the declared delta, stated plainly

**The declared delta did not include `std/assembly/thread.ts`, but I39's
behaviour can only be changed there.** `__workerMainPlain` is guest code in
TensionScript's std; the host never computes the value, it logs what the export
answers. Hence two PRs.

What the gate asked for is still true, and I checked it rather than assuming:

- **`dist/assemblyscript.js` is unchanged at `aa74d6a1`.** std is not embedded in
  the library bundle (measured before the round: `carveThreadLayout` count 0 in
  `assemblyscript.js`, 3 in `asc.js`), so a std edit cannot move the compiler.
- No compiler **source** changed: `src/` is untouched. `git status` on the
  compiler repo showed one file, `std/assembly/thread.ts`.

`dist/asc.js` did change (`f8297c0c` → `da283bcd`) — it embeds std, and it is the
file a CLI runs. Installed in the harness, verified, above.

## 8. What I did not verify

- **The three worker refusals at run time.** `-1`, `-2`, `-3` are unchanged by
  the diff, and their branches are the same early returns, but the host always
  calls `__workerMain` with a valid id on a carved store — so nothing in this
  configuration reaches them. `the_contracts_refusals_are_values` covers
  `__spawnThread`'s refusals (`-1`, `-2`), not the worker body's.
- **A downstream guest that passes a now-host-flag token after the path.**
  Nothing in this repo does; `-v` and the `--window=`/`--title=` family were
  checked and still pass.
- **Windows.** Unchanged by this round (host parse logic and guest status only),
  and not run.
- **The `--help`/`--version` subprocess behaviour.** Those two call
  `process::exit`, so the table test asserts *recognition* for them and cannot
  parse them in-process; their output is covered by the CLI tests.
- `--write-root` has no `=` form. I recorded it and made the suggestion split it,
  but I did not add the `=` form — that would be a feature, not this round.
