# Runtime-migration measurement harness

Tooling for the `--runtime stub` → `--runtime incremental` decision
(`docs/runtime-migration-plan.md`). It compiles a set of AssemblyScript
workloads under each runtime and measures what the allocator and collector
actually do.

Nothing here is Tension-specific. The workloads are ordinary AS modules; the
runner supplies only a clock (`env.now`). That is deliberate: it means the same
harness produces comparable numbers on Linux, on Windows, and under any host
engine.

## Running it

```bash
# Windows (MSYS2 UCRT64), from this directory:
bash run-measurements.sh

# Linux:
ASC=/path/to/assemblyscript/bin/asc.js \
WTRUNNER=/path/to/wtrunner \
bash run-measurements.sh
```

Useful environment variables:

| Variable | Meaning |
|---|---|
| `ASC` | path to the AssemblyScript compiler's `asc.js`. Auto-detected from `examples/*/node_modules` if unset. |
| `WTRUNNER` | path to the wasmtime runner. That engine's section is skipped if unset. |
| `OUT_DIR` | where the report and per-run JSON land (default `./out`) |
| `REPS` | repetitions of the frame-loop measurement (default 1). Use ≥5 to characterise the tail — the worst *single* stall is not a distribution. |
| `REBUILD=1` | recompile the workloads even if the `.wasm` is present |

Flags: `--stub`, `--incremental`, `--minimal` restrict the runtimes; the default
is all three.

The report lands in `$OUT_DIR/report.txt`; every individual measurement is also
in `$OUT_DIR/*.json`, so a number can be re-checked without re-running.

## The wasmtime runner

`wtrunner/` is a ~150-line Rust program that loads a wasm module under
**wasmtime 24.0.13** — the exact version `tension-core` pins
(`tension-core/Cargo.toml`). It provides a real millisecond clock as `env.now`,
traps loudly on any other import, and reads the guest's result array out of
memory.

```bash
cd wtrunner && cargo build --release --offline
```

`--offline` works because the crate is already in the cargo registry cache on the
Windows host. If it is not, drop `--offline`.

## Workloads

| File | Measures |
|---|---|
| `harness.ts` | M1–M4: heap growth for 1k / 100k / 1M environments and a 10k-frame `map`-shaped loop; plus M5 pause timing, M6/M7 suspended-task retention, M8 giant-mark-step, M9 grow failure |
| `retention.ts` | R1 10k suspended tasks survive a collection; R2 a value shared across one; R3 unrooted memory is reclaimed; R4 a local-only reference is not |
| `probe2.ts` | `p1`–`p6`: six shapes of live-local survival across a collection |
| `frame2.ts` | Frame-loop pause distribution: per-allocation stall counts, top-8 stalls, heap, optional frame-boundary `__collect()` |
| `m5c.ts` | Forced full collection vs live-set size |
| `bigarr.ts` | The giant-mark-step hypothesis: one huge array of references vs many small ones, same object count |
| `scale.ts` | Forced collection and churn at a given live-set size |
| `mintest.ts` | `minimal` runtime: with vs without an explicit `__collect()` |

All results are written into a `StaticArray<f64>` the host reads, rather than
printed, so the numbers survive the boundary exactly.

## Why these workloads, and what they are not

TensionScript has no closures or async yet. These workloads allocate **managed
objects of the shape those features will use** — a small class with an `i32`
field for a closure environment, and a `u32`/`i32`/managed-reference triple for
an async state struct — and drive them through the frame patterns the plans
predict.

So: this measures the **allocator and collector** under the right allocation
shape and lifetime pattern, which is what the runtime decision turns on. It does
**not** measure the real closure lowering, which does not exist yet.

## Notes and gotchas

- **`minimal` is included on purpose.** The migration plan tested and rejected it
  (`docs/runtime-migration-plan.md` §4 R1): it is `TLSF + TCMS`, and TCMS has no
  stack scanner at all, so a value referenced only from a wasm local can be
  reclaimed while still live. Keeping it runnable means the rejection stays
  reproducible rather than becoming folklore.
- **The shadow stack is auto-enabled only for `incremental`**
  (`cli/index.js:335`). `--stackSize` does not rescue `minimal`, because there is
  no scanner to read what it maintains.
- **`--exportRuntime` is required** — it is what exports `__collect`, which
  several workloads call directly.
- **Traps are data, not failures.** Under `stub` several workloads trap with
  `unreachable` because the heap is exhausted; the runner reports the trap rather
  than aborting the run.
- **Single-call discipline.** The stateful probes (`r1`–`r4`, `fullCollect`) must
  be invoked exactly once per measurement. Calling one twice measures a warmed
  heap and understates the growth it exists to expose; `measure.mjs` enforces
  this with a `once()` wrapper.
