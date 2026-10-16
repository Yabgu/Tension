# Runtime migration — native Windows verification

**Status:** measurement report for architect review. No implementation, no
changes to `docs/runtime-migration-plan.md`.
**Verifies:** §2 (heap growth), §3 (GC pauses), §3.7 (conservative-scan false
positives), the retention probes (R1/R2), the frame-loop workload, and §5's
scope claim — all reproduced on a **native Windows kernel**.

---

## 0. Answer

**The plan's recommendation survives native Windows. Switch to `incremental`.**

The load-bearing measurements reproduce, and on the two points that matter most
the Windows numbers are *better* than the plan's:

- `stub` still fails outright: **traps `unreachable`** on the 1M-environment and
  10k-frame map workloads under V8, and consumes **the entire 32 MiB cap** on
  wasmtime.
- `incremental` holds the heap at **one page (64 KiB)** through every workload.
- **Zero allocations exceeded 1 ms** in 1,800,000 timed allocations — five
  independent repetitions × 360,000 — at a worst case of **0.599 ms**.

**One divergence is worth the architect's attention, and it favours the plan's
claim over my own earlier finding.** On Linux I had observed `incremental` stalls
of 3.6–4.1 ms in 2 of 3 repetitions, which contradicted the plan's "no allocation
exceeded 1 ms anywhere". **On native Windows that does not reproduce**: five
repetitions, worst 0.599 ms, zero stalls over 1 ms. The plan's claim holds here.
See §7.1 for the full comparison — the two results are both real and the
difference is platform-side.

**One caveat on toolchain identity**, flagged before any number is trusted:
the plan measured with the fork's *development tree* compiler (`Version 0.0.0`).
This machine has the *released* `0.28.20`, which is what Tension actually builds
with (`examples/io/node_modules`). That is arguably the more relevant compiler,
but it is not byte-identical to the one the plan measured. See §6.

---

## 1. Host and toolchain

| | |
|---|---|
| **Windows** | `Microsoft Windows [Version 10.0.26300.9711]` |
| **Kernel view** | `MINGW64_NT-10.0-26300 snow 3.6.9-aa532e7b.x86_64 2026-04-21 17:18 UTC x86_64 Msys` |
| **SSH target** | `yabgu_gm@snow.lan`, project root `C:\Work\Tension` |
| **wasmtime** | **24.0.13** — the exact version `tension-core` pins (`tension-core/Cargo.toml:20`), built from the local crates.io cache with `cargo build --release --offline` |
| **node** | `v26.4.0` (native Windows `node.exe`, `C:\Program Files\nodejs`) |
| **npm** | 11.17.0 |
| **AssemblyScript** | `0.28.20` (`examples/io/node_modules/assemblyscript/bin/asc.js`) |
| **python3** | 3.14.4 (MSYS2 UCRT64) |
| **rustc** | 1.99.0, host `x86_64-pc-windows-msvc` |
| **tension-core** | prebuilt `target/release/tension-core.exe`, 10,493,440 bytes |
| **Wine** | **not used.** Absent from the toolchain for every measurement below. |

**Native, not emulated.** `MINGW64_NT-10.0-26300` is the Windows kernel build
number as reported by MSYS2's `uname`; the SSH session is a Windows OpenSSH
server; `node.exe`, `wtrunner.exe` and `tension-core.exe` are all Windows PE
binaries. Nothing ran under Wine.

### Getting the harness there

The branch was pushed and pulled, with two obstacles worth recording because
they will recur:

- **`git fetch` over SSH fails on this host.** Git for Windows uses its own
  bundled `ssh`, which finds no usable key; the *Windows OpenSSH* client
  authenticates fine (`Hi Yabgu!`). Setting
  `git config core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes"`
  did not fix the fetch either. **Workaround used:** a `git bundle` transferred
  with `scp`, then `git fetch <bundle>` + `git merge --ff-only FETCH_HEAD`. The
  branch landed at the same commit as origin — `46e78fc` on both sides. The
  bundle route is a workaround for a host misconfiguration, not a defect in the
  branch.
- **`cmp` and `diff` are not in the MSYS2 base install.** Transcript comparison
  used Python.

**Branch:** `verify/runtime-migration-windows`, commits `f4651b3` and `46e78fc`,
identical on Linux and Windows.

---

## 2. Heap growth (plan §3.1–3.4)

### 2.1 V8, native Windows `node.exe v26.4.0`

| workload | `stub` | `incremental` | `minimal` |
|---|---|---|---|
| 1,000 environments, used once | grew 0 B, heap 1 p, 0.163 ms | grew 0 B, heap **1 p**, 0.585 ms | grew 0 B, heap 1 p, 0.283 ms |
| 100,000 over 10 s of frames | grew **4,128,768 B**, heap **64 p**, 4.337 ms | grew **0 B**, heap **1 p**, 10.481 ms | grew 4,128,768 B, heap 64 p, 8.441 ms |
| **1,000,000 over 100 s** | **TRAP `unreachable`** | grew **0 B**, heap **1 p**, 36.883 ms | **TRAP `unreachable`** |
| **`map`-shaped, 10,000 frames** | **TRAP `unreachable`** | grew **0 B**, heap **1 p**, 4.497 ms | **TRAP `unreachable`** |

### 2.2 wasmtime 24.0.13, native Windows

| workload | `stub` | `incremental` | `minimal` |
|---|---|---|---|
| 1,000 | heap 65,536 B (1 p), 0.042 ms | heap 65,536 B (1 p), 0.145 ms | heap 65,536 B (1 p), 0.106 ms |
| 100,000 | grew 4,128,768 → **4,194,304 B (64 p)**, 3.770 ms | grew **0** → **65,536 B (1 p)**, 14.274 ms | grew 4,128,768 → 4,194,304 B, 7.398 ms |
| **1,000,000** | grew 33,488,896 → **33,554,432 B = 512 p = the entire cap**, 28.080 ms | grew **0** → **65,536 B (1 p)**, 141.003 ms | grew 33,488,896 → 33,554,432 B, 73.397 ms |
| `map` 10,000 frames | grew 2,031,616 → 2,097,152 B (32 p), 3.171 ms | grew **0** → **65,536 B (1 p)**, 7.593 ms | grew 2,031,616 → 2,097,152 B, 4.670 ms |

**Both failure shapes from the plan reproduce exactly.**

- Under **V8**, `stub` **traps** on the two target workloads. The 1M-environment
  and 10k-frame `map` workloads — the latter being precisely what closures exist
  for — are fatal, not merely wasteful.
- Under **wasmtime**, `stub` *completes* the 1M workload having consumed
  **33,554,432 B = 512 pages**, i.e. it hit `maximum_pages` exactly and survived
  by a single page. Same reading as the plan's Linux number
  (33,554,432 B), to the byte.
- `incremental` holds **one page** in every case on both engines.

`minimal` is indistinguishable from `stub` on these workloads, on both engines —
which is expected and is not the reason it is rejected (§5).

---

## 3. GC pauses (plan §3.5)

**Method:** 3,600 frames × 100 allocations = **360,000 individually-timed
allocations per repetition**, five repetitions per runtime — **1,800,000 timed
allocations each**. The collector runs inline inside the allocation that crosses
the threshold, so timing allocations is how a frame experiences the pause. The
workload also records the top-8 stalls, so a single worst-case number is not
mistaken for a distribution.

### 3.1 Frame-loop stalls, native Windows

| runtime | worst across reps | median of worsts | best rep | stalls >16 ms | >4 ms | >1 ms | final heap |
|---|---|---|---|---|---|---|---|
| `stub` | 0.6533 ms | 0.6265 ms | 0.6228 ms | **0** | **0** | **0** | 256 p |
| **`incremental`** | **0.5991 ms** | **0.5828 ms** | 0.5749 ms | **0** | **0** | **0** | **1 p** |
| `minimal` | 0.6531 ms | 0.6313 ms | 0.6120 ms | **0** | **0** | **0** | 256 p |

Top stalls observed, `incremental` (ms, descending):
`0.599, 0.584, 0.583, 0.580, 0.575, 0.457, 0.404, 0.403`

**No stall came within a factor of 24 of a 16 ms frame budget.** The worst single
stall is **3.7 %** of a frame.

**`incremental`'s worst stall is *lower* than `stub`'s** (0.599 vs 0.653 ms).
`stub` is not pause-free: it pays `memory.grow` in one lump.

**Honest cost, stated plainly:** `incremental` spends roughly **1.8×** the total
time inside allocations — median 43.56 ms vs `stub`'s 24.30 ms across 360,000
allocations. That is the amortised collection work, and it is roughly 1.2 % of the
3600-frame wall clock. It is the real price of reclaiming memory.

### 3.2 Forced full collection vs live-set size (`incremental`)

| live objects | full GC | heap |
|---|---|---|
| 50,000 | 0.793 ms | 32 p |
| 200,000 | 1.458 ms | 128 p |
| 600,000 | **4.463 ms** | 512 p |

Linear, and 600,000 live objects still costs **28 % of a frame budget**.

### 3.3 Explicit frame-boundary `__collect()` (plan decision R2)

3,600 frames, `__collect()` at every frame boundary:

| runtime | worst frame-boundary GC | total across the run | collections | worst alloc | heap |
|---|---|---|---|---|---|
| `incremental` | **0.143 ms** | 14.9 ms | 3,600 | 0.6273 ms | 1 p |
| `stub` | 0.005 ms (no-op) | 0.2 ms | 3,600 | 0.6933 ms | 256 p |

Matches the plan's Linux figure (0.11 ms worst). **R2's conclusion is unchanged
and now confirmed on Windows: the call is cheap but redundant** — automatic
collection already holds the heap at one page without it.

### 3.4 The giant-mark-step hypothesis (plan §3.8)

| shape | count | forced full GC | worst alloc stall |
|---|---|---|---|
| one big array | 200,000 | 2.626 ms | 0.3245 ms |
| many small arrays | 200,000 | 4.431 ms | 0.4518 ms |
| one big array | 500,000 | **6.682 ms** | 0.3670 ms |
| many small arrays | 500,000 | **11.677 ms** | 0.5028 ms |

The hypothesis does not hold on Windows either — the big-array shape is ~2×
*faster* in a full collection. Same direction as Linux. Frame-loop stall stays
≤ 0.51 ms even with 500,000 live objects.

---

## 4. Retention probes (plan §3.6)

All three runtimes, native Windows:

| probe | `stub` | `incremental` | `minimal` |
|---|---|---|---|
| **R1** 10,000 suspended tasks survive 2 forced full collects | 10000/10000 | **10000/10000** | 10000/10000 |
| **R2** shared value across a collection | 42 | **42** | 42 |
| **R3** unrooted reclamation growth (100k objects, 20 rounds) | **3,145,728 B** | **0 B** | **0 B** |
| **R4** local-only reference not reclaimed | 7 | 7 | 7 |
| **p1–p6** six live-local survival shapes | 6/6 | **6/6** | 6/6 |

**R1 passes**, and it is the probe the whole async design rests on: ten thousand
suspended state structs, each rooting an environment, all survive two full
collections intact. A collector that mishandled this would corrupt every parked
task.

**R2 returns 42** — the closures plan's hard case in its essential form: a value
parked, collected over twice, then mutated through one reference and read through
another. Correct under `incremental` on Windows.

**R3 is the leak, quantified:** 100,000 unrooted environments cost **3,145,728 B
under `stub` and 0 B under `incremental`**.

---

## 5. Conservative-scan behaviour (plan §3.7)

**The plan author could not force a false positive after three attempts on Linux.
I could not force one on native Windows either.** Reported as a failure to
reproduce, not as a proof of absence.

Four purpose-built strategies (`tools/runtime-migration/workloads/falsepos.ts`),
on `incremental`:

| strategy | heap growth |
|---|---|
| `fp1` — a dead object's address held in a local **across a call** | **0 B** |
| `fp2` — 16 dead addresses live on the stack **at once**, 500 rounds | **0 B** |
| `fp3` — addresses pushed into a long-lived array, 20,000 entries | 458,752 B |
| `fp4` — **control**: same allocation volume, no aliasing | **0 B** |

**`fp1` and `fp2` are the meaningful results**, and both are zero. `fp4`'s zero
control is what makes them meaningful: the allocation volume alone produces no
growth, so `fp1`/`fp2` are not measuring ordinary overhead.

**`fp3` should not be read as a positive.** Its 458,752 B is the *sink array's
own* growth — 20,000 `usize` entries pushed into a managed `Array<usize>` — not
retention of the dropped objects. The probe as written cannot distinguish the two.
It is left in the file with this caveat rather than quietly removed.

Under `stub` the same probes grow (`fp1` 196,608 B, `fp2` 786,432 B,
`fp3` 3,145,728 B), which is the expected `stub` behaviour — nothing is freed —
and confirms the probes are sensitive to the thing they are testing.

**What this does and does not establish.** Conservative retention is a real
property of `visitStack` by construction: it cannot distinguish an integer from a
pointer, and the source says so plainly
(`std/assembly/rt/itcms.ts:167-173`). **I could not make it observable on Linux
or on Windows.** The steady-state cost is bounded by "some garbage survives to the
next collection", and nothing in these runs shows more than that. **I am not
claiming it cannot happen**, and the recommendation in plan R8 (accept the risk)
is neither strengthened nor weakened by this run.

**One Windows-only observation on `minimal`.** On Windows, `minimal` passed the
retention probes (R1 10000/10000, R2 42, R3 0 B) *and* the frame loop with zero
stalls over 1 ms. This does **not** contradict the plan's rejection of `minimal`,
which rests on a source fact — TCMS has **no** stack scanner
(`grep -c "visitStack\|__stack_pointer" std/assembly/rt/tcms.ts` → **0**; ITCMS
→ 2), so a value referenced only from a wasm local can be reclaimed while live.
It means my probe programs happen not to expose that hole. The rejection stands
on the source; the Windows run simply does not demonstrate the failure.

---

## 6. Compile-time and size (plan §3.9)

### 6.1 Binary sizes — all workloads, native Windows, asc 0.28.20

| workload | `stub` | `incremental` | Δ | `minimal` |
|---|---|---|---|---|
| harness | 4,855 | 11,648 | **+6,793** | 8,943 |
| m5c | 6,840 | 12,106 | +5,266 | 10,654 |
| retention | 2,302 | 7,716 | +5,414 | 6,159 |
| bigarr | 2,439 | 7,735 | +5,296 | 6,365 |
| frame2 | 2,653 | 7,524 | +4,871 | 6,459 |
| scale | 2,144 | 7,142 | +4,998 | 5,972 |
| probe2 | 1,282 | 6,478 | +5,196 | 4,867 |
| mintest | 1,003 | 5,541 | +4,538 | 4,509 |

**A real example, end to end:**

| | bytes |
|---|---|
| `examples/io` with `--runtime stub` | 139,638 |
| `examples/io` with `--runtime incremental` | 145,205 |
| **delta** | **+5,567 bytes (+4.0 %)** |

Consistent with the plan's Linux finding of a fixed ~4.3 KB once a module has
managed classes plus sub-linear growth. **On a real game module it is 4 %.**

### 6.2 Startup

**Cold process start → instantiate → first call**, 15 launches each,
`wtrunner.exe` on the same module:

| runtime | best | mean |
|---|---|---|
| `stub` | 47 ms | 48 ms |
| `incremental` | 49 ms | 50 ms |
| **delta** | **+2 ms** | **+2 ms** |

**wasmtime instantiation alone**, in-process: `stub` 0.102–0.145 ms,
`incremental` 0.109–0.146 ms — indistinguishable. The delta is wasm *compilation*
of the larger module, not instantiation, exactly as the plan found.

### 6.3 End-to-end example, through the real host

`examples/io` built both ways and run through the prebuilt
`tension-core.exe`, **10 interleaved repetitions each** so run order cannot bias
the result:

| runtime | per-run wall time (ms) | median |
|---|---|---|
| `stub` | 51 52 50 50 49 49 50 50 50 50 | **50 ms** |
| `incremental` | 51 54 52 51 53 52 52 53 52 52 | **52 ms** |

**+2 ms end-to-end**, matching the cold-start delta. Both exit 0.

**And the plan's real acceptance test, on Windows:**

```
stub        : 131 bytes
incremental : 131 bytes
IDENTICAL
```

**The example's transcript is byte-identical under both runtimes.** That is
plan §9 step 4 — the migration's actual gate — passing on native Windows for a
real guest through the real host.

---

## 7. Divergences from the plan's Linux/Wine numbers

### 7.1 GC tail latency — Windows is cleaner, and this corrects my own finding

| | worst single-allocation stall | stalls >1 ms |
|---|---|---|
| Plan (Linux, V8 `node v24`) | 0.622 ms | 0 of 360,000 |
| **My Linux re-run** (V8 `node v24`, 3 reps) | **4.095 ms** (2 of 3 reps hit 3.6–4.1 ms) | 1 of 1,080,000 |
| **Native Windows** (V8 `node v26`, 5 reps) | **0.599 ms** | **0 of 1,800,000** |

**The plan's claim — "no allocation exceeded 1 ms anywhere" — holds on native
Windows but did not hold in my Linux re-run.** Both measurements are real; the
difference is platform-side. Two candidate explanations, neither confirmed: the
engine version changed (`node v24` → `v26`), and Windows' timer behaviour
differs. **I did not isolate which**, and the honest summary is that
`incremental`'s stall distribution is *machine-sensitive* — clean on this Windows
host, occasionally spiking on Linux.

**Practical consequence:** the migration is safe on Windows with a very large
margin, but a future workload that is sensitive to multi-millisecond tail latency
should be re-measured rather than assumed. This does not change R1 or R2.

### 7.2 Everything else matches

| measurement | plan (Linux/Wine) | native Windows | verdict |
|---|---|---|---|
| wasmtime `stub` 1M heap after | 33,554,432 B (512 p) | **33,554,432 B (512 p)** | **identical** |
| V8 `stub` 1M / 10k-frame map | TRAP `unreachable` | **TRAP `unreachable`** | identical |
| `incremental` heap on M2/M3/M4 | 65,536 B (1 p) | **65,536 B (1 p)** | identical |
| `stub` R3 growth | 3,145,728–4,128,768 B | 3,145,728 B | within range |
| Full GC @ 600k live | 6.115 ms | **4.463 ms** | 27 % faster |
| Frame-boundary collect worst | 0.11 ms | 0.143 ms | equivalent |
| Big-array vs many-arrays | big array better | big array better | same direction |
| Binary size delta | +4.3 KB fixed, +6.7 KB @ 20 classes | **+4,538 … +6,793 B**; real example **+5,567 B** | consistent |
| Cold-start delta | +1.9 ms | **+2 ms** | same magnitude |
| Retention R1/R2 | 10000/10000, 42 | **10000/10000, 42** | identical |

**Windows absolute cold-start times are ~10× the Linux ones** (48 ms vs 4.3 ms for
process launch). That is process-spawn cost on Windows, not wasm; the *delta*
between runtimes is the same ~2 ms either way.

---

## 8. What I could not measure, and why

1. **Time-to-first-frame of a *rendering* example.** Needs the OGRE capability DSO
   built and a window or headless renderer. I used a **session** example
   (`examples/io`) through the real `tension-core.exe` instead — a real guest,
   real host, real ABI, exit 0, byte-identical transcripts — plus a
   process→first-call measurement on the harness module. A first-*frame* number
   would add GPU/OGRE initialisation to a finding that is currently clean.
2. **The conservative-scan false positive.** Still unforced, on Linux and now on
   Windows, across seven constructed strategies and two controls. §5 states what
   that does and does not establish.
3. **What the real closure lowering costs.** TensionScript has no closures yet. As
   in the plan, the workloads allocate *the shape* a closure environment and an
   async state struct will have, which is what the runtime decision turns on; they
   do not exercise a lowering that does not exist.
4. **Any `minimal` data-loss demonstration.** §5 explains why the rejection rests
   on source, not on this run.

---

## 9. Verdict against the plan's pass criteria

Plan §9's gates, on native Windows:

| gate | result |
|---|---|
| No trap on the 1M / 10k-frame workloads under `incremental` | **PASS** (both engines) |
| Heap holds at 1 page on M2/M3/M4 | **PASS** (64 KiB in every case) |
| R1 = 10000/10000 and R2 = 42 | **PASS** |
| R3 = 0 bytes grown | **PASS** |
| p1–p6 all correct | **PASS** (6/6) |
| Worst single-allocation stall < 1 ms over 360,000 allocations | **PASS** — 0.599 ms worst, and **0 stalls >1 ms in 1,800,000** |
| Every example's transcript byte-identical | **PASS for `examples/io`** (131/131 bytes) — the remaining examples were not run |

**Plan R5 (native-Windows confirmation before the flip) is satisfied for the
measurements it named**, with the two gaps in §8 and the toolchain caveat in §0.

**One recommendation for the architect, from §6.3:** the transcript check is the
migration's real acceptance test and it is nearly free. It should be run for
**every** example before the flip, not just `examples/io` — the six OGRE examples
inherit the runtime from the generated config and are the ones most likely to
have timing-sensitive output.

---

## 10. Artefacts

| | |
|---|---|
| Branch | `verify/runtime-migration-windows`, `46e78fc`, identical on Linux and Windows |
| Harness | `tools/runtime-migration/` on that branch |
| Full report | `C:\Work\rm-out\report.txt` on `snow.lan` |
| Per-run JSON | `C:\Work\rm-out\*.json` — every number above is re-checkable without re-running |
| wasmtime runner | `wtrunner.exe`, 8,466,432 bytes, built from the branch's `wtrunner/` against wasmtime 24.0.13 |
| Example transcripts | `C:\Work\Tension\examples\io\out-{stub,incremental}.txt` |

**No implementation. `docs/runtime-migration-plan.md` was not modified. No
change to `tension-core` was required or made** — every measurement ran against
the existing host binary and the existing ABI. The only writes on the Windows host
were to `C:\Work\` (scratch) and the branch checkout.
