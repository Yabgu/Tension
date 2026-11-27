# DL58 — bank DL57, then prove it

**DL57's work is banked as twelve named commits, and the flakiness it left open is settled:
it was the `parked()` spin, not a tight timeout.** The proof is a red case, not an argument.

```
TensionScript  feat/dl57-async-input @ cfcd05d5   CI 16/16 (46059097144)
Tension        feat/dl57-async-input @ e9383e1   CI green (46060503417, and the head's run)
origin/main    untouched: Tension bdb8a11 · TensionScript 40402d3a
```

---

## 1. Phase 0 — banked

Thirteen commits, in the order the reasoning runs:

| SHA | why |
|---|---|
| `31038ca` | input: a line is a completion, not a blocking call — the reader thread, the two classes, the `peek/take_matching` producer, **and the `parked()` take-back** the spin was |
| `f2f023d` | ai: the await answers the event; the stub streams per drain |
| `c22ae61` | examples/ai: the REPL awaits a line, each chunk prints as it arrives |
| `ff43015` | toolchain: rebuild against the compiler with the input surface |
| `c36d287` | toolchain: repoint the gitlink at the reworded commits |
| `be36c11` | toolchain: re-vendor so the pin names the commit that exists |
| `fc24a50` | abi: the adapter header's layout hash moves with the arena shape |
| `f9b20d3` | abi: 15 class capacities do not fit the record 13 sized |
| `9d6ab7e` | guest: the `SessionInfo` struct declares the capacities it now has |
| `1342518` | tests: the second consumer, as a gate rather than a claim |
| `016fa58` | toolchain: pin the compiler branch head |
| `9f91dac` | ci: the second-consumer gate joins the Stackful proofs too |
| `e9383e1` | runtime: the resume line names the class that arrived |

The three `wip:` commits on TensionScript are `1b37c6cb` (`__inputSupported()` refuses a build
that cannot park an input handle), `0f06c070` (`~lib/io` declares it), `81b5e297` (a resumed
task learns the class its wake arrived as) — rewritten with real subjects, not squashed. The
trees are byte-identical to the WIPs (`git diff --stat 6b72ce62 HEAD` was empty), so the
rewrite cost nothing but the messages. `git status` clean on both.

## 2. Phase 1 — the flakiness, closed by a red case

**Ten runs, statuses read directly (no pipe, each its own `timeout 90`):**

```
ai        0 0 0 0 0 0 0 0 0 0    → 10/10 rc=0, 257 bytes each, all ten byte-identical
async-io  0 0 0 0 0 0 0 0 0 0    → 10/10 rc=0, guest output identical modulo log timestamps
```

**And the earlier `rc=124` was not a tight bound.** A run takes **215 ms**; a 30 s bound is
34× the need. The red case, by reverting exactly the one line and nothing else:

```
(revert `let _ = caller.data_mut().scheduler.take(class, key);` after the fiber resumes)
$ timeout 30 npm run run < in.txt
… session_close(session=1) -> 0
--- end ---
rc=124
```

The guest prints its last line and then never exits, because `parked()` stays above zero and
that is the number `host_loop`'s exit condition reads. Restored, `rc=0`. That is the whole
finding: the spin DL57 fixed was real, and "worked twice" was two samples of a fix that
happened to be in place.

## 3. Phase 2 — the census, before and after

`npm run run:examples`, 30 s each, stdin closed, statuses direct. **`hung` is the only
non-zero exit** — the rest are facts about this host or refusals doing their job.

| example | baseline (before DL57's fix) | after |
|---|---|---|
| ai | **hung** 27.7 s | **ran** 0.2 s |
| async-io | ran | ran |
| async-on-main · audio · io · log | ran | ran |
| ogre/animated-character · bouncing-ball · bouncing-bodies · hello-mesh · hello-triangle | ran | ran |
| ogre/input-camera | **hung** 27.7 s | **hung** 27.7 s |
| platform-control · res · solver/wasm · solver/world | ran | ran |
| solver/collision | refused-by-name (gnuplot) | refused-by-name (gnuplot) |
| **total** | **2 hung, 14 ran, 1 refused** | **1 hung, 15 ran, 1 refused** |

**`ai` moved from hung to ran**, which is the round's claim. `ogre/input-camera` still hangs,
at the same line as the baseline (`the workspace now renders through camera 1`) — and this
round changed the *input ABI*, so that deserves the explicit answer: **it is not the same
defect.** It is a camera/render loop under the OGRE capability, it hangs identically before and
after, and the input capability is not on its path (the example arms no awaitable source; its
input arrives through `tension-input`'s window events). Named, not fixed — out of scope.

## 4. Phase 3 — the gates

**Declared delta, before running:** DL57's change moves the wire format (`CLASS_COUNT` 13 → 15
and `layout_hash` twice), so *every* session guest and both capability DSOs were expected to
move — not a handful.

```
--check (TENSIONSCRIPT_DIR=~/work/TensionScript-a2):  10/10 links PASS
compiler: src → dist/assemblyscript.js  160 inputs → 1fefbe2f73fe  PASS
compiler: dist → installed              77d812321f4d (tree)      PASS
compiler: std mirror                    82 identical             PASS
runtime: src → release / debug          84 inputs → 384b5f6ebb64  PASS
fixtures: committed .wasm -> build      16 current (14 bytes, 2 dwarf)  PASS
guests: tests/programs/**/*.ten → build 36 current               PASS
guests: built by the installed compiler 72 of 72 current         PASS
guests: read set vs .debug_line         36 of 36 agree           PASS
docs: docs/abi/*.md                     current                   PASS
```

Rows that are **not** explained by the ABI bump, and needed their own commits:
**`fc24a50`** — `TENSION_ADAPTER_LAYOUT_HASH` in `tension_adapter.h` is the C twin of
`arena::layout_hash()` and had not moved, so all six OGRE examples were refused by name with
both values (the guard working, loudly). **`f9b20d3`** — 15 capacities do not fit the 13-class
window: `SESSION_INFO_SIZE` 144 → 160, nonce 104 → 112, hash again to `4_177_755_725`.
**`9d6ab7e`** — the guest's `struct SessionInfo` still declared thirteen capacities and
computed 144, so `manifestProblem()` refused every session guest (`guest 144 != host 160`).

**Every suite, from its own line:**

```
park_frame 2 · fiber 6 · fiber-executor 7 · fiber-runner 5
async_on_main 2 · async_main_promise 2 · debugger 5 · threads 15
input_sources 1
--bin default 307 · audio-only 298
build:examples 22 of 22, exit 0
```

**CI:** TensionScript **16/16** (`46059097144`). Tension **green at `f65c088`**
(`46061549748`), and at `9f91dac` (`46060503417`), whose Stackful proofs job ran **six**
binaries — park_frame 2, fiber 6, fiber-executor 7, fiber-runner 5, input_sources 1,
async_on_main 2.

**Red runs, all named — none re-run to green:**

- `46041583361`, `46043896716` — DL56's, quoted in that round's report.
- `46055759166` — `stackful-fiber-record [fixture mismatch]`, from the new
  `completionClass` import. One golden regenerated (`cfcd05d5`).
- **`46061041010` — my own regression.** `e9383e1` reformatted the resume line to name the
  delivered class, and `fiber-runner`'s two substring matchers still expected the old
  phrasing, so "expected exactly one completion" failed on a run that was correct. I had run
  the suites *before* that commit. Fixed in `f65c088` by keying the matchers on the pair and
  the producer's word rather than the line's phrasing.

## 5. Phase 4 — what the round owed

### The second consumer: a file reader, unchanged

`tension-core/tests/programs/probe/input-sources.ten` — one function, two sources:

```ts
async function drain(source: i32, label: string): void {
  line(label + ": armed=" + inputArm(source).toString());
  let running: bool = true;
  while (running) {
    let event: InputEvent = await inputTask(source);
    if (event == InputEvent.Line) { line(label + " line: " + readLineNow(source)); count += 1; }
    else { line(label + " end after " + count.toString()); running = false; }
  }
}
// _start_game:  await drain(0, "stdin");  await drain(1, "file");
```

`drain(0, …)` and `drain(1, …)` differ by one integer. The host side: `input_arm(1)` opens
`TENSION_INPUT_FILE` on the **same reader thread** and posts `IO_READY` per line on the same
`(class, key)` pair with key 1. Run, headless, in `tests/input_sources.rs`:

```
stdin: armed=0
stdin line: from stdin
stdin end after 1
file: armed=0
file line: from file one
file line: from file two
file end after 2
```

Five parks for five events (1 line + 1 EOF from stdin, 2 + 1 from the file), and exit 0.
**Honest about what this is:** a line reader over `std::fs::File`, not a socket. A socket posts
on `(IO_READY, its own key)` and needs no change here; `input_arm` answers `-ENOSYS` for a key
with no producer, so a guest cannot park on a completion nobody will post.

### The click-fault refusal, quoted

```
$ node scripts/tensionscript.mjs game.ten --stackful-backend promise
ERROR AS100: Not implemented: `await inputTask(...)` parks on a producer handle, which needs a
backend that can suspend and a host that posts for it; this build's backend is `promise`
(use --stackful-backend=fiber)
```

### The chunk type

`Task<i32>` is gone from the example (`grep -n "Task<i32>" examples/ai/story.ten` → nothing).
The await and the read:

```ts
signal = rt.stream(session.handle());     // Task<AiEvent>
chunk = await signal;                     // the event, not a count
if (chunk == AiEvent.Error) { … } else if (chunk == AiEvent.Done) { … }
else { write(session.read()); }           // AiEvent.Ready: exactly one chunk
```

`rt.stream`/`rt.streamTask` return `Task<AiEvent>`; `StreamPost::event()` posts the ordinal;
`AiEvent { Ready = 0, Done = 1, Error = 2 }` is the SDK's declaration and `ai/mod.rs` holds the
other end. **The language limit that decided it:** the settle path writes one i32 word, so the
event rides as the payload and the text is read through an accessor — no struct payload, which
would have needed the `@inline` generic treatment DL56 hit with `Task<void>`. The result *names
the event*, which is what decision 3 asked; the chunk's text is `session.read()`.

`Session.read()` changed too, and that is decision 4: it used to loop until the buffer was
empty, so a finely-posted reply printed as one blob. Await once, read once, print once.

Measured, `printf 'hello\n/quit\n' | npm run run`, `TENSION_ITERATIONS=1`:

```
4  completing class 10 (parked on 11) key 1     ← AI_READY, four separate chunks
1  completing class 11 (parked on 11) key 1     ← AI_DONE
2  completing class 13 (parked on 13) key 0     ← one IO_READY per line read
```

each `resume` in the same host pass as its `post` (`root iteration` equal).

### The header comment, rewritten from the transcript

Order was transcript-then-comment: the ten-run proof existed before the edit. The comment now
reads *"This is measured, not promised … four separately-posted chunks (five `(AI_DONE,
session)` parks: four `Ready` and one `Done`, each resumed in the same host pass that posted for
it) and exits 0"* — and the re-measurement above confirmed the class breakdown the old
transcript could only imply.

## 6. What DL57's narration claimed that the tree did not support

- **"Now the census — after the fix."** The census had not run. It does now, and `ogre/input-camera`
  is still hung.
- **"Two clean runs, IDENTICAL, rc=0."** True of that moment; the `rc=124` before it was the
  `parked()` spin, not the timeout — proved by the red case above.
- **"the adapter hash is unchanged"** — it was not bumped at first, and six OGRE examples were
  refused for it. **"the record is 144 bytes"** — it was, and could not hold fifteen capacities.
  **"the guest struct matches"** — it did not, until `9d6ab7e`. DL57 had changed an ABI in three
  homes and moved one.
- **The chunking was claimed before `read()` and the gate were right**: the first version
  printed one blob because `read()` drained everything, and the second hung because
  `StreamPost::gate` suppressed the next append. Both are in the commits as their own defects.

## 7. What I did not verify

- **`ogre/input-camera`'s hang.** Reported, not diagnosed: out of scope, and it hangs identically
  before and after.
- **Windows and macOS.** `tension-input` and the OGRE DSOs were rebuilt on this host only.
- **A real model.** The 2.3 GB weights were never loaded; the stub is the gate, as the brief says.
- **A socket source.** Named as the next consumer; only the file source exists.
- **The `build-stamp.mjs` gap I found and did not fix**: the adapter's input set lists neither
  `tension_adapter.h` nor `arena.rs`, so a shape change reports the adapter fresh and the first
  symptom is a load refusal. One line, its own round, recorded in `fc24a50`.
- **Ten runs is ten.** It rules out the observed flake class and nothing more; a rarer race would
  not appear in ten. No soak was run.
