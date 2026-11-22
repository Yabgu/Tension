# DL17 — Phase A: the flag list, the dash-argument question, and four options for I39

**Stop point.** This is Phase A only. A2's choice and A3's option are the user's;
nothing below is implemented.

## 0. Phase 0, verbatim

```
$ cd ~/work/Tension
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
integration/dwarf-debug
4517e6a
$ cd ~/work/TensionScript-a2
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
main
9393acc9
$ stat -c '%s %y' ~/work/Tension/tension-core/target/release/tension-core
33586784 2026-11-22 18:13:56.622527933 +0100
```

Both trees clean, both at the expected commits.

### The bundle was one behind — installed

```
tree      ~/work/TensionScript-a2/dist/assemblyscript.js                         767d3d7a  (before)
installed ~/work/Tension/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js  767d3d7a
```

Installed `aa74d6a1` (tree → harness, `binaryen.js` excluded), copying the eight
files that differ: `asc.generated.d.ts`, `asc.js`, `asc.js.map`,
`assemblyscript.generated.d.ts`, `assemblyscript.js`, `assemblyscript.js.map`,
`importmap.json`, `web.js`.

```
after: installed assemblyscript.js  aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d
       installed asc.js             f8297c0c32194a84f200971b939b2def8b803f2572f911b3d93dbb130e81f061
tree:  assemblyscript.js            aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d
       asc.js                       f8297c0c32194a84f200971b939b2def8b803f2572f911b3d93dbb130e81f061
```

Both hashes match the tree. Any guest built from `~/work/Tension` from now on
compiles with `aa74d6a1`.

## A1 — the flag inventory, from the parser

`parse_cli` (`tension-core/src/main.rs:795-915`). The loop:

```rust
    let mut rest = argv.into_iter();
    while wasm_path.is_none() {
        let Some(arg) = rest.next() else { break };
        if let Some(value) = arg.strip_prefix("--symbol-path=") {
```

and the two arms that end it:

```rust
            other if other.len() > 1 && other.starts_with('-') => {
                return Err(format!("unknown option `{other}`"));
            }
            other => wasm_path = Some(other.to_string()),
```

then

```rust
        args: rest.collect(),
```

**Value-taking, eight, each with both `--x value` and `--x=value`:**

| flag | value | repeatable |
|---|---|---|
| `--symbol-path` | a path | yes |
| `--res` | a pak path | yes |
| `--capability` | a path or an adapter name | yes |
| `--log-level` | a spec (`level` or `name:level`) | yes |
| `--log-format` | `text` \| `json` | no |
| `--log-file` | a path | no |
| `--session-callbacks` | `<BATCH>[,<EVENT>]` | no |
| `--executors` | a count, 0..=31 | no |

**Value-taking, one, separate form only:**

| flag | value | note |
|---|---|---|
| `--write-root` | a directory | **no `--write-root=` form** — measured: `tension-core --write-root=/tmp game.wasm` → ``tension-core: unknown option `--write-root=/tmp` `` |

That asymmetry matters for A2: a table-driven check has to know which flags take
a value (to name the value in the suggested command line), and a user who typed
the `=` form after the path would in fairness be told something different from a
user who typed it before.

**Bare flags, five, plus the terminator:**

| flag | effect |
|---|---|
| `--debug` | guest debug info + debugger probe |
| `--session-open` | A1 test-only host-side session open |
| `--post-test-events` | A2 test-only three pre-`_start_game` events |
| `-h` / `--help` | print usage + backend, exit 0 |
| `-V` / `--version` | print version, exit 0 |
| `--` | end of options: the **next** argument is `<game.wasm>` |

So **15 spellings** (14 distinct options plus `--`), of which 9 take a value.

## A2 — what the current code does with a dash-argument after the path

**It reaches the guest, every time, unexamined.** `args: rest.collect()` takes
whatever is left with no inspection at all. Measured against
`examples/io/build/game.wasm`, which prints `argCount()` and each `arg(i)`:

```
$ tension-core examples/io/build/game.wasm -v
  count = 1
  arg[0] = "-v"

$ tension-core examples/io/build/game.wasm --executors 2
  count = 2
  arg[0] = "--executors"
  arg[1] = "2"

$ tension-core examples/io/build/game.wasm --debug      →  count = 1, arg[0] = "--debug"
$ tension-core examples/io/build/game.wasm -h           →  count = 1, arg[0] = "-h"
$ tension-core examples/io/build/game.wasm --help       →  count = 1, arg[0] = "--help"
$ tension-core examples/io/build/game.wasm -V           →  count = 1, arg[0] = "-V"
$ tension-core examples/io/build/game.wasm --            →  count = 1, arg[0] = "--"
$ tension-core examples/io/build/game.wasm --write-root →  count = 1, arg[0] = "--write-root"
$ tension-core examples/io/build/game.wasm --log-level  →  count = 1, arg[0] = "--log-level"
```

Every spelling in A1's table reaches the guest when it appears after the path —
including `-h`, `-V` and `--`. That is the documented contract
(`main.rs:681`): *"Options must precede `<game.wasm>`; everything after it is
passed to the game verbatim (that is what the guest's `tension::io arg()` hands
back)."* The contract is not the bug. **The silence is the bug**, on the one flag
that decides the measurement:

```
$ tension-core --executors 2 tension-core/tests/programs/build/count.wasm
executors=3
executorTotal=3

$ tension-core tension-core/tests/programs/build/count.wasm --executors 2
executors=1
executorTotal=1                    ← exit 0, no warning, and "--executors 2" is in argv
```

### Recommendation: refuse **only known host flags**

Refusing every dash-argument is stricter and would break a documented,
measured-working feature: `-v`, `--`, and a guest's own `--foo` all reach the
guest today, and `examples/io/game.ts` is built around exactly that. Changing it
is a worse bug than the one we are fixing, and the brief's own rule — "Do not
break guest argv to fix a flag" — settles it.

But the hole the brief names is real: *"refusing only known flags … leaves a
hole if a new flag is added and not listed."* I recommend closing the hole by
**deriving the known set from one table that the parser itself uses**, rather
than by keeping a second literal list beside the match arms. Concretely: the
value-taking chain is already eight `if let Some(value) = arg.strip_prefix("--x=")`
blocks — a table of `(name, takes_value)` iterated over is the same shape, not a
restructuring. Then a new flag cannot be recognised by the parser without being
in the table, because that is where the parser reads it from.

Two tests would pin it:

1. for every table entry `F`, `parse_cli([F, "guest.wasm"])` must not answer
   ``unknown option`` (the entry is really accepted);
2. every `-`-prefixed token in `USAGE` must appear in the table (adding a flag to
   the help text without the table fails).

The message, per the brief, names the flag, states the rule, and suggests the
corrected line. For the value-taking case the suggestion is mechanical:

```
tension-core: `--executors` was found after the module path, so it was handed to
the guest instead of the host — the guest ran with executors=1 (main alone).

Host options must precede <game.wasm>; everything after it is guest argv.

Try:  tension-core --executors 2 tension-core/tests/programs/build/count.wasm
```

`--write-root` gets a variant, because it takes no `=` form: if the argument is
`--write-root=/x` after the path, the suggestion is `--write-root /x`. I would
treat an `=`-form-after-the-path as a known flag too (it names a host flag), not
as an unknown one.

## A3 — I39: four options for the plain worker's return value

### The facts, measured

```
sync plain entry    (plain-worker.ts)      __workerMain answered 0
served body         (two-workers.ts)       __workerMain answered 0  (twice)
async entry, Promise (strand-nested.ts)    __workerMain answered 169888
```

**Who reads it.** Nothing but two Debug log lines, and both use the same phrasing:

```rust
// thread.rs:488 — run_worker
&format!("executor {id} finished (__workerMain answered {status})"),
// thread.rs:307 — join_finished
&format!("executor {id} joined (__workerMain answered {status})"),
```

**Does `__threadJoin` care? No.** It blocks on the record's state word, which the
guest body itself writes:

```ts
export function __threadJoin(id: i32): i32 {
  ...
  let addr = signalBase(recordBase(id)) + 12;
  while (true) {
    let state = atomicLoad<i32>(addr);
    if (state == 2) return 0;
    atomicWait<i32>(addr, state, -1);
  }
}
```

**Is the export guest-callable? No** — the host is its only caller
(`thread.rs:544`, `get_typed_func::<i32, i32>("__workerMain")`). No TensionScript
guest calls it. So the value is host-visible only, and no guest's code path
depends on it.

**The plain body forwards `__callStart(entry)`** — the entry's own word —
alongside three refusals that *are* meaningful (`-1` not shared / bad id, `-2` no
control block, `-3` arena does not cover the record). The served body answers
`__lastStatus()`, which reads a **module global** (`ASYNC_LAST_STATUS`,
`builtins.ts:12648`); a worker's globals are zero because `$~start` never ran
there, and no resume happens on a plain worker to write it.

**A collision worth naming before any option is chosen:** the host has its own
negative codes in the same channel — `ERR_ID_OUT_OF_RANGE = -1`,
`ERR_ALREADY_BORN = -2`, `ERR_INSTANTIATE = -3` (`thread.rs:58-60`) — while the
plain body answers `-1` for "not shared or bad id", `-2` for "no control block"
and `-3` for "arena does not cover the record". `-1` happens to agree; `-2` and
`-3` do not. Today nobody reads the value, so the collision is latent. **Any
option that starts *reading* it inherits the collision**, and the merged doc
`docs/threads.md` §1 says only *"`0` means the thread is running; anything else
means the worker never started"* for `__startThread` — nothing about
`__workerMain`'s return at all.

### The four options

**Option 1 — the success path answers `0`; the three refusals stay.**

- Breaks: nothing. Nothing reads the value; `__threadJoin` uses the state word.
- Becomes clearer: the export's contract becomes exactly *"`0`, or one of the
  guest's own refusals"* — the same shape as `__threadInit` and `__spawnThread`,
  and the same rule the host states for the whole ABI (`0 is success`).
- Debug log: `answered 0` for every successful worker. Loses the accidental
  signal that the entry returned a word — a loss nobody has ever consumed.
- ABI: **no guest-visible change.** No guest calls this export. A host reading
  the log gets a truer statement.
- Cost: information discarded. If a future round wants a real worker status, it
  starts from zero rather than from a pointer.

**Option 2 — answer `__lastStatus()`, as the served body does.**

- Breaks: nothing, but it *claims* something false. On a plain worker no resume
  ever runs, so `__lastStatus()` reads an untouched module global — `0` — while
  the served body's `0` is "the last resume returned 0". Same value, different
  meaning: the worst kind of agreement.
- Becomes clearer: superficially, the two bodies would look uniform.
- ABI: no guest-visible change; the host log would say `answered 0` and a reader
  would believe both bodies mean the same thing.
- Cost: a false statement in the code, which is the very defect this round is
  about.

**Option 3 — keep forwarding, and document the status as guest-owned.**

- Breaks: nothing.
- Becomes clearer: rephrase the two log lines so they stop implying a contract —
  `executor {id} finished (the entry answered {status})` — and state in
  `thread.ts`'s `__workerMainPlain` doc and in `docs/threads.md` that the word is
  **the guest entry's own return value, not a status**, that a Promise entry
  returns its `Task` handle, and that no host decision reads it. Says what is
  true instead of making it true.
- ABI: the value a host sees is unchanged; the *claim* about it is corrected.
  Guest-invisible.
- Cost: the contract stays undefined — "guest-owned" is a description of the
  current behaviour, not a property a future change can rely on.

**Option 4 — drop the two Debug log lines.**

- Breaks: observability. `thread.rs:488`'s "finished" line is the only place a
  worker's completion is visible at `Debug`, and DL10–DL12B used it repeatedly
  to tell "reached the seam" from "never ran". The park-count line is separate
  and would stay, but a worker that finished *without* parking would leave no
  trace.
- Becomes clearer: nothing claims the value means anything, because it is never
  printed.
- ABI: unchanged.
- Cost: a debugging tool lost to solve a documentation problem.

### Recommendation

**Option 1**, with option 3 as the conservative alternative.

Option 1 is the only one of the four that turns a sentence into a fact rather
than adding a caveat: after it, `__workerMain` answers `0` on success and a
refusal otherwise, which is the contract every other export in this ABI already
has. It cannot break anything, because no guest calls the export and the one
protocol that does depend on a worker finishing (`__threadJoin`) reads the state
word the guest writes. Option 2 is rejected for making the two bodies *look*
alike while meaning different things; option 4 is rejected for paying for a
documentation problem with a debugging tool. Option 3 is the right answer if you
would rather not change a value at all — then the fix is prose in three places
(`thread.ts`, the two `thread.rs` lines, `docs/threads.md`).

Whichever is chosen, I would also record the `-2`/`-3` collision between the
host's `ERR_*` and the guest's refusals in the same doc sentence, so a future
reader of a log does not mistake one for the other.

## A4 — is `docs/abi/guest.md` stale?

**No.** Compared by regenerating, not by guessing:

```
$ node scripts/gen-abi-doc.mjs
wrote docs/abi/adapter.md
wrote docs/abi/guest.md
abi-docs: 62 core imports, 32 capability imports, 2 memory imports, 13 modules

$ diff -q /tmp/dl17-guest-before.md docs/abi/guest.md   → identical
$ git status --short docs/abi/                          → (nothing)
```

It embeds 75 `file:line` references and every one is current — DL10 fixed the
generator, DL12B regenerated after `thread.rs` grew, and DL16 touched
`thread.rs` not at all.

Regenerating means running the checker, so, per the brief, its verdict (I36):

```
$ node scripts/test-abi-docs.mjs
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

The one failure is the pre-existing I36 — the hook exercise copies a tree that is
already stale (the copy list at `scripts/test-abi-docs.mjs:147-158` omits
`packages/cli/src`). It is not about the docs, which are reported current, and
this round does not fix it.

## What I did not verify

- Whether a guest that takes **`--debug` as its own argument** exists anywhere in
  this repo or in a downstream package. `examples/io/game.ts` takes bare `-v`;
  nothing I found takes `--<host-flag-name>`. So the recommended (a) is safe
  against *this* repo, and I cannot speak for others.
- The exact wording of the error for the `--write-root=/x`-after-the-path case —
  I have not written it.
- Whether `--legalize-js-interface`-style options exist in another parser in this
  workspace; I inventoried `tension-core`'s `parse_cli` only, as the brief asked.
- I did not measure what `__lastStatus()` answers on a plain worker directly
  (that would need a source change); I inferred `0` from two facts — it reads a
  module global, and worker globals are zero — plus the served body's measured
  `0`. Option 2's "false claim" argument rests on that inference and on the
  code shape, which is why I flagged it as an inference rather than a measurement.

## Stop

Waiting on: **A2's choice** (recommend: refuse only known host flags, table-derived,
with the two pinning tests) and **A3's option** (recommend: option 1, success path
`0` and refusals kept — or option 3 if no value should change).

Phase B is four small edits plus a possible ABI regeneration; Phase C proves all
three both ways.
