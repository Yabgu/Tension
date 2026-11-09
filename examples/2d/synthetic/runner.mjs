// examples/2d/synthetic/runner.mjs — build and run one synthetic-scene guest.
//
// Shared by `examples/2d/isometric/test-synthetic.mjs` and
// `examples/2d/isometric-framework/test.mjs`. Both do the same four things — emit
// the pages, build the guest, pack, run under a real session — and the framework
// test additionally needs the hand-coded guest's *frames*, not just its exit
// status. Keeping the plumbing here is what lets that comparison happen without
// either runner learning how the other is built.
//
// The frame protocol is the guest's: `FRAME <name> <offset> <hex>` lines, one
// line per 128 bytes, reassembled by offset. It exists because a guest has no
// file writer — see `examples/2d/isometric/src/main.ts`.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emit } from './emit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '..', '..', '..');
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

function findCore() {
  if (process.env.TENSION_CORE && existsSync(process.env.TENSION_CORE)) {
    return process.env.TENSION_CORE;
  }
  for (const profile of ['debug', 'release']) {
    const candidate = join(REPO, 'tension-core', 'target', profile, `tension-core${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.error) return null;
  return result;
}

/**
 * Make `exampleDir` runnable against the synthetic scene. Idempotent, and cheap
 * after the first call except for the pack and the guest compile.
 *
 * Returns the paths a run needs, or throws with the step that failed. Throwing
 * rather than exiting keeps the caller in charge of the message.
 */
export function prepare(exampleDir, { log = console.log } = {}) {
  const s = emit(exampleDir);
  log(`  emitted ${s.pages.map((p) => p.name).join(', ')}`);

  let step = run('node', [join(REPO, 'scripts', 'build-2d-guest.mjs')], { cwd: exampleDir, stdio: 'inherit' });
  if (!step || step.status !== 0) throw new Error('the guest did not build');

  // The renderer is in core since Pass B; the build produces shader modules
  // only. A `--capability` is passed only when a DSO exists (the bisect path).
  const dso = join(REPO, 'tension-2d', 'build', WIN ? 'libtension_2d.dll' : 'libtension_2d.so');
  if (!existsSync(join(REPO, 'tension-2d', 'build', 'shaders', 'default_2d.vert.spv'))) {
    step = run('node', [join(REPO, 'scripts', 'build-2d.mjs')], { cwd: REPO, stdio: 'inherit' });
    if (!step || step.status !== 0) throw new Error('the shader modules did not build');
  }
  const capabilityArgs = existsSync(dso) ? ['--capability', dso] : [];
  const core = findCore();
  if (!core) {
    throw new Error(`no tension-core found\n  Run \`cargo build --manifest-path tension-core/Cargo.toml\`.`);
  }

  step = run('node', [join(REPO, 'scripts', 'pack-example.mjs'), '.'], { cwd: exampleDir, stdio: 'inherit' });
  if (!step || step.status !== 0) throw new Error('packing the synthetic pages failed');

  const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
  const pak = join(exampleDir, pkg.tension?.pack?.output ?? 'build/assets.tns');
  if (!existsSync(pak)) throw new Error(`expected ${pak} after packing`);

  return { scene: s, capabilityArgs, core, pak, guest: join(exampleDir, 'build', 'game.wasm') };
}

/** Run the guest in `ctx` with `guestArgs`; returns its frames and output. */
export function runGuest(ctx, guestArgs = [], { cwd } = {}) {
  const result = run(ctx.core, [
    ...ctx.capabilityArgs,
    '--res', ctx.pak,
    ctx.guest,
    ...guestArgs,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, SDL_VIDEODRIVER: 'offscreen' },
  });
  if (!result) throw new Error('could not start tension-core');

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  // A GPU that cannot create a pipeline stops every 2D guest at `set_pipeline`,
  // so the caller would report "no frames" and send a reader hunting for a
  // renderer bug that is not there. Name the environmental cause here, once,
  // for every caller of this runner.
  const gpu = output.match(/vkCreateGraphicsPipeline[s]?\s+(VK_\w+)/);
  if (gpu) {
    const why =
      `this machine could not create a graphics pipeline (${gpu[1]}).\n` +
      `  That is the driver, not the guest: the pre-port C++ renderer fails the ` +
      `same way on the same rig.\n` +
      `  Run this on a conformant Vulkan ICD (CI's lavapipe); see ` +
      `docs/known-limitations.md.`;
    if (process.env.TENSION_TEST_ALLOW_SKIP === '1') {
      console.log(`SKIP — ${why}`);
      return { status: 0, output, frames: new Map(), skipped: true };
    }
    throw new Error(why);
  }

  const frames = new Map();
  for (const line of (result.stdout ?? '').split('\n')) {
    const m = line.match(/^FRAME (\w+) (\d+) ([0-9a-f]*)$/);
    if (!m) continue;
    const [, name, offset, hex] = m;
    if (!frames.has(name)) frames.set(name, { chunks: [] });
    frames.get(name).chunks.push({ offset: Number(offset), hex });
  }
  for (const frame of frames.values()) {
    frame.chunks.sort((a, b) => a.offset - b.offset);
    frame.rgba = Buffer.concat(frame.chunks.map((c) => Buffer.from(c.hex, 'hex')));
  }
  return { status: result.status, output, frames };
}
