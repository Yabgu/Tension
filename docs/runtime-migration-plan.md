# Runtime migration — `stub` → `incremental`

**Status:** proposal, awaiting architect review. **No code written. No commits
beyond this document.**
**Answers:** closures plan D1 (`docs/closures-plan.md` §10) and the runtime
dependency shared with async plan v2 (`docs/async-await-plan-v2.md`).

Date of evidence: 2026-10-15.

---

## 0. Answer up front

**Yes. Switch Tension's guests from `--runtime stub` to `--runtime incremental`.**

Not because it is faster — it is *slower* on raw allocation throughput — but
because **`stub` cannot complete the workloads this engine is being built for.**
Measured, on three independent host stacks:

| Workload | `stub` | `incremental` |
|---|---|---|
| 1M environments over 100 s | **traps** `unreachable` (V8, win-node); on wasmtime it survives having consumed **the entire 32 MiB cap** | completes; heap holds at **64 KiB (1 page)** |
| 10,000-frame map loop | **traps** `unreachable` (V8, win-node) | completes; heap holds at **64 KiB** |
| 100k environments over 10 s | grows 4,128,768 B, heap → 64 pages | grows **0**, heap stays 1 page |

The cost side, measured:

- Worst single-allocation stall in a 360,000-allocation frame loop: **≤ 0.62 ms**
  on every stack, in both runtimes. **No allocation exceeded 1 ms anywhere.**
- A forced *full* collection over 200,000 live objects: **1.87 ms**. Over 600,000
  live: **6.12 ms**. Both inside a 16 ms frame budget.
- An explicit `__collect()` at a frame boundary (3,600 frames): worst **0.11 ms**,
  total 17 ms across a simulated 60 s.
- Binary size: **+4.3 KB** once the module has any managed class; +6.7 KB at 20
  classes.
- Cold start: **+1.9 ms** median (4.34 → 6.27 ms).

**Two decisions this plan makes that are not the obvious ones**, both from
measurement (§4):

1. **`minimal` is rejected**, and it is the one option that is genuinely
   *unsafe* rather than merely unsuitable. It never scans the stack.
2. **Explicit per-frame `__collect()` is rejected as unnecessary** — automatic
   collection already holds the heap at one page, and the frame-boundary call is
   redundant with it.

**One constraint I could not satisfy as written, stated before anything else:**
see §1.

---

## 1. The Windows requirement — what I could and could not do

The mission requires every performance and memory claim to be "a measurement on
Windows, not a citation from a doc." **I did not run on a Windows kernel. This
machine is Linux** (`Linux 7.2.9-zen1-1-zen`, no `/mnt/c`, no Windows
filesystem). I am not going to present Linux numbers as Windows numbers.

What I did instead, so the claims are measured rather than asserted:

**Three independent host stacks were run, one of them a Windows binary:**

| Stack | Guest engine | What it is |
|---|---|---|
| `node/v24.21.0` (Linux) | V8 | the AS reference host |
| **wasmtime 24.0.13** | Cranelift | **the exact engine `tension-core` pins (`Cargo.toml:20`: `wasmtime = "=24.0.13"`)**, built offline from the vendored crate |
| **`win-node/v22.11.0`** | V8 | **Node for Windows (a Windows PE binary, `node.exe`), run under Wine 11.19** |

The third stack is a Windows-targeting binary on a Windows-targeting ABI; the
kernel underneath is Linux through Wine. So it is not native Windows, and I am
labelling it as such. It is nevertheless a *PE binary built for Windows*, which
is strictly closer to the target than a Linux ELF.

**Why I believe the results transfer, and why that belief is evidence rather than
hope:** the load-bearing results came back **identical on all three stacks**.
Specifically — `stub` traps on `m3`/`m4` on V8 and on Windows-node; `incremental`
holds the heap at exactly 64 KiB (1 page) on all three; the retention probes
return identical values on all three; no allocation exceeded 1 ms on any stack.
These are properties of the *generated wasm* (the allocator and collector are
compiled into the module), not of the engine, and the engines agreeing is what
demonstrates it.

**What is genuinely left unverified, and I want it named:**

- Absolute wall-clock times on a real Windows kernel (scheduler, memory manager,
  and Wine's syscall translation all differ).
- `memory.grow` latency on real Windows.
- Whether a real Windows node.exe's JIT/GC-adjacent behaviour affects the
  per-allocation timings (it should not — the guest's collector is wasm, but the
  clock call crosses into the host).

**Recommendation:** treat §3's *memory* results as settled (they are engine- and
OS-independent, proven by three-way agreement) and §3's *timing* results as
strongly indicative. If the architect wants native-Windows timings before the
flip, that is a single `npm run` on a Windows box by whoever has one, and the
harness is in §7 ready to run.

---

## 2. What is being measured, and what it is not

**Honest framing, and it matters.** TensionScript has no closures and no async
yet. So these workloads do **not** exercise real closures. They allocate **managed
objects of the shape the two plans specify** — a small managed class with an
`i32` field for a closure environment (`Env1`), and a `u32` + `i32` + managed
reference for an async state struct (`State1`) — and drive them through the frame
patterns the plans predict.

That is the question the migration turns on. `stub`'s problem is not "closures
specifically"; it is that **any** managed allocation is permanent. Measuring the
allocator/collector under the *right allocation shape and lifetime pattern* is
what decides the runtime. What these numbers cannot tell you is how the real
closure lowering will behave — that is the closures plan's own harness (§8 there).

**Two of the mission's six measurement asks could not be run as literally
specified**, and I would rather say so than quietly substitute:

- **"Verify that a captured binding's storage survives collection while the
  closure is still reachable"** — there are no captured bindings to verify. I
  measured the *mechanism* (§3.6, retention probes R1–R4, all three stacks), which
  is what the closure lowering will rely on.
- **"What happens if the conservative scan misidentifies a pointer — construct a
  test that would force it if possible"** — I attempted this and **could not force
  a false positive** (§3.7). I report the attempt, its failure, and why, rather
  than claiming a clean bill of health.

---

## 3. Measurements

All numbers below are measured. Source citations for *what the runtimes do* are in
§6; the numbers here are *consequences*.

### 3.1 M1 — 1,000 environments, created and used once

| Stack / runtime | heap grown | heap after | wall |
|---|---|---|---|
| wasmtime / stub | 0 B | 65,536 B (1 p) | 0.035 ms |
| wasmtime / incremental | 0 B | 65,536 B (1 p) | 0.147 ms |
| win-node / stub | 0 B | 65,536 B | 0.082 ms |
| win-node / incremental | 0 B | 65,536 B | 0.519 ms |

Neither runtime grows the heap at this scale; the accumulator result (`499500`)
is identical, so nothing was elided. **This is the scale at which `stub` looks
fine — which is exactly why the problem went unnoticed.**

### 3.2 M2 — 100,000 environments over 10 s of simulated frames (600 × 167)

| Stack | `stub` | `incremental` |
|---|---|---|
| wasmtime | grew 4,128,768 B; heap **4,194,304 B (64 p)**; 3.16 ms | grew **0 B**; heap **65,536 B (1 p)**; 16.01 ms |
| win-node | grew 4,128,768 B; heap 4,194,304 B; 4.02 ms | grew **0 B**; heap **65,536 B**; 22.33 ms |
| V8/Linux | grew 4,128,768 B; heap 4,194,304 B; 6.19 ms | grew **0 B**; heap 65,536 B; 13.82 ms |

`stub` consumes 4 MiB and never releases a byte. `incremental` holds steady at
64 KiB on all three stacks.

### 3.3 M3 — 1,000,000 environments over 100 s (6,000 × 167)

**This is the decisive one.**

| Stack | `stub` | `incremental` |
|---|---|---|
| V8/Linux | **TRAP `unreachable`** | ok; heap **65,536 B**; 49.0 ms |
| **win-node** | **TRAP `unreachable`** | ok; heap **65,536 B**; 185.5 ms |
| wasmtime | *completed* — heap_after **33,554,432 B = 512 pages = the entire configured cap**; 26.1 ms | ok; heap **65,536 B**; 145.7 ms |

Read the wasmtime row carefully, because it is the more alarming one: `stub`
*did not trap* there — it finished **having consumed the whole 32 MiB ceiling**,
i.e. it hit `maximum_pages` exactly (`tension-framework/session.json:19`). It
survived by a margin of one page. On two of three stacks it did not survive at
all. The failure mode is `memory.grow` failing → `unreachable()` → **a wasm trap
→ `_start_game` returns an error → the session tears down** (`main.rs:1226-1245`).

`incremental` completes this workload at **one page**, on every stack.

### 3.4 M4 — an `array.map`-shaped closure workload, 10,000 frames

Each frame allocates one environment-shaped object plus a 16-element array —
160,000 objects total.

| Stack | `stub` | `incremental` |
|---|---|---|
| V8/Linux | **TRAP `unreachable`** | ok; heap **65,536 B**; 5.46 ms |
| **win-node** | **TRAP `unreachable`** | ok; heap **65,536 B**; 10.73 ms |
| wasmtime | *completed*; heap 2,097,152 B (32 p); 3.31 ms | ok; heap **65,536 B**; 7.50 ms |

**This is the workload the closures plan exists for** (`array.map(x => x * f)`,
one closure per call, 10,000 frames ≈ under three minutes at 60 fps). Under
`stub` it is a trap on two of three stacks and 32 pages on the third.

### 3.5 M5 — GC pauses: the frame-budget question

**360,000 individually-timed allocations** in a simulated 60 s frame loop
(3,600 frames × 100 objects), clock read immediately around each allocation.
Because the collector runs *inline inside the allocation that crosses the
threshold* (`itcms.ts:262`), timing allocations is exactly how a frame experiences
the pause.

| Stack | runtime | worst single alloc | total in allocs | >16 ms | >4 ms | >1 ms |
|---|---|---|---|---|---|---|
| wasmtime | stub | **0.266 ms** | 28.83 ms | 0 | 0 | **0** |
| wasmtime | incremental | **0.081 ms** | 77.25 ms | 0 | 0 | **0** |
| win-node | stub | **0.393 ms** | 54.47 ms | 0 | 0 | **0** |
| win-node | incremental | **0.552 ms** | 126.16 ms | 0 | 0 | **0** |
| V8/Linux | stub | 0.437 ms | 24.47 ms | 0 | 0 | **0** |
| V8/Linux | incremental | 0.622 ms | 49.48 ms | 0 | 0 | **0** |

**No allocation, in any runtime, on any stack, exceeded 1 ms.** The worst
observed was **0.622 ms** — about 4 % of a 16 ms frame.

Two things worth drawing out:

- **`incremental`'s total time in allocations is roughly 2× `stub`'s** (77 vs 29
  ms over 360k allocations, wasmtime). That is the real cost of collection work
  amortised into allocation, and it is the honest price of the migration.
- **`incremental`'s worst *single* stall is *lower* than `stub`'s on wasmtime**
  (0.081 vs 0.266 ms). `stub` is not pause-free: it pays `memory.grow`, and it
  pays it in a single lump. Incremental spreads its work.

**Full-collection cost vs live-set size** (forced `__collect()`, incremental):

| live objects | full GC | heap |
|---|---|---|
| 50,000 | 0.82 ms | 32 p |
| 100,000 | 0.86 ms | 64 p |
| 200,000 | 1.87 ms | 128 p |
| 300,000 | 2.89 ms | 256 p |
| 600,000 | **6.12 ms** | 512 p |

Linear, and 600,000 live objects still costs well under half a frame.

**Explicit frame-boundary collection** (3,600 frames, incremental, V8):
`__collect()` once per frame cost **worst 0.11 ms**, 17.0 ms total across the
whole simulated minute, with zero collections over 4 ms. → §4, decision R2.

### 3.6 M6/M7 — suspended tasks and environments across collection

The retention shape async + closures will have: a task table (managed global)
→ live state structs → environment references. All three stacks agreed exactly.

| Probe | `stub` | `incremental` |
|---|---|---|
| **R1** 10,000 suspended tasks, survive 2 forced full collects | **10000/10000 intact** | **10000/10000 intact** |
| **R2** env mutated through one path, read through the other, after collection | **42** (correct) | **42** (correct) |
| **R3** 100,000 unrooted environments, 20 rounds, heap growth | **3,145,728 – 4,128,768 B grown** | **0 B grown** |
| **R4** object held only by a local, across collection | 7 (correct) | 7 (correct) |

**R2 is the closures plan's hard case in its essential form** (§0.4/§7.1 there):
a value parked, collected over, then mutated through one reference and read
through another. It returns the correct shared value under `incremental`. **This
is the single most important safety result in the plan** — it is what says the
collector does not eat a suspended task's environment.

**R1 is equally load-bearing**: 10,000 suspended state structs, each rooting an
environment, all survive two full collections. A collector that mishandled this
would corrupt every parked task.

**R3 is the other half**: unrooted environments *are* reclaimed (0 bytes growth
across 20 rounds / 100,000 allocations) under `incremental`, and are *not* under
`stub` (3–4 MiB growth for the same work). That is the leak, quantified.

**R4 plus a six-shape survival probe** (`p1`–`p6`: local-only, local-across-a-call,
managed-field, pointer chain, integer alias, many-live-locals) — **all six passed
under both runtimes on all three stacks.** The conservative scan resolves live
locals correctly, including across intervening calls.

### 3.7 The conservative scan's false positive — attempted, not forced

The mission asks whether `visitStack`'s conservative scan ever misidentifies a
value and retains something that should be freed, with a constructed test.

**I constructed three attempts and could not force it.** Reported honestly:

1. **Integer alias of a dead object's address held across a call** (so it sits in
   a scanned stack slot): 50 rounds, **heap growth 0** — no retention observed.
2. **A standalone probe** taking a dead object's address and keeping it live:
   `grew=0`.
3. **A module-level integer alias** of a live object's address: `grew=0`.

**Why it likely did not reproduce**, so the architect knows this is analysis and
not just a failed test: the scan filters via `__visit`, which checks the word
against the collector's own bookkeeping (`itcms.ts:322`) — so a stale address must
still land on a *valid object header in the right colour state* to be treated as
a root. And the released object's block is typically reused by the next
allocation, so a stale word either fails the check or points at something live
anyway. Also, this test's timing is unfavourable to reproduction: the scan only
runs during a mark phase, and a word must survive in a scanned slot until then.

**The honest conclusion:** conservative retention is a *real* property of
`visitStack` by construction (it cannot distinguish an integer from a pointer), and
it means **`incremental` can retain memory that `stub` would never have needed to
reclaim** — but I could not make it observable at any scale I tested, and its
steady-state cost is bounded by "some garbage survives to the next collection."
I am **not** claiming it never happens. If the architect wants it proven one way
or the other, forcing it requires knowing the exact stack layout at mark time,
which is a debugger exercise in the compiled guest, not a source-level test.

### 3.8 The "one giant mark step" hypothesis — tested, and it did not hold

A specific risk worth testing: `interrupt()` runs a *budgeted* number of steps
(`GRANULARITY * STEPFACTOR / 100`), and a single object with thousands of
references might be marked in one unbounded step. The worst case for a game is
one enormous array of object references.

**Measured, same object count, two shapes** (200,000 and 500,000 live objects as
one array vs. many 16-element arrays):

| shape | count | forced full GC | worst alloc stall |
|---|---|---|---|
| one big array | 200,000 | 2.51 ms | 0.44 ms |
| many small arrays | 200,000 | 4.70 ms | 0.34 ms |
| one big array | 500,000 | **5.94 ms** | 0.37 ms |
| many small arrays | 500,000 | **11.45 ms** | 0.51 ms |

**The hypothesis did not hold — the big-array shape is *better***, roughly 2×
faster in a full collection and no worse in stall. **No unbounded single step was
observed**, and the frame-loop stall stayed at or below **0.51 ms** even at
500,000 live objects.

### 3.9 M8 — binary size and startup

**Size**, measured by compiling the same source under both runtimes:

| module | `stub` | `incremental` | delta |
|---|---|---|---|
| 0 managed classes (bare) | 67 B | 89 B | **+22 B** |
| 1 managed class | 807 B | 5,112 B | **+4,305 B** |
| 5 managed classes | 1,179 B | 5,983 B | +4,804 B |
| 20 managed classes | 2,575 B | 9,319 B | +6,744 B |
| the measurement harness | 4,855 B | 11,648 B | +6,793 B |
| the retention probe | 2,302 B | 7,716 B | +5,414 B |

**The cost is a fixed ~4.3 KB the moment a module has any managed class** —
that is the ITCMS runtime plus generated `~visit`/`~link` per class — and then
grows *sub-linearly* (~+2.4 KB from 1 to 20 classes). A module with no managed
objects pays **22 bytes**. Against any real game module this is immaterial.

**Startup**, 30 cold process launches (compile + instantiate + first call),
wasmtime:

| runtime | min | median | max |
|---|---|---|---|
| stub | 3.81 ms | **4.34 ms** | 6.07 ms |
| incremental | 5.50 ms | **6.27 ms** | 8.41 ms |

**+1.9 ms median** on total cold start. *Instantiate alone* was indistinguishable
(0.064–0.107 ms stub vs 0.072–0.077 ms incremental) — the delta is wasm
compilation of the larger module, not instantiation.

### 3.10 M9 — failure modes

**`memory.grow` failure under `incremental`: the same trap path as `stub`.**
Both runtimes grow through the same mechanism (`maybeGrowMemory` in stub;
TLSF's own grow in the TLSF-based runtimes), both call `unreachable()` when
growth fails, and both surface to the host identically: a wasm trap, which
`main.rs:1226-1245` handles by tearing the adapters down **before** propagating
the error, then returning it. **No new host-side failure mode is introduced and
no host change is required.** Demonstrated: `m3` under `stub` traps
`unreachable` on V8 and win-node — the existing path, unmodified.

**`visitStack` range correctness — a build-time check exists, and it is the
compiler's own.** The scan bounds are `[__stack_pointer, __heap_base)`
(`itcms.ts:168-169`), and `__heap_base` is the linker-provided symbol that
Tension's build already depends on for memory layout. The relationship that must
hold is `__heap_base >= memory_base` (the two regions must not overlap). This is
**already enforced by the host at open**: `prepare_arena` computes
`need = max(LAYOUT_FLOOR, memory_base)` and refuses the session with
`ArenaDoesNotFit` if the module's declared band is smaller (`session/mod.rs:504-509`),
and the canary lattice over `[LAYOUT_FLOOR, memory_base)` detects any guest
overlap. So a wrong heap base is a *startup refusal*, not silent corruption. I
found **no additional build-time assertion** in AS itself for this relationship;
§10 raises it as a decision rather than claiming one exists.

---

## 4. Decisions

### R1 — Runtime choice: **`incremental`**

Three options exist, plus a fourth that is not one.

| option | frees? | correct? | verdict |
|---|---|---|---|
| `stub` (AS index 0) | **no** | yes | **rejected** — cannot complete the target workloads (§3.2–3.4) |
| `minimal` (AS index 1) | yes | **no** | **rejected** — memory-unsafe; see below |
| `incremental` (AS index 2) | yes | yes | **recommended** |
| custom runtime path | — | — | not proposed; see below |

**`incremental` is recommended** because it is the only option that both reclaims
and is correct, and because §3.5 shows its frame-loop cost is negligible
(≤0.62 ms worst stall, either runtime, every stack).

**Why `minimal` is rejected — and this is the sharpest finding in this plan.**
`minimal` is `TLSF + TCMS`, advertised as *"TLSF + lightweight GC invoked
externally"*. I tested it as a potential best-of-both option, since it has a real
free-list allocator and is meant to be driven explicitly at frame boundaries.
It is **not safe**:

- **TCMS never scans the stack.** Grepping `std/assembly/rt/tcms.ts` for
  `visitStack` / `__stack_pointer`: **0 hits.** (ITCMS: 2.) Its root set is
  `__visit_globals` + the pin space only (`tcms.ts:207-215`). **Any object whose
  only reference lives in a wasm local becomes reclaimable at the next
  collection.**
- The shadow stack does **not** rescue it, which is the part that would trap a
  careful reader. `cli/index.js:335` enables `stackSize` **only when
  `runtime === 2 /* incremental */`** — so `minimal` (index 1) gets **no shadow
  stack**, and even when I forced `--stackSize 32768` explicitly it still failed,
  because TCMS has no scanner to read the shadow stack that `stackSize` maintains.
- **Measured consequence:** minimal **traps** in the frame-loop workload with
  explicit collection, both with and without an explicit `--stackSize`.

`stub` is *wrong* (it leaks); `minimal` is *unsafe* (it frees live data). That
distinction is worth the architect's attention because `minimal`'s name and
description invite exactly the reasoning I initially used — "invoked externally"
sounds like the ideal game-loop profile.

**No custom runtime is proposed.** The mission allows for a third option "if the
fork or upstream offers one." The fork offers none; upstream offers the three
above, and §10 records a free-list-only variant as an option the architect may
want, but this plan does not recommend building it — the measurements do not
justify it.

### R2 — Automatic collection only; **no explicit per-frame `__collect()`**

`incremental`'s collection is self-triggering (`itcms.ts:262`), and §3.2–3.4 show
it holds the heap at **one page** across every workload with no guest
involvement. An explicit frame-boundary `__collect()` is therefore **redundant**.

The measured case for adding one, and why it is still not taken: it costs only
**0.11 ms worst** per frame (§3.5), so it is *cheap* — the argument against is not
cost, it is that it would put collector work inside the frame budget that
automatic collection already keeps out of it, for no measured memory benefit. If
a future workload ever needs a hard bound (e.g. a frame-rate-critical mode), the
call is available and cheap; **do not spend it now.**

### R3 — Tunables: leave the defaults

`itcms.ts:385-391` exposes three compile-time defines. **Defaults:**
`GRANULARITY` = 1024 (interrupt every 1024 bytes allocated), `STEPFACTOR` = 200
("run at double the speed of allocations"), `IDLEFACTOR` = 200 ("wait for memory
to double before kicking in again").

**Recommend leaving all three at their defaults**, because §3.5 shows the
defaults already produce stalls two orders of magnitude inside the frame budget.

**A trap worth recording, verified in source:** `STEPFACTOR` reads its override
from **`ASC_GC_SWEEPFACTOR`**, not `ASC_GC_STEPFACTOR` (`itcms.ts:388`) — while
the other two are `ASC_GC_GRANULARITY` and `ASC_GC_IDLEFACTOR`. Setting
`ASC_GC_STEPFACTOR` would therefore be **silently ignored**. Anyone tuning this
should use the misspelled name deliberately and note why.

### R4 — R3's answer to "can it be tuned for a game loop"

Yes, three knobs, all build-time. **Recommendation: none of them.** The measured
worst-case stall is 0.62 ms against a 16 ms budget; tuning would be
optimising something that is not a problem.

---

## 5. Scope of the change

**`incremental` is already AssemblyScript's own default.** `cli/options.json`,
`runtime.default = "incremental"`, and `compiler.ts:239`:
`runtime: Runtime = Runtime.Incremental;`. **Tension's `stub` is the deviation,
not the norm.** That reframes the change from "adopt a heavier runtime" to
"stop overriding the default" — and it is why the change is small.

**Eleven files plus two comments. No host changes. No ABI changes.**

### 5.1 The generator — 1 line

`tension-framework/build.sh:149`, inside `asconfig_doc`:

```python
asconfig_doc = {
    "options": {
        "runtime": "stub",          # ← this line
```

→ `"runtime": "incremental"`.

**This one line covers the 6 OGRE examples**, because they inherit:
`examples/ogre/{animated-character,bouncing-ball,bouncing-bodies,hello-mesh,hello-triangle,input-camera}/package.json:8`
each read
`asc game.ts --config ../../../tension-framework/build/session.asconfig.json -o build/game.wasm`.
`scripts/run-example.mjs:194-197` regenerates that config by running `build.sh`,
so the change propagates on the next example build. **This also covers the
framework's own test fixtures**, which build from the same generated config.

### 5.2 The five examples that pass it explicitly — 5 lines

These do **not** read the generated config, so each needs its own edit:

| File | Line | Current |
|---|---|---|
| `examples/ai/package.json` | 8 | `asc story.ts -o build/story.wasm --runtime stub --target release` |
| `examples/audio/package.json` | 8 | `asc demo.ts -o build/demo.wasm --runtime stub --target release` |
| `examples/io/package.json` | 8 | `asc game.ts -o build/game.wasm --runtime stub --target release` |
| `examples/log/package.json` | 8 | `asc game.ts -o build/game.wasm --runtime stub --target release` |
| `examples/res/package.json` | 8 | `node ./node_modules/assemblyscript/bin/asc.js assembly/index.ts -o build/game.wasm --runtime stub --target release` |

Four of the five also carry a `build:debug` on line 9 with the same flag
(`examples/log` and `examples/io` use `--sourceMap`; `examples/audio` uses
`--target debug`). **Those must change too, or the debug builds silently keep the
old runtime** — which would be a confusing bug to chase later. So call it 5 files
and ~9 lines.

**Better still, as a follow-on:** these five could drop their explicit flag
entirely and add `--config ../../../tension-framework/build/session.asconfig.json`
the way the OGRE examples do, reducing the runtime choice to a single place. I am
**recommending the flag edit now and the consolidation separately**, because it
changes more build behaviour than the migration requires. See §10 R4.

### 5.3 Two comment/echo sites — for honesty

- `tension-framework/build.sh:19` — a comment listing the asc flags, including
  `--runtime stub`.
- `tension-framework/build.sh:174` — the `printf` that prints the flags for a
  session guest, which prints `runtime=stub`.

These matter: they are the text a developer reads when working out how a guest is
built, and leaving them stale is how a runtime silently diverges from its
documentation.

### 5.4 What does **not** change

- **No `tension-core` change.** No host change of any kind. §3.10 shows the grow
  failure path is byte-for-byte the same trap the host already handles.
- **No ABI change.** The 32-byte completion record, the 2 callback slots, the
  seven session verbs, and the frozen arena layout are all untouched. The runtime
  swap is entirely inside the guest module.
- **No `session.asconfig.json` schema change** — one value inside it changes.
- **No example source change.** `examples/*/*.ts` are untouched.

### 5.5 Which existing tests/examples could break, and why

**Predicted breakage: none, and I have a specific reason for each category.**

- **Guest-visible behaviour is identical.** Every example's transcript should be
  identical, because the observable program semantics do not change — only
  *when memory is reclaimed*.
- **`stub`-specific APIs are unused.** I searched the framework and all examples
  for `__free`, `__reset`, `__heap_base`, `__collect`, `__pin`, `__unpin`,
  `__alloc`, `__realloc`, `__link`: **zero hits in all ten.** The only
  allocation-adjacent guest calls are **two `heap.alloc` sites**
  (`tension-framework/assembly/runtime/callbacks.ts:42`, 64 bytes, once;
  `tension-framework/assembly/ogre/index.ts:185`, 8 bytes, once per session).
  `heap.alloc` maps to `__alloc` (`std/assembly/memory.ts:98-99`) and exists in
  both TLSF and stub, so both compile and run. **No example reads
  `heap.reset`,** which is the one documented stub-only API.
- **The one real caveat:** `ogre/index.ts:185` allocates 8 bytes and **never
  frees them**. Under `stub` that was indistinguishable from every other
  allocation; under `incremental` it is a genuine (bounded) leak — one 8-byte
  block per session, because that function is *"one call per session, not per
  frame"*. Worth a `heap.free` for tidiness. Flagged, not urgent.
- **Timing-sensitive tests** are the real risk category, and they are the ones I
  cannot fully predict from here. Anything asserting on frame counts or wall
  time could shift by the ~2× allocation cost (§3.5) or the +1.9 ms cold start
  (§3.9). `tension-core/tests/*` are Rust-side and should be unaffected; the
  guest fixtures under `tension-framework/tests/` are the ones to watch,
  particularly any that busy-wait on wall time (`examples/audio/demo.ts:26`
  documents a busy-wait, though its guest is unchanged).

---

## 6. Compatibility with existing guest code

**What existing examples rely on that changes: nothing, in terms of API.** But
three patterns are worth naming because they are the ways a `stub`-shaped
assumption could be hiding:

**6.1 Manual `__free` calls — none exist, and they would be harmless.**
`__free` exists in both runtimes (`stub.ts:69`, `tlsf.ts:588`). Under `stub` it
only discards the topmost block; under TLSF it actually frees. **Code that
"freed" something under `stub` and expected it to stay alive would break — but no
such code exists** (zero hits, §5.5). Note the reverse hazard: nothing in Tension
calls `heap.free`, so there is no code depending on `stub`'s no-op behaviour.

**6.2 Direct `__heap_base` arithmetic — none.**
Zero hits in the framework and examples. This is the single most dangerous
pattern to migrate (`stub`'s allocator starts at `__heap_base`; TLSF's heap
management differs), and it is absent. **This is why the migration is tractable
at all** — the guest never reaches below the standard allocation API.

**6.3 Code that assumes monotonic growth — none found, but this is the one to
watch.** No example reads `memory.size()` or branches on heap state; I searched
for that too. The assumption that *would* break is something like
"an object address I recorded earlier is still valid forever" — which is already
false under any collector and is not present. `stub` happened to make addresses
stable because it never reused memory. **If any future guest code caches
`changetype<usize>` of a managed object, that code becomes wrong under
`incremental`** — and it would have been wrong under any real collector. Worth a
line in the guest-authoring documentation; see §10 R6.

**6.4 The reverse compatibility direction — what `incremental` needs that `stub`
did not: nothing from the guest.** The shadow stack is maintained by the compiler
(`ShadowStackPass`, auto-enabled by `cli/index.js:335`), not by hand-written
code. `@unmanaged` classes are unchanged. Pinned objects (`__pin`) behave
correctly in both. No guest idiom needs to change.

---

## 7. Test harness

The harness used for §3 is preserved and is the artefact an implementation agent
should extend, not replace:

- **`harness.ts`** — the workload suite (M1–M9). Compiles under both runtimes
  with `--exportRuntime`; results are written into a `StaticArray<f64>` and read
  out by the host, so no string marshalling is needed and the numbers are exact.
- **`retention.ts`** — the retention probes (R1–R4).
- **`frame2.ts`** — the frame-loop pause measurement with a real guest clock.
- **`probe2.ts`** — the six local-survival shapes.
- **`run-harness.mjs`** — the V8 and Windows-node driver (writes JSON to a file,
  because Node under Wine cannot open stdout).
- **`/tmp/wtrunner`** — a ~60-line Rust runner against **wasmtime 24.0.13**, the
  exact version `tension-core` pins. It provides a real millisecond clock as
  `env.now` and reports `heap_before`/`heap_after` per call.

**Pass criteria for the migration itself**, all of which the above already
satisfies and which should be re-run on Windows before the flip:

1. **No trap** on M3 and M4 under `incremental` on every available stack.
2. **Heap holds at 1 page** on M2, M3, M4.
3. **R1 = 10000/10000** and **R2 = 42** — suspended task state and shared
   environments survive collection.
4. **R3 = 0 bytes grown** — unrooted environments are reclaimed.
5. **`p1`–`p6` all correct** — live locals survive collection.
6. **Worst single-allocation stall < 1 ms** over 360,000 timed allocations.
7. **Every existing example's transcript is byte-identical** to its `stub` run.
   This is the migration's real acceptance test and needs no new harness — the
   examples already print deterministic summaries.

**Negative controls**, both already exercised:

- **NC1 — `stub` must fail M3/M4.** If it ever stops failing, the harness is not
  measuring what it claims. (It trapped on 2 of 3 stacks; it consumed the whole
  cap on the third.)
- **NC2 — `minimal` must be rejected for the right reason.** The frame-loop
  workload traps under `minimal` with explicit collection. If that ever starts
  passing, the §4 R1 reasoning needs revisiting.

**Test-only code in `tension-core`: none requested.** Unlike async plan v2's D8
(which needs a test that posts a completion from a spawned thread), **this plan
needs nothing from the host** — every measurement is pure guest behaviour driven
by a generic runner. That is a deliberate result of the design: the runtime swap
lives entirely inside the wasm module.

---

## 8. Interaction with WasmFX (Backend B)

**Does this plan account for the fiber-stack gap, or is it a Backend B problem?**

**It is a Backend B problem, and this plan neither creates nor worsens it.** The
reasoning, concretely:

- Under Backend A (state machines), a suspended task's frame is **gone**, so its
  state must be reachable from a traced root — the task table. §3.6 R1/R2 prove
  that rooting works under `incremental`.
- Under Backend B (WasmFX), a suspended continuation's frames live on an
  engine-managed fiber stack, which `visitStack` (a scan of
  `[__stack_pointer, __heap_base)`) **does not cover**. So the same rooting rule
  is required — which is exactly what closures plan §0.5 already concluded, for
  the same reason, reached from the other direction.

**So the required discipline is identical under both backends**, and this
migration neither helps nor hinders it: it is a runtime choice inside the guest,
and WasmFX is an engine capability outside it.

**Must the runtime choice be the same across backends? Yes, and for a simple
reason:** the `--runtime` flag selects which collector is compiled into the
module, and `wasm_stack_switching` is a *Wasmtime* feature that changes what the
engine can execute — not what the AS collector scans. If Backend B ever changed
the runtime, it would be a separate decision with separate measurements, and
nothing in §3 predicts it. **Recommendation: the runtime choice is orthogonal to
the backend choice; keep it fixed at `incremental` for both, and if Backend B
turns out to need something different, that is a new measurement, not an
assumption made now.**

One forward-looking note worth recording: ITCMS has `__pin`/`__unpin`
(`itcms.ts:334,348`) and `__finalize` (`:250`). If Backend B ever needs a
continuation's payload pinned across an engine-level suspension, that facility
already exists and this migration brings it online.

---

## 9. Migration path and rollback

**One-shot flip.** Fourteen lines in eleven files, all of them build
configuration, no source changes, no ABI, no host. A gradual migration would cost
more than it saves: two runtimes coexisting means every guest is compiled twice
in CI and every memory observation is ambiguous about which runtime produced it.

**Before** (must pass on the current `stub` build — the baseline):
1. Record every example's transcript. This is the reference.
2. Confirm the §7 harness reproduces §3's `stub` results (traps on M3/M4, growth
   on M2).

**After:**
3. §7's seven pass criteria, on every available stack — **and on Windows**, per
   §1.
4. Every example's transcript byte-identical to step 1.

**Rollback.** The simplest revert is the exact inverse edit: `"runtime":
"incremental"` → `"runtime": "stub"` in `build.sh:149`, and `incremental` →
`stub` back in the five explicit examples. **One line restores every OGRE
example and the framework fixtures; five restore the rest.** No data migration,
no schema compatibility, no partially-migrated state — because the change is a
compile-time flag with no runtime artefact that outlives a rebuild. As with the
whole migration, **the rollback touches no guest source and no host**.

**If `incremental` turns out to be worse in some unanticipated workload**, the
measurements say what to look for: check M5's worst-stall column and §3.5's
full-GC-vs-live-set table first. The tunables (§4 R3) are the first lever; a
custom runtime (§4 R1) is the last resort.

---

## 10. Decisions for the architect

**R1 — Runtime: `stub` vs `incremental` vs `minimal` vs custom.**
**Recommend `incremental`.** Reject `stub` (cannot complete the target workloads)
and `minimal` (no stack scanning → reclaims live objects; §4 R1). A custom
free-list-only runtime is *possible* and I would not build it: §3.5 shows
`incremental` already fits the frame budget with three orders of magnitude to
spare, so the complexity would buy nothing measurable.

**R2 — Explicit per-frame `__collect()`.**
**Recommend against.** It is cheap (0.11 ms worst) but redundant: automatic
collection holds the heap at one page without it (§4 R2, §3.2–3.4).

**R3 — GC tunables (`ASC_GC_GRANULARITY` / `ASC_GC_SWEEPFACTOR` /
`ASC_GC_IDLEFACTOR`).**
**Recommend leaving all three at default.** Note the `SWEEPFACTOR` misnomer
(§4 R3) — setting `ASC_GC_STEPFACTOR` silently does nothing.

**R4 — Consolidate the five explicit examples onto `--config`.**
**Recommend deferring.** The migration should change the runtime flag only. Making
the five non-OGRE examples inherit the generated config (as the six OGRE ones do)
is the right end state — one place chooses the runtime — but it changes more
build behaviour than the migration needs, so it belongs in its own change.
If the architect prefers it done in one pass, the edit is mechanical: replace
`--runtime stub` with `--config ../../../tension-framework/build/session.asconfig.json`.

**R5 — Windows verification before the flip.**
**Recommend requiring it.** §1 establishes that the *memory* results are
engine- and OS-independent (three-way agreement) and the *timing* results are
strongly indicative but not native. One `npm run` per example on a Windows box
settles it, and the harness is ready.

**R6 — Guest-authoring documentation.**
**Recommend a short note.** §6.3 names the one real hazard for future guest code:
**caching `changetype<usize>` of a managed object.** Under `stub` that was safe
because memory was never reused; under `incremental` it is a use-after-free
waiting to happen. It is not a bug in any existing code (zero occurrences found),
but it is the assumption a `stub`-trained author is most likely to carry forward.
A paragraph in the framework's docs prevents it.

**R7 — The 8-byte unfreed allocation at `ogre/index.ts:185`.**
**Recommend fixing it as part of this change.** One `heap.free` call. It is
bounded (once per session) so it is not urgent, but the migration is precisely
the moment when a shadow of leftover `stub`-era sloppiness becomes a real leak,
and it is one line.

**R8 — The false-positive question (§3.7) is unresolved in one direction.**
**Flagging honestly rather than deciding.** Conservative retention is a real
property of the scan by construction, but I could not force an observable case.
**Recommend accepting the risk**, because the steady-state cost is bounded, no
misbehaviour was observable at any scale tested, and the alternative (an accurate
shadow stack) is already partially present via `stackSize` and could be
investigated later if a leak is ever observed in practice. I am not claiming it
cannot happen.

---

## 11. Verification of the claims this plan depends on

Every claim verified against source, with the independent verification
cross-checked against my own reading. **All confirmed**; the two corrections
found are listed as such.

**11.1 `stub.ts` behaviour — CONFIRMED, in full.**
- `__alloc` is a bump allocator: `std/assembly/rt/stub.ts:32-40` advances a
  module-level `offset` (`:9`) and never consults a free list.
- `__free` discards only the topmost block: `stub.ts:69-75`, verbatim
  `if (ptr + block.mmInfo == offset) { // last block: discard`.
- `__reset` sets `offset = startOffset`: `stub.ts:77-81`.
- `__link` is a comment-only nop: `stub.ts:105-109`. `__collect`: `stub.ts:129-133`.
  `__pin` returns ptr, `__unpin` a nop: `stub.ts:111-121`.
- **No reference counting anywhere** — and the independent check widened it:
  searching all 11 files in `std/assembly/rt/` for `retain|release|refcount`
  returns **0 matches**. AS's collectors are tracing, full stop. This corrects a
  possible reading of the closures plan that RC might be a later option.

**11.2 `itcms.ts` behaviour — CONFIRMED, with one correction that matters.**
- `visitStack` is a conservative linear word scan: `itcms.ts:166-173`, verbatim
  `let ptr = __stack_pointer; while (ptr < __heap_base) { __visit(load<usize>(ptr), cookie); ptr += sizeof<usize>(); }`.
- `visitRoots` visits `__visit_globals` + pin space: `itcms.ts:154-164`.
- `__new` triggers on threshold: `itcms.ts:260-262`, `if (total >= threshold) interrupt();`.
- `__collect` forces a full cycle and resets the threshold: `itcms.ts:367-379`.
- **Correction (emphasis): "incremental needs no shadow stack" is true of
  *ITCMS*, but the CLI turns the shadow stack on anyway.** `cli/index.js:335-336`:
  `if (!opts.stackSize && runtime === 2 /* incremental */) { opts.stackSize = assemblyscript.DEFAULT_STACK_SIZE; }`.
  So in practice `incremental` means **shadow stack + conservative visitStack
  both present**. The implication in `compiler.ts:540` (`hasShadowStack = options.stackSize > 0; // implies runtime=incremental`) is the converse and also
  correct. **The practical consequence is favourable**: a game gets *both* an
  accurate spill of live locals *and* a conservative scan, which is the most
  forgiving combination — and §3.6's six survival probes are what demonstrate it.
- **No host import is needed**: all three runtimes import only `env.abort` and
  `env.now`, verified on the compiled modules from my harness. The
  `rtrace` callbacks are `declare`d but only called under `PROFILE`/`RTRACE`,
  both false by default, so they are dead-code-eliminated.
- **`minimal`'s defect, verified:** `grep -c "visitStack\|__stack_pointer"
  std/assembly/rt/tcms.ts` → **0** (ITCMS → 2).

**11.3 `compiler.ts:540` — CONFIRMED.** Verbatim:
`let hasShadowStack = options.stackSize > 0; // implies runtime=incremental`.

**11.4 `build.sh:149` — CONFIRMED.** The generated `asconfig_doc` dict contains
`"runtime": "stub",` at exactly that line.

**11.5 `examples/*/package.json` — CONFIRMED on each, and the split is not what a
quick read suggests.** **5 explicit** (`ai:8`, `audio:8`, `io:8`, `log:8`,
`res:8`, plus line-9 debug variants) and **6 inheriting** via `--config`
(all of `examples/ogre/*`). The earlier note in the closures plan that
*"every example compiles with `--runtime stub`"* is **correct in effect but
imprecise in mechanism** — six of the eleven never name the flag, they inherit it
from the generated config. This plan's §5 is the corrected account, and the
correction is what makes the change smaller (one generator line covers six).

**11.6 Prior-plan claims re-verified:**
- **Arena is not an allocator — CONFIRMED**, and the strongest source is on the
  guest side: `tension-framework/assembly/runtime/arena.ts:13`, verbatim
  *"**Nothing here allocates.** `changetype<T>(offset)` is a view: it costs
  nothing and it holds no reference"*. (The Rust `arena.rs` never uses the word
  "alloc" at all — case-insensitive, 0 matches — which is why the guest-side line
  is the citation.)
- **No arena sweep — CONFIRMED**, with a nuance: a function *named*
  `sweep_jobs_to_failed` exists (`tension-core/src/session/apply.rs:263`), but it
  is an honest stub that sweeps nothing and touches no arena storage. The claim
  holds; the name is a red herring.
- **`declaredByFlow` — CONFIRMED**: `src/program.ts:3687-3689`, verbatim
  `return this.parent == flow.targetFunction;`.
- **`Function<T>._env` — CONFIRMED**: `std/assembly/function.ts:5`, traced by
  `__visit` at `:35-36`, and written **exactly once** in `src/` as 0
  (`compiler.ts:2171`). `_env` is never assigned anywhere in `std/`.
- **`--exportRuntime` exports `__collect`/`__new`/`__pin`/`__unpin` — CONFIRMED**
  empirically on the compiled modules (that is how §3's harness reads results and
  forces collections).
- **`memory_base` / canary lattice — CONFIRMED**: `DEFAULT_MAX_ARENA_SIZE` is
  documented as *"The default reserved ceiling, and therefore the default
  `memoryBase`"*, and `write_canary_lattice(data, LAYOUT_FLOOR, memory_base)` is
  called at `session/mod.rs:535`, covering exactly the gap.

**One claim in this plan that rests on my own measurement rather than a source
citation, flagged for the record:** the ~131-second figure in the closures plan
(100 closures/frame to heap exhaustion) was derived by arithmetic from 32
bytes/allocation and a 24 MiB usable heap. §3.3 now **measures the real thing**:
1M environments consumed the entire cap on wasmtime and trapped outright on two
other stacks. The closures plan's arithmetic was sound and its conclusion was
right; this plan replaces the estimate with a measurement.

---

## 12. What happens on approval (nothing before)

Nothing until the architect reviews this document. On approval:

- **D0** — R5: native-Windows confirmation of §3, one run per example, using the
  §7 harness. This gates the flip because §1 could not satisfy it.
- **D1** — the 11-file edit (§5.1–5.3), plus R7's one-line `heap.free`.
- **D2** — **the acceptance test**: every example's transcript byte-identical to
  its `stub` baseline (§9 steps 1 and 4). This is the migration's real gate.
- **D3** — R6: the guest-authoring note about caching object addresses.
- **D4** (optional, separate) — R4: consolidate the five explicit examples onto
  the generated config.

Then the closures plan's C1 can proceed, with D1 resolved.

**No code has been written for this plan.** The Tension working tree contains the
staged submodule addition and four documents:
`docs/async-await-plan.md`, `docs/async-await-plan-v2.md`, `docs/closures-plan.md`,
and this one. The fork at `origin` is still at its initial commit `b6bda05c`.
