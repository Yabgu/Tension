# DL27 — the cost model: what one await costs

**One await costs ~2.9 µs on the promise backend and ~0.5 µs on the fibre backend, and on
the fibre path the wake channel costs more than the suspension.**

Both numbers come from 1000 pairs in one process, release build, segmented so no figure
blends two things. The instrumentation is default-off and the run is byte-identical with it
on or off.

`~/work/Tension` `integration/dwarf-debug`: `b359f63` → **`edfc199`**. CI **`45229865451`**
on `bb88b19` and **`45230721279`** on `edfc199`, both **success**. `~/work/TensionScript-a2` untouched at **`3f59ec08`**, bundle **`aa74d6a1`**, std
identical. **No compiler change, no std change, no ABI change.**

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`b359f63`**, `git status --porcelain` **empty**, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `package-lock.json` | clean; **no `npm install` ran in this tree** (I63 stays closed) |
| binary **before** | `33 645 768` B, mtime **2026-11-23 17:46:22** |
| newest source **before** | `src/thread.rs` **2026-11-23 17:45:20** — 0 newer |
| binary **after** | `33 647 504` B, mtime **2026-11-23 18:37:29** |
| newest source **after** | `src/thread.rs` **2026-11-23 18:37:01** — 0 newer |

**The machine, stated once so every table below is a claim about something.** AMD Ryzen 5
5600G, 6 cores / 12 threads, WSL2 kernel 6.18.58.1, rustc 1.100.0. Timings on a different
box will move; the *ratios* and the segment ordering are what this round is for.

## 1. Declared before the first run

- **Instrument:** environment variable **`TENSION_MEASURE=1`**, read once into a
  `OnceLock` — a per-delivery `std::env::var` would itself be the cost being measured.
- **Sites:** `service_wakes`' per-delivery segments (five), the park seam (one timestamp
  per park), and the session loop's end (the summary). Plus the probe flag below.
- **Sample count: N = 1000 pairs in one process**, both backends.
- **Columns:** `queue_wait`, `validate`, `scratch`, `call`, `mark`, and the derived
  `host_dispatch` (validate+scratch+mark), `host_total` (+queue_wait), `round_trip` (all
  five). Originals plus `round_trip` added mid-round because the wall clock turned out to
  measure something else entirely (§5).
- **Reader/flag:** `--post-completion-each-park <CLASS>,<N>`, default off, in
  `HOST_OPTIONS` **and** `USAGE`, posting from the park seam.
- **Declared count deltas:** `--test fiber-executor` **6 → 7** and the CI step **12 → 13**,
  because the brief required a looping measurement test and also pinned the count at 6;
  see §6.

## 2. The promise backend

**Release binary, `--executors 2` (one worker), N = 1000, class 5, `--post-completion-each-park 5,1000`,
bundle `aa74d6a1`.** Three runs, same build. Times in nanoseconds.

| column | p50 (run 1 / 2 / 3) | p95 (1/2/3) | min (1/2/3) | max (1/2/3) |
|---|---|---|---|---|
| `queue_wait` | 1162 / 921 / 861 | 1734 / 1082 / 1152 | 851 / 871 / 821 | 71756 / 24747 / 21380 |
| `validate` | 501 / 310 / 311 | 791 / 541 / 531 | 60 / 60 / 60 | 144402 / 122320 / 1042 |
| `scratch` | 30 / 20 / 20 | 31 / 30 / 30 | 20 / 20 / 20 | 491 / 191 / 50 |
| `call(guest runs inside)` | 2365 / 1703 / 1643 | 5941 / 3847 / 3767 | 1603 / 1593 / 1562 | 160182 / 89108 / 37801 |
| `mark` | 30 / 30 / 30 | 31 / 31 / 31 | 20 / 20 / 20 | 300 / 61 / 70 |
| `host_dispatch` (v+s+m) | 551 / 360 / 360 | 862 / 591 / 581 | 120 / 110 / 110 | 144853 / 122551 / 1113 |
| `host_total` (no call) | 1593 / 1292 / 1242 | 2534 / 1633 / 1493 | 1222 / 992 / 952 | 146175 / 123443 / 21551 |
| `round_trip` (all five) | **4008 / 3026 / 2925** | 8165 / 5350 / 5109 | 2966 / 2635 / 2525 | 162155 / 130777 / 39084 |

Run 3 verbatim, as the engine printed it:

```
executor 1: queue_wait               n=1000 p50=861ns p95=1152ns min=821ns max=21380ns
executor 1: validate                 n=1000 p50=311ns p95=531ns min=60ns max=1042ns
executor 1: scratch                  n=1000 p50=20ns p95=30ns min=20ns max=50ns
executor 1: call(guest runs inside)  n=1000 p50=1643ns p95=3767ns min=1562ns max=37801ns
executor 1: mark                     n=1000 p50=30ns p95=31ns min=20ns max=70ns
executor 1: host_dispatch(v+s+m)     n=1000 p50=360ns p95=581ns min=110ns max=1113ns
executor 1: host_total(no call)      n=1000 p50=1242ns p95=1493ns min=952ns max=21551ns
executor 1: round_trip(all five)     n=1000 p50=2925ns p95=5109ns min=2525ns max=39084ns
```

**What each column is, because the label is the result:**

- `queue_wait` — the park was recorded until the delivery was in hand. **This is the
  producer's cadence, not an engine cost**, and in this probe the producer *is* the park
  seam, so it is the tightest cadence that can exist. A decode thread or an I/O completion
  adds its own scheduling here; it cannot make the engine's part cheaper.
- `validate` — `delivery_target` under the store's lock: the I55 guard DL26 added.
- `scratch` — writing the task id into the executor's dead spawn-record words.
- `call(guest runs inside)` — **not host work.** `__taskWake` → `state.resume` → `f$resume`
  runs the guest until it parks again. Its presence in this table is the honest labelling;
  its absence would have been a lie about what the host spends.
- `mark` — setting `resolved` on the record the lookup chose.
- `host_dispatch` — validate+scratch+mark per sample: **the engine's own per-wake work**.
- `host_total` — that plus `queue_wait`, i.e. everything except the wasm call.
- `round_trip` — all five per sample, the park-to-park cycle. Throughput is derived from
  this, never from the wall clock (§5).

### Throughput, promise backend

From `round_trip` p50: **1 / 2.925 µs ≈ 342 000 pairs/s** (run 3), 330 k (run 2), 250 k
(run 1) — so **≈250–340 k pairs/s steady state**.

The **wall clock says 52 ms for 1000 pairs ≈ 19 k pairs/s**, and that number is *wrong as a
per-await cost*: of those 52 ms, ~3 ms is the segments above, ~10–20 ms is process startup
and engine/module setup, and **~50 ms is the session loop's `wait_for_work(SLICE = 50 ms)`
noticing the stop after the last delivery**. Reporting 19 k/s would price the loop's
shutdown slice as if it were an await. Both figures are in this report, labelled.

## 3. The fibre backend

**Release test profile (`cargo test --release --test fiber-executor q_fiber`), N = 1000,
one executor, one thread, bundle `aa74d6a1`.** No `--executors` on this path — the fibre
executor is the probe's own loop, as declared.

| column | p50 (4 runs) | p95 (runs) | min | max |
|---|---|---|---|---|
| `queue_wait` | 410 / 391 / 431 / 460 | 531 / 400 / 521 / 521 | 320 / 380 / 390 / 320 | 61175 / 6773 / 1333 / 29195 |
| `resume` | 70 / 70 / 80 / 80 | 100 / 71 / 91 / 100 | 60 / 60 / 70 / 60 | 47639 / 70844 / 82635 / 48011 |
| `total` | **481 / 461 / 511 / 532** | 622 / 471 / 611 / 611 | 390 / 450 / 460 / 380 | 61706 / 71235 / 83056 / 48451 |

Run 4 verbatim:

```
queue_wait  p50=460ns p95=521ns min=320ns max=29195ns
resume      p50=80ns p95=100ns min=60ns max=48011ns
total       p50=532ns p95=611ns min=380ns max=48451ns
throughput  1236361 pairs/s  (wall 0.809ms over 1000 pairs)
```

**`resume` p50 70–80 ns is at the clock's own resolution and must be read as "unmeasurably
fast", not as a precise figure** (§4). What it means is that the suspension itself — a
stack switch — is *below the cost of two clock reads*, and everything the pair costs is
elsewhere.

**Where it is:** `queue_wait` (p50 0.39–0.46 µs) is ~85 % of `total`. That is the wake
channel — a `Mutex<VecDeque>` push, a `Condvar` notify, and a pop — and it is the single
most expensive part of an await on this backend. **The channel costs more than the park.**

**What is absent, and that absence is a result:** there is no `validate`, no `scratch`, no
`mark`. The fibre path needs no ledger lookup, no write into guest memory, and no per-store
resolution flag, because the suspension *is* the stack switch and the executor holds the
`Fiber` directly. The two tables are not the same shape because the two mechanisms are not
the same shape.

### Throughput, fibre backend

From `total` p50: **1 / 0.532 µs ≈ 1.88 M pairs/s**; the measured wall clock agrees to
within 35 % (0.809 ms / 1000 → 1.24 M/s, including the test harness's setup and the
sample-vector push).

### The two backends side by side

Per-pair, like for like (`round_trip` against `total`), across the run pairs this round
took:

| pair | promise | fibre | ratio |
|---|---|---|---|
| slowest on both sides | 4008 ns | 461 ns | **8.7×** |
| medians | 3026 ns | 496 ns | **6.1×** |
| fastest on both sides | 2925 ns | 532 ns | **5.5×** |

**≈6× by median, 5.5–8.7× across runs.** The ratio is more trustworthy than either absolute
number: both sides are instrumented with the same clock on the same machine within minutes
of each other, so the overhead largely cancels in the comparison even though it inflates both
columns.

## 4. The timer's own cost, measured and disclosed

Not subtracted by estimate — measured, then disclosed with the arithmetic so a reader can
disagree with it.

A standalone microbenchmark of the exact pattern the instrument performs
(`/tmp/dl27/timer_cost.rs`, 200 000 iterations, two runs):

```
N=200000 pairs  total=35.262ms  per pair=176.3ns  per Instant::now()=35.3ns
N=200000 pairs  total=36.239ms  per pair=181.2ns  per Instant::now()=36.2ns
```

So **one `Instant::now()` costs ~35 ns**, and the promise side takes five per delivery
(~176 ns of instrumentation) where the fibre side takes two (~70 ns).

**Every segment overshoots by about one clock read**, because the closing read happens after
the work it closes. Consequences, stated rather than buried:

- `scratch` (p50 20–30 ns) and `mark` (p50 20–30 ns) are **below one clock read**. They are
  not measurements; they are "at or under the resolution of the instrument". A derived
  figure for the two together would be somewhere in 0–60 ns and this round cannot narrow it.
- `host_dispatch` spans three closing reads, so it overshoots by ~105 ns. **Adjusted
  estimate: ~255 ns** (run 3's 360 minus 105). Labelled as derived.
- `queue_wait` and `call` each overshoot by ~35 ns; `round_trip` inherits four closing reads
  → **adjusted ≈ 2 785 ns** for run 3.
- The fibre `resume` at 70–80 ns against a 70 ns instrumentation floor is therefore
  **indistinguishable from zero**.

I have **not** subtracted these from the tables. The tables are what the engine printed; the
adjustment is arithmetic a reader can redo, and a subtraction I performed silently would be
the same blending this round forbids.

**A null-run cross-check that failed, and why that is fine:** the on/off wall-clock
difference is ~1 ms per 1000 pairs (min 51 ms off, 52 ms on), which is far *below* the
probe's own 20 ms polling granularity and the ~50 ms shutdown slice. Wall clock cannot
resolve a 176 µs effect here, which is exactly why the timer's cost is measured directly
instead.

## 5. Functional equivalence: instrument on vs off

**Promise backend, same guest, same flags, 1000 pairs:**

```
$ tension-core --executors 2 --post-completion-each-park 5,1000 wake-loop.wasm
EXIT=0
main: spawning
main: index=0
main: spawn=0
worker: BEFORE 1000 awaits
worker: AFTER 1000 awaits, last=0
main: wakes served=1000
main: join=0
main: done

$ TENSION_MEASURE=1 tension-core --executors 2 --post-completion-each-park 5,1000 wake-loop.wasm
EXIT=0
   … identical, line for line …

$ cmp f-off.out f-on.out
YES — byte-identical stdout
```

Same exit code, byte-identical stdout, and the same `wakes served=1000`. The instrument
changes how long things take; it does not change what the program does.

**Fibre backend:** the same test asserts `Done(42)`, exactly 1000 samples, and `AFTER the
park keep=42` after all 1000 suspensions, whether run with `--nocapture` (which prints) or
without. The measurement test is an ordinary passing test, not a separate mode.

## 6. Declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| `--bin` | 307 | **307** | unchanged |
| census `--workers 8`, alone | 71 pass / 11 no-source | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** capability skips | unchanged |
| thread suite | 7 | **7** (DL21's and DL22's guards unmodified) | unchanged |
| `--test fiber` | 6 | **6** | unchanged |
| `--test fiber-executor` | 6 | **7** | **+1 — declared in §1, see below** |
| CI `Stackful proofs` | 12 tests | **13** (`6 passed` + `7 passed`) | **+1, same cause** |
| bundle / std | unchanged | `aa74d6a1`, `cmp` exit 0 | unchanged |

**The one delta, and it is the brief's own inconsistency.** §3 requires "extend DL25's
executor test to loop N times" while §4 pins `--test fiber-executor` at 6. A new test and an
unchanged count cannot both hold. I kept the test a **real** passing test rather than
`#[ignore]`-ing it, because an ignored test is precisely the vacuous gate this project has
spent six rounds closing — and declared the move before the run rather than after. CI
confirms 6 + 7 = 13.

### Files touched

| file | why |
|---|---|
| `tension-core/src/thread.rs` | `WakeTiming`, `measuring()`, pool storage, the five segments, the summary, `arm_post_each_park`/`note_each_park`, the seam's stamp and post |
| `tension-core/src/main.rs` | the `--post-completion-each-park` option: kind, table entry, `USAGE`, parser, arm site |
| `tension-core/src/host/config.rs`, `host/dev.rs`, `sandbox.rs` | the config field and its three construction sites |
| `tension-core/tests/fiber-executor.rs` | `serve_inner`/`serve_quiet`, `quiet` threaded into `run_guest`, `GUEST_LOOP`, `q_fiber_cost_per_await`, `percentiles` |
| `tools/thread-promise/programs/wake-loop.ts` | the promise probe guest, committed with its build recipe and the two constraints it found |
| `docs/abi/guest.md` | regenerated — twice (§7) |

## 7. Bugs I made, and what caught each

1. **`validated_at` landed on the wrong side of the scratch write.** My first cut put the
   segment boundary *after* the scratch block, so `validate` would have silently absorbed
   the scratch write and `scratch` would have read ~0. **Caught by re-reading the segment
   order before the first run** — this is exactly the "blended figure" the brief calls a
   wrong number, and it would have looked like a clean result.
2. **A spinning `main` in the probe guest, which is a measurement bug not a correctness
   bug.** The first version spun on the served counter; the host bumps that word on every
   wake, so main was ping-ponging the cache line against the writer and burning a core
   competing with the thread it waits for. It also hit the spin bound at 769 and exited 1.
   Replaced with `atomicWait`.
3. **`atomicWait` then hung the run**, because the host **cannot** `atomic.notify` a guest —
   the timeout is the only way the word is ever noticed to change. I had set 2 s, which
   also made the wall clock measure *main's polling granularity* (2.0 s, not the worker's
   work). 20 ms fixed both.
4. **The key space bounded N before anything else did.** `key_capacity` answers
   `Some(768)` for the jobs family and the seam refuses on `key > bound`, so class 4 admits
   keys **0..=768** — 769 distinct keys, and the 770th park (key 769) is refused. Measured:
   the run recorded 770 parks, served 769 wakes, and the refusal named key 769. Found
   because the run exited 1; a silent variant would have measured 769 pairs and called it
   1000. Switched to `CLASS_RESOURCE_READY`, whose bound is 1024.
5. **The ABI doc went stale twice.** I regenerated it, then edited `thread.rs` again, and
   the pre-commit hook refused the commit with the exact stale row. The lesson is not
   "regenerate earlier" but "regenerate at commit time" — a generated file is only valid
   against the source state that is being committed. Third round running where a *generated*
   artifact was what broke the commit.
6. **A `cmp` on a relative path from the wrong directory** reported "No such file" for the
   installed `std`, which looked like a missing package. It was my own path slip; re-run in
   the right directory, `cmp` exits 0.

## 8. What I did not verify

- **Any warm-cache or steady-state claim.** 1000 parks, one process, one worker, run cold
  from process start. The first ~50 samples include module instantiation in whatever they
  touch; p50 over 1000 is dominated by the steady state but the *first* deliveries are not
  separated out. A warm-up-then-measure variant would say more and was not built.
- **Anything about fan-out or batch handoff** — excluded by the brief, and the batch-handoff
  number needs the surface path.
- **Contention.** One worker, one producer, no competing executor. The `Mutex<VecDeque>` and
  `Condvar` numbers are uncontended, so they are a **floor**; N workers sharing a lock path
  would be worse and are unmeasured.
- **The `queue_wait` a real producer would see.** By construction this probe's producer is
  the seam, so every `queue_wait` here is a lower bound. The round says so in every place
  the number appears rather than qualifying it once.
- **Whether the p95/max tails mean anything.** `max` reaches 160 µs on the promise side and
  83 µs on the fibre side, which is far above every p95 — most likely the OS descheduling
  the thread (12 vCPUs on WSL2, and the census ran earlier on this box). I did not
  investigate them, and a tail claim from four runs would be premature.
- **Release `lto`/`codegen-units` variants**, `--executors` other than 2, and Windows.
- **The `TENSION_MEASURE` path itself under load** — no test asserts that a metered run's
  numbers are sane, only that its behaviour is unchanged. That is deliberate: a test on a
  latency is a flaky test.
