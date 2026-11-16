// One spelling for "this assertion did not run", shared by the runner that
// prints the suite output and the projection that decides a commit.
//
// ## Why this exists (gate finding 14)
//
// Two suites exit 0 while their central assertion never ran:
// `window-close`, whose live phase prints a reason and returns, and the `core`
// suite's `replay_device` binary, which counts its own skips and prints
// `PASS (0 ran, 5 skipped)`. The runner saw only an exit status, so
// `[PASS] window close` read identically whether a window was really clicked
// shut or the click never happened. The gate's `26/26` was therefore the same
// string for two different amounts of exercise — the audit's fourth clause
// ("the gate must be able to say what it exercised"), one layer below finding 9.
//
// Counting is not failing. Which skips *may* fail a gate is a policy decision —
// a machine with no GPU has no opinion about a GPU claim, while a machine asked
// for `--live` and silently not doing it is a different thing — so this module
// only **counts**. The default stays non-blocking until the user decides
// otherwise with the CI evidence in hand.
//
// ## The markers
//
// Three spellings exist in the tree, and each is a clause of its own:
//
//   `skipped: <why>`   `tension-core/tests/support/ci.rs` (the tree's one skip
//                      flag) and `tests/replay_device.rs`'s per-test report.
//                      Flush left, because it is a whole line.
//   `SKIP — <why>`     the guest fixtures, `scripts/test-framework.mjs`, and
//                      `scripts/test-ogre.mjs`. Always behind a label:
//                      `tension-ogre tests: SKIP — …`, `gpu: SKIP — …`.
//   `skipped — <why>`  `scripts/test-window-close.mjs` (`== live: skipped — …`)
//                      and `scripts/test-ogre.mjs` (`== windowed: skipped — …`).
//
// ## What is deliberately not a marker
//
//   `replay_device: PASS (0 ran, 5 skipped — no GPU on this machine)` is the
//   *summary* of the five `skipped:` lines above it. Counting both would double
//   the figure; it does not match because the em-dash forms are matched as a
//   clause — line start or after `: ` — and this line's is `5 skipped — …`.
//   `render2d_parity: 16 passed, 0 skipped, 0 failed` and node's `ℹ skipped 0`
//   are tallies, matched by neither spelling.
//   `SKIP: no host window on this machine` (from `tests/ogre_host_surface.rs`)
//   is excluded on purpose: that path exits 77, so cargo fails the suite. A skip
//   that already turns a suite red needs no accounting here.

/// Every line shape that reports an assertion which did not run.
export const SKIP_MARKERS = [
  /^skipped: /,                   // support/ci.rs, replay_device.rs (flush left)
  /(?:^|: )(?:SKIP|skipped) — /,  // `<label>: SKIP — …`, `== live: skipped — …`
];

/// Whether one line reports a skipped assertion.
export function isSkipLine(line) {
  return SKIP_MARKERS.some((marker) => marker.test(line));
}

/// The skip lines in a suite's captured output, in order.
export function skipLines(output) {
  return output.split(/\r?\n/).filter(isSkipLine);
}

/// How many assertions a suite reported as skipped.
export function countSkips(output) {
  return skipLines(output).length;
}
