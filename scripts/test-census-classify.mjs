#!/usr/bin/env node
// The census's judgement, tested without building anything (DL63).
//
// The classifier decides what one example's run *means*, and every round of this arc has
// leaned on it. This checks the decisions that matter, including the one that was missing:
//
//   - a guest that **said it failed and exited 0** is `ran-but-failed`, not `ran`.
//     Four OGRE examples printed `… .mesh did not load (errno -5)` and read as `ran` for
//     four rounds; the transcripts below are those lines, copied from real runs.
//   - a healthy run stays `ran` (the control — without it the class above would match
//     everything and the green table would be gone instead of fixed).
//   - a refusal is still `refused-by-name` and a missing display is still
//     `needs-display`, in that order of specificity.
//   - the backend column reads the **artifact**, not the request: a `promise` build and a
//     `fiber` build of the same fixture are told apart, and a guest with neither section
//     is `continuation` (absence means continuation — the host's own rule).
//
// No compiler, no GPU, no examples: this runs in CI as a plain node step, which is the
// only kind of gate this project has managed to keep green.

import { strict as assert } from 'node:assert';
import { classify, declaredBackend, guestFailure } from './lib/census-classify.mjs';

/// A real transcript from `examples/ogre/hello-mesh` on the fiber backend, trimmed to the
/// lines that decided it. It exited **0**.
const OGRE_EMPTY = `
2026-11-28T01:11:31.807Z INFO  res: mounted "resources/" from ...assets.tns (mount 0)
2026-11-28T01:11:31.807Z INFO  ogre: ogre: adopted the session's mount "resources/" (9728 bytes)
2026-11-28T01:11:31.807Z ERROR core: game aborted: resources/models/Barrel.mesh did not load (errno -5) (in game.ten, line 34, col 3)
`;

/// A real transcript from the same example on the backend it declares, for contrast.
const OGRE_OK = `
2026-11-27T01:08:50.244Z INFO  res: mounted "resources/" from ...assets.tns (mount 0)
rendered 341 frames, 240 non-background pixels, mean rgb 229/51/51
2026-11-27T01:08:58.970Z INFO  session: session_close() -> 0
`;

/// The flat-log shape the census sees for a plain example.
const PLAIN_OK = `
=== TensionCore demo game ===
Arguments passed to the game:
  count = 3
  arg[0] = "alpha"
`;

const REFUSED = `
tension-core: this guest requires \`stack-switching\` (it declares backend \`continuation\` …)
tension-core: … refusing by name, nothing was run
`;

const NO_DISPLAY = `
Error: could not initialize SDL: no available video device
`;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${String(error.message).split('\n').join('\n     ')}`);
  }
}

check('a guest that failed and exited 0 is ran-but-failed, not ran', () => {
  assert.equal(classify(0, false, OGRE_EMPTY), 'ran-but-failed');
});

check('the failure line quoted is the guest\'s own, not the last log line', () => {
  const line = guestFailure(OGRE_EMPTY);
  assert.ok(line && line.includes('Barrel.mesh did not load'), `quoted: ${line}`);
});

check('a healthy run stays ran (the control)', () => {
  assert.equal(classify(0, false, OGRE_OK), 'ran');
  assert.equal(classify(0, false, PLAIN_OK), 'ran');
});

check('a timeout is hung whatever the output says', () => {
  assert.equal(classify(null, true, OGRE_EMPTY), 'hung');
});

check('a refusal is refused-by-name, and beats a display word in the same text', () => {
  assert.equal(classify(1, false, REFUSED), 'refused-by-name');
  assert.equal(classify(1, false, `${NO_DISPLAY}\n… refusing by name`), 'refused-by-name');
});

check('a missing display is needs-display', () => {
  assert.equal(classify(1, false, NO_DISPLAY), 'needs-display');
});

check('a bare assertion failure at exit 0 is ran-but-failed', () => {
  assert.equal(classify(0, false, 'platform: FAIL the host never applied the resize'), 'ran-but-failed');
});

check('a missing tool named with its install line is a refusal', () => {
  const gnuplot = 'gnuplot not found. Install it:\n  Windows:  winget install gnuplot\n';
  assert.equal(classify(1, false, gnuplot), 'refused-by-name');
});

check('a crash that names no refusal is failed, not refused-by-name', () => {
  const crash = "ERROR core: game aborted: Unexpected 'null' (not assigned or failed cast) (in ~lib/task.ts, line 405, col 12)";
  assert.equal(classify(1, false, crash), 'failed');
});

check('the backend is read from the artifact, not the request', () => {
  assert.equal(declaredBackend(Buffer.from('\x00backend=fiber\ntarget=portable\n')), 'fiber');
  assert.equal(declaredBackend('backend=promise\ntarget=portable\n'), 'promise');
  assert.equal(declaredBackend('backend=continuation\ntarget=linux-only\n'), 'continuation');
});

check('an artifact with no backend section is continuation (the host\'s rule)', () => {
  assert.equal(declaredBackend(Buffer.from('\x00asm\x01\x00\x00\x00')), 'continuation');
  assert.equal(declaredBackend(null), 'continuation');
});

if (failures) {
  console.error(`\ncensus classifier: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\ncensus classifier: every check passed');
