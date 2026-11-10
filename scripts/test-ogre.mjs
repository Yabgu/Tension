#!/usr/bin/env node
// tension-ogre test runner — the hello-window gate.
//
// Builds the adapter (`backend=ogre` by default), compiles the guest fixtures
// with the framework's own generated flags, packs the fixtures' shared volume,
// and runs the cases:
//
//   headless      renderer=null     the CI gate: a real NULL render system, a
//                                   real window object, no display needed
//   no-display    renderer=gl3plus  DISPLAY unset: the caught-exception path
//   vulkan        renderer=vulkan   a renderer this build cannot provide
//   shutdown-only ogre::shutdown before any init
//   windowed      renderer=gl3plus  opt-in, opens a real window:
//                                   TENSION_OGRE_WINDOW_TEST=1 npm test
//
// Every case must exit 0: the guest is expected to handle its own failures
// (`--expect-fail`) and say so on stdout, so a non-zero exit here is the bug.
//
// Usage: node scripts/test-ogre.mjs

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { REPO, WIN, npmBin } from './lib/toolchain.mjs';
import { fail, indent, inherit, spawn } from './lib/proc.mjs';

const repo = REPO;
const suite = join(repo, 'tension-ogre');
const framework = join(repo, 'tension-framework');
const out = join(suite, 'build');
const RUNNER = 'tension-ogre tests';

const core = process.env.TENSION_CORE ??
  join(repo, 'tension-core', 'target', 'debug', `tension-core${WIN ? '.exe' : ''}`);
const dso = process.env.TENSION_OGRE_DSO ??
  join(out, WIN ? 'libtension_ogre.dll' : 'libtension_ogre.so');

if (!existsSync(core)) {
  fail(RUNNER, 'the interpreter is not built. Run:\n' +
               '    cargo build --manifest-path tension-core/Cargo.toml --no-default-features');
}

// ── the adapter ────────────────────────────────────────────────────────────
process.env.TENSION_OGRE_BACKEND ??= 'ogre';
if (!existsSync(dso)) {
  console.log(`${RUNNER}: building the adapter…`);
  const built = inherit(process.execPath, [join(repo, 'scripts', 'build-ogre.mjs')]);
  if (built.status !== 0) fail(RUNNER, 'the adapter did not build');
}
if (!existsSync(dso)) fail(RUNNER, `${dso} is missing`);

mkdirSync(out, { recursive: true });

// The adapter's directory carries Ogre's DLLs beside it (the CMake post-build
// step stages them there). Windows resolves imports through PATH, so that
// directory has to be on it before the host loads the capability. On Unix the
// adapter's RPATH covers the in-tree install, but a missing or old RPATH should
// not turn into a confusing loader error, so the directories are named as well —
// the same thing the shell runner did with LD_LIBRARY_PATH.
const libDirs = [
  out,
  join(repo, 'third_party', 'ogre-next-install', 'lib'),
].filter(existsSync);

if (WIN) {
  process.env.PATH = `${[out, ...libDirs].join(delimiter)}${delimiter}${process.env.PATH ?? ''}`;
} else if (libDirs.length) {
  const existing = process.env.LD_LIBRARY_PATH;
  process.env.LD_LIBRARY_PATH = existing
    ? `${libDirs.join(delimiter)}${delimiter}${existing}`
    : libDirs.join(delimiter);
}

/// Fixtures and cases run through `spawn`, which reads `baseEnv()` — so the
/// PATH/LD_LIBRARY_PATH changes above are only visible to this process, not to
/// the hosts it starts. This keeps the two in step.
function envWithOgreLibs() {
  return WIN
    ? { PATH: process.env.PATH }
    : { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
}

const guestEnv = envWithOgreLibs();

// ── the guest's flags come from the framework's generator ────────────────
// One source of truth for the memory relation: the same session.asconfig.json
// every other guest is compiled with, regenerated against this interpreter's
// layout hash.
//
// `TENSION_SESSION_READY=1` means `scripts/test.mjs` generated it once before
// starting the suites; running this script alone generates it here.
if (process.env.TENSION_SESSION_READY === '1') {
  console.log('==> using the session constants the runner generated');
} else {
  const hash = spawn(core, ['layout-hash']).stdout.trim();
  const generated = inherit(process.execPath,
                            [join(repo, 'scripts', 'gen-session.mjs'), '--hash', hash]);
  if (generated.status !== 0) {
    fail(RUNNER, `the framework's generator refused the layout hash (${hash})`);
  }
}

const asc = npmBin(framework, 'tensionscript');
if (!existsSync(asc)) fail(RUNNER, 'tensionscript is not installed in tension-framework/node_modules');
const asconfig = join(framework, 'build', 'session.asconfig.json');

/// Every fixture the suite compiles, in the order the shell runner compiled them.
const FIXTURES = [
  'guest-window', 'guest-jobs', 'guest-async', 'guest-resource-async',
  'guest-triangle', 'guest-motion', 'guest-hierarchy', 'guest-skinning',
  'guest-skin-matrices', 'guest-skin-deform', 'guest-skin-noskel',
  'guest-render-check', 'guest-procedural', 'guest-physics', 'guest-angular',
  'guest-light', 'guest-resource-errors',
];

for (const name of FIXTURES) {
  const result = spawn(asc, [join(suite, 'tests', `${name}.ts`),
                             '--config', asconfig,
                             '-o', join(out, `${name}.wasm`)]);
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    fail(RUNNER, `${name}.ts did not compile`);
  }
}

// One volume for everything the fixtures load (chunk 11): they share
// tests/resources, and every case below hands the path in as the guest's own
// `--tns=` argument. And one volume that is deliberately not shared:
// resources-noskel holds the mesh without its .skeleton (chunk 19, 19e-b).
for (const [input, output] of [
  ['resources', 'fixtures.tns'],
  ['resources-noskel', 'fixtures-noskel.tns'],
]) {
  const packed = spawn(process.execPath, [
    join(repo, 'scripts', 'pack-volume.mjs'),
    join(suite, 'tests', input),
    join(out, output),
  ]);
  if (packed.status !== 0) {
    process.stderr.write(packed.stdout + packed.stderr);
    fail(RUNNER, `the ${input} volume did not pack`);
  }
}

const tns = `--tns=${join(out, 'fixtures.tns')}`;
const tnsNoskel = `--tns=${join(out, 'fixtures-noskel.tns')}`;

/// Run the interpreter against the adapter and one guest, capturing output.
function runGuest(wasm, args = [], options = {}) {
  return spawn(core, ['--capability', dso, join(out, wasm), ...args],
               { env: { ...guestEnv, ...(options.env ?? {}) }, ...options });
}

/// `case <name> <expected-stdout-regex> <expected-stderr-substring-or-empty>`
function caseRun(name, wasm, wantOut, wantErr, args = [], options = {}) {
  const result = runGuest(wasm, args, options);
  if (result.status !== 0) {
    fail(RUNNER, `${name}: the interpreter exited ${result.status} (stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
  }
  if (!new RegExp(wantOut, 'm').test(result.stdout)) {
    fail(RUNNER, `${name}: stdout has no /${wantOut}/ (got: ${result.stdout.trim()})`);
  }
  if (wantErr && !new RegExp(wantErr).test(result.stderr)) {
    fail(RUNNER, `${name}: stderr has no /${wantErr}/`);
  }
  console.log(`== ${name}: ok — ${result.stdout.trim().split('\n').pop()}`);
  return result;
}

/// The ACID fixtures: the guest asserts its own clauses and prints a summary
/// line matching `acid`; extra `report` lines are echoed for the round's notes.
function acidCase(name, wasm, acid, args = [], report = null) {
  const result = runGuest(wasm, args);
  if (result.status !== 0) {
    console.log(indent(result.stdout));
    fail(RUNNER, `${name}: the interpreter exited ${result.status} (stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
  }
  if (!new RegExp(acid, 'm').test(result.stdout)) {
    fail(RUNNER, `${name}: no passing ACID line (got: ${result.stdout.trim().split('\n').slice(-2).join(' | ')})`);
  }
  const line = result.stdout.split(/\r?\n/).filter((l) => /^ACID /.test(l)).pop();
  console.log(`== ${name}: ok — ${line}`);
  if (report) {
    for (const entry of result.stdout.split(/\r?\n/)) {
      if (new RegExp(report).test(entry)) console.log(`== ${name}: ${entry}`);
    }
  }
  return result;
}

// ── the cases ──────────────────────────────────────────────────────────────

caseRun('headless', 'guest-window.wasm', '^OK ', 'window "Tension" 1280x720 created',
        ['--renderer=null', '--frames=3']);

// `headless` is a promise, not a decoration. With an explicit GPU renderer this
// build cannot keep it — there is no offscreen render target, and every GPU
// render system is brought up through createRenderWindow — so init refuses
// synchronously with -EINVAL rather than opening the window the guest asked not
// to have. The guest sees the errno; no thread, no window, no plugin load.
caseRun('headless-refused', 'guest-window.wasm', '^OK init-refused -22$',
        'headless=1 with an explicit renderer', ['--renderer=gl3plus', '--headless',
                                                 '--expect-init-refusal=-22']);

// ── target: where the frame goes ──────────────────────────────────────────
//
// The key is engine-agnostic: these three cases pin the contract, not an Ogre
// feature. `auto` is sent explicitly here (rather than omitted) so the case
// proves the key decodes end-to-end; an omitted key is covered by every case
// above, all of which are auto by default.
caseRun('target-auto', 'guest-window.wasm', '^OK ', 'window "Tension" 1280x720 created',
        ['--renderer=null', '--target=auto', '--frames=3']);

// `swapchain` is a requirement, not a preference. This host published no
// surface (the guest never called `createWindow`), so init refuses -ENODEV
// before a thread exists rather than making a window of its own — `auto` would
// now refuse identically. The case needs no GPU and no display: the refusal
// lands before any plugin load.
caseRun('target-swapchain-refused', 'guest-window.wasm', '^OK init-refused -19$',
        'target=swapchain requires the host\'s surface',
        ['--renderer=gl3plus', '--target=swapchain', '--expect-init-refusal=-19']);

// `offscreen` resolves to the NULL render system: no window, and on this
// backend no image (`known-limitations.md`, "No offscreen GPU render path").
// The log line is the evidence that the value reached the backend, not just the
// decoder.
caseRun('target-offscreen', 'guest-window.wasm', '^OK ',
        'target=offscreen — the NULL render system',
        ['--renderer=null', '--target=offscreen', '--frames=3']);

// A fourth target value is a refusal, not a default: the guest read a header
// this adapter does not implement.
caseRun('target-unknown-refused', 'guest-window.wasm', '^OK init-refused -22$',
        '0\.\.2 are the target ids',
        ['--renderer=null', '--target=3', '--expect-init-refusal=-22']);

// ── target=swapchain against a real host window ───────────────────────────
//
// The case above proves the refusal; this one proves the adoption: the *guest*
// creates the window (`--create-window`, target=vulkan) and the host publishes
// the VkInstance / VkSurfaceKHR inside that call, so the renderer that inits
// next adopts them instead of making a window of its own. It needs a
// display and a Vulkan stack that can make a surface and a swapchain; pipeline
// creation is *not* required, because guest-window draws nothing.
//
// Measured on this rig (WSL2, Mesa `dzn`, 2026-11-09): PASS — Ogre logged
// "rendering into the host's surface", created no window of its own, and ran
// frames. Skips on a headless machine, and skips when TENSION_TEST_ALLOW_SKIP=1
// says a missing GPU environment is acceptable — stating what would have run.
{
  const hasDisplay = WIN || process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  const skipAllowed = process.env.TENSION_TEST_ALLOW_SKIP === '1';
  if (!hasDisplay || skipAllowed) {
    console.log('== target-swapchain-window: SKIP — ' +
                (!hasDisplay ? 'no DISPLAY or WAYLAND_DISPLAY: a host window cannot be opened'
                             : 'TENSION_TEST_ALLOW_SKIP=1') +
                '; would run: guest --create-window with --renderer=vulkan ' +
                '--target=swapchain, asserting OK and that the renderer adopted the host surface');
  } else {
    // The guest creates the window itself (`--create-window`, target=vulkan)
    // and the renderer adopts it: no host flag, which is the point of E1a.
    const result = spawn(core, ['--capability', dso,
                                join(out, 'guest-window.wasm'),
                                '--renderer=vulkan', '--target=swapchain',
                                '--create-window', '--frames=3', '--window-width=640',
                                '--window-height=360'],
                         { env: guestEnv });
    if (result.status !== 0) {
      fail(RUNNER, `target-swapchain-window: the interpreter exited ${result.status} ` +
                   `(stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
    }
    if (!/^OK /m.test(result.stdout)) {
      fail(RUNNER, `target-swapchain-window: no OK line (got: ${result.stdout.trim()})`);
    }
    if (!/rendering into the host's surface/.test(result.stderr)) {
      fail(RUNNER, 'target-swapchain-window: the renderer did not report adopting the ' +
                   "host's surface");
    }
    console.log(`== target-swapchain-window: ok — ${result.stdout.trim().split(/\r?\n/).pop()}`);
  }
}

// No display at all: GL3+ throws on the X connection, the backend catches it,
// and the guest is told which stage failed. Before the catch this aborted the
// process with a core dump (`docs/modules/ogre.md` §8).
//
// The scenario is X11-shaped: on Windows there is no DISPLAY to unset, and the
// GL3+ plugin opens a WGL window instead of throwing, so the case cannot be
// reproduced there. It is reported as a skip naming the reason rather than
// silently dropped.
if (WIN) {
  console.log('== no-display: SKIP — no DISPLAY to unset on Windows; GL3+ uses WGL');
  console.log('== vulkan: SKIP — the no-display path this case exercises is X11-only');
} else {
  {
    // With no display, the *window* is what fails first now: the guest asks for
    // one, the host refuses, and no renderer is ever initialised. Before E1a
    // this case reached the GL3+ plugin and caught it throwing on the X
    // connection; that path still exists, but the reachable no-display scenario
    // is the earlier, cleaner refusal — and asserting it is what says a
    // display-less machine gets a named error rather than a crash.
    const result = runGuest('guest-window.wasm',
                            ['--renderer=gl3plus', '--create-window', '--expect-no-display'],
                            { env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined } });
    if (result.status !== 0) {
      fail(RUNNER, `no-display: the interpreter exited ${result.status} (stderr: ${result.stderr.trim()})`);
    }
    if (!/^OK no-window$/m.test(result.stdout)) {
      fail(RUNNER, `no-display: expected 'OK no-window', got: ${result.stdout.trim()}`);
    }
    if (!/No available video device|Couldn.t open X display|window/i.test(result.stderr)) {
      fail(RUNNER, 'no-display: the diagnostic does not name the failure');
    }
    console.log(`== no-display: ok — ${result.stdout.trim()}`);
  }

  {
    // Vulkan, no display. Kept behind an opt-in because it is the one case whose
    // outcome is decided by the machine's Vulkan stack rather than by this tree:
    // measured on WSL2 (2026-11-05, software `dzn` driver), the plugin refuses
    // with the expected -EIO and then the process segfaults inside Ogre's
    // VulkanXcbSupport. On a machine with a conformant Vulkan ICD the case runs
    // as written. Skipped rather than removed, and skipped rather than loosened
    // to accept a crash.
    if (process.env.TENSION_OGRE_VULKAN_TEST !== '1') {
      console.log('== vulkan: skipped — set TENSION_OGRE_VULKAN_TEST=1 to exercise the ' +
                  'no-display Vulkan refusal (needs a conformant Vulkan ICD)');
    } else {
      const result = runGuest('guest-window.wasm',
                              ['--renderer=vulkan', '--expect-fail'],
                              { env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined } });
      if (result.status !== 0) {
        fail(RUNNER, `vulkan: the interpreter exited ${result.status} (stderr: ${result.stderr.trim()})`);
      }
      if (!/^FAIL 0 -5/m.test(result.stdout)) {
        fail(RUNNER, `vulkan: expected 'FAIL 0 -5' (no display: the plugin's XCB support refuses), got: ${result.stdout.trim()}`);
      }
      if (!/vulkan|resolution|display/i.test(result.stderr)) {
        fail(RUNNER, 'vulkan: the diagnostic does not name the failure');
      }
      console.log(`== vulkan: ok — ${result.stdout.trim()}`);
    }
  }
}

// The 3a acid test: jobs, resources, release and reuse — the guest asserts its
// own results and prints one summary line.
acidCase('jobs', 'guest-jobs.wasm', '^ACID 5/5 passed', [tns, '--renderer=null']);

// The four negative controls of the awaitable resource API. Cases 1, 3 and 4 run
// in one process; the drop case runs in its own, because the OGRE adapter is a
// singleton and `shutdown()` does not make `init` legal again.
acidCase('resource-async', 'guest-resource-async.wasm', '^RESASYNC PASS',
         [tns, '--renderer=null']);
acidCase('resource-async-drop', 'guest-resource-async.wasm', '^RESASYNC PASS',
         [tns, '--resasync-case=drop']);

// Error propagation: what a guest can learn when a resource cannot load.
acidCase('resource-errors', 'guest-resource-errors.wasm', '^OK$',
         [tns, '--renderer=null'], '^RESERR ');

// The renderer is gone: the render thread failed to start (an unknown
// TENSION_RENDERER), so no job can ever be realised again. A load queued after
// that failure must come back FAILED/-EIO rather than sit in PENDING — the case
// that used to leave the guest, and the executable, waiting forever.
{
  const result = runGuest('guest-resource-errors.wasm',
                          [tns, '--renderer=gl3plus', '--dead-renderer'],
                          { env: { TENSION_RENDERER: 'bogus' } });
  if (result.status !== 0) {
    fail(RUNNER, `resource-errors-dead: the interpreter exited ${result.status} (stderr: ${result.stderr.trim()})`);
  }
  if (!/^RESERR 1 dead-renderer -5/m.test(result.stdout)) {
    fail(RUNNER, `resource-errors-dead: no 'RESERR 1 dead-renderer -5' (got: ${result.stdout.trim()})`);
  }
  console.log(`== resource-errors-dead: ok — ${result.stdout.split(/\r?\n/).filter((l) => /^RESERR /.test(l)).pop()}`);
}

// The 3b acid test: the scene mirror, the submission verbs, and — where there is
// a framebuffer — the pixels. Under renderer=null the first five clauses run and
// the pixel clauses are skipped; under GL3+ all eight do.
acidCase('triangle', 'guest-triangle.wasm',
         '^ACID (5/5 passed \\(structural, renderer=null\\)|8/8 passed)',
         [tns, '--renderer=null'], '^pixels: ');

// The chunk-4 acid test: a solver steps once per renderer frame and drives the
// bodies through one submit_motion call per frame.
acidCase('motion', 'guest-motion.wasm',
         '^ACID (5/5 passed \\(structural, renderer=null\\)|10/10 passed)',
         [tns, '--renderer=null'], '^(baseline|final|report):');

// Chunk 5a: a child follows its parent. The adapter composes nothing — OGRE's
// scene graph does — and the pixels are what says so.
acidCase('hierarchy', 'guest-hierarchy.wasm',
         '^ACID (5/5 passed \\(structural, renderer=null\\)|8/8 passed)',
         [tns, '--renderer=null'], '^(baseline|after):');

// Chunk 5b: a rigged mesh deforms because its bone was posed. Nothing in the
// fixture submits motion — that is what makes the pixels a claim about skinning
// rather than about a moving object.
acidCase('skinning', 'guest-skinning.wasm',
         '^ACID (6/6 passed \\(structural, renderer=null\\)|10/10 passed)',
         [tns, '--renderer=null'], '^(baseline|final|report):');

// The render tripwire (post-chunk-5 audit): every material kind must still put
// pixels on the screen, in its own colour. A material path that stops drawing is
// loud here — in a skinned test it would only look like a rig that did not move,
// which is exactly how a missing Hlms folder hid for two chunks.
acidCase('render-check', 'guest-render-check.wasm',
         '^ACID (4/4 passed \\(structural, renderer=null\\)|6/6 passed)',
         [tns, '--renderer=null'], '^(unlit|pbs):');

// Chunk 5.5: a mesh built out of the guest's own memory, with no file involved.
acidCase('procedural', 'guest-procedural.wasm',
         '^ACID (5/5 passed \\(structural, renderer=null\\)|6/6 passed)',
         ['--renderer=null'], '^triangle:');

// Chunk 6: sixteen spheres in a box, and the state they settle into.
acidCase('physics', 'guest-physics.wasm',
         '^ACID (9/9 passed \\(structural, renderer=null\\)|12/12 passed)',
         [tns, '--renderer=null'], '^(2 ok|7 ok|9 ok):');

acidCase('angular', 'guest-angular.wasm',
         '^ACID (8/8 passed \\(structural, renderer=null\\)|11/11 passed)',
         [tns, '--renderer=null'], '^(2 ok|5 ok|7 ok|8 ok|11 ok):');

// Chunk 10: one directional light through the guest's submitLight, shading a PBS
// surface while an emissive-only surface and an Unlit one in the same frame must
// not move.
{
  const result = acidCase('light', 'guest-light.wasm',
                          '^ACID (4/4 passed \\(structural, renderer=null\\)|9/9 passed)',
                          [tns, '--renderer=null'],
                          '^(3 ok|5 ok|5 band|6 ok|7 ok|8 ok|9 ok):');
  // The adapter's own refusals go to the session log: a light the apply path
  // could not realise is a refusal line, and no case may pass with one.
  if (/refused/.test(result.stderr)) {
    fail(RUNNER, `light: the adapter refused something: ${result.stderr.split(/\r?\n/).find((l) => l.includes('refused'))}`);
  }
}

caseRun('shutdown-only', 'guest-window.wasm', '^OK shutdown-before-init', '', ['--shutdown-only']);

// 4e-2's NC3 control: a completion the ring had no room for is counted, and the
// task parked on that family wakes with -EIO instead of hanging (§6.4). A setup
// the environment cannot provide is printed as ASYNC SKIP and reported as a skip
// — never as a pass.
{
  const result = runGuest('guest-async.wasm',
                          [tns, '--renderer=null', '--async-case=drop']);
  if (result.status !== 0) {
    console.log(indent(result.stdout));
    fail(RUNNER, `async-drop: the interpreter exited ${result.status} (stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
  }
  console.log(indent(result.stdout));
  const pass = result.stdout.split(/\r?\n/).find((l) => l === 'ASYNC PASS drop');
  const skipLine = result.stdout.split(/\r?\n/).find((l) => l.startsWith('ASYNC SKIP drop-setup: '));
  if (pass) {
    console.log(`== async-drop: ok — ${pass}`);
  } else if (skipLine) {
    console.log(`== async-drop: SKIP — ${skipLine}`);
  } else {
    fail(RUNNER, `async-drop: neither 'ASYNC PASS drop' nor 'ASYNC SKIP drop-setup' ` +
                 `(got: ${result.stdout.trim().split('\n').slice(-3).join(' | ')})`);
  }
}

// ── windowed, opt-in ───────────────────────────────────────────────────────
//
// Chunk 19c and 19g and 19e are windowed-only: their clauses are pixel clauses,
// and the NULL renderer has no framebuffer to download.
const windowed = process.env.TENSION_OGRE_WINDOW_TEST === '1';
if (!windowed) {
  console.log('== windowed: skipped — set TENSION_OGRE_WINDOW_TEST=1 to open a real window');
  console.log('== skin-matrices: skipped — set TENSION_OGRE_WINDOW_TEST=1 (pixel clauses need a window)');
  console.log('== noskel: skipped — set TENSION_OGRE_WINDOW_TEST=1 (pixel clauses need a window)');
} else if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !WIN) {
  console.log('== windowed: skipped — TENSION_OGRE_WINDOW_TEST=1 but no DISPLAY or WAYLAND_DISPLAY');
} else {
  // The expected-stderr regex matches a *substring* of the adapter's
  // created-window line, so it is unanchored. Two defects were in this literal
  // until now: the group was unterminated, which made `new RegExp` throw inside
  // `caseRun` and killed the whole block before its second case; and the
  // literal parentheses around the renderer name were unescaped, so even a
  // terminated group would not have matched `created (OpenGL 3+ ...)`. The
  // renderer name is the only part that varies — the size in that line is
  // whatever the display gives us, so it is deliberately not matched.
  caseRun('windowed', 'guest-window.wasm', '^OK ',
          'created \\((OpenGL 3\\+ Rendering Subsystem|Vulkan Rendering Subsystem)\\)',
          ['--renderer=gl3plus', '--frames=5']);

  acidCase('jobs-gl3plus', 'guest-jobs.wasm', '^ACID 5/5 passed',
           [tns, '--renderer=gl3plus']);
  acidCase('resource-errors-gl3plus', 'guest-resource-errors.wasm', '^OK$',
           [tns, '--renderer=gl3plus'], '^RESERR ');
  acidCase('triangle-gl3plus', 'guest-triangle.wasm', '^ACID 8/8 passed',
           [tns, '--renderer=gl3plus'], '^pixels: ');
  // Chunk 4: one body for the pixel clauses, then sixty-four for the batch's own
  // numbers — the same assertions at both sizes.
  acidCase('motion-gl3plus', 'guest-motion.wasm', '^ACID 10/10 passed',
           [tns, '--renderer=gl3plus', '--bodies=1'], '^(baseline|final|report):');
  acidCase('motion-throughput', 'guest-motion.wasm', '^ACID 10/10 passed',
           [tns, '--renderer=gl3plus', '--bodies=64'], '^(baseline|final|report):');
  acidCase('hierarchy-gl3plus', 'guest-hierarchy.wasm', '^ACID 8/8 passed',
           [tns, '--renderer=gl3plus'], '^(baseline|after):');
  acidCase('skinning-gl3plus', 'guest-skinning.wasm', '^ACID 10/10 passed',
           [tns, '--renderer=gl3plus'], '^(baseline|final|report):');
  acidCase('render-check-gl3plus', 'guest-render-check.wasm', '^ACID 6/6 passed',
           [tns, '--renderer=gl3plus'], '^(unlit|pbs):');
  acidCase('procedural-gl3plus', 'guest-procedural.wasm', '^ACID 6/6 passed',
           ['--renderer=gl3plus'], '^triangle:');
  acidCase('physics-gl3plus', 'guest-physics.wasm', '^ACID 12/12 passed',
           [tns, '--renderer=gl3plus'], '^(2 ok|7 ok|9 ok):');
  acidCase('angular-gl3plus', 'guest-angular.wasm', '^ACID 11/11 passed',
           [tns, '--renderer=gl3plus'], '^(2 ok|5 ok|7 ok|8 ok|11 ok):');
  acidCase('light-gl3plus', 'guest-light.wasm', '^ACID 9/9 passed',
           [tns, '--renderer=gl3plus'], '^(3 ok|5 ok|5 band|6 ok|7 ok|8 ok|9 ok):');

  // The pixel-clause fixtures: they print OK and a marker line rather than an
  // ACID summary.
  //
  // **These `*-gl3plus` cases open two windows, and only the second is used.**
  // The guest creates the host's Vulkan window (host-window.ts) and GL3+ creates
  // its own GLX window, because the GL3+ plugin cannot consume a
  // `VkSurfaceKHR`; the pixel clauses screenshot GL3+'s. What that means for
  // what these cases prove: they test GL3+'s own-window rendering, not the
  // host-surface path. The one-window proof for the external-surface path is
  // `target-swapchain-window` (Vulkan, `--create-window`), not these.
  //
  // Removing the unused host window needs two changes, and the second is
  // blocked: skipping it in `ensureHostWindow` makes `ogre::init` refuse
  // `-ENODEV` (the adapter's `target=auto` check is renderer-agnostic), and
  // narrowing that check to Vulkan re-exposes a SIGSEGV in GL3+ teardown — the
  // WSL D3D12 driver (`libd3d12core`/`amdxc64`) being unmapped while a thread it
  // spawned is still running. Both are measured, with the run counts and the
  // experiment that localises the fault, in `tension-ogre/tests/host-window.ts`.
  for (const [name, wasm, marker, args] of [
    ['skin-matrices', 'guest-skin-matrices.wasm', '^MATRICES ', [tns, '--renderer=gl3plus']],
    ['skin-deform', 'guest-skin-deform.wasm', '^DEFORM ', [tns, '--renderer=gl3plus']],
    ['noskel-matrix', 'guest-skin-noskel.wasm', '^NOSKEL ', [tnsNoskel, '--renderer=gl3plus']],
    ['noskel-stump', 'guest-skin-noskel.wasm', '^NOSKEL ', [tnsNoskel, '--renderer=gl3plus', '--mode=stump']],
  ]) {
    const result = runGuest(wasm, args);
    if (result.status !== 0) {
      console.log(indent(result.stdout));
      fail(RUNNER, `${name}: the interpreter exited ${result.status} (stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
    }
    if (!/^OK$/m.test(result.stdout)) {
      fail(RUNNER, `${name}: no OK line (got: ${result.stdout.trim().split('\n').slice(-2).join(' | ')})`);
    }
    const line = result.stdout.split(/\r?\n/).filter((l) => new RegExp(marker).test(l)).pop();
    console.log(`== ${name}: ok — ${line ?? ''}`);
  }
}

console.log('tension-ogre tests: all cases passed');
