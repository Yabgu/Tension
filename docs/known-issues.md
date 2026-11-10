# Known issues

Four entries. Three are resolved and kept for the record — each one blocked
the OGRE flip and each fix came from TensionScript, except KS-4, which was the
fixture's own capture and not an engine defect. One is open: worked around.

---

## KS-1 — binaryen aborts at `-O3`: `wasm-interpreter` `getSingleValue`

**Status:** open, worked around. The engine defaults to `-O2` (see
`tension-framework/build.sh`, the `asconfig_doc` generator).

**Symptom.** Compiling a guest at `-O3` aborts in binaryen's interpreter:

```
Aborted(Assertion failed: values.size() == 1, at:
  .../binaryen/src/wasm-interpreter.h,101,getSingleValue)
```

A second, distinct assertion appears when a pass list is run explicitly at
`-O0` (`--runPasses dae-optimizing`):

```
Aborted(Assertion failed: start_it.index <= end_it.index &&
  end_it.index <= usedElements, at: .../binaryen/src/support/mixed_arena.h,233,erase)
```

Both are deterministic. Both are **in-process only**: the same module, emitted
and re-read from bytes or text, optimizes clean with the same passes and the
same settings.

**Affects** (measured at `-O3` through the session config, 2026-10-31, on
TensionScript 0.11.4):

- `guest-triangle` (`tension-ogre/tests/guest-triangle.ts`)
- `guest-motion` (`tension-ogre/tests/guest-motion.ts`)
- `guest-resource-errors` (`tension-ogre/tests/guest-resource-errors.ts`)
- `examples/ogre/bouncing-bodies`, **if forced to `-O3`** — it builds today
  because it takes the session config's `-O2`.

All 17 guest fixtures compile clean at `-O2`.

**Minimal reproduction** (re-verified on 0.11.4: aborts at `-O3`, clean at
`-O2`). Six lines; needs the framework, not just the language:

```ts
import * as ogre from ".../tension-framework/assembly/ogre";
import { Material } from ".../tension-framework/assembly/ogre/wire";
export function _start_game(): void {
  const record = new Material();
  record.materialId = 1;
  ogre.submitMaterial(record);
}
```

Two ingredients are both required: a `new T()` with **one field write**, passed
by value into any `submit*`. Without the field write the same five `submit*`
compile clean at `-O3`.

**Workaround, and its cost.** The engine defaults to `-O2`. The cost is small
and sometimes negative — measured on this tree: `guest-hierarchy` 39,114 B at
`-O2` vs 39,606 at `-O3`, `guest-skinning` 44,900 vs 45,321; the largest
regression across the fixtures is +0.54% (`guest-angular`).

**Falsified hypotheses.** Five probes, each measured:

1. **A newer binaryen.** `131.0.0-nightly.20260721` (pinned), `132.0.0`
   (latest) and `132.0.0-nightly.20260918` (nightly) all crash on the same
   three fixtures. There is nothing newer published to try.
2. **`removeFunction` leaving arena holes.** Measured: **zero** `removeFunction`
   calls compiling the six-line repro *and* all seven fixtures (three crashing,
   four clean). Mutation volume does not separate crashing from clean — a
   crashing fixture makes fewer `addFunction` calls than a clean one.
3. **Batch pass-run granularity.** Splitting the 57-pass list into 57
   single-pass `runPasses` calls crashes identically. Decisive detail: the
   `-O0 + dae-optimizing` case is a **one-element array**, so batch and
   per-pass are the same call by construction — and it still crashes.
4. **A single pass pair.** `dae-optimizing` **alone** crashes at `-O0`; the
   "DAE after `precompute-propagate`" pairing is not the trigger.
5. **The IR shape.** `emitText` on the live module, re-parsed and re-emitted,
   is **byte-identical** (164,870 bytes in, 164,870 out). No reachable
   construct differs, and both forms are clean out-of-process. What differs is
   state the printer does not carry and binaryen exposes no way to inspect or
   release (no detach/collect entry point in either the JS bundle or the
   typings).

**The rejected workaround, and the fresh lead.** Round-tripping the module
(`emitText` → `parseText`) immediately before `optimize()` **fixes every
crash** — all three fixtures and both assertions go clean. It was rejected on
cost: the four fixtures that already compiled grew **+11.1% to +29.4%**
(`guest-angular` 213,662 → 237,402; `guest-hierarchy` 39,706 → 49,932;
`guest-light` 52,001 → 67,303; `guest-skinning` 45,438 → 57,663). Content is
preserved — `guest-hierarchy` at `-O0` is 50,814 without the round-trip and
50,324 with it — so what degrades is *optimization effectiveness* on the
re-parsed module, not correctness of the bytes.

That is the lead worth following: **out of process the two round-trips are
identical** (218,370 bytes for `guest-angular` under the full `-O3` pass list,
whether read from binary or parsed from text), so serialization is neutral by
itself. The regression appears only when the swap happens *inside* AS's own
`optimize()`.

**Recommended path.** Report upstream to binaryen: the failure is a live,
in-memory module that has been built incrementally by an embedder, optimizing
differently from the same module re-read — a batch `_BinaryenModuleRunPasses`
over an internally-managed arena. A future TensionScript release picks up the
fix by raising `optimizeLevel` back to 3.

---

## KS-2 — view miscompilation: `changetype<@unmanaged T>` over a plain struct

**Status:** **resolved** in TensionScript 0.11.3 (TensionScript PR #41).
Discovered 2026-10-31 while verifying this branch's `--ogre-guest` suite.

**Symptom.** Two shapes were wrong, both silently.

*Bound view → `unreachable`.* `const p = changetype<@unmanaged T>(ptr); p.x = v`
with `T` a plain struct compiled with no diagnostic to a body of nothing but
`unreachable`, so every call through it trapped:

```wat
(func $.../p2 (param $0 i32) (result f32)
  (local $1 i32) (local $2 f32) (local $3 f32) (local $4 i32)
  unreachable
)
```

Not the field initializers — the same struct without `= 0` defaults failed
identically. It was the declaration: with `@unmanaged struct Decl` the *same*
`changetype<@unmanaged Decl>(ptr)` emitted real accessors, so the use-site
modifier only worked over a declaration that was already `@unmanaged` — the
shape it was meant to replace.

*Nested access through a view → value-as-pointer.*
`changetype<@unmanaged R>(ptr).pos.x` emitted `i32.load offset=4` — a 4-byte
load of the field's first bytes — and handed that *value* to `V3#set:x` as if
it were an address. Measured: `memory access out of bounds`, a float's bit
pattern used as a pointer. The declared-`@unmanaged` equivalent emits
`i32.const 4; i32.add`.

**Impact in this tree.** All three view sites the flip introduced were dead at
runtime: `motion.ts:99` (`MotionBatch.setPose`), `bones.ts:149`
(`BoneBatch.write`), `ogre/index.ts:296,302,308` (`jobState`, `jobResult`,
`jobError`). `guest-motion` failed at clause 4 (printed `1 ok`, `2 ok`, `3 ok`,
then trapped); `guest-resource-errors` trapped with an out-of-bounds access.

**Resolution.** 0.11.3 landed body-local views (`compileSroaLocal` allocates a
view local with an `i32` slot; `getNonParameterLocalTypes` decides the slot
type) and routed nested inline-struct field access through address arithmetic
(`viewFieldAccess`) on both the bound and unbound paths. Measured after: the
flip's own shape writes and reads back correctly, and `guest-motion` went to
`ACID 5/5`.

---

## KS-3 — sret call-temp address computed as `base + mark`

**Status:** **resolved** in TensionScript 0.11.4 (TensionScript PR #42).

**Symptom.** A function returning a record by sret produced a call-temp slot
address of `base + mark`, where the mark was already absolute
(`ensureSretStack` initialises the bump global to the region's base, and
`makeSretGuard` tests `mark + size > base + SIZE`). The address therefore
pointed at `2 * base + ...` — past the region and usually past linear memory:

```
memory fault at wasm address 0x1002a60 in linear memory of size 0x840000
```

`0x1002a60` is exactly `2 * 0x801430`. Three sites built it independently: the
destination the callee writes into, the discard path, and every read-back.

**Impact in this tree.** `guest-resource-errors` trapped at clause 2
(`RESERR 2 not-loadable -5` printed, then the fault). Reachable, not
flip-caused: while wire records were `@unmanaged` pointers, factories returned
pointers and no sret path was emitted. The flip makes records plain, so
factories return by sret and the path is exercised.

**Resolution.** `makeSretAddress` returns the mark alone; the `base` parameter
is gone from the helper chain. `makeSretGuard` and the global's initial value
were correct and are unchanged. Measured after: `guest-resource-errors` reaches
`RESERR 4 control-done 0`, and `--ogre-guest` is green at `-O2` apart from the
`vulkan` case below.

---

## KS-4 — `skin-matrices` was flaky: the fixture re-read a stale frame

**Status:** **resolved** 2026-11-10 in `tension-ogre/tests/guest-skin-matrices.ts`
(the fixture, not the engine). Before the fix: 9 failures in 50 runs (18%).

**Symptom.** `TENSION_OGRE_WINDOW_TEST=1 node scripts/test-ogre.mjs` failed at
`skin-matrices` in roughly a sixth to a third of runs:

```
MATRICES shifted=7217.0 unshifted=7217.0 delta=0.0
MATRICES 4/4 failed: the two frames differ by 0.0 px, under the floor of 30.0 — the matrices did not reach the shader
```

Passing runs reported 1815, 4046 or 5861; failing runs always reported 0.0 with
both counts equal.

**Cause.** Not the engine, and not a dropped commit. `ogre::screenshot` is
probe/consume over `last_frame_` — it re-reads the same bitmap until a *new*
download replaces it — and the fixture's `grab()` proved freshness with a frame
count (`frameCount() >= armed_at + 3`), which is a guess about when the
download lands, not a proof. Worse, it sampled `armed_at` **before** raising
the readback request, so a descheduled guest could raise the request two frames
later and then wait for one.

When the guess was wrong the capture returned the bitmap from *before* the
commit, and the next clause then compared that same capture against itself. The
commit had landed: in every failing run, an extra grab one call later returned
the correct pose (`5402` instead of `7217`), and the two frames the fixture did
compare were byte-identical (FNV-1a hash equal). The old delta variance was the
same defect at a smaller scale — `1356` (the no-matrices pose) is what a stale
capture of the first pose returns.

**Resolution.** `grab_after(previous)` now synchronises on the frame's
*content*: it re-captures until the bytes differ from `previous`, which is
precisely "the render thread finished a frame drawn after the commit that
produced `previous`". Clause 3 captures the unrigged frame first and requires
the shifted frame to differ from it; clause 4 requires the zero-translation
frame to differ from the shifted one. `capture_once` also arms the readback
request before sampling the counter.

**Measured after.** 50/50 runs pass, and every run reports the same pair —
`shifted=7217 unshifted=5402 delta=1815` — where before the counts drifted
between 1356/5402/7217. Two full `TENSION_OGRE_WINDOW_TEST=1 node
scripts/test-ogre.mjs` runs are green.

**What the test asserts is unchanged.** The floor is still `MIN_DELTA = 30` and
the delta is still read from two independently captured frames; only *when* each
capture is accepted changed.

**Left for another pass.** `guest-skin-deform.ts` and `guest-skin-noskel.ts`
carry the same `grab()` shape (counter before request, fixed 3-frame wait); they
have not flaked in this session's runs, but they are the same latent defect.

---

## Notes

- **`guest-resource-errors` was misattributed in earlier drafts.** It appeared
  in KS-1's "affects" list as an `-O3` casualty. Its real fault was KS-3, which
  reproduced at **both** `-O2` and `-O3` — the `-O3` crash masked it rather
  than causing it. It stays in KS-1's list for a separate reason: after the
  KS-3 fix it *still* aborts at `-O3` on `getSingleValue`, like the other two.
  Both statements are true and measured.
- **`vulkan` fixture SIGSEGV is pre-existing and environmental**, not tracked
  as a Tension bug: after a clean `FAIL 0 -5` from the guest, a software-Vulkan
  worker thread (the log names `dzn`) faults during teardown. It reproduces at
  every optimization level and on pre-flip `main`.
- **`bouncing-ball` example does not build** — `ERROR AS105: Module requires at
  least '133' pages of initial memory` against `session.json`'s
  `initial_pages: 132`. Pre-existing on `main` and on both compiler releases
  tested; a `session.json` + `layout_hash` change, tracked separately.
