#!/usr/bin/env node
// The end-to-end input measurement: a real X server, a real guest, real events.
//
//   node scripts/test-input.mjs --edge          (all three cadences)
//   EDGE_CADENCES=16 node scripts/test-input.mjs --edge
//
// **What this exists to prove.** Before v7 this capability polled SDL on its own
// thread every 2 ms, so motion was accumulated at 2 ms granularity no matter
// what the guest did. Under v7 the host pumps once per guest frame, and the
// question that decides whether the thread could be deleted is: *does a slow
// guest lose motion?* SDL queues the samples, so it should not — but "should" is
// not a gate, and this measures it at three cadences (2, 16 and 33 ms) against a
// known injected displacement.
//
// The interesting quantity is not the event rate, it is the **total**. A guest
// that reads `state()` once per frame accumulates every sample the host handed
// over, so the sum must equal what the device moved, and it must not depend on
// the frame rate. `|dx - D| <= 1 px` at every cadence is the hard gate; a
// failure means the dispatcher needs a raw-motion buffer and this pass stops.
//
// Two soft gates follow, and they are reported rather than asserted because
// neither has a right answer to compare against:
//   latency   how long a key press waits before the guest sees it, per cadence.
//             At a 33 ms pump an idle event can wait most of 33 ms; that is the
//             cost of pumping once per frame, and printing it is the point.
//   overflow  what a burst larger than the 256-event batch does. It is reported
//             because the answer is a contract (rule 13) and a number nobody had.
//
// POSIX/X11-only, and only where XTEST exists: the events have to be real server
// events, so a machine without XTest is a machine where this measurement cannot
// be taken. It says so instead of passing.

import { spawn as spawnAsync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, which } from './lib/toolchain.mjs';
import { fail, inherit, spawn } from './lib/proc.mjs';

const RUNNER = 'tension-input edge';
const CADENCES = (process.env.EDGE_CADENCES ?? '2,16,33').split(',').map((n) => Number(n.trim()));

/// One process and a line feed of what it printed, with the time each line
/// arrived. The arrival time is the clock the latency measurement uses: the
/// guest has no clock of its own (there is no monotonic-time import in the ABI),
/// and a print reaches this process within a fraction of a millisecond.
function startProcess(command, args, env) {
  const child = spawnAsync(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const seen = { lines: [], stderr: '', code: null, signal: null };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      seen.lines.push({ text: line, at: Date.now(), mono: Number(process.hrtime.bigint() / 1000n) });
    }
  });
  child.stderr.on('data', (chunk) => { seen.stderr += chunk; });
  seen.exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      seen.code = code;
      seen.signal = signal;
      resolve();
    });
  });
  return { child, seen };
}

/// Wait for a line starting with `prefix`, or fail with what was printed.
async function waitForLine(seen, prefix, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = seen.lines.find((entry) => entry.text.startsWith(prefix));
    if (line) return line;
    if (seen.code !== null) {
      fail(RUNNER, `${what}: the guest exited ${seen.code} before printing "${prefix}"\n` +
                   `  stdout: ${seen.lines.map((entry) => entry.text).slice(-3).join(' | ')}\n` +
                   `  stderr: ${seen.stderr.trim().split('\n').slice(-2).join(' ')}`);
    }
    if (Date.now() > deadline) {
      fail(RUNNER, `${what}: nothing printed "${prefix}" within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/// Where the guest's window is, and its centre.
///
/// Asked of the window system rather than assumed: with a compositor the window
/// is placed by a policy this repository does not control, and motion events go
/// to whatever the pointer is over. Injecting at the centre of the screen is how
/// a probe measures the root window instead.
function windowCenter() {
  const found = spawn('xdotool', ['search', '--name', '^tension-input$']);
  const id = found.stdout.trim().split('\n').filter(Boolean).pop();
  if (!id) fail(RUNNER, 'the guest window did not appear; nothing to point at');
  const geometry = spawn('xdotool', ['getwindowgeometry', '--shell', id]).stdout;
  const value = (key) => Number(new RegExp(`^${key}=(-?\\d+)$`, 'm').exec(geometry)?.[1]);
  const x = value('X');
  const y = value('Y');
  const width = value('WIDTH');
  const height = value('HEIGHT');
  if (![x, y, width, height].every(Number.isFinite)) {
    fail(RUNNER, `could not read the window's geometry: ${geometry.trim()}`);
  }
  return { id, x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) };
}

/// Give the guest's window the keyboard.
///
/// Motion only needs the pointer over the window; a key event goes to whatever
/// holds the input focus, and a window that was never activated holds nothing.
/// Measured the hard way: 600 injected presses produced zero KEY records until
/// this ran, with the motion measurement working throughout.
function focusWindow(id) {
  spawn('xdotool', ['windowactivate', '--sync', id]);
  spawn('xdotool', ['windowfocus', id]);
}

/// Export the harness's own preconditions, once.
function requireHarness(core, dso, guest, injector) {
  if (!existsSync(core)) fail(RUNNER, 'build the interpreter first');
  if (!existsSync(dso) || !existsSync(guest)) {
    fail(RUNNER, 'build the capability first: node scripts/test-input.mjs');
  }
  if (!existsSync(injector)) {
    fail(RUNNER, `the injector is missing (${injector}); the suite builds it`);
  }
  for (const tool of ['xdotool']) {
    if (!which(tool)) fail(RUNNER, `${tool} is required to locate the guest's window`);
  }
}

// ── the hard gate ───────────────────────────────────────────────────────────

async function fidelity(cadence, count, durationMs, dx, dy, core, dso, guest, injector) {
  // Enough frames that the guest outlives the injection: the burst takes
  // `durationMs`, and the guest's own settle window (500 ms of frames) runs
  // before READY, so only the measurement window matters here.
  const frames = Math.max(30, Math.ceil((durationMs + 700) / cadence));
  const run = startProcess(core, ['--capability', dso, guest,
    '--mode=fidelity', `--cadence=${cadence}`, `--frames=${frames}`]);
  await waitForLine(run.seen, 'READY', 30_000, `fidelity@${cadence}ms`);
  const center = windowCenter();
  const injected = startProcess(injector, ['motion', String(count), String(durationMs),
    String(dx), String(dy), String(center.x), String(center.y)]);
  await injected.seen.exited;
  if (injected.seen.code !== 0) {
    fail(RUNNER, `the injector refused: ${injected.seen.stderr.trim()}`);
  }
  await run.seen.exited;
  if (run.seen.code !== 0) {
    fail(RUNNER, `fidelity@${cadence}ms: the guest exited ${run.seen.code}: ` +
                 run.seen.stderr.trim().split('\n').slice(-2).join(' '));
  }
  const line = run.seen.lines.find((entry) => entry.text.startsWith('FIDELITY '));
  if (!line) fail(RUNNER, `fidelity@${cadence}ms: the guest printed no FIDELITY line`);
  const read = (name) => Number(new RegExp(`${name}=(-?[\\d.]+)`).exec(line.text)?.[1]);
  return {
    cadence,
    frames: read('frames'),
    dx: read('dx'),
    dy: read('dy'),
    expected: count * dx,
    expectedY: count * dy,
    count,
  };
}

// ── the soft gates ──────────────────────────────────────────────────────────

async function latency(cadence, pairs, paceUs, core, dso, guest, injector) {
  const frames = Math.max(60, Math.ceil((pairs * paceUs) / 1000 / cadence) + 40);
  const run = startProcess(core, ['--capability', dso, guest,
    '--mode=latency', `--cadence=${cadence}`, `--frames=${frames}`]);
  await waitForLine(run.seen, 'READY', 30_000, `latency@${cadence}ms`);
  const center = windowCenter();
  focusWindow(center.id);
  const injected = startProcess(injector, ['keys', String(pairs), String(paceUs)]);
  const begin = await waitForLine(injected.seen, 'BEGIN', 10_000, 'injector');
  await injected.seen.exited;
  await run.seen.exited;
  if (run.seen.code !== 0) {
    fail(RUNNER, `latency@${cadence}ms: the guest exited ${run.seen.code}`);
  }
  const summary = run.seen.lines.find((entry) => entry.text.startsWith('LATENCY '))?.text ?? '';
  const observed = Number(/keys=(\d+)/.exec(summary)?.[1] ?? '0');
  const framesWithKeys = run.seen.lines.filter((entry) => entry.text.startsWith('FRAME '));
  // Every key edge the guest counted, in order. Two edges per injected pair
  // (press, release), both at the same instant, so edge k was injected at
  // `begin + floor(k / 2) * pace`.
  // Each line carries the guest's *cumulative* edge count, so the new edges in
  // a frame are the ones between the previous line's count and this one's. Two
  // edges per injected pair (press, release), both at the same instant, and the
  // pair's own monotonic time came back on its `K <index> <micros>` line.
  const injectedAt = new Map();
  for (const line of injected.seen.lines) {
    if (!line.text.startsWith('K ')) continue;
    const [, index, micros] = line.text.split(' ');
    injectedAt.set(Number(index), Number(micros));
  }
  const samples = [];
  let previous = 0;
  for (const frame of framesWithKeys) {
    const cumulative = Number(frame.text.split(' ')[2]);
    for (let index = previous; index < cumulative; index++) {
      const micros = injectedAt.get(Math.floor(index / 2));
      if (micros === undefined) continue;
      samples.push((frame.mono - micros) / 1000);
    }
    previous = cumulative;
  }
  samples.sort((a, b) => a - b);
  const pick = (quantile) => samples.length
    ? samples[Math.min(samples.length - 1, Math.floor(quantile * samples.length))]
    : NaN;
  return {
    cadence,
    observed,
    injectedEdges: pairs * 2,
    min: samples.length ? samples[0] : NaN,
    median: pick(0.5),
    p99: pick(0.99),
    max: samples.length ? samples[samples.length - 1] : NaN,
  };
}

async function overflow(cadence, count, core, dso, guest, injector) {
  const frames = Math.max(30, Math.ceil(700 / cadence));
  const run = startProcess(core, ['--capability', dso, guest,
    '--mode=fidelity', `--cadence=${cadence}`, `--frames=${frames}`]);
  await waitForLine(run.seen, 'READY', 30_000, 'overflow');
  const center = windowCenter();
  // duration 0: as fast as the server will take them, which is the burst that
  // overflows a single 256-event batch.
  const injected = startProcess(injector, ['motion', String(count), '0',
    '1', '0', String(center.x), String(center.y)]);
  await injected.seen.exited;
  await run.seen.exited;
  const line = run.seen.lines.find((entry) => entry.text.startsWith('FIDELITY '))?.text ?? '';
  const lost = run.seen.stderr
    .split('\n')
    .filter((entry) => entry.includes('did not fit this pump'))
    .map((entry) => Number(/(\d+) event/.exec(entry)?.[1] ?? 0))
    .reduce((sum, value) => sum + value, 0);
  const delivered = Number(/dx=(-?[\d.]+)/.exec(line)?.[1] ?? '0');
  return { cadence, injected: count, delivered, lost };
}

// ── the run ─────────────────────────────────────────────────────────────────

export async function run() {
  if (WIN) {
    console.log(`${RUNNER}: SKIPPED — the measurement needs XTEST and xdotool`);
    return;
  }
  if (!process.env.DISPLAY) {
    console.log(`${RUNNER}: SKIPPED — no DISPLAY; the events have to be real server events`);
    return;
  }
  if (!which('cc')) fail(RUNNER, 'a C compiler is required to build the XTEST injector');

  const repo = REPO;
  const suite = join(repo, 'tension-input');
  const out = join(suite, 'build');
  const core = process.env.TENSION_CORE ?? join(repo, 'tension-core', 'target', 'debug', 'tension-core');
  const dso = join(out, 'libtension_input.so');
  const guest = join(out, 'guest-input.wasm');

  const built = inherit(process.execPath, [join(repo, 'scripts', 'build-input.mjs')]);
  if (built.status !== 0) fail(RUNNER, 'the DSO did not build');
  const injector = join(out, 'xinject');
  const compiled = inherit('cc', ['-O2', '-o', injector,
    join(suite, 'tests', 'xinject.c'), '-lX11', '-lXtst']);
  if (compiled.status !== 0) {
    console.log(`${RUNNER}: SKIPPED — the XTEST injector did not build ` +
                '(libX11 and libXtst development files are required)');
    return;
  }
  requireHarness(core, dso, guest, injector);

  const MOTION_COUNT = Number(process.env.EDGE_MOTION_COUNT ?? 400);
  const MOTION_MS = Number(process.env.EDGE_MOTION_MS ?? 200);
  const MOTION_DX = 1;

  console.log(`===================================================================
 input fidelity — does a slow guest lose motion?
 ===================================================================
 Injecting ${MOTION_COUNT} relative motion events of ${MOTION_DX} px over ${MOTION_MS} ms
 (total ${MOTION_COUNT * MOTION_DX} px) at three pump cadences. The guest accumulates
 every state record it reads; the sums must agree with the injection.
===================================================================`);

  const fidelityRuns = [];
  for (const cadence of CADENCES) {
    const result = await fidelity(cadence, MOTION_COUNT, MOTION_MS, MOTION_DX, 0,
                                  core, dso, guest, injector);
    fidelityRuns.push(result);
    console.log(`  cadence ${String(cadence).padStart(2)} ms: dx=${result.dx} ` +
                `(injected ${result.expected}) over ${result.frames} frames`);
  }

  let gateFailed = false;
  for (const result of fidelityRuns) {
    const error = Math.abs(result.dx - result.expected);
    if (error > 1) {
      gateFailed = true;
      console.log(`  FAIL cadence ${result.cadence} ms: |${result.dx} - ${result.expected}| = ` +
                  `${error} px > 1`);
    }
  }
  if (gateFailed) {
    // Deliberately fatal. A dispatcher that loses motion at a low frame rate
    // would silently regress every mouse-look game, and the pass that deleted
    // the polling thread must not land on that.
    fail(RUNNER, 'MOTION FIDELITY GATE FAILED — the dispatcher loses motion at low ' +
                 'frame rates; a raw-motion buffer is needed before InputThread can go');
  }
  console.log('  PASS: every cadence reproduced the injected displacement within 1 px');

  console.log(`\n===================================================================
 input latency — how long a key waits for the next pump
 ===================================================================`);
  const latencyRuns = [];
  for (const cadence of CADENCES) {
    const result = await latency(cadence, 300, 5000, core, dso, guest, injector);
    latencyRuns.push(result);
    console.log(`  cadence ${String(cadence).padStart(2)} ms: observed ${result.observed}/` +
                `${result.injectedEdges} edges  min=${fmt(result.min)} ` +
                `median=${fmt(result.median)} p99=${fmt(result.p99)} max=${fmt(result.max)} ms`);
  }
  if (latencyRuns.some((run_) => run_.observed < run_.injectedEdges)) {
    console.log('  note: fewer edges arrived than were injected — the pump window was ' +
                'shorter than the injection, or the server dropped some');
  }

  console.log(`\n===================================================================
 event batch overflow — a burst larger than one batch
 ===================================================================`);
  const overflowRun = await overflow(33, 300, core, dso, guest, injector);
  console.log(`  injected ${overflowRun.injected} events in one burst at a 33 ms cadence: ` +
              `${overflowRun.delivered} px observed, ${overflowRun.lost} event(s) reported ` +
              'as not fitting the batch');
  console.log('  contract (thread rule 13): the batch is delivered whole, the excess is ');
  console.log('  counted and logged, and a layer must coalesce what it needs rather than ');
  console.log('  assume the batch is the whole drain.');

  console.log('\ntension-input edge: fidelity gate passed');
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(1) : 'n/a';
}
