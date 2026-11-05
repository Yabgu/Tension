#!/usr/bin/env node
// Build the interpreter and three examples, then run them against fixed input.
//
// The point is a scripted smoke run with no windows: io, audio and ai, each fed
// the same arguments every time, so "did the demo still work" is one command and
// one exit code.
//
// The ai example is the one piece that depends on more than the repository: it
// needs a GGUF model, and `ai` is a default cargo feature — a plain build links
// vendored llama.cpp (a one-time ~2 minute C++ build needing cmake and a C++
// compiler), and with the model absent the example cannot answer from it. This
// builds with the default features when the model and the toolchain are both
// present, and otherwise builds `--no-default-features --features audio` so the
// demo runs on the host's deterministic headless adapter, saying so — an
// ai-enabled interpreter with no model is exactly how "the ai example does not
// reply" happens.
//
// Usage: npm run demo

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, which } from './lib/toolchain.mjs';
import { fail, inherit, spawn } from './lib/proc.mjs';

const repo = REPO;
const RUNNER = 'demo';
const host = join(repo, 'tension-core', 'target', 'debug', `tension-core${WIN ? '.exe' : ''}`);
const model = process.env.MODEL ?? join('examples', 'ai', 'models', 'Phi-3-mini-4k-instruct-q4.gguf');

/// Install an example's dependencies and build its guest.
function buildExample(dir) {
  const wired = existsSync(join(repo, dir, 'node_modules', '@yabgu_gm', 'tensionscript')) ||
                existsSync(join(repo, dir, 'node_modules', '.bin', WIN ? 'tensionscript.cmd' : 'tensionscript'));
  if (!wired) {
    console.log(`==> installing ${dir} deps (tensionscript + tension-framework)`);
    // The ai example's postinstall fetches ~2.3 GB of weights; a demo run must
    // not start that behind your back. `npm install` inside examples/ai does.
    inherit('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: join(repo, dir),
      env: { TENSION_SKIP_MODEL_FETCH: '1' },
    });
  }
  console.log(`==> building the ${dir.replace(/^examples\//, '')} example`);
  const built = inherit('npm', ['run', 'build'], { cwd: join(repo, dir) });
  if (built.status !== 0) fail(RUNNER, `${dir}: build failed`);
}

/// Run the host with a guest and fixed stdin, echoing what it printed.
///
/// `spawn` captures both streams, so the output is printed here rather than
/// streamed: the demo's whole point is a short, comparable transcript, and
/// interleaving live stderr makes two runs hard to diff.
function runGuest(wasm, args, stdin) {
  const result = spawn(host, [join(repo, 'examples', wasm), ...args], { cwd: repo, input: stdin });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) fail(RUNNER, `${wasm} exited ${result.status}`);
}

// The ai example runs on the real model only when the gguf file exists AND the
// toolchain can link llama.cpp; anything less keeps the deterministic adapter.
const hasModel = existsSync(join(repo, model));
const canLinkAi = Boolean(which('cmake')) && Boolean(which(WIN ? 'g++' : 'c++'));

console.log('==> building tension-core');
if (hasModel && canLinkAi) {
  console.log('    (default features: `ai` links vendored llama.cpp; one-time ~2 min)');
  if (inherit('cargo', ['build', '--manifest-path', 'tension-core/Cargo.toml']).status !== 0) {
    fail(RUNNER, 'cargo build failed');
  }
} else {
  console.log(`    (headless ai adapter: ${hasModel ? 'no cmake/C++ compiler' : `no ${model}`})`);
  if (inherit('cargo', ['build', '--manifest-path', 'tension-core/Cargo.toml',
                        '--no-default-features', '--features', 'audio']).status !== 0) {
    fail(RUNNER, 'cargo build failed');
  }
}

buildExample('examples/io');
console.log('==> running the io example');
runGuest(join('io', 'build', 'game.wasm'), ['alpha', 'beta', 'gamma'], 'hello from the terminal\n');

buildExample('examples/audio');
console.log('==> running the audio demo (stderr shows the [tension:audio] ABI trace)');
runGuest(join('audio', 'build', 'demo.wasm'), [], '');

buildExample('examples/ai');
if (hasModel && canLinkAi) {
  console.log(`==> running the ai demo (model: ${model})`);
} else {
  console.log('==> running the ai demo (deterministic headless adapter — no model needed;');
  console.log("    fetch weights with 'npm install' in examples/ai for the real thing)");
}
runGuest(join('ai', 'build', 'story.wasm'), [model], 'hello there\n/quit\n');

console.log('demo: all three examples ran');
