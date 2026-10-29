// A sustained-load bench for the evaluator's rotation path — and the reproducer
// for the TensionScript defect that blocks `Quat` as a value type (plan §4.6).
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// Converting `class Quat` to `struct Quat` (plan §4, Phase 3) compiles clean,
// passes every framework fixture, and then corrupts memory under sustained load:
// a method returning a plain struct writes outside its frame. The suite cannot
// see it because a fixture samples a handful of ratios; this bench runs the same
// call a few thousand times.
//
// **It is a bench, not a test, on purpose.** It faults on the converted tree, so
// it cannot join `tests/run.sh` — the suite's contract is "exit 0". Its job is
// to fail before the compiler fix and pass after, which makes it a fixture for
// the fix rather than a gate on the engine.
//
// ── Running it ───────────────────────────────────────────────────────────
//
//   cd tension-framework
//   ./node_modules/.bin/tensionscript tests/benches/quat-value-bench.ts \
//       --runtime incremental --target release --initialMemory 132 \
//       -o build/quat-value-bench.wasm
//   ../tension-core/target/debug/tension-core \
//       build/quat-value-bench.wasm 10000
//
// `--initialMemory 132` matches the session config the framework's own guests
// are built with (`build/session.asconfig.json`), so the memory ceiling under
// test is the real one. The frame count is the single guest argument; the frame
// time is measured on the host, because the guest has no clock — the same reason
// `guest-motion` estimates its fps.
//
// ── Recorded evidence (2026-10-29, 0.11.0) ───────────────────────────────
//
//   build                     workload     result
//   class Quat (pre-Phase-3)  10,000       checksum 4909.033      OK
//   struct Quat (Phase 3)        300       checksum 147.27113     OK
//   struct Quat (Phase 3)      1,500       memory fault at 0xb7b50008
//                                          (float bit pattern, ~ -5.2e-5)
//                                          in 8,650,752-byte memory
//
// The fault is deterministic at that address, identical under `--target debug`
// and `--target release`, and disappears when a `print` is added inside the loop
// — an out-of-bounds access whose verdict depends on allocator state. The
// unchanged out-parameter path (`translationAt`) runs 1,000,000 iterations clean,
// which is what localises the defect to the value return rather than the call
// graph. Full characterisation and the diagnosis boundary: plan §4.6.
//
// The checksums are the contract. They are equal at 300 frames whether `Quat` is
// a class or a struct — which is exactly why the defect survived the suite. A
// build that prints a *different* checksum here has a correctness bug, not a
// layout one.

import { arg, argCount, print } from "../../assembly/io";
import { Animation, BoneTransform, indexAnimation, sampleRatio } from "../../assembly/anim";
import { fixtureBytes } from "../anim-fixtures";

/** The frame count from the guest's first argument; 300 when absent. */
function frames(): i32 {
  if (argCount() < 1) return 300;
  const text = arg(0);
  let n: i32 = 0;
  for (let i = 0; i < text.length; i++) {
    const digit: i32 = <i32>text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) break;
    n = n * 10 + digit;
  }
  return n;
}

export function _start_game(): void {
  // The same archive `guest-anim-eval` verifies against the reference runtime:
  // 68 slots, 67 tracks. Compiled in, so the bench needs no host file.
  const animation = Animation.parse(fixtureBytes("animation_v7_le"));
  print("animation error=\"" + animation.error + "\" slots=" + animation.slots.toString() +
        " tracks=" + animation.trackCount.toString());
  const index = indexAnimation(animation);

  const slots = animation.slots;
  const pose = new Array<BoneTransform>(slots);
  for (let i = 0; i < slots; i++) pose[i] = new BoneTransform();

  const n = frames();
  const denom: f32 = n > 0 ? <f32>n : <f32>1;
  let checksum: f32 = 0;
  for (let frame = 0; frame < n; frame++) {
    sampleRatio(animation, index, <f32>frame / denom, pose);
    // Two slots, far apart, so the compiler cannot narrow the loop to one read.
    checksum += pose[0].rx + pose[slots - 1].rw;
  }
  print("frames=" + n.toString() + " checksum=" + checksum.toString());
  print("OK");
}
